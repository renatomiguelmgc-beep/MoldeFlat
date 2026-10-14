const fs = require("fs"); const sharp = require("sharp");
const s = fs.readFileSync(__dirname + "/vector_block.js", "utf8");
const block = s.slice(s.indexOf("/* VECTOR-BEGIN */"), s.indexOf("/* VECTOR-END */"));
const api = new Function("markerRealXY", block + "; return { vectorizePiece, expandLoop, vectorToDXF, vectorToSVG };")((m) => ({ x: m.x_mm, y: m.y_mm }));
const pxPerMm = 1.6, W = 1600, H = 2400, R = 3;
// verdade: contorno em ops, gera caminho SVG e pontos densos
const ops = []; // {t:'M'|'L'|'A', x,y, cx,cy}
const dense = [];
const line = (x0, y0, x1, y1) => { const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.25); for (let i = 0; i < n; i++) dense.push([x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]); };
const arc = (cx, cy, a0, a1) => { const n = 24; for (let i = 0; i < n; i++) { const a = a0 + (a1 - a0) * i / n; dense.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]); } };
let d = "M103 100";
const pi = Math.PI;
const L = (x, y, x0, y0) => { d += ` L${x} ${y}`; line(x0, y0, x, y); };
const A = (x, y, cx, cy, a0, a1, sw) => { d += ` A${R} ${R} 0 0 ${sw === 0 ? 0 : 1} ${x} ${y}`; arc(cx, cy, a0, a1); };
L(497, 100, 103, 100); A(500, 103, 497, 103, -pi / 2, 0);
L(500, 140, 500, 103); L(522, 140, 500, 140); A(522, 146, 522, 143, -pi / 2, pi / 2); L(500, 146, 522, 146);
L(500, 200, 500, 146); L(522, 200, 500, 200); A(522, 206, 522, 203, -pi / 2, pi / 2); L(500, 206, 522, 206);
L(500, 240, 500, 206); L(478, 240, 500, 240); A(475, 243, 478, 243, -pi / 2, -pi, 0); L(475, 245, 475, 243); A(478, 248, 478, 245, pi, pi / 2, 0); L(500, 248, 478, 248); L(500, 297, 500, 248); A(497, 300, 497, 297, 0, pi / 2);
L(103, 300, 497, 300); A(100, 297, 103, 297, pi / 2, pi);
L(100, 103, 100, 297); A(103, 100, 103, 103, pi, 1.5 * pi);
d += " Z";
const sc = pxPerMm;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><radialGradient id="g" cx="65%" cy="55%" r="55%"><stop offset="0" stop-color="#7a6a64"/><stop offset="1" stop-color="#1c1a1c"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/><g transform="translate(0.5 0.5) scale(${sc})"><path d="${d}" fill="#d8d6b8"/></g></svg>`;
(async () => {
  let buf = await sharp(Buffer.from(svg)).blur(1.1).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < buf.length; i += 4) { const n = (Math.random() + Math.random() + Math.random() - 1.5) * 12; for (let k = 0; k < 3; k++) buf[i + k] = Math.max(0, Math.min(255, buf[i + k] + n)); }
  const vec = api.vectorizePiece(buf, W, H, pxPerMm, { marker_size_mm: 100, markers: [] }, { noMask: true });
  if (vec.error) { console.log("ERRO", vec.error); return; }
  const l = vec.loops.find((x) => !x.hole);
  const arcs = l.pts.filter((p) => p.bulge);
  console.log(`nós: ${l.pts.length} | arcos: ${arcs.length}`);
  l.pts.forEach((p, i) => { if (p.bulge) { const q = l.pts[(i + 1) % l.pts.length]; const c = Math.hypot(q.x - p.x, q.y - p.y), th = 4 * Math.atan(p.bulge); console.log(`  arco em (${p.x.toFixed(1)},${p.y.toFixed(1)}): ângulo ${(th * 180 / pi).toFixed(0)}°, raio ${Math.abs(c / (2 * Math.sin(th / 2))).toFixed(2)} mm`); } });
  const ex = api.expandLoop(l.pts, 16).map((p) => [p.x, p.y]);
  const segDist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
  const dist = (p, poly) => { let m = 1e9; for (let i = 0; i < poly.length; i++) m = Math.min(m, segDist(p, poly[i], poly[(i + 1) % poly.length])); return m; };
  const e1 = ex.map((p) => dist(p, dense)), e2 = dense.filter((_, i) => i % 3 === 0).map((p) => dist(p, ex));
  const st = (a) => `média ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3)} mm, máx ${Math.max(...a).toFixed(3)} mm`;
  console.log("extraído→verdade:", st(e1)); console.log("verdade→extraído:", st(e2));
  fs.writeFileSync("test_arcs.dxf", api.vectorToDXF({ loops: [l], lines: [] }, H / pxPerMm)); fs.writeFileSync("test_arcs.svg", api.vectorToSVG({ loops: [l], lines: [] }, W / pxPerMm, H / pxPerMm));
})();
