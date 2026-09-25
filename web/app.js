"use strict";

/* ------------------------------------------------------------------ *
 * Configuração / estado
 * ------------------------------------------------------------------ */

const DETECT_MAX_SIDE = 1400;   // downscale para detecção dos marcadores (velocidade)
const OUTPUT_TARGET_LONG = 2400; // lado maior da imagem retificada final (qualidade x tamanho de arquivo)
const LEGEND_HEIGHT_MM = 25;     // faixa extra no rodapé da imagem final para a régua de escala
const MIN_MARKERS_REQUIRED = 4;  // mínimo de marcadores visíveis para calibrar (homografia por mínimos quadrados)

let matConfig = null;      // conteúdo de mat-profiles.json
let currentProfile = null; // perfil selecionado
let mediaStream = null;    // stream da câmera aberta

const el = (id) => document.getElementById(id);

const profileSelect = el("profileSelect");
const profileInfo = el("profileInfo");
const btnOpenCamera = el("btnOpenCamera");
const btnStopCamera = el("btnStopCamera");
const btnShot = el("btnShot");
const fileInput = el("fileInput");
const cameraWrap = el("cameraWrap");
const video = el("video");
const stepProcess = el("step-process");
const processStatus = el("processStatus");
const sourceCanvas = el("sourceCanvas");
const detectCanvas = el("detectCanvas");
const stepResult = el("step-result");
const resultCanvas = el("resultCanvas");
const resultInfo = el("resultInfo");
const btnDownload = el("btnDownload");
const btnShare = el("btnShare");
const btnRetry = el("btnRetry");
const progressFill = el("progressFill");
const calibWarning = el("calibWarning");
const installBanner = el("installBanner");
const installHint = el("installHint");
const btnInstall = el("btnInstall");
const btnInstallDismiss = el("btnInstallDismiss");

/* ------------------------------------------------------------------ *
 * Carregar perfis do tapete
 * ------------------------------------------------------------------ */

async function loadProfiles() {
  // no-store: o app é atualizado com frequência (perfis de tapete novos/
  // corrigidos) e o celular não pode ficar preso numa versão antiga em cache.
  const res = await fetch("mat-profiles.json", { cache: "no-store" });
  matConfig = await res.json();
  profileSelect.innerHTML = "";
  for (const p of matConfig.profiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.nome;
    profileSelect.appendChild(opt);
  }
  profileSelect.addEventListener("change", () => {
    updateProfileInfo();
    openCamera();
  });
  currentProfile = matConfig.profiles[0];
  updateProfileInfo();
  openCamera();
}

function updateProfileInfo() {
  currentProfile = matConfig.profiles.find((p) => p.id === profileSelect.value);
  const p = currentProfile;
  profileInfo.textContent =
    `${p.width_mm / 10} x ${p.height_mm / 10} cm · ${p.markers.length} marcadores de ${p.marker_size_mm / 10} cm · ` +
    `precisa de pelo menos ${MIN_MARKERS_REQUIRED} visíveis para calibrar.` +
    (p.ribbon ? " Inclui fita de referência para maior precisão." : "") +
    (p.descricao ? ` ${p.descricao}` : "");
}

/* ------------------------------------------------------------------ *
 * Geometria do tapete (tem que espelhar generate_mat.js)
 * ------------------------------------------------------------------ */

// Cada marcador do perfil tem posição real explícita (x_mm/y_mm, layout de
// borda) ou um nome de canto (corner, layout antigo de 4 pontos) — suporta os dois.
function markerRealXY(m, profile) {
  if (m.x_mm != null) return { x: m.x_mm, y: m.y_mm };
  const { width_mm, height_mm, margin_mm } = profile;
  switch (m.corner) {
    case "top-left": return { x: margin_mm, y: margin_mm };
    case "top-right": return { x: width_mm - margin_mm, y: margin_mm };
    case "bottom-right": return { x: width_mm - margin_mm, y: height_mm - margin_mm };
    case "bottom-left": return { x: margin_mm, y: height_mm - margin_mm };
    default: throw new Error(`Canto desconhecido: ${m.corner}`);
  }
}

/* ------------------------------------------------------------------ *
 * Câmera
 * ------------------------------------------------------------------ */

btnOpenCamera.addEventListener("click", () => openCamera(false));

