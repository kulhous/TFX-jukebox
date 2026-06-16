import fs from 'fs';
import MT32Module from './mt32emu.js';
import { parseMidi } from './midi.js';
const RATE=32000, CHUNK=128;
const ROM='/sessions/focused-great-mayer/mnt/TFX/mt32/legacy';
const M=await MT32Module();
const ctrl=fs.readFileSync(ROM+'/MT32_CONTROL.ROM'), pcm=fs.readFileSync(ROM+'/MT32_PCM.ROM');
let cp=M._malloc(ctrl.length);M.HEAPU8.set(ctrl,cp);let pp=M._malloc(pcm.length);M.HEAPU8.set(pcm,pp);
console.log('init sr=',M._mt32_init(cp,ctrl.length,pp,pcm.length));
const mid=new Uint8Array(fs.readFileSync('midis/tune_07_at031f51d_RLD_dec23300.mid'));
const P=parseMidi(mid);
console.log('events',P.events.length,'notes',P.notes.length,'dur',P.duration.toFixed(1));
const rp=M._malloc(CHUNK*4); let sxCap=0,sxp=0;
for(const e of P.events) if(e.type==='sysex') sxCap=Math.max(sxCap,e.sysex.length); sxp=M._malloc(sxCap);

function run(seconds, muteAll){
  // reset
  M._mt32_reset();
  let idx=0, pos=0; let peak=0, sum=0, cnt=0;
  const totalFrames=seconds*RATE;
  while(pos<totalFrames){
    const tReal=pos/RATE;
    while(idx<P.events.length && P.events[idx].tSec<=tReal){
      const e=P.events[idx++];
      if(e.type==='sysex'){ M.HEAPU8.set(e.sysex,sxp); M._mt32_play_sysex(sxp,e.sysex.length); }
      else { if(e.hi===0x90&&e.d2>0&&muteAll){} else M._mt32_play_msg(e.raw32); }
    }
    M._mt32_render(rp,CHUNK);
    const base=rp>>1;
    for(let i=0;i<CHUNK*2;i++){const v=M.HEAP16[base+i];peak=Math.max(peak,Math.abs(v));sum+=Math.abs(v);cnt++;}
    pos+=CHUNK;
  }
  return {peak, mean:(sum/cnt).toFixed(1), eventsFired:idx};
}
console.log('NORMAL 8s :', run(8,false));
console.log('MUTED  8s :', run(8,true));
