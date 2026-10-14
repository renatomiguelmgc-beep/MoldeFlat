const fs=require('fs'); const sharp=require('sharp');
const s=fs.readFileSync(__dirname+'/vector_block.js','utf8'); const block=s.slice(s.indexOf('/* VECTOR-BEGIN */'),s.indexOf('/* VECTOR-END */'));
const api=new Function('markerRealXY',block+';return {vectorizePiece};')((m)=>({x:m.x_mm,y:m.y_mm}));
(async()=>{
  // retângulo simples 300x880mm, borrado + ruído + JPEG-like, em 1.6px/mm
  const pxPerMm=1.6, W=1600,H=2400;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#161616"/><g transform="translate(0.5 0.5)"><rect x="${300*pxPerMm}" y="${300*pxPerMm}" width="${300*pxPerMm}" height="${880*pxPerMm}" fill="#d8d6b8"/></g></svg>`;
  let buf=await sharp(Buffer.from(svg)).blur(1.2).ensureAlpha().raw().toBuffer();
  for(let i=0;i<buf.length;i+=4){const n=(Math.random()+Math.random()+Math.random()-1.5)*14;for(let k=0;k<3;k++)buf[i+k]=Math.max(0,Math.min(255,buf[i+k]+n));}
  const vec=api.vectorizePiece(buf,W,H,pxPerMm,{marker_size_mm:100,markers:[]},{noMask:true});
  console.log('retângulo: nós =',vec.loops[0].pts.length,'| bbox',vec.bbox.w.toFixed(2),'x',vec.bbox.h.toFixed(2),'(esperado 300 x 880)');
})();