// silent=true nas aberturas automáticas (ao carregar a página / trocar de
// tapete) — se falhar (ex.: permissão ainda não concedida), a pessoa sempre
// pode abrir manualmente pelo botão "Abrir câmera", que aí sim mostra o erro.
async function openCamera(silent = true) {
  if (mediaStream) return; // já aberta (ex.: trocou de tapete com a câmera em uso)
  try {
    // 1920x1080 (não 4K): pedir resolução muito alta faz alguns celulares
    // demorarem bem mais pra iniciar a câmera. A foto final não perde muito —
    // "Carregar foto" (app nativo de câmera) continua sendo o caminho de
    // maior qualidade quando isso importa.
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    video.srcObject = mediaStream;
    cameraWrap.classList.remove("hidden");
    document.body.classList.add("camera-mode");
  } catch (err) {
    if (!silent) alert("Não foi possível abrir a câmera: " + err.message);
  }
}

btnStopCamera.addEventListener("click", stopCamera);

function stopCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  cameraWrap.classList.add("hidden");
  document.body.classList.remove("camera-mode");
}

btnShot.addEventListener("click", () => {
  const w = video.videoWidth;
  const h = video.videoHeight;
  sourceCanvas.width = w;
  sourceCanvas.height = h;
  sourceCanvas.getContext("2d").drawImage(video, 0, 0, w, h);
  stopCamera();
  processImage();
});

/* ------------------------------------------------------------------ *
 * Upload de arquivo (também usado pela captura nativa do celular)
 * ------------------------------------------------------------------ */

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    sourceCanvas.width = bitmap.width;
    sourceCanvas.height = bitmap.height;
    sourceCanvas.getContext("2d").drawImage(bitmap, 0, 0);
    processImage();
  } catch (err) {
    alert("Não foi possível ler essa foto: " + err.message);
  } finally {
    fileInput.value = "";
  }
});

/* ------------------------------------------------------------------ *
 * Pipeline de processamento
 * ------------------------------------------------------------------ */

function setStatus(msg, kind) {
  processStatus.textContent = msg;
  processStatus.className = "status" + (kind ? " status-" + kind : "");
}

function setProgress(fraction) {
  if (progressFill) progressFill.style.width = Math.round(fraction * 100) + "%";
}

