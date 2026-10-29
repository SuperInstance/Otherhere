"""Thor Foundry registry: sqlite record of every minted asset.

Doctrine: params + seed ARE the asset. Meshes/renders are a cache.
Destroying an asset deletes the cache, never the recipe.
"""
import sqlite3
import json
import os
import time

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "registry.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    archetype TEXT NOT NULL,
    seed INTEGER NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    rung TEXT NOT NULL DEFAULT 'L0',
    status TEXT NOT NULL DEFAULT 'active',
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at REAL,
    created_at REAL NOT NULL,
    out_dir TEXT,
    glb_path TEXT,
    blend_path TEXT,
    render_path TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_arch_seed ON assets(archetype, seed);
"""


def db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def register(archetype, seed, params, rung, out_dir, glb, blend, render):
    con = db()
    now = time.time()
    con.execute(
        """INSERT INTO assets (archetype, seed, params, rung, status, created_at,
                               out_dir, glb_path, blend_path, render_path)
           VALUES (?,?,?,?, 'active', ?, ?, ?, ?, ?)
           ON CONFLICT(archetype, seed) DO UPDATE SET
             params=excluded.params, rung=excluded.rung, status='active',
             out_dir=excluded.out_dir, glb_path=excluded.glb_path,
             blend_path=excluded.blend_path, render_path=excluded.render_path""",
        (archetype, seed, json.dumps(params), rung, now, out_dir, glb, blend, render))
    con.commit()
    row = con.execute("SELECT * FROM assets WHERE archetype=? AND seed=?",
                      (archetype, seed)).fetchone()
    con.close()
    return dict(row)


def get(asset_id=None, archetype=None, seed=None):
    con = db()
    if asset_id:
        row = con.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
    else:
        row = con.execute("SELECT * FROM assets WHERE archetype=? AND seed=?",
                          (archetype, seed)).fetchone()
    con.close()
    return dict(row) if row else None


def touch(asset_id, count=1):
    con = db()
    con.execute("UPDATE assets SET use_count = use_count + ?, last_used_at = ? WHERE id = ?",
                (count, time.time(), asset_id))
    con.commit()
    row = con.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
    con.close()
    return dict(row)


def set_rung(asset_id, rung):
    con = db()
    con.execute("UPDATE assets SET rung=? WHERE id=?", (rung, asset_id))
    con.commit()
    con.close()


def mark_destroyed(asset_id):
    con = db()
    con.execute("""UPDATE assets SET status='destroyed', rung='destroyed',
                   glb_path=NULL, blend_path=NULL, render_path=NULL WHERE id=?""",
                (asset_id,))
    con.commit()
    con.close()


def list_assets():
    con = db()
    rows = [dict(r) for r in con.execute("SELECT * FROM assets ORDER BY archetype, seed")]
    con.close()
    return rows


def least_used(max_use=None, active_only=True):
    rows = list_assets()
    rows = [r for r in rows if r["status"] == "active"] if active_only else rows
    if max_use is not None:
        rows = [r for r in rows if r["use_count"] <= max_use]
    return sorted(rows, key=lambda r: (r["use_count"], r["last_used_at"] or 0))
