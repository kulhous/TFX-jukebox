// Shared TFX web-player render engine (used by index.html and medit.html).
// Backends: MT-32 = Munt (mt32emu.js), SCC = Nuked-SC55 (sc55.js), ADL = Nuked-OPL3
// (opl3.js). Those wasm loaders must be loaded as classic <script> tags BEFORE
// this module so window.MT32Module / SC55Module / OPLModule globals exist.
// The UI sets Engine.onEnded to be notified when playback reaches the end.
import { parseMidi } from './midi.js';
import { parseDro } from './opl-player.js';

const CHUNK = 128;
const $ = id => document.getElementById(id);

// Mobile/low-power devices can't afford the 8-tap Lanczos resampler running
// per-sample on the main thread (it stutters). Detect them so the engine can
// fall back to cheap linear interpolation. Desktop keeps the hi-fi path.
const IS_MOBILE = (typeof navigator!=='undefined') && (
  /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent||'') ||
  (navigator.maxTouchPoints>1 && /Mac/.test(navigator.platform||'')) ||
  (typeof window!=='undefined' && window.matchMedia && window.matchMedia('(pointer:coarse)').matches)
);

// Optional self-contained build: roms.embedded.js (gitignored) sets window.__TFX_ROMS
// to a { filename: Uint8Array } map of the Roland ROMs so no separate ROM files are
// fetched. Absent in the public repo -> we fall back to fetching ROM files from disk.
await import('./roms.embedded.js').catch(()=>{});
const rdBin = async f => {
  const emb = (typeof window!=='undefined' && window.__TFX_ROMS) || null;
  if(emb && emb[f]) return emb[f];
  const r = await fetch(f);
  if(!r.ok) throw new Error('missing ROM/data file: '+f+' ('+r.status+')');
  return new Uint8Array(await r.arrayBuffer());
};

// ---------- Synth backends (MT-32 = Munt, SCC = Nuked-SC55) ----------
// Each backend exposes: rate, M(odule), renderPtr, ready, boot(), reset(),
// msg(raw32), sysex(uint8), render(frames) -> fills HEAP16 at renderPtr.
const MT32Backend = {
  key:'RLD', label:'MT-32', rate:32000, M:null, renderPtr:0, sysexPtr:0, sysexCap:0, ready:false,
  async boot(){
    if(this.ready) return;
    this.M = await MT32Module();
    // Roland CM-32L / LAPC-I ROMs: the MT-32's LA-synth superset, adding the
    // extra PCM sound-effect timbres. A strict superset of the MT-32, so MT-32-
    // targeted scores sound identical while CM-32L-aware ones gain the extras.
    const [ctrl,pcm] = await Promise.all([rdBin('CM32L_CONTROL.ROM'), rdBin('CM32L_PCM.ROM')]);
    const cp=this.M._malloc(ctrl.length); this.M.HEAPU8.set(ctrl,cp);
    const pp=this.M._malloc(pcm.length);  this.M.HEAPU8.set(pcm,pp);
    const sr=this.M._mt32_init(cp,ctrl.length,pp,pcm.length);
    this.M._free(cp); this.M._free(pp);
    if(sr!==this.rate && sr<=0) throw new Error('MT-32 init failed ('+sr+')');
    this.renderPtr = this.M._malloc(CHUNK*2*2);
    this.ready=true;
  },
  reset(){ this.M._mt32_reset(); },
  sysex(u8){
    if(u8.length>this.sysexCap){ if(this.sysexPtr) this.M._free(this.sysexPtr); this.sysexPtr=this.M._malloc(u8.length); this.sysexCap=u8.length; }
    this.M.HEAPU8.set(u8, this.sysexPtr); this.M._mt32_play_sysex(this.sysexPtr, u8.length);
  },
  msg(raw32){ this.M._mt32_play_msg(raw32); },
  render(frames){ this.M._mt32_render(this.renderPtr, frames); return this.M.HEAP16; },
};

