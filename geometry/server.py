#!/usr/bin/env python3
"""The geometry service: the Thor answers "what is here?" with a depth map.

The renderer has a place file and a bundle. What it has never had is a way to ask
a model what the world looks like from a photograph. This is that way, and it is
the first service on the Thor that answers a *question* rather than serving a
payload it already holds.

The model is MoGe ViT-Large (MIT). Measured on this box on 2026-10-29, warm, at
518x924: **72 ms** at `num_tokens=1200`, 150 ms at full resolution, 1.4 GB of
VRAM. See `docs/adr/0022-the-geometry-service-is-moge.md`.

What it sends back, and why it is not a point map
--------------------------------------------------
A full point map for one 518x924 frame is 478,632 points: 5.74 MB as fp32, 2.87 MB
as fp16. Over the measured 9.3 MB/s Thor-ProArt link that is 0.31-0.62 s of
transfer, which would dominate the 72 ms of compute. So the service sends **the
depth map and the intrinsics** -- 0.96 MB as fp16 -- and lets the consumer
unproject it, which it can do exactly and for free.

The depth map is metric only up to the model's own scale convention, so the
intrinsics travel with it: a point recovered from them is in the same units as
the depth.

Routes
------
    GET  /health      -> {"status":"ok","model":"moge-vitl","numTokens":1200,...}
    POST /geometry    -> the image bytes in the body; the geometry out as JSON.

The image may be any format Pillow reads. It is resized so both sides are
divisible by 14 (the model's patch grid) with the aspect ratio preserved, and
the depth map comes back at the model's working resolution.

Usage:
    python3 server.py --port 8099 --weights ~/models/moge-vitl/model.pt
"""
import argparse
import base64
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
import torch
from PIL import Image

# The model's patch grid: both sides of the input must be divisible by this.
PATCH = 14
# The default accuracy knob. 1200 tokens is the coarse end of the range the model
# documents (1200-2500) and the fastest measured setting on this box.
DEFAULT_NUM_TOKENS = 1200

_MODEL = None
_NUM_TOKENS = DEFAULT_NUM_TOKENS
# One GPU, one model: inference is serialised rather than queued.
_LOCK = threading.Lock()
_STATS = {"queries": 0, "errors": 0, "total_infer_s": 0.0}


def load_model(weights: str, num_tokens: int):
    """Load MoGe once. The weights are resident for the life of the process."""
    from moge.model.v1 import MoGeModel

    t0 = time.time()
    model = MoGeModel.from_pretrained(weights)
    model = model.eval()
    if torch.cuda.is_available():
        model = model.to("cuda")
    else:
        print("WARNING: no CUDA device; geometry will be slow", file=sys.stderr)
    print(
        f"moge loaded in {time.time() - t0:.1f}s device={model.device} weights={weights}",
        flush=True,
    )
    return model


def fit_for_model(image: Image.Image) -> Image.Image:
    """Resize so both sides are multiples of the patch grid, keeping the aspect."""
    w, h = image.size
    scale = 1.0
    # A working image larger than this costs link and time for no useful detail.
    longest = max(w, h)
    if longest > 1024:
        scale = 1024 / longest
    new_w = max(PATCH, int(round(w * scale / PATCH)) * PATCH)
    new_h = max(PATCH, int(round(h * scale / PATCH)) * PATCH)
    if (new_w, new_h) == (w, h):
        return image
    return image.resize((new_w, new_h), Image.Resampling.BICUBIC)


