// player-page.js — shared jukebox page controller for ALL game pages
// (index/TFX, inferno, ufo, tftd, wc2, df, ww, ea, lba, d2, dm2).
//
// The render Engine + synth backends live in player-engine.js. This module owns
// the page UI (track list, piano roll, channel strip, transport, media session,
// mobile/compact layout, scrollbar) which used to be copy-pasted into every
// <game>.html. Each page now only supplies a small GAME config describing its
// tracks, drivers, colour-derived bits, status labels and metadata — everything
// the pages genuinely differ by. Call initPlayer(GAME) once per page.
import { $, Engine, parseMidi, parseDro, CH_SWATCH, CH_TILE, setChannelPalette } from './player-engine.js';

const LOW = 21, HIGH = 108;            // A0..C8 — full piano
const WHITE = [0, 2, 4, 5, 7, 9, 11];
const isWhite = p => WHITE.includes(((p % 12) + 12) % 12);

export function initPlayer(GAME) {
  // --- config defaults (a minimal GAME only needs songsUrl, path, prepare,
  //     chip, status, media) ---
  GAME = Object.assign({
    backdrop: '#13180f',          // piano-roll canvas backdrop fill
    name: s => s._name,           // display name (track header + media title)
  }, GAME);
  if (GAME.palette) setChannelPalette(GAME.palette);

  const UI = {
    songs: [], cur: null, raf: 0, filter: 'ALL',

    async init() {
      this.songs = (await fetch(GAME.songsUrl).then(r => r.json())).filter(s => !s.hidden);
      this.songs.forEach((s, i) => GAME.prepare(s, i));   // sets s._drv,_key,_name (+ _tid/_ord/game extras)
      this.songs.sort(GAME.sort);
      const list = $('songlist');
      this.songs.forEach((s, i) => {
        const row = document.createElement('div'); row.className = 'song'; row.dataset.i = i; row.dataset.key = s._key;
        const [dc, dl, dtitle] = GAME.chip(s);
        row.innerHTML = `<span class="dchip ${dc}" title="${dtitle}">${dl}</span><span class="nm">${s._name}</span>`;
        row.onclick = () => this.pick(i);
        list.appendChild(row);
      });
      [...document.querySelectorAll('.fbtn')].forEach(b => b.onclick = () => {
        this.filter = b.dataset.f;
        document.querySelectorAll('.fbtn').forEach(x => x.classList.toggle('on', x === b));
        this.applyFilter();
      });
      this.applyFilter();
      document.querySelectorAll('.mtab[data-v]').forEach(b => b.onclick = () => this.setMobileView(b.dataset.v));
      const infoModal = $('infoModal');
      const setInfo = show => { infoModal.classList.toggle('show', show); document.querySelectorAll('#infoBtn,#minfo').forEach(b => b.classList.toggle('on', show)); if (show) infoModal.querySelector('.imodal-body').scrollTop = 0; };
      const toggleInfo = () => setInfo(!infoModal.classList.contains('show'));
      const closeInfo = () => setInfo(false);
      $('infoBtn').onclick = toggleInfo;
      $('minfo').onclick = toggleInfo;
      // LOW-PERF toggle: lighter linear resampling instead of 8-tap Lanczos for
      // slow devices. Persisted so the choice survives reloads.
      const lowPerf = localStorage.getItem('tfxLowPerf') === '1';
      const applyLowPerf = on => {
        Engine.hifi = !on; Engine.rsTblRatio = 0;   // force resampler table rebuild on next render
        document.querySelectorAll('#lpBtn,#mlp').forEach(b => b.classList.toggle('on', on));
      };
      applyLowPerf(lowPerf);
      const toggleLowPerf = () => { const on = Engine.hifi; applyLowPerf(on); localStorage.setItem('tfxLowPerf', on ? '1' : '0'); };
      $('lpBtn').onclick = toggleLowPerf;
      $('mlp').onclick = toggleLowPerf;
      // SOUNDFONT toggle: render the General MIDI version through GeneralUser-GS.sf2
      // instead of the Roland SC-55 ROM emulator. Bank fetched lazily on first use.
      const applySf2 = on => { Engine.sf2Mode = on; document.querySelectorAll('#sfBtn,#msf').forEach(b => b.classList.toggle('on', on)); };
      applySf2(localStorage.getItem('tfxSf2') === '1');
      const toggleSf2 = async () => { const on = !Engine.sf2Mode; applySf2(on); localStorage.setItem('tfxSf2', on ? '1' : '0'); if (this.cur != null) await this.pick(this.cur); };
      $('sfBtn').onclick = toggleSf2;
      $('msf').onclick = toggleSf2;
      $('play').onclick = () => this.toggle();
      $('restart').onclick = () => { Engine.seekTo(0); if (!Engine.playing) this.draw(); };
      // REPEAT / AUTOADVANCE: mutually exclusive; both persist across reloads.
      this.repeat = localStorage.getItem('tfxRepeat') === '1';
      this.autoAdv = localStorage.getItem('tfxAutoAdv') === '1';
      const paintLoop = () => {
        document.querySelectorAll('#repeatBtn,#mrepeat').forEach(b => b.classList.toggle('on', this.repeat));
        document.querySelectorAll('#autoBtn,#mauto').forEach(b => b.classList.toggle('on', this.autoAdv));
      };
      document.querySelectorAll('#repeatBtn,#mrepeat').forEach(b => b.onclick = () => {
        this.repeat = !this.repeat; if (this.repeat) this.autoAdv = false;
        localStorage.setItem('tfxRepeat', this.repeat ? '1' : '0'); localStorage.setItem('tfxAutoAdv', this.autoAdv ? '1' : '0'); paintLoop();
      });
      document.querySelectorAll('#autoBtn,#mauto').forEach(b => b.onclick = () => {
        this.autoAdv = !this.autoAdv; if (this.autoAdv) this.repeat = false;
        localStorage.setItem('tfxAutoAdv', this.autoAdv ? '1' : '0'); localStorage.setItem('tfxRepeat', this.repeat ? '1' : '0'); paintLoop();
      });
      paintLoop();
      $('clear').onclick = () => { Engine.mute.clear(); Engine.solo.clear(); this.refreshChannels(); };
      $('speed').oninput = e => { const t = Engine.songTime(); Engine.speed = +e.target.value; $('speedV').textContent = Math.round(+e.target.value * 100) + '%'; Engine.synthPos = Math.round((t / Engine.speed) * Engine.rate); Engine.frozenSong = t; Engine.anchored = false; };
      $('vol').oninput = e => { Engine.vol = +e.target.value; $('volV').textContent = Math.round(+e.target.value * 100) + '%'; };
      $('mix').oninput = e => { Engine.blend = +e.target.value; $('mixV').textContent = Math.round(+e.target.value * 100) + '%'; };
      $('rvb').oninput = e => { Engine.setReverb(+e.target.value); $('rvbV').textContent = Math.round(+e.target.value) + '%'; };
      $('seek').oninput = e => { const T = (+e.target.value / 1000) * Engine.duration; Engine.seekTo(T); $('seekfill').style.width = (+e.target.value / 10) + '%'; $('t-cur').textContent = this.fmt(T); if (!Engine.playing) this.draw(); };
      list.onscroll = () => this.syncScrollbar();
      window.addEventListener('keydown', e => {
        if ($('infoModal').classList.contains('show')) { if (e.code === 'Escape') closeInfo(); return; }
        if (e.code === 'Space') { e.preventDefault(); this.toggle(); }
      });
      this.canvas = $('roll'); this.cx = this.canvas.getContext('2d');
      new ResizeObserver(() => this.resize()).observe($('rollWrap')); this.resize();
      window.addEventListener('resize', () => { this.syncScrollbar(); this.tuneMarquee(); });
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.tuneMarquee());

      try { await Engine.boot(); } catch (err) { $('overlay').textContent = 'ENGINE ERROR: ' + err.message; $('status').textContent = 'ERROR'; return; }
      $('overlay').classList.add('hidden'); $('status').textContent = 'READY';
      ['play', 'restart', 'clear', 'seek'].forEach(id => $(id).disabled = false);
      // restore the song named in the URL hash (so a refresh keeps the same track)
      let startIdx = 0;
      const want = decodeURIComponent((location.hash || '').replace(/^#/, ''));
      if (want) { const j = this.songs.findIndex(s => s.file === want); if (j >= 0) startIdx = j; }
      window.addEventListener('hashchange', () => {
        const w = decodeURIComponent((location.hash || '').replace(/^#/, ''));
        const j = this.songs.findIndex(s => s.file === w);
        if (j >= 0 && j !== this.cur) this.pick(j);
      });
      this.setupMedia();
      Engine.onEnded = () => this.onEnded();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Engine.playing) this.requestWake(); });
      this.pick(startIdx);
      this.loop();
    },

    resize() {
      const wrap = $('rollWrap'); const cw = wrap.clientWidth, ch = wrap.clientHeight; const dpr = devicePixelRatio || 1;
      let nW = 0; for (let p = LOW; p <= HIGH; p++) if (isWhite(p)) nW++;
      const minKeyW = this.isMobile() ? 22 : 0;
      const fullW = Math.max(cw, nW * minKeyW);
      this.canvas.style.width = fullW + 'px'; this.canvas.style.height = ch + 'px';
      this.canvas.width = fullW * dpr; this.canvas.height = ch * dpr; this.W = fullW; this.H = ch; this.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.buildKeys(); this.syncScrollbar();
      if (this.isMobile() && this._lastFullW !== fullW) { this._lastFullW = fullW; this.centerRoll(); }
    },

    centerRoll() { const w = $('rollWrap'); if (w) w.scrollLeft = Math.max(0, (this.W - w.clientWidth) / 2); },

    buildKeys() {
      const whites = []; for (let p = LOW; p <= HIGH; p++) if (isWhite(p)) whites.push(p);
      const nW = whites.length, wW = this.W / nW; const wi = {};
      const lay = {};
      let k = 0; for (let p = LOW; p <= HIGH; p++) if (isWhite(p)) { wi[p] = k; lay[p] = { x: k * wW, w: wW, black: false, cx: k * wW + wW / 2 }; k++; }
      const bw = wW * 0.62;
      for (let p = LOW; p <= HIGH; p++) if (!isWhite(p)) { const c = (wi[p - 1] + 1) * wW; lay[p] = { x: c - bw / 2, w: bw, black: true, cx: c }; }
      this.keys = lay; this.whiteW = wW; this.blackW = bw;
    },

    applyFilter() {
      let n = 0;
      document.querySelectorAll('.song').forEach(r => {
        const show = this.filter === 'ALL' || r.dataset.key === this.filter;
        r.style.display = show ? '' : 'none'; if (show) n++;
      });
      $('trackcount').textContent = n;
      this.syncScrollbar();
    },

    async pick(i) {
      this.cur = i; const s = this.songs[i];
      history.replaceState(null, '', '#' + encodeURIComponent(s.file));
      $('status').textContent = 'LOADING';
      [...document.querySelectorAll('.song')].forEach(r => r.classList.toggle('sel', +r.dataset.i === i));
      const sel = document.querySelector('.song.sel'); if (sel) sel.scrollIntoView({ block: 'nearest' });
      Engine.playing = false; this.setPlayUI(false);
      await Engine.useDevice(s._drv);
      const bytes = new Uint8Array(await fetch(GAME.path(s)).then(r => r.arrayBuffer()));
      const parsed = s._drv === 'ADL' ? parseDro(bytes) : parseMidi(bytes);
      Engine.mute.clear(); Engine.solo.clear();
      Engine.loadSong(parsed);
      this.buildChannels(parsed);
      $('trackname').textContent = GAME.name(s); this.updateMediaMeta(s);
      const st = GAME.status(s, Engine.sf2Mode);
      const setTxt = (id, v) => { const e = $(id); if (e && v != null) e.textContent = v; };
      setTxt('st-drv', st.drv);
      setTxt('st-synth', st.synth);
      setTxt('st-src', st.src);     // some pages (e.g. TFX/index) drop the SOURCE field
      setTxt('st-notes', parsed.notes.length);
      setTxt('st-ch', parsed.channels.length);
      $('seek').value = 0;
      $('status').textContent = 'READY';
      this.tuneMarquee();
      if (this.isMobile()) this.setMobileView('notes');
      this.draw();
    },

    buildChannels(parsed) {
      const box = $('chans'); box.innerHTML = '';
      const noteCount = {}; parsed.notes.forEach(n => noteCount[n.channel] = (noteCount[n.channel] || 0) + 1);
      parsed.channels.forEach(ch => {
        const cell = document.createElement('div'); cell.className = 'ch'; cell.dataset.ch = ch;
        cell.style.setProperty('--swatch', CH_SWATCH[ch]);
        cell.title = `Channel ${ch + 1} — ${noteCount[ch] || 0} notes · tap/click mute · long-press or right-click solo`;
        cell.textContent = ch + 1;
        const doMute = () => { if (Engine.mute.has(ch)) { Engine.mute.delete(ch); } else { Engine.mute.add(ch); Engine.cutChannel(ch); } this.refreshChannels(); };
        const doSolo = () => { if (Engine.solo.has(ch)) { Engine.solo.delete(ch); } else { Engine.solo.add(ch); } for (const c of parsed.channels) if (Engine.effMuted(c)) Engine.cutChannel(c); this.refreshChannels(); };
        let timer = null, fired = false, moved = false, sx = 0, sy = 0;
        cell.addEventListener('pointerdown', e => {
          fired = false; moved = false; sx = e.clientX; sy = e.clientY;
          if (e.pointerType === 'mouse' && e.button !== 0) return;   // right-click solo handled by contextmenu
          clearTimeout(timer);
          timer = setTimeout(() => { fired = true; doSolo(); }, 450); // hold = solo
        });
        cell.addEventListener('pointermove', e => {
          if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) { moved = true; clearTimeout(timer); } // scrolling the strip
        });
        cell.addEventListener('pointerup', e => {
          clearTimeout(timer);
          if (fired || moved) return;                              // long-press or scroll: not a tap
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          doMute();                                                // tap/click = mute
        });
        cell.addEventListener('pointercancel', () => { clearTimeout(timer); });
        cell.oncontextmenu = e => { e.preventDefault(); if (!fired) doSolo(); }; // desktop right-click = solo
        box.appendChild(cell);
      });
      this.refreshChannels();
    },
    refreshChannels() {
      [...document.querySelectorAll('.ch')].forEach(cell => {
        const ch = +cell.dataset.ch;
        cell.classList.toggle('solo', Engine.solo.has(ch));
        cell.classList.toggle('muted', Engine.effMuted(ch) && !Engine.solo.has(ch));
      });
    },

    // Quantise the header marquee so it scrolls in whole TFX font-pixels.
    tuneMarquee() {
      const m = document.querySelector('.hmarquee'); if (!m) return;
      const cs = getComputedStyle(m);
      if (cs.animationName !== 'hmarq') { m.style.animationTimingFunction = ''; return; } // desktop: flows in flex, no marquee
      const fpx = Math.max(1, Math.round(parseFloat(cs.fontSize) * 0.2));
      const steps = Math.max(1, Math.round(m.scrollWidth / fpx));
      m.style.animationTimingFunction = 'steps(' + steps + ')';
    },

    syncScrollbar() {
      const l = $('songlist'), thumb = $('sbthumb'), sb = $('sb'); if (!sb) return;
      const trackH = sb.clientHeight; const ratio = l.clientHeight / l.scrollHeight;
      const th = Math.max(18, trackH * Math.min(1, ratio));
      thumb.style.height = th + 'px';
      const max = l.scrollHeight - l.clientHeight;
      thumb.style.top = (max > 0 ? (l.scrollTop / max) * (trackH - th) : 0) + 'px';
    },

    toggle() {
      if (Engine.ended) { Engine.seekTo(0); }
      Engine.ensureAudio(); if (Engine.ctx.state === 'suspended') Engine.ctx.resume();
      Engine.anchored = false; Engine.playing = !Engine.playing; this.setPlayUI(Engine.playing);
    },
    setPlayUI(p) {
      const b = $('play'); b.textContent = p ? 'PAUSE' : 'PLAY'; b.classList.toggle('on', p);
      [...document.querySelectorAll('.song')].forEach(r => r.classList.toggle('playing', p && +r.dataset.i === this.cur));
      if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = p ? 'playing' : 'paused'; } catch (e) { } }
      if (p) this.requestWake(); else this.releaseWake();
      this.updatePositionState();
    },
    onEnded() {
      if (this.repeat) { this.toggle(); return; }            // replay current song from the start
      if (this.autoAdv) { this.advance(1); return; }          // jump to the next visible song
      this.setPlayUI(false);
    },
    advance(dir) {
      const vis = this.visibleIdx(); if (!vis.length) { this.setPlayUI(false); return; }
      let k = vis.indexOf(this.cur); if (k < 0) k = 0;
      k = (k + dir + vis.length) % vis.length;
      Promise.resolve(this.pick(vis[k])).then(() => { if (!Engine.playing) this.toggle(); });
    },

    // ---- Media Session (lockscreen / Bluetooth / wired-headset transport) ----
    setupMedia() {
      if (!('mediaSession' in navigator)) return;
      const ms = navigator.mediaSession, set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch (e) { } };
      set('play', () => { if (!Engine.playing) this.toggle(); });
      set('pause', () => { if (Engine.playing) this.toggle(); });
      set('stop', () => { Engine.playing = false; Engine.seekTo(0); this.setPlayUI(false); this.draw(); });
      set('previoustrack', () => this.step(-1));
      set('nexttrack', () => this.step(1));
      set('seekbackward', d => { const t = Math.max(0, Engine.songTime() - ((d && d.seekOffset) || 10)); Engine.seekTo(t); if (!Engine.playing) this.draw(); });
      set('seekforward', d => { const t = Math.min(Engine.duration, Engine.songTime() + ((d && d.seekOffset) || 10)); Engine.seekTo(t); if (!Engine.playing) this.draw(); });
      set('seekto', d => { if (d && d.seekTime != null) { Engine.seekTo(d.seekTime); if (!Engine.playing) this.draw(); } });
    },
    visibleIdx() { return [...document.querySelectorAll('.song')].filter(r => r.style.display !== 'none').map(r => +r.dataset.i); },
    step(dir) {
      const vis = this.visibleIdx(); if (!vis.length) return;
      let k = vis.indexOf(this.cur); if (k < 0) k = 0;
      k = (k + dir + vis.length) % vis.length;
      const wasPlaying = Engine.playing;
      Promise.resolve(this.pick(vis[k])).then(() => { if (wasPlaying && !Engine.playing) this.toggle(); });
    },
    updateMediaMeta(s) {
      if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
      const m = GAME.media(s);
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: m.title, artist: m.artist, album: m.album }); } catch (e) { }
    },
    updatePositionState() {
      if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
      const dur = Engine.duration || 0; if (dur <= 0) return;
      let pos = Engine.songTime(); if (pos < 0) pos = 0; else if (pos > dur) pos = dur;
      try { navigator.mediaSession.setPositionState({ duration: dur, position: pos, playbackRate: Engine.speed || 1 }); } catch (e) { }
    },
    // ---- Screen Wake Lock: keep the phone awake while music is playing ----
    async requestWake() {
      if (!('wakeLock' in navigator) || this._wake || document.visibilityState !== 'visible') return;
      try { this._wake = await navigator.wakeLock.request('screen'); this._wake.addEventListener('release', () => { this._wake = null; }); } catch (e) { this._wake = null; }
    },
    releaseWake() { try { if (this._wake) this._wake.release(); } catch (e) { } this._wake = null; },

    isMobile() { return window.matchMedia('(max-width:720px)').matches; },
    setMobileView(v) {
      const tracks = v === 'tracks';
      document.body.classList.toggle('mtracks', tracks);
      document.body.classList.toggle('mnotes', !tracks);
      document.querySelectorAll('.mtab[data-v]').forEach(x => x.classList.toggle('on', x.dataset.v === v));
      this.resize();
    },

    fmt(s) { s = Math.max(0, s | 0); return (s / 60 | 0) + ':' + String(s % 60).padStart(2, '0'); },

    loop() {
      this.draw();
      const now = performance.now(); if (!this._posT || now - this._posT > 500) { this._posT = now; this.updatePositionState(); }
      this.raf = requestAnimationFrame(() => this.loop());
    },
    draw() {
      const cx = this.cx, W = this.W, H = this.H; if (!W || !this.keys) return;
      const kbH = Math.min(120, Math.max(78, H * 0.20)), hit = H - kbH, look = 3.0;
      if (hit <= 0) return;   // roll pane hidden/too short (e.g. mobile TRACKS view) — skip drawing
      cx.fillStyle = GAME.backdrop; cx.fillRect(0, 0, W, H);
      // radar arcs + grid backdrop
      cx.strokeStyle = 'rgba(115,129,90,.16)'; cx.lineWidth = 1;
      const cxn = W / 2, cyn = hit * 0.52, R = Math.min(W, hit) * 0.46;
      for (let k = 1; k <= 3; k++) { cx.beginPath(); cx.arc(cxn, cyn, R * k / 3, 0, Math.PI * 2); cx.stroke(); }
      cx.beginPath(); cx.moveTo(cxn, cyn - R); cx.lineTo(cxn, cyn + R); cx.moveTo(cxn - R, cyn); cx.lineTo(cxn + R, cyn); cx.stroke();
      // black-key lane shading
      for (let p = LOW; p <= HIGH; p++) if (!isWhite(p)) { const k = this.keys[p]; cx.fillStyle = 'rgba(0,0,0,.14)'; cx.fillRect(k.x, 0, k.w, hit); }
      // hit line
      cx.strokeStyle = 'rgba(233,239,206,.6)'; cx.lineWidth = 2; cx.beginPath(); cx.moveTo(0, hit); cx.lineTo(W, hit); cx.stroke();

      const now = Engine.songTime();
      const FADE = 0.5; const flashes = {}, held = {};
      // notes — whites first, blacks on top
      for (let pass = 0; pass < 2; pass++) {
        for (const nt of Engine.notes) {
          const k = this.keys[nt.pitch]; if (!k) continue;
          if ((pass === 0) === k.black) continue;
          if (nt.startSec > now + look) continue;
          const muted = Engine.effMuted(nt.channel);
          const age = now - nt.startSec;
          if (age >= 0 && age < FADE && !muted) { const f = 1 - age / FADE; if (!(flashes[nt.pitch] >= f)) flashes[nt.pitch] = f; }
          if (nt.startSec <= now && nt.endSec > now && !muted) held[nt.pitch] = true;   // key currently sounding
          if (nt.endSec < now - 0.05) continue;
          const yS = hit - ((nt.startSec - now) / look) * hit, yE = hit - ((nt.endSec - now) / look) * hit;
          const top = Math.min(yS, yE), h = Math.max(3, Math.abs(yE - yS));
          cx.globalAlpha = muted ? 0.13 : 1;
          if (!this._chPat) this._chPat = CH_TILE.map(t => cx.createPattern(t, 'repeat'));
          cx.fillStyle = this._chPat[nt.channel];
          this.rr(cx, k.x + 0.7, top, k.w - 1.4, h, 2); cx.fill();
          // light border so notes (incl. dark channel shades) stay legible on the dark roll
          cx.globalAlpha = muted ? 0.10 : 0.9; cx.strokeStyle = 'rgba(233,239,206,.85)'; cx.lineWidth = 1;
          this.rr(cx, k.x + 0.7 + 0.5, top + 0.5, k.w - 1.4 - 1, Math.max(2, h - 1), 2); cx.stroke();
        }
      }
      cx.globalAlpha = 1;
      // keyboard: white keys, then black keys on top
      cx.fillStyle = '#0e120a'; cx.fillRect(0, hit, W, kbH);
      for (let p = LOW; p <= HIGH; p++) if (isWhite(p)) {
        const k = this.keys[p];
        const f = flashes[p] || 0;
        const sus = held[p] ? [233, 239, 206] : [206, 212, 184];
        const fl = [253, 231, 120];
        const r = sus[0] + (fl[0] - sus[0]) * f, g = sus[1] + (fl[1] - sus[1]) * f, b = sus[2] + (fl[2] - sus[2]) * f;
        cx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
        cx.fillRect(k.x + 0.5, hit + 1, k.w - 1, kbH - 2);
        cx.strokeStyle = '#3a3f30'; cx.lineWidth = 1; cx.strokeRect(k.x + 0.5, hit + 1, k.w - 1, kbH - 2);
      }
      const bkH = kbH * 0.62;
      for (let p = LOW; p <= HIGH; p++) if (!isWhite(p)) {
        const k = this.keys[p];
        const f = flashes[p] || 0;
        const sus = held[p] ? [70, 80, 55] : [28, 32, 22];
        const fl = [160, 200, 110];
        const r = sus[0] + (fl[0] - sus[0]) * f, g = sus[1] + (fl[1] - sus[1]) * f, b = sus[2] + (fl[2] - sus[2]) * f;
        cx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
        cx.fillRect(k.x, hit, k.w, bkH);
        cx.strokeStyle = '#000'; cx.strokeRect(k.x + 0.5, hit + 0.5, k.w - 1, bkH);
      }
      // readout — left shows current time, right shows total only (no duplicate)
      $('time').textContent = this.fmt(Engine.duration);
      $('t-cur').textContent = this.fmt(now);
      const pct = Math.min(100, (now / Engine.duration) * 100 || 0);
      $('seekfill').style.width = pct + '%';
      if (document.activeElement !== $('seek')) $('seek').value = Math.min(1000, (now / Engine.duration) * 1000 || 0);
    },
    rr(cx, x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2); if (r < 0) r = 0; cx.beginPath();
      cx.moveTo(x + r, y); cx.arcTo(x + w, y, x + w, y + h, r); cx.arcTo(x + w, y + h, x, y + h, r);
      cx.arcTo(x, y + h, x, y, r); cx.arcTo(x, y, x + w, y, r); cx.closePath();
    },
  };

  UI.init();
  return UI;
}
