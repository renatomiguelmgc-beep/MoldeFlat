// Gera uma foto sintética (com perspectiva conhecida + desfoque/ruído/JPEG)
// do tapete "tapete_1000x1500_fita" pra testar o app.js de PRODUÇÃO de
// verdade no navegador (não o protótipo Node) — via upload do arquivo.
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { AR } = require("../web/lib/aruco.js");
const Ribbon = require("../web/lib/ribbon.js");

const SCRATCH = __dirname;

function computeHomography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < src.length; i++) {
    const { x, y } = src[i]; const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const n = 8;
  const AtA = Array.from({ length: n }, () => Array(n).fill(0));
  const Atb = Array(n).fill(0);
  for (let r = 0; r < A.length; r++) {
    for (let i = 0; i < n; i++) { Atb[i] += A[r][i] * b[r]; for (let j = 0; j < n; j++) AtA[i][j] += A[r][i] * A[r][j]; }
  }
  const h = solveLinear(AtA, Atb);
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}
function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (pivot !== col) { const t = M[col]; M[col] = M[pivot]; M[pivot] = t; }
    const pv = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= pv;
    for (let r = 0; r < n; r++) { if (r === col) continue; const f = M[r][col]; if (f === 0) continue; for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]; }
  }
  return M.map((row) => row[n]);
}
function invert3x3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  const det = a * A + b * B + c * C;
  const invDet = 1 / det;
  return [[A * invDet, D * invDet, G * invDet], [B * invDet, E * invDet, H * invDet], [C * invDet, F * invDet, I * invDet]];
}
function applyH(m, x, y) {
  const X = m[0][0] * x + m[0][1] * y + m[0][2];
  const Y = m[1][0] * x + m[1][1] * y + m[1][2];
  const W = m[2][0] * x + m[2][1] * y + m[2][2];
  return [X / W, Y / W];
}
function sampleBilinear(data, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const idx = (xx, yy) => (yy * w + xx) * 4;
  const out = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const v00 = data[idx(x0, y0) + k], v10 = data[idx(x1, y0) + k];
    const v01 = data[idx(x0, y1) + k], v11 = data[idx(x1, y1) + k];
    const top = v00 + (v10 - v00) * fx, bot = v01 + (v11 - v01) * fx;
    out[k] = top + (bot - top) * fy;
  }
  return out;
}

const profile = {
  width_mm: 1000, height_mm: 1500, margin_mm: 80, marker_size_mm: 100,
  markers: [
    { id: 0, x_mm: 80, y_mm: 80 }, { id: 1, x_mm: 920, y_mm: 80 },
    { id: 2, x_mm: 920, y_mm: 1420 }, { id: 3, x_mm: 80, y_mm: 1420 },
  ],
};
const seqBits = Ribbon.deBruijn(2, 8);
const ribbonCells = Ribbon.buildRibbonCells(profile, seqBits);
const dictionary = new AR.Dictionary("ARUCO_MIP_36h12");
function markerSvg(markerId, cx, cy, sizeMm) {
  const svg = dictionary.generateSVG(markerId);
  const native = parseFloat(svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) /)[1]);
  const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  return `<g transform="translate(${cx - sizeMm / 2} ${cy - sizeMm / 2}) scale(${sizeMm / native})">${inner}</g>`;
}
const moldWmm = 300, moldHmm = 900, moldX0 = 350, moldY0 = 300;
let ribbonSvg = "";
for (const c of ribbonCells) ribbonSvg += `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="${c.bit ? "#fff" : "#000"}"/>`;
let markersSvg = "";
for (const m of profile.markers) markersSvg += markerSvg(m.id, m.x_mm, m.y_mm, profile.marker_size_mm);
const flatSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${profile.width_mm}" height="${profile.height_mm}" viewBox="0 0 ${profile.width_mm} ${profile.height_mm}">
  <rect x="0" y="0" width="${profile.width_mm}" height="${profile.height_mm}" fill="#0a0a0a"/>
  ${ribbonSvg}${markersSvg}
  <path transform="translate(260 520)" d="M103 100 L497 100 A3 3 0 0 1 500 103 L500 140 L522 140 A3 3 0 0 1 522 146 L500 146 L500 200 L522 200 A3 3 0 0 1 522 206 L500 206 L500 297 A3 3 0 0 1 497 300 L103 300 A3 3 0 0 1 100 297 L100 103 A3 3 0 0 1 103 100 Z" fill="#d8d6b8"/>
</svg>`;
const PX_PER_MM_FLAT = 2;
const flatW = profile.width_mm * PX_PER_MM_FLAT, flatH = profile.height_mm * PX_PER_MM_FLAT;

(async () => {
  const flatPng = await sharp(Buffer.from(flatSvg)).resize(flatW, flatH).png().toBuffer();
  const photoW = 1600, photoH = 2000;
  const dstPersp = [{ x: 220, y: 120 }, { x: 1430, y: 260 }, { x: 1380, y: 1900 }, { x: 150, y: 1780 }];
  const srcPersp = [{ x: 0, y: 0 }, { x: flatW, y: 0 }, { x: flatW, y: flatH }, { x: 0, y: flatH }];
  const Hphoto = computeHomography(srcPersp, dstPersp);
  const HphotoInv = invert3x3(Hphoto);
  const { data: flatData } = await sharp(flatPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let photoBuf = Buffer.alloc(photoW * photoH * 4);
  for (let y = 0; y < photoH; y++) {
    for (let x = 0; x < photoW; x++) {
      const [sx, sy] = applyH(HphotoInv, x, y);
      const px = sampleBilinear(flatData, flatW, flatH, sx, sy);
      const o = (y * photoW + x) * 4;
      if (px) { photoBuf[o] = px[0]; photoBuf[o + 1] = px[1]; photoBuf[o + 2] = px[2]; photoBuf[o + 3] = 255; }
      else { photoBuf[o] = 50; photoBuf[o + 1] = 50; photoBuf[o + 2] = 55; photoBuf[o + 3] = 255; }
    }
  }
  let degradedBuf = await sharp(photoBuf, { raw: { width: photoW, height: photoH, channels: 4 } }).blur(1.2).raw().toBuffer();
  for (let i = 0; i < degradedBuf.length; i += 4) {
    const n = (Math.random() + Math.random() + Math.random() - 1.5) * 10;
    for (let k = 0; k < 3; k++) degradedBuf[i + k] = Math.max(0, Math.min(255, degradedBuf[i + k] + n));
  }
  const outPath = path.join(SCRATCH, "synthetic_arcs.jpg");
  await sharp(degradedBuf, { raw: { width: photoW, height: photoH, channels: 4 } }).jpeg({ quality: 80 }).toFile(outPath);

  // ground truth: onde ficam os 4 cantos do tapete (mm) e o retângulo do molde
  // na foto, pra depois medir o erro de posição pós-correção no navegador.
  fs.writeFileSync(path.join(SCRATCH, "synthetic_arcs_gt.json"), JSON.stringify({
    profile, moldX0, moldY0, moldWmm, moldHmm, photoW, photoH,
  }, null, 2));
  console.log("Foto sintética salva em:", outPath);
})().then(null, (e) => { console.error(e); process.exit(1); });
