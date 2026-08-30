import { nativeImage } from "electron";
import type { NativeImage, WebContents } from "electron";

// Spec the painter draws. Icon = breathing DawnStar + optional running count;
// pill = completion toast (check/cross + name + suffix + optional +N + drain).
export type TraySpec =
  | { mode: "icon"; running: boolean; count: number; connected: boolean; scale: number; opacity: number }
  | { mode: "pill"; name: string; suffix: string; failed: boolean; remaining: number; drain: number; dark: boolean };

// Runs in the renderer (detached canvas — never attached to the DOM, zero page
// impact). Ports DawnStar geometry (8 rounded spokes r=11 in a 240-space + core
// ellipse r=20) and the pill layout from app/StatusBar/StatusItemController.swift.
// nativeImage can't rasterize SVG, so Canvas 2D → PNG data URL is the path.
const PAINT_FN = `function(spec){
  var DPR=2, H=22, hPad=6, gap=5;
  var cv=document.createElement('canvas'), ctx=cv.getContext('2d');
  function mono(px,w){return w+' '+px+'px ui-monospace, Menlo, monospace';}
  function rr(x,y,w,h,r){ctx.beginPath();ctx.roundRect(x,y,w,h,r);}
  function star(cx,cy,size,alpha){
    ctx.save();ctx.globalAlpha=alpha;ctx.fillStyle='#000';
    ctx.translate(cx,cy);var s=size/240;ctx.scale(s,s);
    for(var d=0;d<360;d+=45){ctx.save();ctx.rotate(d*Math.PI/180);ctx.beginPath();ctx.roundRect(-11,-96,22,84,11);ctx.fill();ctx.restore();}
    ctx.beginPath();ctx.ellipse(0,0,20,20,0,0,Math.PI*2);ctx.fill();ctx.restore();
  }
  function mark(x,y,size,failed,color){
    var s=size/16;ctx.strokeStyle=color;ctx.lineWidth=2;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();
    if(!failed){ctx.moveTo(x+3.4*s,y+8.5*s);ctx.lineTo(x+6.6*s,y+11.4*s);ctx.lineTo(x+12.6*s,y+4.8*s);}
    else{ctx.moveTo(x+5*s,y+5*s);ctx.lineTo(x+11*s,y+11*s);ctx.moveTo(x+11*s,y+5*s);ctx.lineTo(x+5*s,y+11*s);}
    ctx.stroke();
  }
  var width, nameW=0, sufW=0, badgeW=0;
  if(spec.mode==='icon'){
    var w=hPad, cw=0;
    if(spec.running&&spec.count>0){ctx.font=mono(11,'600');cw=Math.ceil(ctx.measureText(''+spec.count).width);w+=cw+gap;}
    w+=15+hPad; width=w;
  } else {
    ctx.font=mono(12,'600');nameW=Math.ceil(ctx.measureText(spec.name).width);
    ctx.font=mono(11.5,'400');sufW=Math.ceil(ctx.measureText(spec.suffix).width);
    var pw=hPad+14+gap+nameW+gap+sufW;
    if(spec.remaining>0){ctx.font=mono(10,'700');badgeW=Math.ceil(ctx.measureText('+'+spec.remaining).width)+10;pw+=gap+badgeW;}
    width=pw+hPad;
  }
  cv.width=Math.ceil(width*DPR);cv.height=Math.ceil(H*DPR);
  ctx.scale(DPR,DPR);ctx.textBaseline='middle';ctx.clearRect(0,0,width,H);
  if(spec.mode==='icon'){
    var x=hPad;
    if(spec.running&&spec.count>0){
      ctx.font=mono(11,'600');ctx.globalAlpha=spec.connected?0.7:0.4;ctx.fillStyle='#000';
      ctx.fillText(''+spec.count,x,H/2);x+=Math.ceil(ctx.measureText(''+spec.count).width)+gap;ctx.globalAlpha=1;
    }
    var op=spec.running?(spec.connected?spec.opacity:0.3):(spec.connected?0.6:0.3);
    star(x+15/2,H/2,15*spec.scale,op);
  } else {
    var tint=spec.dark?'rgba(255,255,255,0.92)':'rgba(0,0,0,0.86)';
    var sem=spec.failed?(spec.dark?'#d97670':'#cf222e'):(spec.dark?'#67c084':'#1a7f37');
    var x2=hPad;
    mark(x2,(H-14)/2,14,spec.failed,sem);x2+=14+gap;
    ctx.fillStyle=tint;ctx.font=mono(12,'600');ctx.globalAlpha=1;ctx.fillText(spec.name,x2,H/2);x2+=nameW+gap;
    ctx.font=mono(11.5,'400');ctx.globalAlpha=0.5;ctx.fillText(spec.suffix,x2,H/2);x2+=sufW;ctx.globalAlpha=1;
    if(spec.remaining>0){
      x2+=gap;ctx.fillStyle=spec.dark?'rgba(255,255,255,0.14)':'rgba(0,0,0,0.10)';rr(x2,(H-14)/2,badgeW,14,4);ctx.fill();
      ctx.fillStyle=tint;ctx.font=mono(10,'700');ctx.fillText('+'+spec.remaining,x2+5,H/2);x2+=badgeW;
    }
    ctx.fillStyle=sem;var full=width-hPad*2;rr(hPad,H-3,Math.max(0,full*spec.drain),1.5,0.75);ctx.fill();
  }
  return cv.toDataURL('image/png');
}`;

// Render one frame in the (always-alive, possibly hidden) main webContents and
// wrap it as a retina (2×) nativeImage. Icon frames are template images so macOS
// auto-tints them for the menu bar; the colored pill is not.
export async function renderTrayImage(wc: WebContents, spec: TraySpec): Promise<NativeImage | null> {
  try {
    const dataUrl = await wc.executeJavaScript(`(${PAINT_FN})(${JSON.stringify(spec)})`, true);
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) return null;
    const buf = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
    const img = nativeImage.createFromBuffer(buf, { scaleFactor: 2 });
    if (spec.mode === "icon") img.setTemplateImage(true);
    return img;
  } catch {
    return null;
  }
}