const SC55Backend = {
  key:'SCC', label:'SC-55', rate:64000, M:null, renderPtr:0, ready:false, _f:null,
  async boot(){
    if(this.ready) return;
    this.M = await SC55Module();
    const f = {
      rom1:this.M.cwrap('sc55_set_rom1',null,['number','number']),
      rom2:this.M.cwrap('sc55_set_rom2',null,['number','number']),
      wave:this.M.cwrap('sc55_set_waverom',null,['number','number','number']),
      start:this.M.cwrap('sc55_start','number',['number']),
      gs:this.M.cwrap('sc55_reset_gs',null,[]),
      midi:this.M.cwrap('sc55_write_midi',null,['number']),
      render:this.M.cwrap('sc55_render','number',['number','number']),
    };
    this._f=f;
    const load=async(fn,file,...extra)=>{ const b=await rdBin(file); const p=this.M._malloc(b.length); this.M.HEAPU8.set(b,p); fn(...extra,p,b.length); this.M._free(p); };
    await load((p,l)=>f.rom1(p,l),'SC55_ROM1.bin');
    await load((p,l)=>f.rom2(p,l),'SC55_ROM2.bin');
    for(let i=1;i<=3;i++) await load((p,l)=>f.wave(i,p,l),'SC55_WAVE'+i+'.bin');
    f.start(0); // model 0 = SC-55 v1.21
    this.renderPtr = this.M._malloc(CHUNK*2*2);
    // run ~3s emulated boot self-test so the synth is ready (discard audio)
    const scratch=this.M._malloc(4096*2*2);
    for(let n=0;n<Math.ceil(this.rate*3/4096);n++) f.render(scratch,4096);
    this.M._free(scratch);
    f.gs();
    this.ready=true;
  },
  reset(){ this._f.gs(); },
  sysex(u8){ for(let i=0;i<u8.length;i++) this._f.midi(u8[i]); },
  msg(raw32){
    const st=raw32&0xff, hi=st&0xf0;
    this._f.midi(st); this._f.midi((raw32>>8)&0x7f);
    if(hi!==0xC0 && hi!==0xD0) this._f.midi((raw32>>16)&0x7f);
  },
  render(frames){ this._f.render(this.renderPtr, frames); return this.M.HEAP16; },
};

// AdLib / OPL3 (Nuked-OPL3). Driven by raw OPL register writes from .dro, not MIDI.
const OPLBackend = {
  key:'ADL', label:'AdLib', rate:49716, M:null, renderPtr:0, ready:false, _f:null,
  async boot(){
    if(this.ready) return;
    this.M = await OPL3Module();
    this._f = {
      init:this.M.cwrap('opl_init',null,['number']),
      reset:this.M.cwrap('opl_reset',null,[]),
      write:this.M.cwrap('opl_write',null,['number','number']),
      render:this.M.cwrap('opl_render',null,['number','number']),
    };
    this._f.init(this.rate);
    this.renderPtr = this.M._malloc(CHUNK*2*2);
    this.ready=true;
  },
  reset(){ this._f.reset(); },
  sysex(){},                         // OPL has no sysex
  msg(){},                           // not MIDI-driven
  oplWrite(reg,val){ this._f.write(reg&0x1ff, val&0xff); },
  oplCut(ch){ const bank=ch>8?0x100:0, n=ch%9; this._f.write(bank|(0xb0+n), 0); }, // clear key-on
  render(frames){ this._f.render(this.renderPtr, frames); return this.M.HEAP16; },
};

