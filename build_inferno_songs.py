#!/usr/bin/env python3
"""Flatten the INFERNO entries of medit/medit_songs.json into a flat
inferno_songs.json the shared player-page.js controller can consume.

The MEdit catalog is nested (games -> compositions -> per-device renditions);
the shared controller expects a flat array of song rows, one per composition x
sound device. Re-run after the MEdit catalog changes.
"""
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
cat = json.loads((HERE / "medit" / "medit_songs.json").read_text())
comps = cat["games"].get("INFERNO", [])

rows = []
for comp in sorted(comps, key=lambda c: c["name"].lower()):
    for drv in ("RLD", "SCC", "ADL"):
        d = comp["devices"].get(drv)
        if not d:
            continue
        rows.append({
            "file": d["file"],          # e.g. INFERNO/9CU760U_RLD.mid (under medit/)
            "drv": drv,                 # RLD = MT-32, SCC = General MIDI (SC-55), ADL = AdLib
            "name": comp["name"],
            "notes": d.get("notes", 0),
        })

out = HERE / "inferno_songs.json"
out.write_text(json.dumps(rows, indent=0) + "\n")
print(f"wrote {out.name} \u2014 {len(rows)} rows from {len(comps)} compositions")
