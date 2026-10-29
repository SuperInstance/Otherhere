"""CAD lane runner: executes inside ~/foundry/cad-venv's python.
Execs the version's code.py (build123d), takes namespace["result"] as the
solid, exports STEP + STL + GLB. Prints one line: CAD_RESULT {json}.
Usage: python cad_runner.py --dir <version_dir>
"""
import argparse
import json
import os
import sys
import time
import traceback

ap = argparse.ArgumentParser()
ap.add_argument("--dir", required=True)
a = ap.parse_args()
vdir = os.path.abspath(a.dir)

result = {"ok": False}
try:
    import build123d as bd

    ns = {"__name__": "build"}
    for k in dir(bd):
        if not k.startswith("_"):
            ns[k] = getattr(bd, k)
    code = open(os.path.join(vdir, "code.py")).read()
    exec(compile(code, "code.py", "exec"), ns)  # noqa: S102 — glass box
    solid = ns.get("result")
    if solid is None:
        raise RuntimeError("code must define `result` (a build123d solid)")

    t = time.time()
    step = os.path.join(vdir, "part.step")
    stl = os.path.join(vdir, "part.stl")
    glb = os.path.join(vdir, "part.glb")
    bd.export_step(solid, step)
    bd.export_stl(solid, stl)
    # build123d 0.13's export_gltf writes JSON glTF + external .bin even to a
    # .glb name; the portal wants a true binary GLB, so convert via trimesh.
    # build123d works in mm; the foundry world is metres — bake the 0.001
    # scale into the mesh so the registered asset is true-size (the STEP
    # file keeps the exact mm geometry).
    import trimesh
    mesh = trimesh.load(stl)
    mesh.apply_scale(0.001)
    mesh.export(glb)
    result.update(ok=True, cad_export_s=round(time.time() - t, 2),
                  step=step, stl=stl, glb=glb)
except Exception as e:  # noqa: BLE001 — CAD_RESULT is the error surface
    result["error"] = str(e)[-2500:]
    result["traceback"] = traceback.format_exc()[-2000:]
print("CAD_RESULT " + json.dumps(result))
sys.exit(0 if result["ok"] else 1)
