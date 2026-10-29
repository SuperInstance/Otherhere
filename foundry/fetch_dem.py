"""Fetch a real DEM for Sitka, AK into foundry/data/ (Otherhere steal:
world from real data + parameters). Source: AWS terrain tiles (skadi SRTM).
Crops the Sitka harbor area and writes a 16-bit PNG heightmap + meta.json.
Falls back gracefully: exits nonzero with reason if the fetch fails.
"""
import gzip
import json
import os
import struct
import sys
import urllib.request

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
# Sitka harbor ~57.053, -135.336. Skadi tile N57W136: lat 57..58, lon -136..-135, 3601x3601 int16 BE.
URL = "https://s3.amazonaws.com/elevation-tiles-prod/skadi/N57/N57W136.hgt.gz"
TILE = 3601
LAT0, LON0 = 57.022, -135.372   # crop SW corner (town + Baranof west slope)
SPAN = 0.11                     # ~12 km box


def main():
    os.makedirs(OUT, exist_ok=True)
    raw_path = os.path.join(OUT, "N57W136.hgt")
    if not os.path.exists(raw_path):
        print("downloading", URL)
        req = urllib.request.Request(URL, headers={"User-Agent": "thor-foundry/1.0"})
        with urllib.request.urlopen(req, timeout=120) as r, open(raw_path + ".gz", "wb") as f:
            f.write(r.read())
        with gzip.open(raw_path + ".gz", "rb") as g, open(raw_path, "wb") as f:
            f.write(g.read())
        os.remove(raw_path + ".gz")
    data = open(raw_path, "rb").read()
    vals = struct.unpack(">%dh" % (TILE * TILE), data)

    def elev(lat, lon):
        y = int((58.0 - lat) / 1.0 * (TILE - 1))
        x = int((lon + 136.0) / 1.0 * (TILE - 1))
        return vals[y * TILE + x]

    N = 256
    lo, hi = 32767, -32768
    grid = []
    for j in range(N):
        lat = LAT0 + SPAN * (j / (N - 1))
        row = []
        for i in range(N):
            lon = LON0 + SPAN * (i / (N - 1))
            e = elev(lat, lon)
            if e < -500 or e > 9000:
                e = 0
            row.append(e)
            lo = min(lo, e); hi = max(hi, e)
        grid.append(row)
    from PIL import Image
    img = Image.new("I;16", (N, N))
    px = img.load()
    for j in range(N):
        for i in range(N):
            v = int((grid[j][i] - lo) / max(1, (hi - lo)) * 65535)
            px[i, N - 1 - j] = v
    path = os.path.join(OUT, "sitka_height.png")
    img.save(path)
    meta = {"source": "SRTM via AWS terrain tiles (skadi N57W136)", "tile": "N57W136",
            "lat0": LAT0, "lon0": LON0, "span_deg": SPAN,
            "elev_min_m": lo, "elev_max_m": hi, "file": path}
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=2)
    print("DEM OK", meta)


if __name__ == "__main__":
    main()