async function processImage() {
  stepProcess.classList.remove("hidden");
  stepResult.classList.add("hidden");
  stepProcess.scrollIntoView({ behavior: "smooth", block: "start" });
  setProgress(0.05);

  await nextFrame();
  setStatus("Preparando imagem para detecção...");
  await nextFrame();

  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  const scaleDetect = Math.min(1, DETECT_MAX_SIDE / Math.max(srcW, srcH));
  const dW = Math.round(srcW * scaleDetect);
  const dH = Math.round(srcH * scaleDetect);
  detectCanvas.width = dW;
  detectCanvas.height = dH;
  const dctx = detectCanvas.getContext("2d");
  dctx.drawImage(sourceCanvas, 0, 0, dW, dH);
  const imageData = dctx.getImageData(0, 0, dW, dH);

  setStatus("Detectando marcadores do tapete...");
  setProgress(0.15);
  await nextFrame();

  let markers;
  try {
    const detector = new AR.Detector({ dictionaryName: matConfig.dictionary });
    markers = detector.detect(imageData);
  } catch (err) {
    setStatus("Erro ao detectar marcadores: " + err.message, "error");
    setProgress(0);
    return;
  }

  const found = new Map(); // id -> marker
  for (const m of markers) found.set(m.id, m);

  // Só precisamos de MIN_MARKERS_REQUIRED visíveis (não todos) — assim uma peça
  // grande pode cobrir parte do tapete sem quebrar a calibração, desde que
  // marcadores suficientes continuem visíveis em outros pontos da borda.
  const usedMarkers = currentProfile.markers.filter((m) => found.has(m.id));
  const missingIds = currentProfile.markers.filter((m) => !found.has(m.id)).map((m) => m.id);
  if (usedMarkers.length < MIN_MARKERS_REQUIRED) {
    setStatus(
      `Só encontrei ${usedMarkers.length} de ${currentProfile.markers.length} marcadores ` +
      `(preciso de pelo menos ${MIN_MARKERS_REQUIRED}). ` +
      `Faltando: ID ${missingIds.join(", ID ")}. ` +
      `Tente novamente com mais marcadores da borda visíveis, bem iluminados e sem reflexo.`,
      "error"
    );
    setProgress(0);
    return;
  }

  setStatus(
    `${usedMarkers.length} de ${currentProfile.markers.length} marcadores encontrados` +
    (missingIds.length ? ` (faltou ID ${missingIds.join(", ID ")})` : "") +
    `. Calculando correção de perspectiva e escala...`
  );
  setProgress(0.3);
  await nextFrame();

  // Pontos de origem (na foto em resolução total) e destino (mm reais, escalados para px)
  const pxPerMm = OUTPUT_TARGET_LONG / Math.max(currentProfile.width_mm, currentProfile.height_mm);
  const outW = Math.round(currentProfile.width_mm * pxPerMm);
  const outH = Math.round(currentProfile.height_mm * pxPerMm);

  const srcPts = [];
  const dstPts = [];
  for (const m of usedMarkers) {
    const marker = found.get(m.id);
    const center = markerCenter(marker.corners);
    // volta pra escala da foto original (a detecção rodou numa cópia reduzida)
    srcPts.push({ x: center.x / scaleDetect, y: center.y / scaleDetect });
    const mm = markerRealXY(m, currentProfile);
    dstPts.push({ x: mm.x * pxPerMm, y: mm.y * pxPerMm });
  }

  // Com exatamente 4 pontos isso é um ajuste exato; com mais, é por mínimos
  // quadrados (mais robusto a ruído de detecção e a marcadores individuais
  // com posição ligeiramente imprecisa).
  const Hrough = computeHomography(srcPts, dstPts);
  const HroughInv = invert3x3(Hrough);

  // Se o perfil tem fita de referência (borda com padrão De Bruijn), lê os
  // bits, localiza cada célula na sequência com confiança e usa os pontos
  // extras (muito mais numerosos que os 4 cantos) pra refinar a homografia.
  // Precisa da foto em resolução total (não a cópia reduzida da detecção).
  // Buscamos os pixels da foto em resolução total aqui (não só quando a fita
  // está ativa) pra reaproveitar no warp final mais abaixo, sem ler duas vezes.
  const srcCtx = sourceCanvas.getContext("2d");
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH);

  let ribbonResult = null;
  if (currentProfile.ribbon) {
    setStatus("Lendo fita de referência para refinar a precisão...");
    await nextFrame();
    try {
      ribbonResult = refineHomographyWithRibbon(
        currentProfile, HroughInv, srcData, srcW, srcH, pxPerMm, srcPts, dstPts
      );
    } catch (err) {
      ribbonResult = null; // qualquer falha na fita: segue só com os 4 cantos, nunca trava o app
    }
  }

  const H = (ribbonResult && ribbonResult.Hfinal) ? ribbonResult.Hfinal : Hrough;
  const Hinv = invert3x3(H);

  // Autoverificação: cada marcador tem um tamanho real conhecido (marker_size_mm).
  // Medimos o próprio marcador DEPOIS de corrigido e comparamos com esse valor —
  // se não bater, a suposição de geometria do tapete (ou a detecção) está errada,
  // e isso teria passado batido com um ajuste de só 4 pontos (sempre "perfeito").
  const calibration = checkCalibrationQuality(H, usedMarkers, found, scaleDetect, pxPerMm, currentProfile.marker_size_mm);

  setStatus("Gerando imagem corrigida (pode levar alguns segundos)...");
  await nextFrame();

  const legendPx = Math.round(LEGEND_HEIGHT_MM * pxPerMm);
  const finalCanvas = document.createElement("canvas");
  finalCanvas.width = outW;
  finalCanvas.height = outH + legendPx;
  const fctx = finalCanvas.getContext("2d");
  fctx.fillStyle = "#ffffff";
  fctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);

  const outImageData = fctx.getImageData(0, 0, outW, outH);

  await warpPerspective(srcData, outImageData, Hinv, srcW, srcH, (progress) => {
    setStatus(`Gerando imagem corrigida... ${Math.round(progress * 100)}%`);
    setProgress(0.3 + progress * 0.65);
  });
  fctx.putImageData(outImageData, 0, 0);

  drawLegend(fctx, outW, outH, legendPx, pxPerMm, currentProfile);

  resultCanvas.width = finalCanvas.width;
  resultCanvas.height = finalCanvas.height;
  resultCanvas.getContext("2d").drawImage(finalCanvas, 0, 0);

  const mmPerPx = 1 / pxPerMm;
  resultInfo.textContent =
    `Escala: 1 px = ${mmPerPx.toFixed(3)} mm (1 cm real = ${(pxPerMm * 10).toFixed(1)} px). ` +
    `Use a régua de ${100} mm no rodapé da imagem para conferir/ajustar a escala no AutoCAD.` +
    (currentProfile.ribbon
      ? (ribbonResult && ribbonResult.Hfinal
          ? ` Calibração refinada com ${ribbonResult.pointsUsed} pontos da fita de referência.`
          : ` Fita de referência não pôde ser lida com confiança (usando só os 4 cantos) — confira iluminação/foco da borda.`)
      : "");

  showCalibrationWarning(calibration, currentProfile);

  setStatus("Concluído!", "ok");
  setProgress(1);
  stepResult.classList.remove("hidden");
  stepResult.scrollIntoView({ behavior: "smooth", block: "start" });
  setupDownloadShare(finalCanvas);
}

