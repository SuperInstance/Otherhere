#!/usr/bin/env python3
"""Thor Foundry CLI — mint parametric 3D assets from seeds.

    mint.py mint     --archetype fishing_boat --seed 7 [--params '{...}']
    mint.py family   --archetype fishing_boat --count 8 [--seed-start 1]
    mint.py turntable --archetype fishing_boat --seed 3
    mint.py bob      --seed 3
    mint.py refine   --id 4                      (L1: SDXL texture pass)
    mint.py touch    --id 4 [--count 3]          (record usage)
    mint.py list
    mint.py cull     [--max-use 0]               (destroy least-used caches)
    mint.py regen    --id 9                      (re-mint a destroyed asset from seed)

Doctrine: params + seed ARE the asset. Mesh/render files are its current
rendering — a cache. Culling deletes the cache, never the recipe.
"""
import argparse
import json
import os
import random
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import registry

BLENDER_CANDIDATES = [os.path.join(HERE, "blender", "blender"), "/usr/bin/blender"]
OUT_ROOT = os.path.join(HERE, "out")
COMFY = "http://localhost:8188"
SDXL = "sd_xl_base_1.0.safetensors"

JITTER = {
    "fishing_boat": {"length": (0.88, 1.15), "beam_ratio": (0.31, 0.38),
                     "wear": (0.05, 0.80), "cabin_len": (0.26, 0.36),
                     "mast_h": (4.0, 5.4)},
    "harbor_house": {"width": (6.0, 8.6), "roof_pitch": (0.40, 0.70)},
    "sitka_house": {"roof_pitch": (0.45, 0.80), "wear": (0.0, 0.35),
                    "overhang": (0.25, 0.45)},
    "pier": {"length": (14.0, 24.0), "piling_gap": (2.6, 3.8)},
    "spruce": {"height": (7.0, 12.0), "snow": (0.1, 0.8)},
    "terrain": {},
}


def blender_bin():
    for c in BLENDER_CANDIDATES:
        if os.path.exists(c):
            return c
    raise SystemExit("no blender binary found")


MULT_KEYS = {("fishing_boat", "length")}  # jitter as multiplier of base, not absolute


def defaults(arch):
    base = {
        "fishing_boat": {"length": 10.0, "beam_ratio": 0.34, "freeboard": 0.85,
                         "draft": 0.75, "cabin_len": 0.30, "cabin_h": 1.55,
                         "mast_h": 4.6, "wear": 0.3},
        "harbor_house": {"width": 7.0, "depth": 6.0, "stories": 2, "roof_pitch": 0.55},
        "sitka_house": {"foot_w": 9.5, "foot_d": 8.0, "stories": 2, "storey_h": 2.9,
                        "roof_form": "gable", "roof_pitch": 0.6, "ridge_dir": "street",
                        "siding": "white_siding", "palette": 0, "roof_mat": "galvanised",
                        "porch": 0, "chimney": 1, "win_rhythm": 2.2, "wear": 0.15,
                        "overhang": 0.32},
        "pier": {"length": 18.0, "width": 3.2, "piling_gap": 3.0},
        "spruce": {"height": 9.0, "branch_density": 5, "snow": 0.4},
        "terrain": {"size": 220.0, "height": 26.0},
    }
    return dict(base[arch])


def effective_params(arch, seed, overrides=None):
    """Deterministic per-seed jitter: same seed -> same params, forever."""
    p = defaults(arch)
    rng = random.Random(seed * 31 + 7)
    for k, (lo, hi) in JITTER.get(arch, {}).items():
        if (arch, k) in MULT_KEYS:
            p[k] = round(p[k] * rng.uniform(lo, hi), 3)
        else:
            p[k] = round(rng.uniform(lo, hi), 3)
    if arch == "fishing_boat":
        p["palette"] = seed % 8
    if arch == "harbor_house":
        p["palette"] = seed % 6
        p["stories"] = 1 + (seed % 2)
    if arch == "sitka_house":
        p["palette"] = seed % 6
        p["porch"] = 1 if seed % 3 == 0 else 0
        p["chimney"] = 0 if seed % 7 == 0 else 1
    if arch == "spruce":
        p["branch_density"] = 4 + (seed % 4)
    if overrides:
        p.update(overrides)
    return p


