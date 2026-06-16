# TFX Jukebox 🎵✈️

A browser **"falling-notes" jukebox** for the soundtrack of **TFX — Tactical Fighter
Experiment** (DID / Ocean, 1993), synthesized live in your browser by emulated
**Roland MT-32** and **SC-55** hardware compiled to WebAssembly.

> **A tribute to one of the best game soundtracks ever made.**
> Music composed by **[Barry Leitch](https://barryleitch.bandcamp.com/album/tfx-tactical-fighter-experiment)**. All rights to the music belong to him.

The tunes were reverse-engineered and extracted straight from the original game data
(`TFX.DAT` / `START.EXE` track driver, RLD & SCC module formats) and converted to
Standard MIDI Files so they can be played back note-for-note on the same synth chips
the game used. Watch the notes fall, change the tempo, and solo/mute individual
channels in real time.

## ▶️ Run it

Because browsers block pages opened directly from disk (`file://`) from loading the
WASM engines, ROMs and MIDI files, you need a tiny local web server.

**macOS:** double-click **`start-player.command`**. It serves this folder and opens
the player in your browser. Keep the little terminal window open while you play.

**Any OS:** from inside this folder run

```sh
python3 -m http.server 8777
```

then open <http://localhost:8777/> (Chrome works best).

## 🎹 Synth ROMs are required (not included)

The Roland **MT-32** and **SC-55** ROM images are copyrighted by Roland and are
**not distributed here**. To enable audio, drop your own legally-obtained copies into
this folder:

| File                | Synth | Notes |
|---------------------|-------|-------|
| `MT32_CONTROL.ROM`  | MT-32 | Control ROM (v1.07) |
| `MT32_PCM.ROM`      | MT-32 | PCM ROM |
| `SC55_ROM1.bin`     | SC-55 | Program ROM 1 |
| `SC55_ROM2.bin`     | SC-55 | Program ROM 2 |
| `SC55_WAVE1.bin`    | SC-55 | Wave ROM 1 |
| `SC55_WAVE2.bin`    | SC-55 | Wave ROM 2 |
| `SC55_WAVE3.bin`    | SC-55 | Wave ROM 3 |

Without these the page loads but stays on the "initialising" overlay.

## 🎛️ Controls

- **Song dropdown** — pick a tune (RLD = MT-32 version, SCC = SC-55 version).
- **Play / Pause** — or press the spacebar.
- **⟲** — restart from the beginning.
- **Speed** — 0.25×–2× without changing pitch (re-times the MIDI; the synth still runs
  at its native rate).
- **Vol** — master volume.
- **Channel list** — every MIDI channel in use, each with **S** (solo) and **M** (mute).
- **Seek bar** — drag to jump anywhere; synth patch state is restored at the target.

## 📁 What's here

- `index.html` — the app (synth engines, scheduler, falling-notes canvas, controls).
- `midi.js` — Standard MIDI File parser.
- `mt32emu.js` / `mt32emu.wasm` — MT-32 emulator (libmt32emu / **munt**).
- `sc55.js` / `sc55.wasm` — SC-55 emulator (**Nuked-SC55**).
- `opl-player.js` / `opl3.js` / `opl3.wasm` — OPL3 (AdLib) emulator (**Nuked-OPL3**).
- `midis/` — the extracted TFX tunes as Standard MIDI Files.
- `songs.json` — the song list / labels shown in the dropdown.
- `tfxfont.ttf` / `tfxfont.woff` — the in-game pixel font.
- [`TRACK_NAMES.md`](TRACK_NAMES.md) — canonical track names and reverse-engineering notes.

## 🙏 Credits

- **Music:** Barry Leitch — buy the official album on
  [Bandcamp](https://barryleitch.bandcamp.com/album/tfx-tactical-fighter-experiment).
- **Game:** *TFX — Tactical Fighter Experiment*, Digital Image Design / Ocean, 1993.
- **Synth emulation:** [munt](https://github.com/munt/munt) (MT-32),
  [Nuked-SC55](https://github.com/nukeykt/Nuked-SC55),
  [Nuked-OPL3](https://github.com/nukeykt/Nuked-OPL3).

## ⚖️ Disclaimer

This is a non-commercial fan tribute. The TFX music and the TFX name are the property
of their respective owners; all rights to the music belong to **Barry Leitch**. No
copyrighted ROM images or game assets beyond the reverse-engineered MIDI note data are
distributed in this repository. If you are a rights holder and would like something
removed, please open an issue.
