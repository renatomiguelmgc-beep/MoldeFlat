const fs = require("fs"); const sharp = require("sharp");
const s = fs.readFileSync(__dirname + "/vector_block.js", "utf8");
const block = s.slice(s.indexOf("/* VECTOR-BEGIN */"), s.indexOf("/* VECTOR-END */"));
const api = new Function("markerRealXY", block + "; return { vectorizePiece, expandLoop, symFindAxes, symSymmetrizeOuter, symSymmetrizeHoles, vectorToDXF, vectorToSVG };")((m) => ({ x: m.x_mm, y: m.y_mm }));
const pxPerMm = 1.6, W = 1600, H = 2400, PI = Math.PI;
const rnd = (a, b) => a + Math.random() * (b - a);

// ---- design ideal simétrico (eixo x = 300) ----
const half = [];
const L = (x, y) => half.push({ x, y });
const arc = (cx, cy, r, a0, a1, n = 14) => { for (let i = 1; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; half.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); } };
const lineTo = (x1, y1) => { const p = half[half.length - 1]; const n = Math.ceil(Math.hypot(x1 - p.x, y1 - p.y) / 0.5); for (let i = 1; i <= n; i++) half.push({ x: p.x + ((x1 - p.x) * i) / n, y: p.y + ((y1 - p.y) * i) / n }); };
half.push({ x: 300, y: 115 }); lineTo(305, 115); lineTo(305, 100); lineTo(530, 100); lineTo(550, 120); lineTo(550, 257);
arc(547, 257, 3, 0, PI / 2); lineTo(406, 260); lineTo(406, 277); arc(403, 277, 3, 0, PI); lineTo(400, 260); lineTo(300, 260);
const refl = (p) => ({ x: 600 - p.x, y: p.y });
const ideal = half.concat(half.slice(1, -1).reverse().map(refl));
const holes = [{ x: 230, y: 190, r: 4 }, { x: 370, y: 190, r: 4 }];

// ---- "à mão": ondulação independente ao longo do contorno (normal), até ~1 mm ----
function handMade(poly, amp) {
  const n = poly.length, cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(poly[(i + 1) % n].x - poly[i].x, poly[(i + 1) % n].y - poly[i].y));
  const comps = [[1.0, 180], [0.7, 70], [0.5, 30]].map(([a, l]) => ({ a: a * amp, l, ph: rnd(0, 2 * PI) }));
  return poly.map((p, i) => {
    const a = poly[(i - 1 + n) % n], b = poly[(i + 1) % n];
    let tx = b.x - a.x, ty = b.y - a.y; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    let d = 0; for (const c of comps) d += c.a * Math.sin((2 * PI * cum[i]) / c.l + c.ph);
    return { x: p.x + ty * d, y: p.y - tx * d };
  });
}
const theta = (7 * PI) / 180, T = (p) => { const x = p.x - 300, y = p.y - 190; return { x: 300 + x * Math.cos(theta) - y * Math.sin(theta) + 400, y: 190 + x * Math.sin(theta) + y * Math.cos(theta) + 500 }; };

const segDist = (p, a, b) => { const dx = b.x - a.x, dy = b.y - a.y; const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); };
const distTo = (p, poly) => { let m = 1e9; for (let i = 0; i < poly.length; i++) m = Math.min(m, segDist(p, poly[i], poly[(i + 1) % poly.length])); return m; };
const stat = (arr) => `média ${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)} mm, máx ${Math.max(...arr).toFixed(2)} mm`;

(async () => {
  const amp = parseFloat(process.argv[2] || "1");
  const hand = handMade(ideal, amp);
  const idealT = ideal.map(T), handT = hand.map(T);
  const holeT = holes.map((h) => { const c = T({ x: h.x + rnd(-1, 1) * amp, y: h.y + rnd(-1, 1) * amp }); return { cx: c.x, cy: c.y, r: h.r + rnd(-0.3, 0.3) }; });
  const pathD = "M" + handT.map((p) => p.x.toFixed(2) + " " + p.y.toFixed(2)).join(" L") + " Z";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><radialGradient id="g" cx="65%" cy="55%" r="55%"><stop offset="0" stop-color="#6a5a54"/><stop offset="1" stop-color="#1c1a1c"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/><g transform="translate(0.5 0.5) scale(${pxPerMm})"><path d="${pathD}" fill="#d8d6b8"/>${holeT.map((h) => `<circle cx="${h.cx}" cy="${h.cy}" r="${h.r}" fill="#2a2523"/>`).join("")}</g></svg>`;
  let buf = await sharp(Buffer.from(svg)).blur(1.1).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < buf.length; i += 4) { const n = (Math.random() + Math.random() + Math.random() - 1.5) * 12; for (let k = 0; k < 3; k++) buf[i + k] = Math.max(0, Math.min(255, buf[i + k] + n)); }
  const vec = api.vectorizePiece(buf, W, H, pxPerMm, { marker_size_mm: 100, markers: [] }, { noMask: true });
  if (vec.error) { console.log("ERRO vetorização", vec.error); return; }
  const outer = vec.silhouette.find((l) => !l.circle && l.raw);
  const denseOrig = outer.raw;
  const t0 = Date.now();
  const axes = api.symFindAxes(denseOrig);
  const tAxis = Date.now() - t0;
  console.log(`eixos: ${axes.map((a) => a.angleDeg.toFixed(1) + "° (IoU " + (a.iou * 100).toFixed(1) + "%)").join(" | ")}  [${tAxis} ms]  esperado ~97°`);
  const ax = axes[0];
  const t1 = Date.now();
  const res = api.symSymmetrizeOuter(denseOrig, ax, {});
  console.log(`simetrização [${Date.now() - t1} ms]:`, res.error || `exata=${res.exact} nós=${res.pts.length} arcos=${res.pts.filter((p) => p.bulge).length}  assimetria original máx ${res.asymMaxMm.toFixed(2)} mm | correção máx ${res.maxShiftMm.toFixed(2)} mm, média ${res.meanShiftMm.toFixed(2)} mm`);
  if (res.error) return;
  const denseSym = api.expandLoop(res.pts, 16);
  // 1) simetria exata: distância do contorno final ao seu espelho
  const reflA = (p) => { const d = (p.x - ax.cx) * ax.nx + (p.y - ax.cy) * ax.ny; return { x: p.x - 2 * d * ax.nx, y: p.y - 2 * d * ax.ny }; };
  const mirrorPoly = denseSym.map(reflA);
  const symErr = denseSym.filter((_, i) => i % 3 === 0).map((p) => distTo(p, mirrorPoly));
  console.log("simetria do resultado (distância ao espelho):", stat(symErr));
  // 2) fidelidade ao design ideal (verdade): peça "à mão" vs resultado simetrizado
  const e1 = denseOrig.filter((_, i) => i % 3 === 0).map((p) => distTo(p, idealT));
  const e2 = denseSym.filter((_, i) => i % 3 === 0).map((p) => distTo(p, idealT));
  console.log("à mão    → design ideal:", stat(e1));
  console.log("simétrica → design ideal:", stat(e2));
  // 3) furos
  const hres = api.symSymmetrizeHoles(holeT, ax);
  console.log("furos simetrizados:", hres.circles.map((c) => `(${c.cx.toFixed(1)},${c.cy.toFixed(1)}) r${c.r.toFixed(2)}`).join("  "), "| sem par:", hres.unpaired);
  fs.writeFileSync("test_sym.dxf", api.vectorToDXF({ loops: [{ pts: res.pts, hole: false }], lines: [] }, H / pxPerMm));
})();