function markerCenter(corners) {
  let x = 0, y = 0;
  for (const c of corners) { x += c.x; y += c.y; }
  return { x: x / corners.length, y: y / corners.length };
}

function nextFrame() {
  // setTimeout (não requestAnimationFrame) de propósito: rAF pausa por completo
  // quando a aba/app vai para segundo plano, o que travaria o processamento.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ------------------------------------------------------------------ *
 * Homografia (DLT de 4 pontos) + warp
 * ------------------------------------------------------------------ */

function computeHomography(src, dst) {
  // Resolve h = [h11,h12,h13,h21,h22,h23,h31,h32] (h33 = 1) via DLT.
  // Com exatamente 4 correspondências isso é um ajuste exato; com mais de 4
  // (marcadores extras na borda), vira mínimos quadrados via equações normais
  // (A^T A) h = A^T b — mais robusto a ruído de detecção em marcadores individuais.
  const A = [];
  const b = [];
  for (let i = 0; i < src.length; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const n = 8;
  const AtA = Array.from({ length: n }, () => Array(n).fill(0));
  const Atb = Array(n).fill(0);
  for (let r = 0; r < A.length; r++) {
    for (let i = 0; i < n; i++) {
      Atb[i] += A[r][i] * b[r];
      for (let j = 0; j < n; j++) AtA[i][j] += A[r][i] * A[r][j];
    }
  }
  const h = solveLinear(AtA, Atb);
  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ];
}

function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (pivot !== col) { const tmp = M[col]; M[col] = M[pivot]; M[pivot] = tmp; }
    const pv = M[col][col];
    if (Math.abs(pv) < 1e-12) throw new Error("Sistema singular ao calcular a homografia (pontos colineares?).");
    for (let c = col; c <= n; c++) M[col][c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

function invert3x3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("Homografia não é invertível.");
  const invDet = 1 / det;
  return [
    [A * invDet, D * invDet, G * invDet],
    [B * invDet, E * invDet, H * invDet],
    [C * invDet, F * invDet, I * invDet],
  ];
}

function applyH(m, x, y) {
  const X = m[0][0] * x + m[0][1] * y + m[0][2];
  const Y = m[1][0] * x + m[1][1] * y + m[1][2];
  const W = m[2][0] * x + m[2][1] * y + m[2][2];
  return [X / W, Y / W];
}

// Só os CENTROS dos marcadores entram no cálculo da homografia (4 pontos = ajuste
// exato, sem sobra pra acusar erro). Os CANTOS de cada marcador não são usados pra
// calcular a transformação, então dá pra usá-los como verificação independente:
// cada marcador mede marker_size_mm de lado na vida real — comparamos com o que
// ele mede depois de corrigido.
function checkCalibrationQuality(H, markersToCheck, found, scaleDetect, pxPerMm, markerSizeMm) {
  // detect() traça o contorno do quadrado PRETO do marcador — a zona de silêncio
  // branca ao redor (parte do "tile" gerado por generateSVG) não é detectável
  // contra o fundo branco/preto do tapete (o tile em si sempre tem fundo branco
  // próprio). O tile inteiro tem (markSize+2) unidades de lado, e o quadrado
  // preto tem markSize unidades — então o que a câmera realmente vê é
  // marker_size_mm * markSize / (markSize + 2), não marker_size_mm.
  const dict = new AR.Dictionary(matConfig.dictionary);
  const detectableMm = (markerSizeMm * dict.markSize) / (dict.markSize + 2);

  const results = [];
  for (const m of markersToCheck) {
    const marker = found.get(m.id);
    const corners = marker.corners.map((c) => ({ x: c.x / scaleDetect, y: c.y / scaleDetect }));
    const transformed = corners.map((c) => applyH(H, c.x, c.y));
    let sumSides = 0;
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = transformed[i];
      const [x2, y2] = transformed[(i + 1) % 4];
      sumSides += Math.hypot(x2 - x1, y2 - y1);
    }
    const avgSidePx = sumSides / 4;
    const measuredMm = avgSidePx / pxPerMm;
    const errorPct = ((measuredMm - detectableMm) / detectableMm) * 100;
    results.push({ id: m.id, measuredMm, errorPct });
  }
  const maxAbsErrorPct = Math.max(...results.map((r) => Math.abs(r.errorPct)));
  return { perMarker: results, maxAbsErrorPct, detectableMm };
}

