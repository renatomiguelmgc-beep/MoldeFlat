// Fita De Bruijn ao redor da borda do tapete — geração da sequência e do
// layout geométrico das células. Usado tanto pelo gerador do tapete (Node)
// quanto pelo app (navegador), pra garantir que os dois calculam exatamente
// a mesma coisa a partir do mesmo perfil (sem precisar guardar a sequência
// inteira no mat-profiles.json — ela é sempre recalculada, é determinística).

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Ribbon = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Algoritmo clássico (FKM / Lyndon words) pra gerar de Bruijn B(k,n) —
  // sequência cíclica onde toda janela de n símbolos aparece exatamente 1 vez.
  function deBruijn(k, n) {
    const a = new Array(k * n).fill(0);
    const seq = [];
    function db(t, p) {
      if (t > n) {
        if (n % p === 0) for (let i = 1; i <= p; i++) seq.push(a[i]);
      } else {
        a[t] = a[t - p];
        db(t + 1, p);
        for (let j = a[t - p] + 1; j < k; j++) { a[t] = j; db(t + 1, t); }
      }
    }
    db(1, 1);
    return seq;
  }

  // Geometria: fita a 15mm de inset (entre a borda física e os marcadores
  // ArUco, que começam a 30mm), 20mm de largura, células de 25mm, parando
  // 20mm antes de cada quina (evita sobrepor a própria fita na virada).
  const RIBBON_INSET_MM = 15;
  const RIBBON_BAND_WIDTH_MM = 20;
  const RIBBON_CELL_LEN_MM = 25;
  const RIBBON_CORNER_GAP_MM = 20;
  const RIBBON_WINDOW_BITS = 8; // janela de unicidade pra localização confiante

  function buildRibbonCells(profile, sequenceBits) {
    const { width_mm: W, height_mm: H } = profile;
    const inset = RIBBON_INSET_MM, half = RIBBON_BAND_WIDTH_MM / 2;
    const cellLen = RIBBON_CELL_LEN_MM, cornerGap = RIBBON_CORNER_GAP_MM;

    const edges = [
      { len: W - 2 * cornerGap, cellRect: (i) => ({ x: cornerGap + i * cellLen, y: inset - half, w: cellLen, h: RIBBON_BAND_WIDTH_MM }) },
      { len: H - 2 * cornerGap, cellRect: (i) => ({ x: W - inset - half, y: cornerGap + i * cellLen, w: RIBBON_BAND_WIDTH_MM, h: cellLen }) },
      { len: W - 2 * cornerGap, cellRect: (i) => ({ x: W - cornerGap - (i + 1) * cellLen, y: H - inset - half, w: cellLen, h: RIBBON_BAND_WIDTH_MM }) },
      { len: H - 2 * cornerGap, cellRect: (i) => ({ x: inset - half, y: H - cornerGap - (i + 1) * cellLen, w: RIBBON_BAND_WIDTH_MM, h: cellLen }) },
    ];

    const cells = [];
    let bitIndex = 0;
    for (const edge of edges) {
      const n = Math.floor(edge.len / cellLen);
      for (let i = 0; i < n; i++) {
        const rect = edge.cellRect(i);
        const bit = sequenceBits[bitIndex % sequenceBits.length];
        cells.push({ bitIndex, bit, x: rect.x, y: rect.y, w: rect.w, h: rect.h, cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2 });
        bitIndex++;
      }
    }
    return cells;
  }

  // eixos locais de uma célula: u = ao longo da fita, v = atravessando (pra fora)
  function cellAxes(cell) {
    if (cell.w >= cell.h) return { u: { x: 1, y: 0 }, v: { x: 0, y: 1 } };
    return { u: { x: 0, y: 1 }, v: { x: 1, y: 0 } };
  }
  function outwardSign(cell, profile, axes) {
    if (axes.v.y === 1) return cell.cy < profile.height_mm / 2 ? -1 : 1;
    return cell.cx < profile.width_mm / 2 ? -1 : 1;
  }

  return {
    deBruijn, buildRibbonCells, cellAxes, outwardSign,
    RIBBON_INSET_MM, RIBBON_BAND_WIDTH_MM, RIBBON_CELL_LEN_MM, RIBBON_CORNER_GAP_MM, RIBBON_WINDOW_BITS,
  };
});
