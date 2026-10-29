"""Thor Foundry demo driver: the full v1 + lifecycle sequence, logged.

Order matters: the cull demo is scoped to the boat family by running it
before the other archetypes are minted.
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import registry

LOG = open(os.path.join(HERE, "logs", "demo.log"), "a")


def log(event, **kw):
    rec = {"t": round(time.time(), 1), "event": event, **kw}
    LOG.write(json.dumps(rec) + "\n")
    LOG.flush()
    print(json.dumps(rec), flush=True)


def run(*args):
    t = time.time()
    r = subprocess.run([sys.executable, os.path.join(HERE, "mint.py"), *args],
                       capture_output=True, text=True, cwd=HERE)
    dt = round(time.time() - t, 2)
    lines = [ln for ln in r.stdout.splitlines() if ln.startswith("{")]
    parsed = []
    for ln in lines:
        try:
            parsed.append(json.loads(ln))
        except Exception:
            pass
    log("cli", args=list(args), wall_s=dt, out=parsed,
        stderr_tail=r.stderr[-400:] if r.returncode else "")
    return parsed


def snapshot(name):
    rows = registry.list_assets()
    slim = [{k: r[k] for k in ("id", "archetype", "seed", "rung", "status", "use_count")}
            for r in rows]
    path = os.path.join(HERE, "logs", f"registry_{name}.json")
    json.dump(slim, open(path, "w"), indent=2)
    log("snapshot", name=name, assets=len(slim), path=path)
    return slim


def main():
    log("demo_start")
    # ---- core: family of 8 boats + coherence sheet
    run("family", "--archetype", "fishing_boat", "--count", "8", "--seed-start", "1")
    snapshot("after_family")

    # ---- lifecycle: simulate usage (3 boats used, 5 untouched)
    ids = {}
    for seed in range(1, 9):
        row = registry.get(archetype="fishing_boat", seed=seed)
        ids[seed] = row["id"]
    for seed, count in ((3, 5), (1, 3), (2, 2)):
        run("touch", "--id", str(ids[seed]), "--count", str(count))
    snapshot("after_touch")

    # ---- L1 refinement on the most-used boat
    run("refine", "--id", str(ids[3]))
    snapshot("after_refine")

    # ---- procedural destruction of the untouched (cache deleted, recipe kept)
    culled = run("cull", "--max-use", "0")
    snapshot("after_cull")

    # ---- regeneration from seed: restore the first culled boat
    run("regen", "--id", str(ids[4]))
    snapshot("after_regen")

    # ---- remaining archetypes
    run("family", "--archetype", "harbor_house", "--count", "6", "--seed-start", "1")
    run("mint", "--archetype", "pier", "--seed", "1")
    run("mint", "--archetype", "spruce", "--seed", "2")
    dem = os.path.join(HERE, "data", "sitka_height.png")
    params = {"heightmap": dem} if os.path.exists(dem) else {}
    run("mint", "--archetype", "terrain", "--seed", "1", "--params", json.dumps(params))

    # ---- motion proofs on boat seed 3
    run("turntable", "--archetype", "fishing_boat", "--seed", "3")
    run("bob", "--seed", "3")
    snapshot("final")
    log("demo_done")


if __name__ == "__main__":
    main()