// SoundFont backend (spessasynth_core, pure-JS SF2/SF3 synth). Optional override
// for SCC/GM (General MIDI) songs: instead of the Roland SC-55 ROM emulator, render
// the same MIDI stream through the GeneralUser-GS.sf2 sound bank. The 32 MB bank and
// the synth bundle are both fetched lazily the first time SoundFont mode is used, so
// users who never enable it pay nothing. Unlike the wasm ROM backends this emits
// Float32 PCM directly (floatRender=true), so the engine skips the int16 conversion.
const SF2_URL = 'GeneralUser-GS.sf2';
const SoundFontBackend = {
  key:'SF2', label:'SoundFont', rate:48000, floatRender:true, ready:false,
  gain:0.6,   // SpessaSynth full-mix output can exceed unity; trim to avoid clipping after the volume stage
  syn:null, _L:null, _R:null, onProgress:null, _bootPromise:null,
  boot(){
    if(this.ready) return Promise.resolve();
    // The 32 MB bank takes seconds to download. Without this guard, every track
    // the user clicks during that window re-enters boot() (ready is still false)
    // and kicks off a duplicate download, leaving the synth half-built and songs
    // "unswitchable". Share one in-flight promise so concurrent callers wait for
    // the same load.
    if(this._bootPromise) return this._bootPromise;
    this._bootPromise = this._boot().catch(e=>{ this._bootPromise=null; throw e; });
    return this._bootPromise;
  },
  async _boot(){
    const core = await import('./spessasynth_core.min.js');
    const sf2 = await this._fetchBank(SF2_URL);            // Uint8Array, with progress
    const bank = core.SoundBankLoader.fromArrayBuffer(sf2.buffer);
    const synth = new core.SpessaSynthProcessor(this.rate, { enableEventSystem:false });
    synth.soundBankManager.addSoundBank(bank, 'main');
    if(synth.processorInitialized) await synth.processorInitialized;
    try{ synth.setSystemParameter && synth.setSystemParameter('autoAllocateVoices', true); }catch(e){}
    this.syn = synth;
    this._L = new Float32Array(CHUNK);
    this._R = new Float32Array(CHUNK);
    this.ready = true;
  },
  // Stream the bank with progress reporting (loaded/total bytes). Falls back to a
  // plain arrayBuffer() if the body isn't a readable stream.
  async _fetchBank(url){
    const r = await fetch(url);
    if(!r.ok) throw new Error('missing SoundFont: '+url+' ('+r.status+')');
    const total = +(r.headers.get('content-length')||0);
    if(this.onProgress) this.onProgress(0, total, false);
    if(!r.body || !r.body.getReader){
      const u8 = new Uint8Array(await r.arrayBuffer());
      if(this.onProgress) this.onProgress(u8.length, u8.length, true);
      return u8;
    }
    const reader = r.body.getReader(); const chunks=[]; let loaded=0;
    for(;;){
      const {done,value} = await reader.read();
      if(done) break;
      chunks.push(value); loaded += value.length;
      if(this.onProgress) this.onProgress(loaded, total, false);
    }
    const u8 = new Uint8Array(loaded); let off=0;
    for(const c of chunks){ u8.set(c, off); off += c.length; }
    if(this.onProgress) this.onProgress(loaded, total||loaded, true);
    return u8;
  },
  // Force-kill every sounding voice BEFORE the controller reset. syn.reset()
  // only RELEASES voices (graceful envelope), so on a stop/seek/track-change the
  // halted render loop freezes those release tails and they resume — bleeding the
  // previous track's notes into the next one. stopAllChannels(true) hard-stops them.
  reset(){ if(this.syn){ this.syn.stopAllChannels(true); this.syn.reset(); } },
  sysex(u8){ this.syn.systemExclusive(u8.subarray(1)); },   // drop leading 0xF0
  msg(raw32){
    const st=raw32&0xff, hi=st&0xf0, ch=st&0x0f, d1=(raw32>>8)&0x7f, d2=(raw32>>16)&0x7f;
    const s=this.syn;
    switch(hi){
      case 0x90: if(d2>0) s.noteOn(ch,d1,d2); else s.noteOff(ch,d1); break;
      case 0x80: s.noteOff(ch,d1); break;
      case 0xB0: s.controllerChange(ch,d1,d2); break;
      case 0xC0: s.programChange(ch,d1); break;
      case 0xE0: s.pitchWheel(ch, d1|(d2<<7)); break;
      case 0xD0: s.channelPressure(ch,d1); break;
      case 0xA0: s.polyPressure(ch,d1,d2); break;
    }
  },
  // floatRender path: fill the engine's per-chunk L/R Float32 buffers directly.
  renderFloat(frames, L, R){ this.syn.process(L, R, 0, frames); const g=this.gain; if(g!==1){ for(let i=0;i<frames;i++){ L[i]*=g; R[i]*=g; } } },
  // seekTo() calls render(CHUNK) to flush restored controller/patch state and
  // discards the result; process into scratch buffers so that path works too.
  render(frames){ this.syn.process(this._L, this._R, 0, frames); },
};

const BACKENDS = { RLD:MT32Backend, SCC:SC55Backend, ADL:OPLBackend, SF2:SoundFontBackend };

// channel colors: MONOCHROME phosphor display palette — 5 shades spanning the full
// dynamic range from near-black to near-white. With 16 channels the 5 shades repeat,
// so each GROUP of 5 channels gets a stripe orientation: ch 0-4 solid, 5-9 horizontal,
// 10-14 vertical, 15 diagonal. shade × orientation = every channel unique & legible.
// Default is the green CRT ramp (index/medit). Pages with a different monitor tint
// (e.g. inferno's red phosphor) call setChannelPalette() to re-tint the same arrays.
const CH_GREEN=['#10160c','#52613b','#8fa06f','#c2d0a4','#f4f9e6'];
let CH_SHADES=CH_GREEN;
const CH_ORDER=[0,4,1,3,2];
// per channel: base shade cycles within each group; orientation steps every 5 channels
const chDef=()=>Array.from({length:16},(_,i)=>({
  shade:CH_SHADES[CH_ORDER[i%CH_ORDER.length]], pat:Math.floor(i/5) }));
