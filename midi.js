// Minimal Standard MIDI File parser (format 0/1).
// Produces: { division, durationSec, events[], notes[], channels[] }
//  events: {tSec, status, d1, d2, channel, type, sysex?}  (sorted by tick)
//  notes:  {channel, pitch, vel, startSec, endSec}
// tSec is at 1x speed (real seconds via tempo map).

export function parseMidi(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const u32 = () => { const v = dv.getUint32(p); p += 4; return v; };
  const u16 = () => { const v = dv.getUint16(p); p += 2; return v; };
  const u8  = () => bytes[p++];

  if (u32() !== 0x4d546864) throw new Error('Not a MIDI file (no MThd)');
  u32(); // header length
  u16(); // format
  const ntrk = u16();
  const division = u16(); // assume ticks-per-quarter (TPQN), top bit 0

  // Collect raw events per track with absolute ticks
  const raw = []; // {tick, status, d1, d2, channel, type, sysex, tempo}
  for (let t = 0; t < ntrk; t++) {
    if (u32() !== 0x4d54726b) throw new Error('Bad track chunk');
    const len = u32();
    const end = p + len;
    let tick = 0, running = 0;
    while (p < end) {
      // variable-length delta
      let delta = 0, b;
      do { b = u8(); delta = (delta << 7) | (b & 0x7f); } while (b & 0x80);
      tick += delta;
      let status = bytes[p];
      if (status & 0x80) { p++; running = status; } else { status = running; }
      const hi = status & 0xf0, ch = status & 0x0f;
      if (status === 0xff) {            // meta
        const type = u8();
        let l = 0, bb; do { bb = u8(); l = (l << 7) | (bb & 0x7f); } while (bb & 0x80);
        if (type === 0x51 && l === 3) { // tempo
          const tempo = (bytes[p] << 16) | (bytes[p+1] << 8) | bytes[p+2];
          raw.push({ tick, type: 'tempo', tempo });
        }
        p += l;
      } else if (status === 0xf0 || status === 0xf7) { // sysex
        let l = 0, bb; do { bb = u8(); l = (l << 7) | (bb & 0x7f); } while (bb & 0x80);
        const sx = new Uint8Array(l + 1);
        sx[0] = 0xf0;
        for (let i = 0; i < l; i++) sx[i + 1] = bytes[p + i];
        p += l;
        raw.push({ tick, type: 'sysex', sysex: sx });
      } else {
        let d1 = 0, d2 = 0;
        if (hi === 0xc0 || hi === 0xd0) { d1 = u8(); }
        else { d1 = u8(); d2 = u8(); }
        raw.push({ tick, type: 'chan', status, hi, channel: ch, d1, d2 });
      }
    }
    p = end;
  }

  // Sort by tick (stable)
  raw.forEach((e, i) => e._i = i);
  raw.sort((a, b) => a.tick - b.tick || a._i - b._i);

  // Build tempo map -> seconds
  let curTick = 0, curSec = 0, usPerQuarter = 500000;
  const tickToSec = (tick) => curSec + ((tick - curTick) / division) * (usPerQuarter / 1e6);

  const events = [];
  const notes = [];
  const open = {}; // key ch*128+pitch -> note
  const channels = new Set();

  for (const e of raw) {
    const tSec = tickToSec(e.tick);
    if (e.type === 'tempo') {
      curSec = tSec; curTick = e.tick; usPerQuarter = e.tempo; continue;
    }
    if (e.type === 'sysex') {
      events.push({ tSec, type: 'sysex', sysex: e.sysex });
      continue;
    }
    // channel event
    channels.add(e.channel);
    const raw32 = e.status | (e.d1 << 8) | (e.d2 << 16);
    events.push({ tSec, type: 'chan', status: e.status, hi: e.hi, channel: e.channel, d1: e.d1, d2: e.d2, raw32 });
    if (e.hi === 0x90 && e.d2 > 0) {
      const k = e.channel * 128 + e.d1;
      // These tunes are note-on-only (no note-offs); a retrigger of the same
      // pitch ends the previous note. Clamp ring-out so bars don't run forever.
      const prev = open[k];
      if (prev) { prev.endSec = Math.min(tSec, prev.startSec + 1.0); notes.push(prev); }
      open[k] = { channel: e.channel, pitch: e.d1, vel: e.d2, startSec: tSec, endSec: tSec + 0.3 };
    } else if (e.hi === 0x80 || (e.hi === 0x90 && e.d2 === 0)) {
      const k = e.channel * 128 + e.d1, n = open[k];
      if (n) { n.endSec = tSec; notes.push(n); delete open[k]; }
    }
  }
  // close hanging notes
  let durationSec = 0;
  for (const e of events) durationSec = Math.max(durationSec, e.tSec);
  for (const k in open) { const n = open[k]; n.endSec = n.startSec + 0.3; notes.push(n); }
  durationSec += 1.0;

  events.sort((a, b) => a.tSec - b.tSec);
  notes.sort((a, b) => a.startSec - b.startSec);
  return { division, durationSec, events, notes, channels: [...channels].sort((a, b) => a - b) };
}