const CALIB_OK_THRESHOLD_PCT = 1; // abaixo disso: pode usar. Igual ou acima: não recomendado.

function showCalibrationWarning(calibration, profile) {
  const pct = calibration.maxAbsErrorPct;
  const pctStr = pct.toFixed(2);
  let level, msg;
  const expectedMm = calibration.detectableMm.toFixed(1);
  if (pct <= CALIB_OK_THRESHOLD_PCT) {
    level = "ok";
    msg = `✓ PODE USAR — calibração dentro de ${pctStr}% do esperado (${expectedMm} mm), até o limite de ${CALIB_OK_THRESHOLD_PCT}%.`;
  } else if (pct < 4) {
    level = "warn";
    msg = `✖ NÃO recomendado usar esta imagem sem conferir — erro de ${pctStr}% (limite pra uso seguro é ${CALIB_OK_THRESHOLD_PCT}%). ` +
      `Pode ser leve imprecisão de detecção (luz, ângulo) — tire outra foto ou confira uma medida real antes de mandar cortar.`;
  } else {
    level = "error";
    msg = `✖ NÃO USE esta imagem — erro de ${pctStr}% é grande demais (deveria ser abaixo de ${CALIB_OK_THRESHOLD_PCT}%, marcador deveria medir ${expectedMm} mm). ` +
      `Confira se o perfil de tapete selecionado ("${profile.nome}") bate com o tapete físico usado, e se os 4 marcadores foram bem detectados.`;
  }
  calibWarning.textContent = msg;
  calibWarning.className = "calib-warning level-" + level;
}