// contrasting stripe color (50% toward black for light shades, toward white for dark)
function chStripe(hex){
  const n=parseInt(hex.slice(1),16),r=n>>16,g=(n>>8)&255,b=n&255;
  const lum=0.299*r+0.587*g+0.114*b, t=lum>110?0:255, m=(c)=>Math.round(c+(t-c)*0.5);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}
// CSS swatch background for one channel (gradient stripes)
function buildSwatch(d){
  const s=chStripe(d.shade);
  if(d.pat===1) return `repeating-linear-gradient(0deg,${d.shade} 0 2px,${s} 2px 4px)`;
  if(d.pat===2) return `repeating-linear-gradient(90deg,${d.shade} 0 2px,${s} 2px 4px)`;
  if(d.pat===3) return `repeating-linear-gradient(45deg,${d.shade} 0 2px,${s} 2px 4px)`;
  return d.shade;
}
// 8×8 canvas tile for one channel (seamlessly tileable stripe pattern)
function buildTile(d){
  const c=document.createElement('canvas'); c.width=c.height=8; const g=c.getContext('2d');
  g.fillStyle=d.shade; g.fillRect(0,0,8,8);
  g.strokeStyle=chStripe(d.shade); g.lineWidth=1.6;
  if(d.pat===1){ for(let y=2;y<8;y+=4){ g.beginPath(); g.moveTo(0,y+0.5); g.lineTo(8,y+0.5); g.stroke(); } }
  else if(d.pat===2){ for(let x=2;x<8;x+=4){ g.beginPath(); g.moveTo(x+0.5,0); g.lineTo(x+0.5,8); g.stroke(); } }
  else if(d.pat===3){ for(let o=-8;o<8;o+=4){ g.beginPath(); g.moveTo(o,0); g.lineTo(o+8,8); g.stroke(); } }
  return c;
}
// Stable array references so importers keep working after a palette swap.
const CH_SWATCH=chDef().map(buildSwatch);
const CH_TILE=chDef().map(buildTile);
// Re-tint channel swatches + note tiles in place from a 5-shade ramp
// (dark -> light). Call before building the channel strip / drawing notes.
function setChannelPalette(shades){
  CH_SHADES=shades.slice();
  chDef().forEach((d,i)=>{ CH_SWATCH[i]=buildSwatch(d); CH_TILE[i]=buildTile(d); });
}

// Band-limited (Lanczos-4, 8-tap) polyphase resampler. Replaces 2-tap linear
// interpolation: proper anti-aliasing when downsampling (SC-55 64k->48k) and
// better HF retention when upsampling (MT-32 32k->48k). Linear phase, unity gain
// (per-phase weights are normalized so the output level is unchanged).
const INV15 = 1/32768;
function lanczos(x,a){ if(x===0) return 1; if(x<=-a||x>=a) return 0; const px=Math.PI*x; return a*Math.sin(px)*Math.sin(px/a)/(px*px); }
function buildPolyphase(ratio){
  const a=4, taps=8, P=512, s=ratio>1?ratio:1;   // s>1 widens the kernel (lowers cutoff) for downsampling
  const tbl=new Float32Array(P*taps);
  for(let p=0;p<P;p++){
    const f=p/P; let sum=0; const b=p*taps;
    for(let k=0;k<taps;k++){ const w=lanczos((f-(k-3))/s,a); tbl[b+k]=w; sum+=w; }
    const inv=sum?1/sum:0; for(let k=0;k<taps;k++) tbl[b+k]*=inv;
  }
  return tbl;
}

