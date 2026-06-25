#!/usr/bin/env python3
"""Convert the standard mt32web game pages to the shared player-page.js controller.

Each standard page (index, ufo, tftd, wc2, df, ww, ea, lba, d2, dm2) carries a
~400-line inline `<script type="module">` that is a copy of the same UI logic with
a handful of game-specific bits. This script extracts those bits into a small GAME
config object and replaces the inline UI with a thin `initPlayer(GAME)` call that
imports the now-shared controller from player-page.js.

inferno.html / medit.html are intentionally skipped: they are the MEdit editor
variant (track renaming, per-game group headers, JSON export) and do not share the
simple controller.

Idempotent: a page already converted (no player-engine import in its module) is
left untouched. mt32web is a git repo, so `git checkout -- <page>` reverts.
"""
import re
import sys
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
STD_PAGES = ["index", "ufo", "tftd", "wc2", "df", "ww", "ea", "lba", "d2", "dm2"]


def extract_module(content):
    """Return (start, end, module_text) for the last <script type="module"> block."""
    start = content.rfind('<script type="module">')
    if start < 0:
        return None
    open_end = start + len('<script type="module">')
    close = content.index('</script>', open_end)
    return start, close + len('</script>'), content[open_end:close]


def grab(pattern, text, flags=re.DOTALL, group=1, required=True, label=""):
    m = re.search(pattern, text, flags)
    if not m:
        if required:
            raise ValueError(f"could not extract {label or pattern!r}")
        return None
    return m.group(group)


def build_config(mod):
    cfg = {}
    cfg["songsUrl"] = grab(r"fetch\('([\w.\-/]+\.json)'\)\.then\(r=>r\.json\(\)\)\)\.filter",
                           mod, label="songsUrl")

    # palette (optional — index/medit keep the default green ramp)
    pal = grab(r"setChannelPalette\((\[[^\]]+\])\)", mod, required=False, label="palette")
    cfg["palette"] = pal

    # canvas backdrop fill
    cfg["backdrop"] = grab(r"cx\.fillStyle='(#[0-9a-fA-F]+)';\s*cx\.fillRect\(0,0,W,H\)",
                           mod, label="backdrop")

    # device sort order (referenced by the page's sort comparator; may be unused)
    cfg["DRVORD"] = grab(r"const DRVORD=(\{[^}]+\})", mod, required=False, label="DRVORD") or "{}"

    # which song field is the filter/sort key (._filt or ._drv) — from the row dataset
    cfg["keyfield"] = grab(r"row\.dataset\.\w+=s\._(\w+)", mod, label="keyfield")

    # the page's exact sort comparator (kept verbatim so behaviour is identical)
    cfg["sort"] = grab(r"this\.songs\.sort\((.*?)\);", mod, label="sort").strip()

    # per-song prepare loop body (supports both `s=>{` and `(s,i)=>{`)
    body = grab(r"this\.songs\.forEach\((?:\(s,i\)|s)=>\{(.*?)\n\s*\}\);(?:.*?)this\.songs\.sort",
                mod, label="prepare body")
    cfg["prepareBody"] = body.strip("\n")

    # driver chip map (DCH) + its default key
    cfg["DCH"] = grab(r"const DCH=(\{.*?\});", mod, label="DCH")
    cfg["DCHdefault"] = grab(r"=DCH\[s\._\w+\]\|\|DCH\.(\w+);", mod, label="DCH default")

    # fetch path for the song bytes
    pref = re.search(r"fetch\('([^']+)'\+s\.file\)", mod)
    if pref:
        cfg["path"] = f"s => '{pref.group(1)}' + s.file"
    else:
        direxpr = grab(r"const dir\s*=\s*(.+?);\s*\n\s*const bytes=new Uint8Array\(await fetch\(dir\+s\.file\)",
                       mod, label="dir expr")
        cfg["path"] = f"s => ({direxpr.strip()}) + s.file"

    # status labels (st-drv / st-synth / st-src) — some pages omit st-src
    cfg["stDrv"] = grab(r"\$\('st-drv'\)\.textContent=(.*?);\s*\n", mod, required=False, label="st-drv")
    synth = grab(r"\$\('st-synth'\)\.textContent=(.*?);\s*\n", mod, required=False, label="st-synth")
    cfg["stSynth"] = synth.replace("Engine.sf2Mode", "sf2") if synth else None
    cfg["stSrc"] = grab(r"\$\('st-src'\)\.textContent=(.*?);\s*\n", mod, required=False, label="st-src")

    # media metadata
    cfg["mediaDev"] = grab(r"const dev=(\{.*?\})\[s\._\w+\]\|\|s\._\w+;", mod, label="media dev")
    cfg["album"] = grab(r"album:'([^']*)'", mod, label="album")
    return cfg


def render_module(cfg):
    pal = f"\n  palette: {cfg['palette']}," if cfg["palette"] else ""
    keyfield = cfg["keyfield"]
    statuslines = []
    if cfg["stDrv"]:
        statuslines.append(f"      drv: {cfg['stDrv']},")
    if cfg["stSynth"]:
        statuslines.append(f"      synth: {cfg['stSynth']},")
    if cfg["stSrc"]:
        statuslines.append(f"      src: {cfg['stSrc']},")
    status_body = "\n".join(statuslines)
    return f"""<script type="module">
import {{ initPlayer }} from './player-page.js';
const DRVORD = {cfg['DRVORD']};
initPlayer({{
  songsUrl: '{cfg['songsUrl']}',
  path: {cfg['path']},{pal}
  backdrop: '{cfg['backdrop']}',
  sort: {cfg['sort']},
  prepare(s, i){{
{cfg['prepareBody']}
    s._key = s._{keyfield};
  }},
  chip(s){{
    const DCH={cfg['DCH']};
    return DCH[s._key] || DCH.{cfg['DCHdefault']};
  }},
  status(s, sf2){{
    return {{
{status_body}
    }};
  }},
  media(s){{
    const dev={cfg['mediaDev']}[s._key]||s._key;
    return {{ title: s._name, artist: dev, album: '{cfg['album']}' }};
  }},
}});
</script>"""


def convert(stem, dry=False):
    path = HERE / f"{stem}.html"
    content = path.read_text(encoding="utf-8")
    found = extract_module(content)
    if not found:
        print(f"  {stem}: no module script found — skip")
        return
    start, end, mod = found
    if "player-page.js" in mod and "player-engine.js" not in mod:
        print(f"  {stem}: already converted — skip")
        return
    cfg = build_config(mod)
    new_mod = render_module(cfg)
    new_content = content[:start] + new_mod + content[end:]
    if dry:
        print(f"\n===== {stem} =====\n{new_mod}\n")
        return
    path.write_text(new_content, encoding="utf-8")
    print(f"  {stem}: converted ({end - start} -> {len(new_mod)} chars)")


if __name__ == "__main__":
    args = sys.argv[1:]
    dry = "--dry" in args
    pages = [a for a in args if not a.startswith("-")] or STD_PAGES
    for p in pages:
        convert(p, dry=dry)