// Amostragem bilinear de srcData em (x,y) (coordenadas de ponto flutuante)
function sampleBilinear(srcData, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const d = srcData.data;
  const idx = (xx, yy) => (yy * w + xx) * 4;
  const out = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const v00 = d[idx(x0, y0) + k], v10 = d[idx(x1, y0) + k];
    const v01 = d[idx(x0, y1) + k], v11 = d[idx(x1, y1) + k];
    const top = v00 + (v10 - v00) * fx;
    const bot = v01 + (v11 - v01) * fx;
    out[k] = top + (bot - top) * fy;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Fita de referência De Bruijn (perfis com "ribbon: true")
 *
 * Além dos 4 cantos, o tapete tem uma fita fina na borda com células
 * preto/branco codificando uma sequência de De Bruijn (ver web/lib/ribbon.js).
 * Toda janela de N bits dessa sequência é única, então dá pra ler um trecho
 * qualquer da fita (mesmo com peça cobrindo parte dela) e saber exatamente
 * onde ele está no tapete. Cada célula branca lida com confiança vira um
 * ponto extra de referência (muito mais numeroso que os 4 cantos), usado
 * pra refinar a homografia — corrige erros de perspectiva que 4 pontos
 * sozinhos não conseguem enxergar.
 *
 * Validado extensivamente em fotos sintéticas (ver scratchpad de P&D):
 * 80-84% de redução no erro de posição em condições realistas de ruído de
 * detecção. Ainda não testado com foto real de fita impressa.
 * ------------------------------------------------------------------ */

// Localiza um trecho lido (com bits eventualmente ilegíveis = null) na
// sequência De Bruijn, só aceitando se o melhor candidato for inequivocamente
// melhor que o segundo melhor (evita "acertar com confiança" errado).
function locateConfident(seq, chunk, maxErrorRate, minMarginBits) {
  const len = seq.length;
  const scored = [];
  for (let start = 0; start < len; start++) {
    let errors = 0, readable = 0;
    for (let j = 0; j < chunk.length; j++) {
      if (chunk[j] === null) continue;
      readable++;
      if (seq[(start + j) % len] !== chunk[j]) errors++;
    }
    if (readable === 0) continue;
    if (errors / readable <= maxErrorRate) scored.push({ start, errors, readable });
  }
  scored.sort((a, b) => a.errors - b.errors);
  if (scored.length === 0) return { accepted: false };
  if (scored.length === 1) return { accepted: true, start: scored[0].start };
  const margin = scored[1].errors - scored[0].errors;
  if (margin < minMarginBits) return { accepted: false };
  return { accepted: true, start: scored[0].start };
}

// Lê a fita na foto (via Hrough, o ajuste só-4-cantos), localiza os trechos
// legíveis na sequência, refina a posição real de cada célula lida por
// correção de delta (não pelas posições brutas, que herdam o viés do Hrough),
// e recalcula a homografia com cantos + pontos da fita (descartando os 15%
// piores por resíduo, pra não deixar uma célula mal lida puxar tudo).
// Retorna { Hfinal: null, pointsUsed } se não conseguir confiar em pontos
// suficientes — nesse caso o chamador deve continuar usando só os 4 cantos.
function refineHomographyWithRibbon(profile, HroughInv, srcData, srcW, srcH, pxPerMm, cornerSrcPts, cornerDstPts) {
  const seqBits = Ribbon.deBruijn(2, profile.ribbon_bits || Ribbon.RIBBON_WINDOW_BITS);
  const ribbonCells = Ribbon.buildRibbonCells(profile, seqBits);

  function grayAt(x, y) {
    const px = sampleBilinear(srcData, srcW, srcH, x, y);
    return px ? (px[0] + px[1] + px[2]) / 3 : null;
  }
  function readCellBit(cell) {
    let sum = 0, n = 0;
    for (const fx of [0.3, 0.5, 0.7]) {
      for (const fy of [0.3, 0.5, 0.7]) {
        const outx = (cell.x + cell.w * fx) * pxPerMm, outy = (cell.y + cell.h * fy) * pxPerMm;
        const [px, py] = applyH(HroughInv, outx, outy);
        const g = grayAt(px, py);
        if (g !== null) { sum += g; n++; }
      }
    }
    if (n === 0) return null;
    return sum / n > 110 ? 1 : 0;
  }
  const readBits = ribbonCells.map(readCellBit);

  const WINDOW = 26, MAX_ERR_RATE = 0.15, MARGIN_BITS = 3;
  const coveredIdx = new Set();
  for (let start = 0; start + WINDOW <= readBits.length; start += 4) {
    const chunk = readBits.slice(start, start + WINDOW);
    const res = locateConfident(seqBits, chunk, MAX_ERR_RATE, MARGIN_BITS);
    if (!res.accepted || res.start !== start) continue; // só aceita se bateu na própria posição (sem falso-positivo)
    for (let j = 0; j < WINDOW; j++) coveredIdx.add(start + j);
  }

  function sweep1D(seedMmX, seedMmY, dirX, dirY, halfRangeMm, stepMm) {
    const steps = Math.round(halfRangeMm / stepMm);
    const samples = [];
    for (let t = -steps; t <= steps; t++) {
      const mmx = seedMmX + dirX * stepMm * t, mmy = seedMmY + dirY * stepMm * t;
      const [px, py] = applyH(HroughInv, mmx * pxPerMm, mmy * pxPerMm);
      samples.push({ px, py, g: grayAt(px, py) });
    }
    return samples;
  }
  function findCrossing(samples) {
    const valid = samples.filter((s) => s.g !== null);
    if (valid.length < 4) return null;
    const lo = Math.min(...valid.map((s) => s.g)), hi = Math.max(...valid.map((s) => s.g));
    if (hi - lo < 30) return null; // sem transição preto/branco clara: não confia
    const mid = (lo + hi) / 2;
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i], b = samples[i + 1];
      if (a.g === null || b.g === null) continue;
      if (a.g >= mid && b.g < mid) {
        const frac = (mid - a.g) / (b.g - a.g);
        return { px: a.px + (b.px - a.px) * frac, py: a.py + (b.py - a.py) * frac };
      }
    }
    return null;
  }
  // Correção de delta: mede (achado − previsto pelo Hrough) em DOIS eixos
  // locais independentes (ao longo da fita "u", atravessando "v") no MESMO
  // deslocamento de referência, e soma os dois deltas na posição prevista da
  // célula. Válido porque, numa vizinhança pequena, qualquer homografia suave
  // se comporta como uma transformação afim local.
  function refine2D(cell) {
    if (cell.bit !== 1) return null; // só células brancas têm uma borda nítida pra medir
    const axes = Ribbon.cellAxes(cell);
    const [seedPx, seedPy] = applyH(HroughInv, cell.cx * pxPerMm, cell.cy * pxPerMm);
    const halfLen = (cell.w >= cell.h ? cell.w : cell.h) / 2;
    let alongDelta = null;
    for (const dir of [1, -1]) {
      const ux = axes.u.x * dir, uy = axes.u.y * dir;
      const foundPt = findCrossing(sweep1D(cell.cx, cell.cy, ux, uy, halfLen + 4, 0.5));
      if (!foundPt) continue;
      const [expPx, expPy] = applyH(HroughInv, (cell.cx + ux * halfLen) * pxPerMm, (cell.cy + uy * halfLen) * pxPerMm);
      alongDelta = { dx: foundPt.px - expPx, dy: foundPt.py - expPy };
      break;
    }
    if (!alongDelta) return null;
    const sign = Ribbon.outwardSign(cell, profile, axes);
    const vx = axes.v.x * sign, vy = axes.v.y * sign;
    const foundV = findCrossing(sweep1D(cell.cx, cell.cy, vx, vy, 14, 0.5));
    if (!foundV) return null;
    const [expPxV, expPyV] = applyH(HroughInv, (cell.cx + vx * 10) * pxPerMm, (cell.cy + vy * 10) * pxPerMm);
    const crossDelta = { dx: foundV.px - expPxV, dy: foundV.py - expPyV };
    return {
      px: seedPx + alongDelta.dx + crossDelta.dx,
      py: seedPy + alongDelta.dy + crossDelta.dy,
      mmx: cell.cx, mmy: cell.cy,
    };
  }

  const extraSrc = [], extraDst = [];
  for (let i = 0; i < ribbonCells.length; i++) {
    if (!coveredIdx.has(i)) continue;
    const pt = refine2D(ribbonCells[i]);
    if (!pt) continue;
    extraSrc.push({ x: pt.px, y: pt.py });
    extraDst.push({ x: pt.mmx * pxPerMm, y: pt.mmy * pxPerMm });
  }

  // Poucos pontos confiáveis (ex.: peça grande cobrindo quase toda a fita,
  // ou foto ruim): não vale a pena arriscar, segue só com os 4 cantos.
  const MIN_RIBBON_POINTS = 8;
  if (extraSrc.length < MIN_RIBBON_POINTS) return { Hfinal: null, pointsUsed: extraSrc.length };

  const allSrc = [...cornerSrcPts, ...extraSrc];
  const allDst = [...cornerDstPts, ...extraDst];
  const H0 = computeHomography(allSrc, allDst);
  const residuals = allSrc.map((s, i) => {
    const [px, py] = applyH(H0, s.x, s.y);
    return Math.hypot(px - allDst[i].x, py - allDst[i].y);
  });
  const sortedRes = [...residuals].sort((a, b) => a - b);
  const cutoff = sortedRes[Math.floor(sortedRes.length * 0.85)];
  const keptSrc = [], keptDst = [];
  for (let i = 0; i < allSrc.length; i++) {
    if (i < cornerSrcPts.length || residuals[i] <= cutoff) { keptSrc.push(allSrc[i]); keptDst.push(allDst[i]); }
  }
  const Hfinal = computeHomography(keptSrc, keptDst);
  return { Hfinal, pointsUsed: extraSrc.length };
}