// ---------- Synth engine ----------
const Engine = {
  syn:null, rate:32000, ctx:null, node:null,
  onEnded:null,    // optional callback the UI sets; fired when playback reaches the end
  sf2Mode:false,   // when true, SCC/GM songs render via GeneralUser-GS.sf2 (SoundFontBackend)
  onSf2Progress:null, // optional (loaded,total,done) callback the UI sets for the SF2 download bar
  events:[], notes:[], duration:0, channels:[],
  eventIdx:0, synthPos:0,
  speed:1, vol:0.85, blend:0, reverb:0, playing:false, ended:false,
  ratio:1, frac:0, prevL:0,prevR:0,curL:0,curR:0,
  // hifi=true -> 8-tap Lanczos polyphase resampler. hifi=false -> cheap 2-tap
  // linear interpolation (fallback). Mobile uses the hi-fi path too now that the
  // real stutter cause (coarse latencyHint:'playback' clock) is fixed.
  hifi:true,
  // Lanczos polyphase resampler: ring of recent source frames + continuous read position.
  rsL:new Float32Array(16), rsR:new Float32Array(16), rsHead:0, rsPos:3, rsTbl:null, rsTblRatio:0,
  chunkL:new Float32Array(CHUNK),chunkR:new Float32Array(CHUNK),chunkIdx:CHUNK,chunkLen:CHUNK,
  mute:new Set(), solo:new Set(),
  anchored:false, anchorPlay:0, anchorSong:0, frozenSong:0,

  async boot(){ await this.useDevice('RLD'); },

  // Switch active synth (booting it on first use). Returns when ready.
  async useDevice(drv){
    // SoundFont mode: route SC-55 / General MIDI (SCC) songs through the
    // GeneralUser-GS.sf2 sound bank instead of the Roland ROM emulator. MT-32
    // (RLD) and AdLib (ADL) keep their native hardware emulation.
    if(this.sf2Mode && drv==='SCC') drv='SF2';
    const b = BACKENDS[drv] || BACKENDS.RLD;
    if(b===SoundFontBackend) b.onProgress = (l,t,done)=>{ this._sf2Bar(l,t,done); if(this.onSf2Progress) this.onSf2Progress(l,t,done); };
    await b.boot();
    this.syn = b; this.rate = b.rate;
    if(this.ctx) this.ratio = this.rate/this.ctx.sampleRate;
  },

  // Built-in SoundFont download progress bar. Created lazily and shared by every
  // page so they don't each have to build one. A page that wants a custom bar can
  // set Engine.onSf2Progress; this default overlay always runs alongside it.
  _sf2Bar(loaded, total, done){
    let el = this._sf2El;
    if(!el){
      el = this._sf2El = document.createElement('div');
      el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;'
        +'background:rgba(8,10,8,.94);color:#e8f0d8;border:1px solid #5a6b40;border-radius:8px;'
        +'padding:12px 16px;font:12px/1.4 system-ui,sans-serif;min-width:240px;box-shadow:0 6px 24px rgba(0,0,0,.5)';
      el.innerHTML = '<div style="margin-bottom:7px;letter-spacing:.04em">Loading SoundFont (GeneralUser-GS)…</div>'
        +'<div style="height:8px;background:#1c2415;border-radius:4px;overflow:hidden">'
        +'<div class="sf2fill" style="height:100%;width:0;background:linear-gradient(90deg,#8fa06f,#c2d0a4);transition:width .12s"></div></div>'
        +'<div class="sf2pct" style="margin-top:6px;text-align:right;opacity:.85">0%</div>';
      document.body.appendChild(el);
    }
    const pct = total ? Math.min(100, Math.round(loaded/total*100)) : 0;
    el.querySelector('.sf2fill').style.width = pct+'%';
    el.querySelector('.sf2pct').textContent = total ? (pct+'%  ('+(loaded/1048576).toFixed(1)+' / '+(total/1048576).toFixed(1)+' MB)') : (loaded/1048576).toFixed(1)+' MB';
    el.style.display = 'block';
    if(done){ const e2=el; setTimeout(()=>{ if(this._sf2El===e2) e2.style.display='none'; }, 600); }
  },

  ensureAudio(){
    if(this.ctx) return;
    const C = window.AudioContext||window.webkitAudioContext;
    // latencyHint:'playback' lets the UA choose larger, glitch-resistant buffers (ideal for a music player).
    // But on mobile those big hardware buffers make ctx.currentTime advance in coarse steps, which makes the
    // rAF-driven falling-notes clock (songTime() reads ctx.currentTime) stutter. Use 'interactive' on mobile
    // so the clock ticks finely and the roll animates smoothly.
    const hint = IS_MOBILE ? 'interactive' : 'playback';
    let ctx; try{ ctx=new C({sampleRate:48000,latencyHint:hint}); }catch(e){ try{ ctx=new C({latencyHint:hint}); }catch(e2){ ctx=new C(); } }
    this.ctx=ctx; this.ratio=this.rate/ctx.sampleRate;
    const node=ctx.createScriptProcessor(8192,0,2);
    node.onaudioprocess=e=>this.process(e);
    this.node=node;
    // Reverb send: the synth node splits into a dry path (always unity) and a wet
    // path through a ConvolverNode. The impulse response is synthesised in code
    // (exponentially-decaying stereo noise) so there's no asset to download. The
    // dry signal is never attenuated, so RVB=0 sounds identical to no reverb and
    // higher values pile reverb on top (post-style send).
    const dry=ctx.createGain(); dry.gain.value=1;
    const wet=ctx.createGain(); wet.gain.value=0;
    const conv=ctx.createConvolver();
    conv.buffer=this._makeIR(ctx);
    node.connect(dry); dry.connect(ctx.destination);
    node.connect(conv); conv.connect(wet); wet.connect(ctx.destination);
    this._dryGain=dry; this._wetGain=wet; this._conv=conv;
    this.setReverb(this.reverb);
  },

  // Build a ~2.2s exponentially-decaying stereo noise impulse response for the
  // convolution reverb. Slight L/R decorrelation gives the tail a bit of width.
  _makeIR(ctx){
    const sr=ctx.sampleRate, len=(sr*2.2)|0, ir=ctx.createBuffer(2,len,sr);
    for(let c=0;c<2;c++){
      const d=ir.getChannelData(c);
      for(let i=0;i<len;i++){
        const env=Math.pow(1-i/len, 2.5);   // smooth tail, ~exponential decay
        d[i]=(Math.random()*2-1)*env;
      }
    }
    return ir;
  },

  // RVB slider handler. pct is 0..100. Dry stays at unity; wet rises with pct so
  // the reverb is added on top. pct 100 -> wet ~0.7 (strong but not drowning).
  setReverb(pct){
    this.reverb=pct;
    if(this._wetGain) this._wetGain.gain.value = Math.max(0, pct/100) * 0.7;
  },

  loadSong(parsed){
    this.events=parsed.events; this.notes=parsed.notes;
    this.duration=parsed.durationSec; this.channels=parsed.channels;
    this.oplOwner=new Int16Array(18).fill(-1);   // OPL voice -> current source channel (CMAP-driven)
    this.seekTo(0,true);
  },

  effMuted(ch){ return this.solo.size ? !this.solo.has(ch) : this.mute.has(ch); },

  dispatch(ev, allowNoteOn=true){
    if(ev.type==='sysex'){ this.syn.sysex(ev.sysex); return; }
    if(ev.type==='opl'){
      let val=ev.val;
      if(ev.keyon){
        const oplc = ev.channel;                       // OPL voice slot 0..17
        const on = (val & 0x20) !== 0;
        if(on){
          // ev.src (from the DRO's CMAP) is the STABLE source MIDI channel that
          // owns this voice; without a map it falls back to the OPL slot index.
          const mc = (ev.src!=null) ? ev.src : oplc;
          if(this.oplOwner && oplc>=0) this.oplOwner[oplc]=mc;
          if(mc>=0 && this.effMuted(mc)) val &= ~0x20;  // suppress key-on for a muted source
        } else if(this.oplOwner && oplc>=0){
          this.oplOwner[oplc]=-1;
        }
      }
      this.syn.oplWrite(ev.reg, val);
      return;
    }
    if(ev.hi===0x90 && ev.d2>0){
      if(!allowNoteOn || this.effMuted(ev.channel)) return;
    }
    this.syn.msg(ev.raw32);
  },

  seekTo(T, full){
    this.syn.reset();
    this.eventIdx=0; this.ended=false;
    this.frac=0; this.chunkIdx=CHUNK; this.chunkLen=CHUNK; this.prevL=this.prevR=this.curL=this.curR=0;
    this.rsHead=0; this.rsPos=3; this.rsL.fill(0); this.rsR.fill(0);   // reset resampler ring/phase
    if(this.oplOwner) this.oplOwner.fill(-1);   // OPL voice ownership is rebuilt as events replay

    // 1) Replay every state-affecting message strictly BEFORE T to rebuild the
    //    synth's controller/patch state. Note-ons are suppressed (nothing is
    //    re-attacked here); events exactly at T are left for normal playback so
    //    the target's own programs/notes fire in their natural order.
    const prog=new Int16Array(16).fill(-1);
    while(this.eventIdx<this.events.length && this.events[this.eventIdx].tSec<T){
      const ev=this.events[this.eventIdx];
      this.dispatch(ev, false);
      if(ev.type==='chan' && ev.hi===0xC0) prog[ev.channel]=ev.d1;   // track active patch
      this.eventIdx++;
    }

    // 2) Re-assert each channel's most-recent program change so the correct
    //    timbre is guaranteed selected before any note sounds; otherwise a seek
    //    can land a note on a stale/default patch (wrong instrument). Then let
    //    the synth apply the restored patch/sysex state (output discarded).
    for(let ch=0;ch<16;ch++) if(prog[ch]>=0) this.syn.msg((0xC0|ch)|(prog[ch]<<8));
    this.syn.render(CHUNK);

    this.synthPos = Math.round((T/this.speed)*this.rate);
    this.curL=this.curR=0;
    this.anchored=false; this.frozenSong=T;

    // 3) Re-attack notes that should still be ringing at T so the seek target
    //    isn't silent until the next note-on. (msg() is a no-op for the OPL
    //    backend, which restores voices via its own register replay above.)
    if(T>0){
      for(const n of this.notes){
        if(n.startSec>=T) break;                 // notes are sorted by startSec
        if(n.endSec>T && !this.effMuted(n.channel))
          this.syn.msg((0x90|n.channel)|(n.pitch<<8)|((n.vel||96)<<16));
      }
    }
  },

  songTime(){
    if(!this.ctx || !this.playing || !this.anchored) return this.frozenSong;
    let t = this.anchorSong + (this.ctx.currentTime - this.anchorPlay)*this.speed;
    if(t<0) t=0; else if(t>this.duration) t=this.duration;
    this.frozenSong = t; return t;
  },
  cutChannel(ch){
    if(this.syn.oplCut){
      // OPL: `ch` is a source channel. Silence every OPL voice it currently owns
      // (CMAP playback); without a map, fall back to treating ch as the voice.
      if(this.oplOwner){
        let any=false;
        for(let o=0;o<18;o++) if(this.oplOwner[o]===ch){ this.syn.oplCut(o); this.oplOwner[o]=-1; any=true; }
        if(!any) this.syn.oplCut(ch);
      } else this.syn.oplCut(ch);
      return;
    }
    this.syn.msg(0xB0|ch|(120<<8)); this.syn.msg(0xB0|ch|(123<<8));
  },

  renderChunk(){
    const tReal=this.synthPos/this.rate;
    // Sample-accurate backends (OPL) need register writes applied at their true
    // sub-chunk sample position: a note-off and the following note-on can be <1
    // chunk apart, and if both are dispatched before rendering the whole chunk the
    // synth never "sees" the key-off->key-on edge and the re-attack is lost (rapid
    // repeated notes get dropped). So for OPL we render the chunk in slices split
    // at each event's time. MIDI synths (MT-32/SCC) sequence internally, so the
    // simple "dispatch all due events then render" path is fine for them.
    if(this.syn.oplWrite){
      const base=this.syn.renderPtr>>1, rate=this.rate, speed=this.speed, t0=this.synthPos;
      let done=0;
      let sameSample=-1;
      const sameSampleKeyOn=new Array(18).fill(null);
      const slice=(count)=>{
        if(count<=0) return;
        const h=this.syn.render(count);
        for(let i=0;i<count;i++){ this.chunkL[done+i]=h[base+i*2]*INV15; this.chunkR[done+i]=h[base+i*2+1]*INV15; }
        done+=count;
      };
      while(done<CHUNK){
        if(this.eventIdx<this.events.length){
          const evSample=Math.round((this.events[this.eventIdx].tSec/speed)*rate)-t0;
          if(evSample<=done){
            const ev=this.events[this.eventIdx];
            // Some AdLib jingles retrigger notes as key-off + key-on at the exact
            // same timestamp on the same channel. If both writes are dispatched
            // with no rendered sample between them, the re-attack can be lost.
            // Insert a 1-sample gap only for same-sample off->on transitions.
            if(evSample!==sameSample){
              sameSample=evSample;
              sameSampleKeyOn.fill(null);
            }
            const low=ev.reg&0xff;
            if(ev.type==='opl' && low>=0xb0 && low<=0xb8 && ev.channel>=0 && ev.channel<18){
              const newOn=(ev.val&0x20)!==0;
              const prevOn=sameSampleKeyOn[ev.channel];
              if(prevOn===false && newOn===true && done<CHUNK) slice(1);
              sameSampleKeyOn[ev.channel]=newOn;
            }
            this.dispatch(ev); this.eventIdx++; continue;
          }
          slice(Math.min(CHUNK,evSample)-done);
        } else { slice(CHUNK-done); }
      }
      this.chunkIdx=0;
      if(this.eventIdx>=this.events.length && tReal>this.duration/this.speed) this.ended=true;
      return;
    }
    while(this.eventIdx<this.events.length && (this.events[this.eventIdx].tSec/this.speed)<=tReal){
      this.dispatch(this.events[this.eventIdx]); this.eventIdx++;
    }
    if(this.syn.floatRender){
      // SoundFont backend emits Float32 PCM directly into our chunk buffers.
      this.syn.renderFloat(CHUNK, this.chunkL, this.chunkR);
      this.chunkIdx=0;
      if(this.eventIdx>=this.events.length && tReal>this.duration/this.speed) this.ended=true;
      return;
    }
    const h=this.syn.render(CHUNK);
    const base=this.syn.renderPtr>>1;
    for(let i=0;i<CHUNK;i++){ this.chunkL[i]=h[base+i*2]*INV15; this.chunkR[i]=h[base+i*2+1]*INV15; }
    this.chunkIdx=0;
    if(this.eventIdx>=this.events.length && tReal>this.duration/this.speed) this.ended=true;
  },
  nextFrame(){
    if(this.chunkIdx>=this.chunkLen) this.renderChunk();
    const L=this.chunkL[this.chunkIdx], R=this.chunkR[this.chunkIdx];
    this.chunkIdx++; this.synthPos++;
    return [L,R];
  },

  process(e){
    const outL=e.outputBuffer.getChannelData(0), outR=e.outputBuffer.getChannelData(1);
    const n=outL.length;
    if(!this.playing){ outL.fill(0); outR.fill(0); return; }
    this.anchorPlay = (e.playbackTime!=null) ? e.playbackTime : (this.ctx.currentTime + n/this.ctx.sampleRate);
    this.anchorSong = (this.synthPos/this.rate)*this.speed;
    this.anchored = true;
    const v=this.vol, ratio=this.ratio, blend=this.blend;
    if(this.hifi && this.rsTblRatio!==ratio){ this.rsTbl=buildPolyphase(ratio); this.rsTblRatio=ratio; }
    const tbl=this.rsTbl, rsL=this.rsL, rsR=this.rsR;
    if(this.hifi){
      for(let i=0;i<n;i++){
        // pull source frames until the 8-tap window around rsPos is available
        const need=(this.rsPos|0)+4;
        while(this.rsHead<=need){ const fr=this.nextFrame(); const m=this.rsHead&15; rsL[m]=fr[0]; rsR[m]=fr[1]; this.rsHead++; }
        const i0=this.rsPos|0, frac=this.rsPos-i0;
        const b=((frac*512)|0)*8, o=i0-3;
        let L=0,R=0;
        for(let k=0;k<8;k++){ const m=(o+k)&15, w=tbl[b+k]; L+=w*rsL[m]; R+=w*rsR[m]; }
        // stereo blend: fold L/R toward their mono mid (0=full stereo, 1=mono)
        if(blend>0){ const mid=(L+R)*0.5; L+=(mid-L)*blend; R+=(mid-R)*blend; }
        outL[i]=L*v;
        outR[i]=R*v;
        this.rsPos+=ratio;
      }
    } else {
      // Cheap 2-tap linear interpolation (mobile). ~4x less per-sample work than
      // the Lanczos path, which keeps low-power CPUs from underrunning the buffer.
      for(let i=0;i<n;i++){
        const i0=this.rsPos|0, need=i0+1;
        while(this.rsHead<=need){ const fr=this.nextFrame(); const m=this.rsHead&15; rsL[m]=fr[0]; rsR[m]=fr[1]; this.rsHead++; }
        const frac=this.rsPos-i0, a=i0&15, b2=(i0+1)&15;
        let L=rsL[a]+(rsL[b2]-rsL[a])*frac, R=rsR[a]+(rsR[b2]-rsR[a])*frac;
        if(blend>0){ const mid=(L+R)*0.5; L+=(mid-L)*blend; R+=(mid-R)*blend; }
        outL[i]=L*v;
        outR[i]=R*v;
        this.rsPos+=ratio;
      }
    }
    if(this.ended){ this.playing=false; if(this.onEnded) this.onEnded(); }
  },
};

export { CHUNK, $, rdBin, MT32Backend, SC55Backend, OPLBackend, SoundFontBackend, BACKENDS, Engine, parseMidi, parseDro, CH_SWATCH, CH_TILE, setChannelPalette };