def infer(image_bytes: bytes, num_tokens: int, want_mask: bool) -> dict:
    """Run the model and package the answer."""
    with Image.open(io.BytesIO(image_bytes)) as im:
        im = im.convert("RGB")
        work = fit_for_model(im)
        arr = np.asarray(work).copy()

    tensor = torch.from_numpy(arr).permute(2, 0, 1).float() / 255.0
    if torch.cuda.is_available():
        tensor = tensor.cuda()

    with _LOCK:
        t0 = time.time()
        with torch.no_grad():
            out = _MODEL.infer(
                tensor,
                num_tokens=num_tokens,
                apply_mask=want_mask,
                use_fp16=True,
            )
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        infer_s = time.time() - t0

    _STATS["queries"] += 1
    _STATS["total_infer_s"] += infer_s

    depth = out["depth"].squeeze(0) if out["depth"].dim() == 3 else out["depth"]
    intrinsics = out["intrinsics"]
    if intrinsics.dim() == 3:
        intrinsics = intrinsics[0]

    depth_np = depth.detach().float().cpu().numpy()
    # fp16 halves the payload; the depth is metric and does not need more.
    depth16 = depth_np.astype(np.float16)

    height, width = int(depth_np.shape[0]), int(depth_np.shape[1])
    intr = intrinsics.detach().cpu().numpy()
    # The model returns intrinsics in NORMALISED coordinates: the principal
    # point is (0.5, 0.5) and the focal length is in units of the image's own
    # width/height. That convention is easy to get wrong and impossible to
    # guess, so the pixel form travels alongside it.
    pixel_intr = [
        [float(intr[0][0]) * width, 0.0, float(intr[0][2]) * width],
        [0.0, float(intr[1][1]) * height, float(intr[1][2]) * height],
        [0.0, 0.0, 1.0],
    ]

    answer = {
        "format": "otherhere.geometry.v1",
        "model": "moge-vitl",
        "numTokens": num_tokens,
        "width": width,
        "height": height,
        "inferSeconds": round(infer_s, 4),
        "intrinsics": [[float(v) for v in row] for row in intr],
        "intrinsicsNormalised": True,
        "intrinsicsPixels": pixel_intr,
        "depth": {
            "encoding": "base64-fp16",
            "shape": [height, width],
            "bytes": base64.b64encode(depth16.tobytes()).decode("ascii"),
        },
    }

    mask = out.get("mask")
    if want_mask and mask is not None:
        mask_np = mask.squeeze(0) if mask.dim() == 3 else mask
        mask_np = mask_np.detach().float().cpu().numpy()
        answer["mask"] = {
            "encoding": "base64-uint8",
            "shape": [int(mask_np.shape[0]), int(mask_np.shape[1])],
            "bytes": base64.b64encode((mask_np * 255).astype(np.uint8).tobytes()).decode("ascii"),
        }
    return answer


class Handler(BaseHTTPRequestHandler):
    server_version = "otherhere-geometry/1.0"

    def log_message(self, fmt, *args):  # noqa: A003 - the base class's name
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, body: bytes, content_type: str):
        self.send_response(code)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        # The renderer fetches from another origin; the capture service sets the
        # same rule. This service holds no per-caller state, so '*' is honest.
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "content-type")
        self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802 - the base class's name
        self._send(204, b"", "text/plain")

    def do_GET(self):  # noqa: N802 - the base class's name
        url = urlparse(self.path)
        if url.path in ("/health", "/geometry/health"):
            body = json.dumps(
                {
                    "status": "ok",
                    "model": "moge-vitl",
                    "numTokens": _NUM_TOKENS,
                    "device": str(_MODEL.device) if _MODEL else "none",
                    "stats": dict(_STATS),
                }
            ).encode()
            self._send(200, body, "application/json")
            return
        self._send(404, json.dumps({"error": f"no route for GET {url.path}"}).encode(), "application/json")

    def do_POST(self):  # noqa: N802 - the base class's name
        url = urlparse(self.path)
        if url.path != "/geometry":
            self._send(404, json.dumps({"error": f"no route for POST {url.path}"}).encode(), "application/json")
            return
        query = parse_qs(url.query)
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            self._send(400, json.dumps({"error": "empty body: send the image bytes"}).encode(), "application/json")
            return
        body = self.rfile.read(length)
        try:
            num_tokens = int(query.get("num_tokens", [_NUM_TOKENS])[0])
        except ValueError:
            self._send(400, json.dumps({"error": "num_tokens must be an integer"}).encode(), "application/json")
            return
        want_mask = query.get("mask", ["1"])[0] not in ("0", "false", "no")
        try:
            answer = infer(body, num_tokens, want_mask)
        except Exception as exc:  # noqa: BLE001 - a bad image is the client's fault
            _STATS["errors"] += 1
            self._send(
                400,
                json.dumps({"error": f"{type(exc).__name__}: {exc}"}).encode(),
                "application/json",
            )
            return
        self._send(200, json.dumps(answer).encode(), "application/json")


def main():
    global _MODEL, _NUM_TOKENS
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--weights", default=os.path.expanduser("~/models/moge-vitl/model.pt"))
    ap.add_argument("--num-tokens", type=int, default=DEFAULT_NUM_TOKENS)
    args = ap.parse_args()

    _NUM_TOKENS = args.num_tokens
    _MODEL = load_model(args.weights, args.num_tokens)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"geometry service on http://{args.host}:{args.port}/geometry", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
