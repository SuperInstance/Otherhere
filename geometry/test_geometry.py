#!/usr/bin/env python3
"""The geometry service's self-test.

The repo's CI is pnpm-based and does not run Python, so this is a script the
Thor runs itself rather than a suite the pipeline runs. It has two halves:

  - the part that needs no model: the input fitting and the wire contract;
  - the part that needs the model: a real query, its determinism, and whether
    the answer is a geometry rather than noise.

    python3 geometry/test_geometry.py              # the model-free half
    python3 geometry/test_geometry.py --with-model # both

It talks to a running service by default; --service points it elsewhere.
"""
import argparse
import base64
import json
import os
import struct
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

FAILURES = []


def check(name: str, ok: bool, detail: str = ""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")
    if not ok:
        FAILURES.append(name)


def test_fit():
    """The input is fitted so both sides are multiples of the patch grid."""
    from PIL import Image

    print("input fitting")
    for size, longest in (((300, 200), 1024), ((1920, 1080), 1024), ((518, 924), 1024)):
        im = Image.new("RGB", size)
        work = fit_for_model(im)
        w, h = work.size
        check(
            f"{size} -> {size} divisible by the patch grid",
            w % PATCH == 0 and h % PATCH == 0,
            f"got {w}x{h}",
        )
        check(
            f"{size} -> {size} the long side is capped",
            max(w, h) <= longest + PATCH,
            f"got {max(w, h)}",
        )
        check(
            f"{size} -> {size} the aspect ratio is kept",
            abs((w / h) - (size[0] / size[1])) < 0.1,
            f"{w / h:.3f} vs {size[0] / size[1]:.3f}",
        )


def test_service(service: str, image_path: str):
    """A real query: the contract, the determinism, and the geometry."""
    print("the service")
    try:
        with urllib.request.urlopen(f"{service}/health", timeout=15) as res:
            health = json.load(res)
    except Exception as exc:  # noqa: BLE001
        check("health", False, f"{type(exc).__name__}: {exc}")
        return
    check("health", health.get("status") == "ok", json.dumps(health.get("stats", {})))

    body = open(image_path, "rb").read()
    answers = []
    for _ in range(2):
        req = urllib.request.Request(
            f"{service}/geometry?num_tokens=1200&mask=0",
            data=body,
            headers={"Content-Type": "image/jpeg"},
        )
        with urllib.request.urlopen(req, timeout=120) as res:
            answers.append(json.load(res))

    first, second = answers
    check("the format is the one the ADR names", first.get("format") == "otherhere.geometry.v1")
    check("the depth is fp16", first["depth"]["encoding"] == "base64-fp16")
    check(
        "the depth's shape matches the answer's width and height",
        first["depth"]["shape"] == [first["height"], first["width"]],
        f"{first['depth']['shape']} vs [{first['height']}, {first['width']}]",
    )
    check(
        "the pixel intrinsics are in pixels",
        abs(first["intrinsicsPixels"][0][2] - first["width"] / 2) < 1.0,
        f"cx={first['intrinsicsPixels'][0][2]}, width={first['width']}",
    )
    check(
        "the pixels are square (fx == fy in pixels)",
        abs(first["intrinsicsPixels"][0][0] - first["intrinsicsPixels"][1][1]) < 1.0,
        f"fx={first['intrinsicsPixels'][0][0]}, fy={first['intrinsicsPixels'][1][1]}",
    )
    check("the same image gives the same depth", first["depth"]["bytes"] == second["depth"]["bytes"])

    depth = _decode_fp16(first["depth"])
    check("the depth has values", depth is not None and len(depth) > 0)
    if depth:
        finite = [v for v in depth if v == v and 0 < v < 1e6]
        check("the depth is plausible", len(finite) > len(depth) * 0.5, f"{len(finite)}/{len(depth)} finite")
        check(
            "the depth is metric, not millimetres",
            0.05 < (sum(finite) / len(finite)) < 100.0,
            f"mean {sum(finite) / len(finite):.3f}",
        )


def _decode_fp16(block: dict):
    """fp16 -> float, without numpy (the Thor's system python has none)."""
    try:
        raw = base64.b64decode(block["bytes"])
    except Exception:  # noqa: BLE001
        return None
    count = len(raw) // 2
    values = []
    for i in range(count):
        (bits,) = struct.unpack_from("<H", raw, i * 2)
        sign = -1.0 if bits & 0x8000 else 1.0
        exponent = (bits >> 10) & 0x1F
        fraction = bits & 0x03FF
        if exponent == 0:
            value = fraction / 1024.0 * 2**-14
        elif exponent == 31:
            value = float("inf")
        else:
            value = (1 + fraction / 1024.0) * 2 ** (exponent - 15)
        values.append(sign * value)
    return values


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--with-model", action="store_true")
    ap.add_argument("--service", default="http://127.0.0.1:8099")
    ap.add_argument(
        "--image",
        default=os.path.expanduser("~/sitka-distill/exp1/cathedral/frames_full/frame_00000.jpg"),
    )
    args = ap.parse_args()

    from server import PATCH, fit_for_model  # noqa: E402

    globals()["PATCH"] = PATCH
    globals()["fit_for_model"] = fit_for_model

    test_fit()
    if args.with_model:
        test_service(args.service, args.image)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
