"""Foundry Builder runner: executes ONE build version end to end.

Usage:
  python3 build_runner.py --dir <version_dir> --engine blender|cad
The version dir must contain:
  code.py        the brain's code (blender) or build123d code (cad)
  request.json   {textures: [...], motion: {...}, samples: int, seed: int}
Produces in the version dir:
  textures/<key>.png (+ textures.json with prompts + measured times)
  preview.png, turntable.webp, motion.webp (when motion), asset.glb/.blend
    (blender) or part.step / part.glb (cad, + staged preview via harness)
  result.json    {ok, timings, objects, textures, error, ...}
Prints the same result.json to stdout. Exit 0 on success, 1 on failure.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
FOUNDRY = os.path.dirname(HERE)
sys.path.insert(0, FOUNDRY)
sys.path.insert(0, HERE)

BLENDER_CANDIDATES = [os.path.join(FOUNDRY, "blender", "blender"),
                      "/usr/bin/blender"]
CAD_PYTHON = os.path.join(FOUNDRY, "cad-venv", "bin", "python")


def blender_bin():
    for c in BLENDER_CANDIDATES:
        if os.path.isfile(c):
            return c
    raise SystemExit("no blender binary found")


def make_tileable(src_png, dst_png):
    """Mirror-tile: compose a 2x2 mirrored canvas. Plain REPEAT wrapping of
    a mirrored canvas is seamless with zero blur — the earlier offset
    cross-blend smeared visible bands across both proof textures.
    Returns seconds spent."""
    from PIL import Image
    t = time.time()
    im = Image.open(src_png).convert("RGB")
    w, h = im.size
    canvas = Image.new("RGB", (w * 2, h * 2))
    canvas.paste(im, (0, 0))
    canvas.paste(im.transpose(Image.FLIP_LEFT_RIGHT), (w, 0))
    canvas.paste(im.transpose(Image.FLIP_TOP_BOTTOM), (0, h))
    canvas.paste(im.transpose(Image.ROTATE_180), (w, h))
    canvas.save(dst_png)
    return time.time() - t


def gen_textures(vdir, specs, result):
    """Generate every requested texture into vdir/textures/. Returns dict
    key -> abs path. Raises on failure (the turn reports it honestly)."""
    tex_dir = os.path.join(vdir, "textures")
    os.makedirs(tex_dir, exist_ok=True)
    paths = {}
    infos = []
    for spec in specs or []:
        key = spec["key"]
        kind = spec.get("kind", "tile")
        dst = os.path.join(tex_dir, key + ".png")
        info = {"key": key, "kind": kind, "prompt": spec.get("prompt", ""),
                "negative_prompt": spec.get("negative_prompt", "")}
        t = time.time()
        if kind == "svg":
            import cairosvg
            svg = spec.get("svg") or ""
            if "<svg" not in svg:
                raise RuntimeError(f"texture {key}: svg payload has no <svg>")
            with open(os.path.join(tex_dir, key + ".svg"), "w") as f:
                f.write(svg)
            cairosvg.svg2png(bytestring=svg.encode(),
                             output_width=int(spec.get("px", 1024)),
                             output_height=int(spec.get("px", 1024)),
                             write_to=dst)
            info["tileable"] = False
        else:
            import mint as fmint
            raw = os.path.join(tex_dir, key + "_raw.png")
            prompt = spec.get("prompt", "")
            if "seamless" not in prompt.lower():
                prompt = "seamless tileable texture, " + prompt
            fmint.comfy_texture(
                raw, seed=int(spec.get("seed", 777)),
                prompt=prompt,
                negative=spec.get("negative_prompt") or
                "photo, scene, perspective, objects, text, watermark, border",
                steps=int(spec.get("steps", 16)), cfg=float(spec.get("cfg", 6.5)),
                width=int(spec.get("px", 512)), height=int(spec.get("px", 512)))
            info["tile_s"] = round(make_tileable(raw, dst), 2)
            info["tileable"] = True
            os.remove(raw)
        info["gen_s"] = round(time.time() - t, 2)
        info["path"] = dst
        infos.append(info)
        paths[key] = dst
    with open(os.path.join(vdir, "textures.json"), "w") as f:
        json.dump(infos, f, indent=1)
    result["textures"] = infos
    return paths


def assemble_webp(frames_dir, out_path, fps=6):
    from PIL import Image
    frames = sorted(f for f in os.listdir(frames_dir) if f.endswith(".png"))
    if not frames:
        return None
    imgs = [Image.open(os.path.join(frames_dir, f)).convert("RGB")
            for f in frames]
    imgs[0].save(out_path, format="WEBP", save_all=True,
                 append_images=imgs[1:], duration=int(1000 / fps), loop=0)
    return out_path


def run_blender(vdir, extra_args, timeout=900):
    args = [blender_bin(), "-b", "--python", os.path.join(HERE, "harness.py"),
            "--"] + extra_args
    t = time.time()
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    wall = time.time() - t
    res = None
    for line in r.stdout.splitlines():
        if line.startswith("BUILDER_RESULT "):
            res = json.loads(line[len("BUILDER_RESULT "):])
    if res is None:
        tail = (r.stdout[-3000:] + "\n" + r.stderr[-1500:]).strip()
        raise RuntimeError("blender produced no result:\n" + tail)
    res["_wall_s"] = round(wall, 2)
    return res


def run_blender_build(vdir, req, tex_paths):
    args = ["--code", os.path.join(vdir, "code.py"),
            "--out", vdir,
            "--textures", json.dumps(tex_paths),
            "--motion", json.dumps(req.get("motion") or {}),
            "--samples", str(int(req.get("samples", 48))),
            "--seed", str(int(req.get("seed", 7)))]
    res = run_blender(vdir, args)
    for frames, name, fps in (("frames_tt", "turntable.webp", 6),
                              ("frames_motion", "motion.webp", 10)):
        fd = os.path.join(vdir, frames)
        if os.path.isdir(fd):
            wp = assemble_webp(fd, os.path.join(vdir, name), fps=fps)
            if wp:
                res[name] = wp
            shutil.rmtree(fd, ignore_errors=True)
    return res


def run_cad_build(vdir, req, tex_paths):
    if not os.path.isfile(CAD_PYTHON):
        raise RuntimeError("CAD lane not installed (~/foundry/cad-venv missing)")
    t = time.time()
    r = subprocess.run([CAD_PYTHON, os.path.join(HERE, "cad_runner.py"),
                        "--dir", vdir],
                       capture_output=True, text=True, timeout=600)
    cad = None
    for line in r.stdout.splitlines():
        if line.startswith("CAD_RESULT "):
            cad = json.loads(line[len("CAD_RESULT "):])
    if cad is None:
        tail = (r.stdout[-2500:] + "\n" + r.stderr[-1500:]).strip()
        raise RuntimeError("cad runner produced no result:\n" + tail)
    if not cad.get("ok"):
        # surface the brain's real CAD error (was masked by a KeyError
        # on cad["glb"] — the first CAD proof died behind it)
        raise RuntimeError("cad code failed: " + str(cad.get("error", "?"))
                           + "\n" + str(cad.get("traceback", ""))[-1200:])
    cad["cad_s"] = round(time.time() - t, 2)
    # Stage the mesh through the Blender harness for preview/turntable/glb.
    args = ["--import-glb", cad["glb"], "--out", vdir,
            "--textures", "{}", "--motion", "{}", "--samples", "48"]
    res = run_blender(vdir, args)
    res.update({k: cad[k] for k in ("step", "stl", "cad_s") if k in cad})
    res["engine"] = "cad"
    fd = os.path.join(vdir, "frames_tt")
    if os.path.isdir(fd):
        assemble_webp(fd, os.path.join(vdir, "turntable.webp"), fps=6)
        shutil.rmtree(fd, ignore_errors=True)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--engine", default="blender")
    ap.add_argument("--skip-textures", action="store_true",
                    help="reuse textures already in the version dir")
    a = ap.parse_args()
    vdir = os.path.abspath(a.dir)
    result = {"ok": False, "engine": a.engine}
    t0 = time.time()
    try:
        req = json.load(open(os.path.join(vdir, "request.json")))
        result["request"] = req
        tex_paths = {}
        if req.get("textures") and not a.skip_textures:
            tex_paths = gen_textures(vdir, req["textures"], result)
        elif req.get("textures"):
            tex_dir = os.path.join(vdir, "textures")
            tex_paths = {s["key"]: os.path.join(tex_dir, s["key"] + ".png")
                         for s in req["textures"]}
            if os.path.exists(os.path.join(vdir, "textures.json")):
                result["textures"] = json.load(
                    open(os.path.join(vdir, "textures.json")))
        if a.engine == "cad":
            res = run_cad_build(vdir, req, tex_paths)
        else:
            res = run_blender_build(vdir, req, tex_paths)
        result.update(res)
        result["ok"] = True
    except Exception as e:  # noqa: BLE001 — result.json is the error surface
        result["error"] = str(e)[-3500:]
        result["traceback"] = traceback.format_exc()[-2500:]
    result["total_s"] = round(time.time() - t0, 2)
    with open(os.path.join(vdir, "result.json"), "w") as f:
        json.dump(result, f, indent=1)
    print(json.dumps(result)[:4000])
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