async function warpPerspective(srcData, outImageData, Hinv, srcW, srcH, onProgress) {
  const outW = outImageData.width;
  const outH = outImageData.height;
  const out = outImageData.data;
  const ROWS_PER_CHUNK = 40;

  for (let yStart = 0; yStart < outH; yStart += ROWS_PER_CHUNK) {
    const yEnd = Math.min(yStart + ROWS_PER_CHUNK, outH);
    for (let y = yStart; y < yEnd; y++) {
      for (let x = 0; x < outW; x++) {
        const [sx, sy] = applyH(Hinv, x, y);
        const px = sampleBilinear(srcData, srcW, srcH, sx, sy);
        const o = (y * outW + x) * 4;
        if (px) {
          out[o] = px[0]; out[o + 1] = px[1]; out[o + 2] = px[2]; out[o + 3] = 255;
        } else {
          out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = 255;
        }
      }
    }
    onProgress(yEnd / outH);
    await nextFrame();
  }
}

/* ------------------------------------------------------------------ *
 * Legenda / régua de escala
 * ------------------------------------------------------------------ */

function drawLegend(ctx, outW, outH, legendPx, pxPerMm, profile) {
  const barMm = 100;
  const barPx = barMm * pxPerMm;
  const x0 = 24;
  const yMid = outH + legendPx / 2;

  ctx.fillStyle = "#000000";
  ctx.fillRect(x0, yMid - 1, barPx, 2);
  for (const t of [0, barPx]) {
    ctx.fillRect(x0 + t - 1, yMid - 6, 2, 12);
  }
  ctx.font = "16px Arial";
  ctx.fillText("100 mm", x0, yMid - 12);

  ctx.textAlign = "right";
  ctx.font = "12px Arial";
  const dateStr = new Date().toLocaleDateString("pt-BR");
  ctx.fillText(
    `${profile.nome} · escala 1px=${(1 / pxPerMm).toFixed(3)}mm · ${dateStr}`,
    outW - 16,
    yMid
  );
  ctx.textAlign = "left";
}