def run_engine(mode, **kw):
    args = [blender_bin(), "-b", "--python", os.path.join(HERE, "engine.py"), "--",
            "--mode", mode]
    for k, v in kw.items():
        args += ["--" + k, str(v)]
    t = time.time()
    r = subprocess.run(args, capture_output=True, text=True, timeout=3600)
    wall = time.time() - t
    result = None
    for line in r.stdout.splitlines():
        if line.startswith("FOUNDRY_RESULT "):
            result = json.loads(line[len("FOUNDRY_RESULT "):])
    if result is None:
        sys.stderr.write(r.stdout[-4000:] + "\n" + r.stderr[-2000:])
        raise SystemExit(f"engine mode={mode} produced no result")
    result["_wall_s"] = round(wall, 2)
    return result


def out_dir(arch, seed):
    return os.path.join(OUT_ROOT, arch, f"seed-{seed}")


def do_mint(arch, seed, overrides=None, rung="L0", register=True):
    p = effective_params(arch, seed, overrides)
    od = out_dir(arch, seed)
    os.makedirs(od, exist_ok=True)
    res = run_engine("mint", archetype=arch, seed=seed,
                     params=json.dumps(p), out=od)
    row = None
    if register:
        row = registry.register(arch, seed, p, rung, od, res["glb"], res["blend"],
                                os.path.join(od, "preview.png"))
    print(json.dumps({"minted": arch, "seed": seed, "id": row["id"] if row else None,
                      "rung": rung, "device": res["device"],
                      "render_s": res["render_s"], "wall_s": res["_wall_s"],
                      "glb": res["glb"]}))
    return row, res


def assemble_webp(frames_dir, out_path, fps=6):
    from PIL import Image
    frames = sorted(f for f in os.listdir(frames_dir) if f.startswith("frame_"))
    imgs = [Image.open(os.path.join(frames_dir, f)).convert("RGB") for f in frames]
    imgs[0].save(out_path, format="WEBP", save_all=True, append_images=imgs[1:],
                 duration=int(1000 / fps), loop=0, quality=82)
    return out_path


# ------------------------------------------------------------- L1 refinement
REFINE_PROMPT = ("flat frontal texture of a weathered fishing boat hull side, peeling painted "
                 "wood planks, salt streaks, rust weep below fittings, scratched paint, "
                 "full-frame seamless texture, no perspective, no sky, no water, texture only")
REFINE_NEGATIVE = "photograph of a boat, harbor scene, sky, water, people, perspective, 3d render"
REFINE_DEFAULTS = {"model": SDXL, "prompt": REFINE_PROMPT,
                   "negative_prompt": REFINE_NEGATIVE, "steps": 20, "cfg": 7.0,
                   "width": 1024, "height": 512, "sampler": "euler",
                   "scheduler": "normal", "seed": 1234}


def refine_recipe():
    """The canonical L1 recipe as data. The portal's glass-box cards read
    these exact values from here, so what Casey sees on the card is what
    refine will run — one source of truth, no drift."""
    return dict(REFINE_DEFAULTS)


def comfy_texture(dest_png, seed=1234, prompt=None, negative=None, steps=20,
                  cfg=7.0, width=1024, height=512, sampler="euler", model=None):
    """One SDXL pass through the image studio -> a hull-side texture."""
    wf = {
        "3": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": sampler,
            "scheduler": "normal", "denoise": 1.0,
            "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0],
            "latent_image": ["5", 0]}},
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": SDXL if model is None else model}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 1], "text":
              REFINE_PROMPT if prompt is None else prompt}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 1], "text":
              REFINE_NEGATIVE if negative is None else negative}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "foundry_tex"}},
    }
    t = time.time()
    req = urllib.request.Request(COMFY + "/prompt",
                                 data=json.dumps({"prompt": wf}).encode(),
                                 headers={"Content-Type": "application/json"})
    pid = json.loads(urllib.request.urlopen(req, timeout=30).read())["prompt_id"]
    while True:
        time.sleep(2)
        h = json.loads(urllib.request.urlopen(COMFY + f"/history/{pid}", timeout=30).read())
        if pid in h:
            imgs = h[pid]["outputs"]["9"]["images"]
            break
        if time.time() - t > 600:
            raise SystemExit("comfy texture timed out")
    im = imgs[0]
    url = f"{COMFY}/view?filename={im['filename']}&subfolder={im.get('subfolder','')}&type=output"
    with urllib.request.urlopen(url, timeout=60) as r, open(dest_png, "wb") as f:
        f.write(r.read())
    return time.time() - t


