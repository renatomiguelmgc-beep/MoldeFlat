// Precisão do contorno vetorizado: imagem sintética "já corrigida" (1 px = 1/pxPerMm mm)
// com uma peça de geometria conhecida (polígono girado + furo circular + recorte),
// fundo escuro com reflexo largo e ruído, borrado como numa foto.
const fs = require("fs");
const sharp = require("sharp");
const src = fs.readFileSync(__dirname + "/vector_block.js", "utf8");
const block = src.slice(src.indexOf("/* VECTOR-BEGIN */"), src.indexOf("/* VECTOR-END */"));
const api = new Function("markerRealXY", block + "; return { vectorizePiece, vectorToDXF, vectorToSVG };")((m) => ({ x: m.x_mm, y: m.y_mm }));

const pxPerMm = 1.6;
const W = 1600, H = 2400; // ~1000 x 1500 mm
// peça: polígono (mm) com um recorte, girado ~12°
const base = [[0, 0], [750, 0], [750, 160], [440, 160], [440, 260], [750, 260], [750, 380], [0, 380]];
const ang = (12 * Math.PI) / 180, cx = 150, cy = 400;
const poly = base.map(([x, y]) => [cx + x * Math.cos(ang) - y * Math.sin(ang), cy + x * Math.sin(ang) + y * Math.cos(ang)]);
const holeC = (() => { const x = 120, y = 190; return [cx + x * Math.cos(ang) - y * Math.sin(ang), cy + x * Math.sin(ang) + y * Math.cos(ang)]; })();
const holeR = 35;
const px = (v) => (v * pxPerMm).toFixed(2);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs><radialGradient id="g" cx="65%" cy="55%" r="55%"><stop offset="0" stop-color="#7a6a64"/><stop offset="1" stop-color="#1c1a1c"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
<g transform="translate(0.5 0.5)"><path d="M${poly.map((p) => px(p[0]) + " " + px(p[1])).join(" L")} Z" fill="#d8d6b8"/>
<circle cx="${px(holeC[0])}" cy="${px(holeC[1])}" r="${px(holeR)}" fill="url(#g)"/></g>
</svg>`;

(async () => {
  let buf = await sharp(Buffer.from(svg)).blur(1.1).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < buf.length; i += 4) { const n = (Math.random() + Math.random() + Math.random() - 1.5) * 12; for (let k = 0; k < 3; k++) buf[i + k] = Math.max(0, Math.min(255, buf[i + k] + n)); }
  const t0 = Date.now();
  const vec = api.vectorizePiece(buf, W, H, pxPerMm, { marker_size_mm: 100, markers: [] }, { noMask: true });
  const ms = Date.now() - t0;
  if (vec.error) { console.log("ERRO", vec.error); return; }
  console.log(`${ms}ms | curvas: ${vec.loops.length} (furos: ${vec.loops.filter((l) => l.hole).length}) | pts: ${vec.loops.reduce((s, l) => s + l.pts.length, 0)} | limiar ${vec.threshold}`);

  const segDist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
  const distPoly = (p, pl) => Math.min(...pl.map((a, i) => segDist(p, a, pl[(i + 1) % pl.length])));
  const outer = vec.loops.find((l) => !l.hole), hole = vec.loops.find((l) => l.hole);
  // extraído -> verdade
  const eo = outer.pts.map((p) => distPoly([p.x, p.y], poly));
  const eh = hole ? hole.pts.map((p) => Math.abs(Math.hypot(p.x - holeC[0], p.y - holeC[1]) - holeR)) : [NaN];
  // verdade -> extraído (amostra a borda verdadeira)
  const samples = [];
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4); for (let k = 0; k < n; k++) samples.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]); }
  const ptsO = outer.pts.map((p) => [p.x, p.y]);
  const te = samples.map((s) => distPoly(s, ptsO));
  const st = (a) => `média ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3)} mm, máx ${Math.max(...a).toFixed(3)} mm`;
  console.log("contorno externo (extraído→verdade):", st(eo));
  console.log("contorno externo (verdade→extraído):", st(te));
  console.log("furo (raio):", st(eh));
  const trueW = Math.max(...poly.map((p) => p[0])) - Math.min(...poly.map((p) => p[0]));
  console.log(`bbox extraído ${vec.bbox.w.toFixed(2)} x ${vec.bbox.h.toFixed(2)} mm | verdadeiro ${trueW.toFixed(2)} x ${(Math.max(...poly.map((p) => p[1])) - Math.min(...poly.map((p) => p[1]))).toFixed(2)} mm`);
  const dxf = api.vectorToDXF(vec, H / pxPerMm); fs.writeFileSync("test_vec.dxf", dxf);
  fs.writeFileSync("test_vec.svg", api.vectorToSVG(vec, W / pxPerMm, H / pxPerMm));
  console.log("DXF bytes", dxf.length);
})();