/* ------------------------------------------------------------------ *
 * Download / compartilhar / nova foto
 * ------------------------------------------------------------------ */

function setupDownloadShare(canvas) {
  btnDownload.onclick = () => {
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `molde_${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }, "image/png");
  };

  if (navigator.share && navigator.canShare) {
    canvas.toBlob((blob) => {
      const file = new File([blob], `molde_${Date.now()}.png`, { type: "image/png" });
      if (navigator.canShare({ files: [file] })) {
        btnShare.classList.remove("hidden");
        btnShare.onclick = () => navigator.share({ files: [file], title: "Molde digitalizado" });
      }
    }, "image/png");
  }
}

btnRetry.addEventListener("click", () => {
  stepResult.classList.add("hidden");
  stepProcess.classList.add("hidden");
  openCamera(false);
});

/* ------------------------------------------------------------------ *
 * Instalar como app (tela inicial)
 * ------------------------------------------------------------------ */

const INSTALL_DISMISS_KEY = "moldeflat_install_dismissed_at";
const INSTALL_DISMISS_DAYS = 14;

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS 13+
}

function recentlyDismissed() {
  const raw = localStorage.getItem(INSTALL_DISMISS_KEY);
  if (!raw) return false;
  const days = (Date.now() - parseInt(raw, 10)) / 86400000;
  return days < INSTALL_DISMISS_DAYS;
}

let deferredInstallPrompt = null;

function showInstallBanner({ withButton }) {
  if (isStandalone() || recentlyDismissed()) return;
  installBanner.classList.remove("hidden");
  btnInstall.classList.toggle("hidden", !withButton);
  installHint.textContent = withButton
    ? "Adicione à tela inicial pra abrir como app"
    : "Toque em compartilhar (⬆) e depois em \"Adicionar à Tela de Início\"";
}

function hideInstallBanner() {
  installBanner.classList.add("hidden");
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner({ withButton: true });
});

window.addEventListener("appinstalled", hideInstallBanner);

btnInstall.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  hideInstallBanner();
});

btnInstallDismiss.addEventListener("click", () => {
  localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
  hideInstallBanner();
});

if (isIOS() && !isStandalone()) {
  showInstallBanner({ withButton: false });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

/* ------------------------------------------------------------------ */

// Chamado pelo auth.js depois que o login é confirmado (não roda sozinho —
// o app só começa a carregar depois que a sessão é validada).
window.MoldeFlatInit = function MoldeFlatInit() {
  loadProfiles().catch((err) => {
    alert("Erro ao carregar os perfis do tapete (mat-profiles.json): " + err.message);
  });
};