def do_refine(asset_id, tex_kw=None):
    row = registry.get(asset_id=asset_id)
    if not row:
        raise SystemExit("no such asset id")
    if row["status"] != "active":
        raise SystemExit("asset is destroyed; regen first")
    tex = os.path.join(row["out_dir"], "texture_l1.png")
    tex_s = comfy_texture(tex, **(tex_kw or {}))
    params = json.loads(row["params"])
    params["hull_texture"] = tex
    res = run_engine("mint", archetype=row["archetype"], seed=row["seed"],
                     params=json.dumps(params), out=row["out_dir"])
    registry.set_rung(asset_id, "L1")
    print(json.dumps({"refined": asset_id, "rung": "L1", "texture_s": round(tex_s, 2),
                      "texture": tex, "render_s": res["render_s"], "device": res["device"],
                      "preview": os.path.join(row["out_dir"], "preview.png")}))
    return tex_s, res


# ------------------------------------------------------------- verbs
def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="verb", required=True)
    for name in ("mint", "turntable"):
        s = sub.add_parser(name)
        s.add_argument("--archetype", default="fishing_boat")
        s.add_argument("--seed", type=int, default=1)
        s.add_argument("--params", default="{}")
    s = sub.add_parser("family")
    s.add_argument("--archetype", default="fishing_boat")
    s.add_argument("--count", type=int, default=8)
    s.add_argument("--seed-start", type=int, default=1)
    s = sub.add_parser("bob")
    s.add_argument("--seed", type=int, default=3)
    s.add_argument("--params", default="{}")
    s = sub.add_parser("refine"); s.add_argument("--id", type=int, required=True)
    # Optional texture-pass overrides (the portal's glass-box cards use
    # these; a bare `refine --id N` behaves exactly as it always has).
    s.add_argument("--prompt", default=None)
    s.add_argument("--negative", default=None)
    s.add_argument("--steps", type=int, default=None)
    s.add_argument("--cfg", type=float, default=None)
    s.add_argument("--tex-seed", type=int, default=None)
    s.add_argument("--width", type=int, default=None)
    s.add_argument("--height", type=int, default=None)
    s.add_argument("--sampler", default=None)
    s.add_argument("--model", default=None)
    s = sub.add_parser("touch")
    s.add_argument("--id", type=int, required=True); s.add_argument("--count", type=int, default=1)
    s = sub.add_parser("list")
    s = sub.add_parser("cull"); s.add_argument("--max-use", type=int, default=0)
    s = sub.add_parser("regen"); s.add_argument("--id", type=int, required=True)
    a = ap.parse_args()

    if a.verb == "mint":
        do_mint(a.archetype, a.seed, json.loads(a.params))
    elif a.verb == "family":
        rows = []
        for i in range(a.count):
            row, _ = do_mint(a.archetype, a.seed_start + i)
            rows.append(row)
        members = ",".join(r["glb_path"] for r in rows)
        os.makedirs(os.path.join(OUT_ROOT, "family"), exist_ok=True)
        sheet = os.path.join(OUT_ROOT, "family", f"{a.archetype}_family.png")
        res = run_engine("familysheet", archetype=a.archetype, members=members, out=sheet)
        print(json.dumps({"family_sheet": sheet, "render_s": res["render_s"],
                          "members": res["members"], "device": res["device"]}))
    elif a.verb == "turntable":
        p = effective_params(a.archetype, a.seed, json.loads(a.params))
        fd = os.path.join(out_dir(a.archetype, a.seed), "turntable_frames")
        res = run_engine("turntable", archetype=a.archetype, seed=a.seed,
                         params=json.dumps(p), out=fd)
        webp = assemble_webp(fd, os.path.join(out_dir(a.archetype, a.seed), "turntable.webp"), fps=6)
        print(json.dumps({"turntable": webp, "frames": res["frames"],
                          "per_frame_s": res["per_frame_s"], "device": res["device"]}))
    elif a.verb == "bob":
        p = effective_params("fishing_boat", a.seed, json.loads(a.params))
        fd = os.path.join(out_dir("fishing_boat", a.seed), "bob_frames")
        res = run_engine("bob", seed=a.seed, params=json.dumps(p), out=fd)
        webp = assemble_webp(fd, os.path.join(out_dir("fishing_boat", a.seed), "bob.webp"),
                             fps=res["fps"])
        print(json.dumps({"bob": webp, "frames": res["frames"], "fps": res["fps"],
                          "blend": res["blend"], "per_frame_s": res["per_frame_s"],
                          "device": res["device"]}))
    elif a.verb == "refine":
        kw = {}
        if a.prompt is not None:
            kw["prompt"] = a.prompt
        if a.negative is not None:
            kw["negative"] = a.negative
        if a.steps is not None:
            kw["steps"] = a.steps
        if a.cfg is not None:
            kw["cfg"] = a.cfg
        if a.tex_seed is not None:
            kw["seed"] = a.tex_seed
        if a.width is not None:
            kw["width"] = a.width
        if a.height is not None:
            kw["height"] = a.height
        if a.sampler is not None:
            kw["sampler"] = a.sampler
        if a.model is not None:
            kw["model"] = a.model
        do_refine(a.id, kw)
    elif a.verb == "touch":
        row = registry.touch(a.id, a.count)
        print(json.dumps({"touched": a.id, "use_count": row["use_count"],
                          "last_used_at": row["last_used_at"]}))
    elif a.verb == "list":
        for r in registry.list_assets():
            print(f"#{r['id']:>3} {r['archetype']:<13} seed={r['seed']:<3} rung={r['rung']:<9} "
                  f"status={r['status']:<9} uses={r['use_count']:<3} dir={r['out_dir']}")
    elif a.verb == "cull":
        victims = registry.least_used(max_use=a.max_use)
        for v in victims:
            import shutil
            for key in ("glb_path", "blend_path", "render_path"):
                if v[key] and os.path.exists(v[key]):
                    os.remove(v[key])
            extra = os.path.join(v["out_dir"], "texture_l1.png")
            if os.path.exists(extra):
                os.remove(extra)
            registry.mark_destroyed(v["id"])
            print(json.dumps({"culled": v["id"], "archetype": v["archetype"],
                              "seed": v["seed"], "uses": v["use_count"],
                              "recipe_kept": True}))
        print(json.dumps({"culled_count": len(victims)}))
    elif a.verb == "regen":
        row = registry.get(asset_id=a.id)
        if not row:
            raise SystemExit("no such asset id")
        if row["archetype"] == "freeform":
            # A freeform asset's recipe is its build code (+ texture
            # prompts), kept in the builder version dir. Regen re-runs
            # that exact version through the builder runner, then
            # restores the artifacts into the registry out_dir.
            import shutil
            import subprocess as _sp
            params = json.loads(row["params"])
            vdir = os.path.join(OUT_ROOT, "builds",
                                f"b{params['build_id']}", f"v{params['version']}")
            r = _sp.run(["/usr/bin/python3",
                         os.path.join(HERE, "builder", "build_runner.py"),
                         "--dir", vdir, "--engine",
                         params.get("engine", "blender")],
                        capture_output=True, text=True, timeout=1800)
            res = json.load(open(os.path.join(vdir, "result.json")))
            if not res.get("ok"):
                raise SystemExit("freeform regen failed: " +
                                 str(res.get("error"))[:600])
            od = row["out_dir"] or out_dir("freeform", row["seed"])
            os.makedirs(od, exist_ok=True)
            def _cp(name):
                src = os.path.join(vdir, name)
                if os.path.isfile(src):
                    dst = os.path.join(od, name)
                    shutil.copyfile(src, dst)
                    return dst
                return None
            glb = _cp("asset.glb") or _cp("part.glb")
            if glb and os.path.basename(glb) != "asset.glb":
                shutil.copyfile(glb, os.path.join(od, "asset.glb"))
                glb = os.path.join(od, "asset.glb")
            blend = _cp("asset.blend") or glb
            preview = _cp("preview.png")
            _cp("turntable.webp"); _cp("motion.webp"); _cp("code.py")
            registry.register("freeform", row["seed"], params, "L0", od,
                              glb, blend, preview)
            new = registry.get(archetype="freeform", seed=row["seed"])
            print(json.dumps({"regenerated": a.id, "new_id": new["id"],
                              "status": new["status"], "rung": new["rung"],
                              "render_s": res.get("preview_render_s"),
                              "device": res.get("device"), "glb": glb}))
            return
        overrides = json.loads(row["params"])
        # params in registry are already the effective params; re-mint with them
        # as overrides over defaults (jitter would re-derive identical values
        # only for untouched keys, so pass all as overrides via --params route)
        p = defaults(row["archetype"])
        p.update(overrides)
        od = row["out_dir"] or out_dir(row["archetype"], row["seed"])
        os.makedirs(od, exist_ok=True)
        res = run_engine("mint", archetype=row["archetype"], seed=row["seed"],
                         params=json.dumps(p), out=od)
        registry.register(row["archetype"], row["seed"], overrides, "L0", od,
                          res["glb"], res["blend"], os.path.join(od, "preview.png"))
        new = registry.get(archetype=row["archetype"], seed=row["seed"])
        print(json.dumps({"regenerated": a.id, "new_id": new["id"], "status": new["status"],
                          "rung": new["rung"], "render_s": res["render_s"],
                          "device": res["device"], "glb": res["glb"]}))


if __name__ == "__main__":
    main()
