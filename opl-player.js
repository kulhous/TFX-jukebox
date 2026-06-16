// DRO (DOSBox Raw OPL) parser + OPL note extractor for TFX AdLib tunes.
// Produces the SAME shape as parseMidi():
//   { durationSec, events[], notes[], channels[] }
//   events: { tSec, type:'opl', reg, val, channel, keyon? }   (sorted by time)
//   notes:  { channel, pitch, vel, startSec, endSec }
// Audio is driven by replaying the `opl` register writes through the OPL3 WASM;
// `notes` are derived from OPL key-on / F-number / block state for the piano roll.

const FSAMPLE = 49716; // OPL sample clock (3.579545 MHz / 72)

function fnumToMidi(fnum, block) {
  if (!fnum) return -1;
  const freq = fnum * FSAMPLE / Math.pow(2, 20 - block);
  if (freq <= 0) return -1;
  const m = Math.round(69 + 12 * Math.log2(freq / 440));
  return Math.max(0, Math.min(127, m));
}

// Parse a DRO file into a flat list of timed register writes.
// Returns { writes:[{ms,reg,val}], lengthMs }
function parseDroWrites(b) {
  const sig = String.fromCharCode(...b.slice(0, 8));
  if (sig !== 'DBRAWOPL') throw new Error('Not a DRO file');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const major = dv.getUint16(8, true);
  const writes = [];
  let ms = 0;

  if (major === 2) {
    // DRO v2.0
    const lengthPairs = dv.getUint32(12, true);
    const lengthMs = dv.getUint32(16, true);
    const shortDelay = b[23];
    const longDelay = b[24];
    const codemapLen = b[25];
    const codemap = b.slice(26, 26 + codemapLen);
    let p = 26 + codemapLen;
    for (let i = 0; i < lengthPairs && p + 1 < b.length; i++) {
      const code = b[p++], val = b[p++];
      if (code === shortDelay) { ms += val + 1; }
      else if (code === longDelay) { ms += (val + 1) << 8; }
      else {
        const high = code & 0x80;
        const idx = code & 0x7f;
        const reg = (codemap[idx] | (high ? 0x100 : 0)) >>> 0;
        writes.push({ ms, reg, val });
      }
    }
    return { writes, lengthMs: lengthMs || ms };
  }

  // DRO v1 (best-effort)
  const lengthMs = dv.getUint32(8, true);
  // hardware byte layout varies; data begins after the 24-byte header in most files
  let p = 24;
  let bank = 0;
  while (p < b.length) {
    const cmd = b[p++];
    if (cmd === 0x00) { ms += (b[p++] || 0) + 1; }
    else if (cmd === 0x01) { ms += dv.getUint16(p, true) + 1; p += 2; }
    else if (cmd === 0x02) { bank = 0; }
    else if (cmd === 0x03) { bank = 0x100; }
    else if (cmd === 0x04) { const reg = b[p++], val = b[p++]; writes.push({ ms, reg: (reg | bank) >>> 0, val }); }
    else { const val = b[p++]; writes.push({ ms, reg: (cmd | bank) >>> 0, val }); }
  }
  return { writes, lengthMs: lengthMs || ms };
}

// OPL channel that a channel-register (0xA0-0xB8 / 0xC0-0xC8) belongs to.
function regChannel(reg) {
  const low = reg & 0xff, bank = (reg & 0x100) ? 9 : 0;
  if (low >= 0xa0 && low <= 0xa8) return bank + (low - 0xa0);
  if (low >= 0xb0 && low <= 0xb8) return bank + (low - 0xb0);
  if (low >= 0xc0 && low <= 0xc8) return bank + (low - 0xc0);
  return -1;
}

const PERC = [ // rhythm-mode hits: bit, viz channel, fixed pitch
  { bit: 0x10, ch: 9, pitch: 36 },  // BD
  { bit: 0x08, ch: 10, pitch: 38 }, // SD
  { bit: 0x04, ch: 11, pitch: 43 }, // TT
  { bit: 0x02, ch: 12, pitch: 49 }, // CY
  { bit: 0x01, ch: 13, pitch: 42 }, // HH
];

export function parseDro(bytes) {
  const { writes, lengthMs } = parseDroWrites(bytes);

  const fnumLow = new Array(18).fill(0);
  const keyon = new Array(18).fill(false);
  const cur = new Array(18).fill(null);     // open melodic note per channel
  const percOn = {};                        // rhythm hits in progress
  let rhythm = false, bdState = 0;

  const events = [];
  const notes = [];
  const channels = new Set();

  for (const w of writes) {
    const tSec = w.ms / 1000;
    const low = w.reg & 0xff;
    let ev = { tSec, type: 'opl', reg: w.reg, val: w.val, channel: regChannel(w.reg) };

    if (low >= 0xa0 && low <= 0xa8) {
      fnumLow[ev.channel] = w.val;
    } else if (low >= 0xb0 && low <= 0xb8) {
      const ch = ev.channel;
      const newOn = (w.val & 0x20) !== 0;
      const block = (w.val >> 2) & 7;
      const fnum = ((w.val & 3) << 8) | fnumLow[ch];
      ev.keyon = true; // mark so mute can suppress
      if (newOn && !keyon[ch]) {
        const pitch = fnumToMidi(fnum, block);
        if (pitch >= 0) {
          const n = { channel: ch & 15, pitch, vel: 100, startSec: tSec, endSec: tSec + 0.3 };
          cur[ch] = n; channels.add(ch & 15);
        }
      } else if (!newOn && keyon[ch]) {
        if (cur[ch]) { cur[ch].endSec = tSec; notes.push(cur[ch]); cur[ch] = null; }
      }
      keyon[ch] = newOn;
    } else if (low === 0xbd) {
      // rhythm mode register
      const newRhythm = (w.val & 0x20) !== 0;
      for (const d of PERC) {
        const on = newRhythm && (w.val & d.bit);
        if (on && !percOn[d.bit]) {
          const n = { channel: d.ch, pitch: d.pitch, vel: 100, startSec: tSec, endSec: tSec + 0.18 };
          percOn[d.bit] = n; channels.add(d.ch);
        } else if (!on && percOn[d.bit]) {
          percOn[d.bit].endSec = tSec; notes.push(percOn[d.bit]); percOn[d.bit] = null;
        }
      }
      rhythm = newRhythm; bdState = w.val;
    }
    events.push(ev);
  }

  // close hanging notes
  let durationSec = Math.max(lengthMs / 1000, writes.length ? writes[writes.length - 1].ms / 1000 : 0);
  for (let ch = 0; ch < 18; ch++) if (cur[ch]) { cur[ch].endSec = durationSec; notes.push(cur[ch]); }
  for (const k in percOn) if (percOn[k]) { percOn[k].endSec = percOn[k].startSec + 0.18; notes.push(percOn[k]); }
  durationSec += 0.5;

  notes.sort((a, b) => a.startSec - b.startSec);
  return { durationSec, events, notes, channels: [...channels].sort((a, b) => a - b) };
}
