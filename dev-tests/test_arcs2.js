const fs = require("fs"); const sharp = require("sharp");
const s = fs.readFileSync(__dirname + "/vector_block.js", "utf8");
const block = s.slice(s.indexOf("/* VECTOR-BEGIN */"), s.indexOf("/* VECTOR-END */"));
const api = new Function("markerRealXY", block + "; return { vectorizePiece, expandLoop, vectorToDXF };")((m) => ({ x: m.x_mm, y: m.y_mm }));
const pxPerMm = 1.6, W = 1600, H = 2400, pi = Math.PI;
const dense = []; let d = "M103 100";
const line = (x0, y0, x1, y1) => { const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.25); for (let i = 0; i < n; i++) dense.push([x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]); };
const L = (x, y, x0, y0) => { d += ` L${x} ${y}`; line(x0, y0, x, y); };
const A = (r, x, y, cx, cy, a0, a1, sw) => { d += ` A${r} ${r} 0 0 ${sw} ${x} ${y}`; for (let i = 0; i < 40; i++) { const a = a0 + (a1 - a0) * i / 40; dense.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
L(470, 100, 103, 100); A(10, 480, 110, 470, 110, -pi / 2, 0, 1);
L(480, 170, 480, 110); A(8, 488, 178, 488, 170, pi, pi / 2, 0);
L(520, 178, 488, 178); A(3, 523, 181, 520, 181, -pi / 2, 0, 1);
L(523, 297, 523, 181); A(3, 520, 300, 520, 297, 0, pi / 2, 1);
L(103, 300, 520, 300); A(3, 100, 297, 103, 297, pi / 2, pi, 1);
L(100, 103, 100, 297); A(3, 103, 100, 103, 103, pi, 1.5 * pi, 1);
d += " Z";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><radialGradient id="g" cx="65%" cy="55%" r="55%"><stop offset="0" stop-color="#7a6a64"/><stop offset="1" stop-color="#1c1a1c"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/><g transform="translate(0.5 0.5) scale(${pxPerMm})"><path d="${d}" fill="#d8d6b8"/></g></svg>`;
(async () => {
  let buf = await sharp(Buffer.from(svg)).blur(1.1).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < buf.length; i += 4) { const n = (Math.random() + Math.random() + Math.random() - 1.5) * 12; for (let k = 0; k < 3; k++) buf[i + k] = Math.max(0, Math.min(255, buf[i + k] + n)); }
  const vec = api.vectorizePiece(buf, W, H, pxPerMm, { marker_size_mm: 100, markers: [] }, { noMask: true });
  if (vec.error) { console.log("ERRO", vec.error); return; }
  const l = vec.loops.find((x) => !x.hole);
  console.log(`nós: ${l.pts.length} | arcos: ${l.pts.filter((p) => p.bulge).length}  (esperado 6: R10, R8 côncavo, 4x R3)`);
  l.pts.forEach((p, i) => { if (p.bulge) { const q = l.pts[(i + 1) % l.pts.length]; const c = Math.hypot(q.x - p.x, q.y - p.y), th = 4 * Math.atan(p.bulge); console.log(`  arco (${p.x.toFixed(0)},${p.y.toFixed(0)}): ${(th * 180 / pi).toFixed(0)}°, raio ${Math.abs(c / (2 * Math.sin(th / 2))).toFixed(2)} mm`); } });
  const ex = api.expandLoop(l.pts, 16).map((p) => [p.x, p.y]);
  const segDist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
  const dist = (p, poly) => { let m = 1e9; for (let i = 0; i < poly.length; i++) m = Math.min(m, segDist(p, poly[i], poly[(i + 1) % poly.length])); return m; };
  const e1 = ex.map((p) => dist(p, dense)), e2 = dense.filter((_, i) => i % 3 === 0).map((p) => dist(p, ex));
  const st = (a) => `média ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3)} mm, máx ${Math.max(...a).toFixed(3)} mm`;
  console.log("extraído→verdade:", st(e1)); console.log("verdade→extraído:", st(e2));
})();
