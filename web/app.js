"use strict";

/* ------------------------------------------------------------------ *
 * Configuração / estado
 * ------------------------------------------------------------------ */

const APP_VERSION = "2026-10-09.8";
const DETECT_MAX_SIDE = 1400;   // 1a tentativa de detecção (rápida); se faltar marcador, tenta resoluções maiores
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
  currentProfile = effectiveProfile(matConfig.profiles[0]);
  updateProfileInfo();
  openCamera();
}

// Escala de impressão MEDIDA do tapete físico (trena entre marcadores / valor do projeto).
// O check de tamanho dos marcadores não enxerga isso: se o tapete inteiro saiu 3% menor,
// marcadores e distâncias encolhem juntos e o check continua dando ~0%, mas todas as
// medidas em mm saem erradas. "print_scale": { "x": 0.967, "y": 0.967 } no perfil corrige:
// o app passa a usar as dimensões e posições REAIS do tapete impresso.
function effectiveProfile(p) {
  const sx = (p.print_scale && p.print_scale.x) || 1;
  const sy = (p.print_scale && p.print_scale.y) || 1;
  if (sx === 1 && sy === 1) return p;
  const sAvg = (sx + sy) / 2;
  return {
    ...p,
    nominal: p,
    width_mm: p.width_mm * sx,
    height_mm: p.height_mm * sy,
    marker_size_mm: p.marker_size_mm * sAvg,
    margin_mm: p.margin_mm * sAvg,
    markers: p.markers.map((m) => (m.x_mm != null ? { ...m, x_mm: m.x_mm * sx, y_mm: m.y_mm * sy } : m)),
  };
}

function updateProfileInfo() {
  currentProfile = effectiveProfile(matConfig.profiles.find((p) => p.id === profileSelect.value));
  const p = currentProfile.nominal || currentProfile;
  const ps = currentProfile.nominal ? currentProfile.print_scale : null;
  profileInfo.textContent =
    `${p.width_mm / 10} x ${p.height_mm / 10} cm · ${p.markers.length} marcadores de ${p.marker_size_mm / 10} cm · ` +
    (ps ? `escala de impressão medida: ${(ps.x * 100).toFixed(2).replace(".", ",")}% x ${(ps.y * 100).toFixed(2).replace(".", ",")}% · ` : "") +
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
    startLiveAnalysis();
  } catch (err) {
    if (!silent) alert("Não foi possível abrir a câmera: " + err.message);
  }
}

btnStopCamera.addEventListener("click", stopCamera);

function stopCamera() {
  stopLiveAnalysis();
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  cameraWrap.classList.add("hidden");
  document.body.classList.remove("camera-mode");
}

let presetMarkers = null;

function captureFromVideo(liveFound, frameCanvas) {
  // frameCanvas: o quadro exato já medido ao vivo (captura automática); sem ele, usa o vídeo agora
  const fromFrame = frameCanvas instanceof HTMLCanvasElement;
  const w = fromFrame ? frameCanvas.width : video.videoWidth;
  const h = fromFrame ? frameCanvas.height : video.videoHeight;
  presetMarkers = liveFound instanceof Map ? { found: liveFound, w, h } : null;
  sourceCanvas.width = w;
  sourceCanvas.height = h;
  sourceCanvas.getContext("2d").drawImage(fromFrame ? frameCanvas : video, 0, 0, w, h);
  stopCamera();
  processImage();
}

btnShot.addEventListener("click", captureFromVideo);

/* ------------------------------------------------------------------ *
 * Análise ao vivo + captura automática
 *
 * Com a câmera aberta, analisa o quadro ~6x por segundo: acha os 4
 * marcadores, confere enquadramento, distância, inclinação do celular
 * (marcadores devem aparecer do mesmo tamanho) e firmeza (marcadores
 * parados). Mostra o que ajustar; quando tudo estiver ok por alguns
 * quadros seguidos, tira a foto sozinho (se "Captura automática" ligada).
 * ------------------------------------------------------------------ */

const liveOverlay = el("liveOverlay");
const liveHint = el("liveHint");
const autoCaptureToggle = el("autoCaptureToggle");
const AUTO_CAPTURE_KEY = "moldeflat_auto_capture";

const LIVE_DETECT_SIDE = 1920;     // lado maior da cópia usada na análise (marcador pequeno demais não é lido)
const LIVE_MIN_MARKER_PX = 55;     // marcador menor que isso (px da câmera) = longe demais
const LIVE_EDGE_MARGIN = 0.015;    // fração do quadro: marcador mais perto da borda que isso = cortado
const LIVE_MAX_SKEW = 0.07;        // diferença máxima de tamanho entre marcadores (~inclinação de 7°)
const LIVE_MAX_MOVE_PX = 10;       // movimento médio entre análises (px da câmera) acima disso = tremendo
let LIVE_TARGET_ERR_PCT = 0.8;     // erro de calibração (%, o mesmo do resultado final, com a fita) máximo pra capturar sozinho
const LIVE_MAX_TRIES = 10;         // medições completas sem atingir a meta: captura a melhor que viu
const LIVE_PRECHECK_PCT = 2.5;     // só roda a conta completa (com fita, mais pesada) se a estimativa só com os 4 cantos estiver abaixo disso
const LIVE_STABLE_FRAMES = 5;      // análises boas seguidas pra capturar (~1 s)

try {
  const saved = localStorage.getItem(AUTO_CAPTURE_KEY);
  if (saved !== null) autoCaptureToggle.checked = saved === "1";
} catch (e) { /* sem storage: fica no padrão (ligado) */ }
autoCaptureToggle.addEventListener("change", () => {
  try { localStorage.setItem(AUTO_CAPTURE_KEY, autoCaptureToggle.checked ? "1" : "0"); } catch (e) { /* ok */ }
});

const liveCanvas = document.createElement("canvas");
let liveTimer = null;
let liveActive = false;
let liveGoodCount = 0;
let liveBadStreak = 0;
let liveErrHistory = [];
let liveBestExact = null;
let liveBestFrame = null;   // { pct, found } do melhor quadro medido (canvas em liveBestCanvas)
let liveExactTries = 0;
const liveBestCanvas = document.createElement("canvas");
const liveFullCanvas = document.createElement("canvas");
let livePrevCenters = null;
let liveDetector = null;

function startLiveAnalysis() {
  stopLiveAnalysis();
  liveActive = true;
  liveGoodCount = 0;
  liveBadStreak = 0;
  liveErrHistory = [];
  liveBestExact = null;
  liveBestFrame = null;
  liveExactTries = 0;
  livePrevCenters = null;
  setLiveHint("bad", "Iniciando câmera…", "v" + APP_VERSION);
  liveTimer = setTimeout(liveTick, 300);
}

function stopLiveAnalysis() {
  liveActive = false;
  clearTimeout(liveTimer);
  liveTimer = null;
  liveHint.classList.add("hidden");
  const ctx = liveOverlay.getContext("2d");
  ctx.clearRect(0, 0, liveOverlay.width, liveOverlay.height);
}

function setLiveHint(level, text, detail) {
  liveHint.className = "live-hint level-" + level;
  liveHint.textContent = "";
  const main = document.createElement("div");
  main.textContent = text;
  liveHint.appendChild(main);
  if (detail) {
    const d = document.createElement("div");
    d.className = "live-detail";
    d.textContent = detail;
    liveHint.appendChild(d);
  }
}

function markerSidePx(corners) {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum / 4;
}

// Devolve { level, text, ok } para os marcadores achados no quadro (px da câmera).
function evaluateLiveFrame(found, vw, vh) {
  const m = { n: found.size };
  const r = evaluateLiveFrameCore(found, vw, vh, m);
  r.m = m;
  return r;
}

function evaluateLiveFrameCore(found, vw, vh, m) {
  const markers = currentProfile.markers;
  const missing = markers.filter((m) => !found.has(m.id)).map((m) => m.id);
  if (found.size === 0) {
    return { level: "bad", ok: false, text: "Procurando o tapete… enquadre os 4 marcadores dos cantos" };
  }
  if (missing.length) {
    return {
      level: "bad", ok: false,
      text: `Faltam os marcadores ${missing.map((i) => "ID " + i).join(", ")} — enquadre o tapete inteiro (afaste um pouco)`,
    };
  }

  const mx = vw * LIVE_EDGE_MARGIN, my = vh * LIVE_EDGE_MARGIN;
  for (const f of found.values()) {
    if (f.corners.some((c) => c.x < mx || c.y < my || c.x > vw - mx || c.y > vh - my)) {
      return { level: "bad", ok: false, text: `Marcador ID ${f.id} quase cortado na borda — centralize o tapete na tela` };
    }
  }

  const sides = [...found.values()].map((f) => ({ f, side: markerSidePx(f.corners) }));
  const minSide = Math.min(...sides.map((x) => x.side));
  const maxSide = Math.max(...sides.map((x) => x.side));
  m.side = Math.round(minSide);
  if (minSide < LIVE_MIN_MARKER_PX) {
    return { level: "bad", ok: false, text: "Aproxime o celular do tapete (marcadores pequenos demais pra medir bem)" };
  }

  // Câmera paralela ao tapete => os 4 marcadores aparecem do mesmo tamanho.
  const skew = (maxSide - minSide) / maxSide;
  m.skew = Math.round(skew * 100);
  if (skew > LIVE_MAX_SKEW) {
    const far = sides.find((x) => x.side === minSide).f;
    const c = markerCenter(far.corners);
    const dx = c.x - vw / 2, dy = c.y - vh / 2;
    const where = Math.abs(dy) * vw > Math.abs(dx) * vh
      ? (dy < 0 ? "de cima" : "de baixo")
      : (dx < 0 ? "esquerdo" : "direito");
    return {
      level: "warn", ok: false,
      text: `Celular inclinado (${(skew * 100).toFixed(0)}%): o lado ${where} da tela está mais longe do tapete — deixe o celular paralelo ao tapete`,
    };
  }

  const centers = new Map([...found.values()].map((f) => [f.id, markerCenter(f.corners)]));
  let move = 0;
  if (livePrevCenters) {
    let sum = 0, n = 0;
    for (const [id, c] of centers) {
      const p = livePrevCenters.get(id);
      if (p) { sum += Math.hypot(c.x - p.x, c.y - p.y); n++; }
    }
    move = n ? sum / n : 0;
  }
  m.move = Math.round(move);
  livePrevCenters = centers;
  if (move > LIVE_MAX_MOVE_PX) {
    return { level: "warn", ok: false, text: "Segure firme… o celular está se mexendo" };
  }
  return { level: "good", ok: true, text: "" };
}

// Estimativa do erro de calibração (%) do quadro atual: ajusta a homografia pelos
// centros dos marcadores e mede o tamanho dos marcadores já corrigidos contra o
// tamanho real — a mesma autoverificação do resultado final (sem a fita).
function liveCalibrationErrorPct(found) {
  const used = currentProfile.markers.filter((m) => found.has(m.id));
  if (used.length < MIN_MARKERS_REQUIRED) return null;
  const src = [], dst = [];
  for (const m of used) {
    src.push(markerCenter(found.get(m.id).corners));
    dst.push(markerRealXY(m, currentProfile));
  }
  let H;
  try { H = computeHomography(src, dst); } catch (e) { return null; }
  const dict = new AR.Dictionary(matConfig.dictionary);
  const detectableMm = (currentProfile.marker_size_mm * dict.markSize) / (dict.markSize + 2);
  let worst = 0;
  for (const m of used) {
    const t = found.get(m.id).corners.map((c) => applyH(H, c.x, c.y));
    let sum = 0;
    for (let i = 0; i < 4; i++) sum += Math.hypot(t[(i + 1) % 4][0] - t[i][0], t[(i + 1) % 4][1] - t[i][1]);
    worst = Math.max(worst, Math.abs((sum / 4 - detectableMm) / detectableMm) * 100);
  }
  return worst;
}

// Erro de calibração do quadro atual calculado EXATAMENTE como no resultado final
// (homografia refinada com a fita + mesma autoverificação). Mais pesado que a
// estimativa só com os 4 cantos, por isso só roda quando a estimativa já está boa.
function liveFinalError(found, vw, vh, fullData) {
  if (!fullData) return null;
  try {
    const used = currentProfile.markers.filter((m) => found.has(m.id));
    const pxPerMm = OUTPUT_TARGET_LONG / Math.max(currentProfile.width_mm, currentProfile.height_mm);
    const srcPts = [], dstPts = [];
    for (const m of used) {
      const c = markerCenter(found.get(m.id).corners);
      srcPts.push({ x: c.x, y: c.y });
      const mm = markerRealXY(m, currentProfile);
      dstPts.push({ x: mm.x * pxPerMm, y: mm.y * pxPerMm });
    }
    const Hrough = computeHomography(srcPts, dstPts);
    let H = Hrough, ribbonPts = 0, lensUsed = null;
    if (currentProfile.ribbon) {
      const r = refineHomographyWithRibbon(currentProfile, invert3x3(Hrough), fullData, vw, vh, pxPerMm, srcPts, dstPts);
      if (r && r.Hfinal) { H = r.Hfinal; ribbonPts = r.pointsUsed; lensUsed = r.lens || null; }
    }
    const cal = checkCalibrationQuality(H, used, undistortFound(found, lensUsed), 1, pxPerMm, currentProfile.marker_size_mm);
    return { pct: cal.maxAbsErrorPct, ribbonPts };
  } catch (e) {
    return null;
  }
}

function drawLiveOverlay(found, vw, vh, color) {
  if (liveOverlay.width !== vw || liveOverlay.height !== vh) {
    liveOverlay.width = vw;
    liveOverlay.height = vh;
  }
  const ctx = liveOverlay.getContext("2d");
  ctx.clearRect(0, 0, vw, vh);
  ctx.lineWidth = Math.max(3, vw / 300);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.font = `bold ${Math.round(vw / 40)}px Arial`;
  for (const f of found.values()) {
    ctx.beginPath();
    f.corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.fillText("ID " + f.id, f.corners[0].x, f.corners[0].y - 6);
  }
}

async function liveTick() {
  if (!liveActive) return;
  const t0 = performance.now();
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || video.readyState < 2) {
    liveTimer = setTimeout(liveTick, 200);
    return;
  }

  const found = new Map();
  try {
    const scale = Math.min(1, LIVE_DETECT_SIDE / Math.max(vw, vh));
    liveCanvas.width = Math.round(vw * scale);
    liveCanvas.height = Math.round(vh * scale);
    const ctx = liveCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, liveCanvas.width, liveCanvas.height);
    const imageData = ctx.getImageData(0, 0, liveCanvas.width, liveCanvas.height);
    if (!liveDetector) liveDetector = new AR.Detector({ dictionaryName: matConfig.dictionary });
    const wanted = new Set(currentProfile.markers.map((m) => m.id));
    for (const m of liveDetector.detect(imageData)) {
      if (!wanted.has(m.id)) continue;
      const corners = m.corners.map((c) => ({ x: c.x / scale, y: c.y / scale }));
      const prev = found.get(m.id);
      if (!prev || markerSidePx(corners) > markerSidePx(prev.corners)) found.set(m.id, { id: m.id, corners });
    }
  } catch (err) { /* quadro ruim: trata como nada achado */ }
  if (!liveActive) return;

  // Com os 4 marcadores à vista: lê o quadro em resolução total (a mesma imagem
  // é usada pra refinar os cantos, medir com a fita e, se for o caso, virar a foto).
  let fullData = null;
  if (found.size === currentProfile.markers.length) {
    try {
      liveFullCanvas.width = vw;
      liveFullCanvas.height = vh;
      const fctx = liveFullCanvas.getContext("2d", { willReadFrequently: true });
      fctx.drawImage(video, 0, 0, vw, vh);
      fullData = fctx.getImageData(0, 0, vw, vh);
      refineFoundMarkers(found, fullData);
    } catch (err) { fullData = null; }
  }

  const result = evaluateLiveFrame(found, vw, vh);
  const elapsed = Math.round(performance.now() - t0);
  const detail =
    `v${APP_VERSION} · ${vw}x${vh} · ${elapsed}ms · achados: ${found.size ? [...found.keys()].sort().join(",") : "nenhum"}` +
    (result.m.side != null ? ` · marcador ${result.m.side}px` : "") +
    (result.m.skew != null ? ` · inclinação ${result.m.skew}%` : "") +
    (result.m.move != null ? ` · mov ${result.m.move}px` : "");
  let avgErr = null;
  if (result.ok) {
    liveGoodCount++;
    liveBadStreak = 0;
    const e = liveCalibrationErrorPct(found);
    if (e != null) {
      liveErrHistory.push(e);
      if (liveErrHistory.length > LIVE_STABLE_FRAMES) liveErrHistory.shift();
      avgErr = liveErrHistory.reduce((a, b) => a + b, 0) / liveErrHistory.length;
    }
  } else {
    liveBadStreak++;
    // um quadro ruim isolado (detecção falhou 1x) não zera a contagem
    if (liveBadStreak >= 2) { liveGoodCount = 0; liveErrHistory = []; liveBestFrame = null; liveExactTries = 0; liveBestExact = null; }
    if (result.level === "bad") livePrevCenters = null;
  }
  const pc = (v) => v.toFixed(2).replace(".", ",") + "%";
  const metaStr = pc(LIVE_TARGET_ERR_PCT);
  const roughStr = avgErr != null ? pc(avgErr) : "…";

  const overlayColor = result.ok ? "#35d68a" : (result.level === "warn" ? "#ffc400" : "#ff6b6b");
  drawLiveOverlay(found, vw, vh, overlayColor);

  if (result.ok) {
    const stable = liveGoodCount >= LIVE_STABLE_FRAMES && liveErrHistory.length >= LIVE_STABLE_FRAMES;
    if (!stable || avgErr == null || avgErr > LIVE_PRECHECK_PCT) {
      // ainda ajustando: mostra a estimativa rápida (só 4 cantos)
      setLiveHint("warn",
        stable
          ? `Ajustando — erro estimado ${roughStr}. Segure reto, ajuste a distância e evite reflexo nos marcadores`
          : `Boa posição — segure parado… ${liveGoodCount}/${LIVE_STABLE_FRAMES}`,
        detail + ` · 4 cantos ${roughStr}`);
    } else {
      setLiveHint("warn", "Medindo com a fita de referência…", detail + ` · 4 cantos ${roughStr}`);
      const exact = liveFinalError(found, vw, vh, fullData);
      if (!liveActive) return;
      if (exact) {
        liveExactTries++;
        if (liveBestFrame == null || exact.pct < liveBestFrame.pct) {
          liveBestCanvas.width = vw;
          liveBestCanvas.height = vh;
          liveBestCanvas.getContext("2d").drawImage(liveFullCanvas, 0, 0);
          liveBestFrame = { pct: exact.pct, found };
        }
        liveBestExact = liveBestFrame.pct;
        const exactStr = pc(exact.pct);
        const info = detail + ` · 4 cantos ${roughStr} · com fita ${exactStr} (${exact.ribbonPts} pts)`;
        if (exact.pct <= LIVE_TARGET_ERR_PCT) {
          if (autoCaptureToggle.checked) {
            setLiveHint("good", `Perfeito! Erro ${exactStr} — capturando…`, info);
            if (navigator.vibrate) navigator.vibrate(60);
            captureFromVideo(found, liveFullCanvas);
            return;
          }
          setLiveHint("good", `Foto ajustada (erro ${exactStr}) — pode tirar a foto`, info);
        } else if (autoCaptureToggle.checked && liveExactTries >= LIVE_MAX_TRIES) {
          // não chegou na meta depois de várias medições: usa o melhor quadro que viu
          setLiveHint("good", `Não chegou em ${metaStr} — capturando a melhor foto (erro ${pc(liveBestFrame.pct)})…`, info);
          if (navigator.vibrate) navigator.vibrate(60);
          captureFromVideo(liveBestFrame.found, liveBestCanvas);
          return;
        } else {
          setLiveHint("warn",
            `Quase lá — erro ${exactStr} (meta até ${metaStr}; melhor até agora ${pc(liveBestExact)}). Medição ${liveExactTries}/${LIVE_MAX_TRIES}: se não chegar na meta, uso a melhor foto`,
            info);
        }
      }
    }
  } else {
    setLiveHint(result.level, result.text, detail);
  }

  liveTimer = setTimeout(liveTick, Math.max(60, 160 - (performance.now() - t0)));
}

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

// Detecta os marcadores do perfil em várias escalas: começa na escala rápida
// e só tenta resoluções maiores se faltar marcador (em foto de celular, depois de
// reduzir pra ~1400px o marcador pode ficar pequeno demais pra decodificar).
// Considera só os IDs do perfil atual: a fita da borda gera falsos marcadores
// (ids aleatórios) que não podem entrar na calibração.
async function detectProfileMarkers(srcW, srcH) {
  const wanted = new Set(currentProfile.markers.map((m) => m.id));
  const found = new Map(); // id -> { id, corners (px da foto original) }
  const debug = { scales: [], rawQuads: [] };
  const perimeter = (cs) => cs.reduce((a, c, i) => a + Math.hypot(cs[(i + 1) % 4].x - c.x, cs[(i + 1) % 4].y - c.y), 0);
  const detector = new AR.Detector({ dictionaryName: matConfig.dictionary });
  const longSide = Math.max(srcW, srcH);
  const sides = [DETECT_MAX_SIDE, 2200, 3200];
  const tried = new Set();
  for (const side of sides) {
    const scale = Math.min(1, side / longSide);
    const key = scale.toFixed(4);
    if (tried.has(key)) continue;
    tried.add(key);
    if (found.size >= wanted.size) break;
    const dW = Math.round(srcW * scale);
    const dH = Math.round(srcH * scale);
    detectCanvas.width = dW;
    detectCanvas.height = dH;
    const dctx = detectCanvas.getContext("2d", { willReadFrequently: true });
    dctx.drawImage(sourceCanvas, 0, 0, dW, dH);
    const imageData = dctx.getImageData(0, 0, dW, dH);
    if (side > DETECT_MAX_SIDE) {
      setStatus("Procurando marcadores em maior resolução...");
      await nextFrame();
    }
    const dets = detector.detect(imageData);
    debug.scales.push({ side: Math.max(dW, dH), ids: dets.map((m) => m.id) });
    for (const m of dets) {
      debug.rawQuads.push({ id: m.id, corners: m.corners.map((c) => ({ x: c.x / scale, y: c.y / scale })) });
      if (!wanted.has(m.id)) continue;
      const corners = m.corners.map((c) => ({ x: c.x / scale, y: c.y / scale }));
      const prev = found.get(m.id);
      if (!prev || perimeter(corners) > perimeter(prev.corners)) found.set(m.id, { id: m.id, corners });
    }
  }
  return { found, debug };
}

async function processImage() {
  stepProcess.classList.remove("hidden");
  stepResult.classList.add("hidden");
  if (el("diagCanvas")) el("diagCanvas").classList.add("hidden");
  stepProcess.scrollIntoView({ behavior: "smooth", block: "start" });
  setProgress(0.05);

  await nextFrame();
  setStatus("Preparando imagem para detecção...");
  await nextFrame();

  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;

  setStatus("Detectando marcadores do tapete...");
  setProgress(0.15);
  await nextFrame();

  // Os cantos já vêm em coordenadas da foto original (resolução total),
  // independente da escala em que cada tentativa de detecção rodou.
  const scaleDetect = 1;
  // pixels da foto em resolução total: usados pra refinar os cantos dos marcadores,
  // ler a fita e fazer o warp final (lidos uma vez só)
  const srcCtx = sourceCanvas.getContext("2d");
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH);
  let found, detectDebug;
  const preset = presetMarkers;
  presetMarkers = null;
  try {
    if (preset && preset.w === srcW && preset.h === srcH && preset.found.size >= currentProfile.markers.length) {
      // captura automática: usa os marcadores já medidos no quadro analisado ao vivo
      found = preset.found;
      detectDebug = { scales: [], rawQuads: [] };
    } else {
      ({ found, debug: detectDebug } = await detectProfileMarkers(srcW, srcH));
      refineFoundMarkers(found, srcData);
    }
  } catch (err) {
    setStatus("Erro ao detectar marcadores: " + err.message, "error");
    setProgress(0);
    return;
  }

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
      `Tente novamente com mais marcadores da borda visíveis, bem iluminados e sem reflexo. ` +
      `[v${APP_VERSION} · foto ${srcW}x${srcH} · tentativas: ${detectDebug.scales.map((t) => t.side + "px→" + (t.ids.length ? t.ids.join(",") : "nenhum")).join(" | ")}]`,
      "error"
    );
    drawDetectionDiagnostic(found, detectDebug);
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
  const lens = (ribbonResult && ribbonResult.lens) || null;
  const foundForCheck = undistortFound(found, lens);
  const Hinv = invert3x3(H);

  // Autoverificação: cada marcador tem um tamanho real conhecido (marker_size_mm).
  // Medimos o próprio marcador DEPOIS de corrigido e comparamos com esse valor —
  // se não bater, a suposição de geometria do tapete (ou a detecção) está errada,
  // e isso teria passado batido com um ajuste de só 4 pontos (sempre "perfeito").
  const calibration = checkCalibrationQuality(H, usedMarkers, foundForCheck, scaleDetect, pxPerMm, currentProfile.marker_size_mm);

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
  }, lens);
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
          ? ` Calibração refinada com ${ribbonResult.pointsUsed} pontos da fita de referência.` +
            (ribbonResult.lens ? ` Distorção da lente corrigida (k1 = ${(ribbonResult.lens.k1 * 100).toFixed(2).replace(".", ",")}%).` : "") +
            ` Concordância da fita com a calibração: média ${mmStr(ribbonResult.resid.final.mean)}, 95% dos pontos até ${mmStr(ribbonResult.resid.final.p95)}` +
            ` (só com os 4 cantos seria: média ${mmStr(ribbonResult.resid.cornersOnly.mean)}, até ${mmStr(ribbonResult.resid.cornersOnly.p95)}).` +
            ` Isso mede a consistência da foto, não o erro de escala de impressão do tapete.`
          : ` Fita de referência não pôde ser lida com confiança (usando só os 4 cantos) — confira iluminação/foco da borda.`)
      : "");

  showCalibrationWarning(calibration, currentProfile);

  setStatus("Concluído!", "ok");
  setProgress(1);
  stepResult.classList.remove("hidden");
  stepResult.scrollIntoView({ behavior: "smooth", block: "start" });
  setupDownloadShare(finalCanvas);
  currentResult = {
    canvas: finalCanvas, profileName: currentProfile.nome, errPct: calibration.maxAbsErrorPct,
    geo: { canvas: finalCanvas, outW, outH, pxPerMm, profile: currentProfile },
  };
  currentResult.vectorPromise = runVectorization(currentResult);
  btnMoreYes.disabled = false;
  btnMoreNo.disabled = false;
}

// Em caso de falha, mostra a foto com o que foi detectado (verde = marcador do
// tapete, vermelho = detecção com ID que não é do tapete) pra dar pra ver
// o que o app está enxergando.
function drawDetectionDiagnostic(found, debug) {
  const cv = el("diagCanvas");
  if (!cv) return;
  const maxW = 900;
  const k = Math.min(1, maxW / sourceCanvas.width);
  cv.width = Math.round(sourceCanvas.width * k);
  cv.height = Math.round(sourceCanvas.height * k);
  const ctx = cv.getContext("2d");
  ctx.drawImage(sourceCanvas, 0, 0, cv.width, cv.height);
  ctx.lineWidth = 3;
  ctx.font = "bold 18px Arial";
  const draw = (corners, color, label) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    corners.forEach((c, i) => (i ? ctx.lineTo(c.x * k, c.y * k) : ctx.moveTo(c.x * k, c.y * k)));
    ctx.closePath();
    ctx.stroke();
    ctx.fillText(label, corners[0].x * k + 4, corners[0].y * k - 4);
  };
  for (const q of debug.rawQuads) if (!found.has(q.id)) draw(q.corners, "#ff4d4d", "?" + q.id);
  for (const m of found.values()) draw(m.corners, "#35d68a", "ID " + m.id);
  cv.classList.remove("hidden");
}

/* REFINE-BEGIN */
// Refinamento sub-pixel dos cantos de um marcador. O detector (js-aruco2) acha o
// contorno numa imagem binarizada e erra ~1px nos cantos, o que já dá ~1% no
// tamanho de um marcador de ~90px. Aqui cada lado do quadrado preto é re-medido
// no ponto em que a intensidade cruza o meio entre preto e branco, uma reta é
// ajustada por mínimos quadrados e os cantos são as interseções das retas.
// Em fotos sintéticas com verdade conhecida: check de tamanho de ~1,4% para ~0,1-0,5%
// e erro real de posição 30-40% menor.
function refineMarkerCorners(data, w, h, corners) {
  const gray = (x, y) => {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return null;
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const fx = x - x0, fy = y - y0;
    const g = (xx, yy) => { const i = (yy * w + xx) * 4; return (data[i] + data[i + 1] + data[i + 2]) / 3; };
    const top = g(x0, y0) + (g(x1, y0) - g(x0, y0)) * fx;
    const bot = g(x0, y1) + (g(x1, y1) - g(x0, y1)) * fx;
    return top + (bot - top) * fy;
  };
  const cx = corners.reduce((a, c) => a + c.x, 0) / 4, cy = corners.reduce((a, c) => a + c.y, 0) / 4;
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 12) return null;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    let nx = -uy, ny = ux;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; } // normal aponta pra fora do marcador
    // janela de busca: até ~8% do lado (a borda preta e a zona branca têm 12,5% cada)
    const half = Math.max(2.5, Math.min(14, len * 0.08));
    const step = half > 6 ? 0.5 : 0.25;
    const pts = [];
    for (let k = 0; k < 11; k++) {
      const t = 0.2 + 0.6 * (k / 10);
      const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
      const sm = [];
      let outside = false;
      for (let d = -half; d <= half + 1e-9; d += step) {
        const g = gray(px + nx * d, py + ny * d);
        if (g === null) { outside = true; break; }
        sm.push({ d, g });
      }
      if (outside) continue;
      let lo = Infinity, hi = -Infinity;
      for (const q of sm) { if (q.g < lo) lo = q.g; if (q.g > hi) hi = q.g; }
      if (hi - lo < 40) continue; // sem transição preto/branco clara
      const mid = (lo + hi) / 2;
      let best = null;
      for (let j = 0; j < sm.length - 1; j++) {
        if (sm[j].g < mid && sm[j + 1].g >= mid) { // escuro (dentro) -> claro (fora)
          const d = sm[j].d + ((mid - sm[j].g) / (sm[j + 1].g - sm[j].g)) * (sm[j + 1].d - sm[j].d);
          if (best === null || Math.abs(d) < Math.abs(best)) best = d;
        }
      }
      if (best !== null) pts.push({ x: px + nx * best, y: py + ny * best });
    }
    if (pts.length < 5) return null;
    const fit = (P) => {
      const mx2 = P.reduce((q, p) => q + p.x, 0) / P.length, my2 = P.reduce((q, p) => q + p.y, 0) / P.length;
      let sxx = 0, sxy = 0, syy = 0;
      for (const p of P) { const dx = p.x - mx2, dy = p.y - my2; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      return { x: mx2, y: my2, dx: Math.cos(ang), dy: Math.sin(ang) };
    };
    let L = fit(pts);
    const res = (p) => Math.abs((p.x - L.x) * -L.dy + (p.y - L.y) * L.dx);
    const sorted = [...pts].sort((p, q) => res(p) - res(q));
    L = fit(sorted.slice(0, Math.max(5, Math.ceil(sorted.length * 0.8)))); // descarta os 20% piores
    lines.push(L);
  }
  const out = [];
  for (let i = 0; i < 4; i++) { // canto i = interseção da reta (i-1) com a reta i
    const A = lines[(i + 3) % 4], B = lines[i];
    const det = A.dx * -B.dy - A.dy * -B.dx;
    if (Math.abs(det) < 1e-6) return null;
    const t = ((B.x - A.x) * -B.dy - (B.y - A.y) * -B.dx) / det;
    out.push({ x: A.x + A.dx * t, y: A.y + A.dy * t });
  }
  return out;
}

// Refina todos os marcadores achados (cantos em px da imagem completa). Se o
// resultado fugir demais do detector (reflexo, borda mal lida), mantém o original.
function refineFoundMarkers(found, imageData) {
  for (const m of found.values()) {
    const r = refineMarkerCorners(imageData.data, imageData.width, imageData.height, m.corners);
    if (!r) continue;
    const maxShift = Math.max(4, markerSidePx(m.corners) * 0.1);
    if (r.every((c, i) => Math.hypot(c.x - m.corners[i].x, c.y - m.corners[i].y) <= maxShift)) m.corners = r;
  }
}
/* REFINE-END */

const mmStr = (v) => v.toFixed(2).replace(".", ",") + " mm";

/* VECTOR-BEGIN */
// Vetorização do contorno das peças na imagem corrigida (1 px = 1/pxPerMm mm; o pixel de
// índice i corresponde à coordenada i/pxPerMm mm, origem no canto do tapete).
// Passos: valor (canal máximo) -> máscara (borda do tapete e marcadores) -> sementes da peça
// (parte bem clara) -> MODELO DE FUNDO local (tapete + reflexo, estimado só onde não é peça)
// -> peça = o que fica bem acima do fundo (+ fita adesiva verde, por cor) -> componentes
// -> contorno sub-pixel por marching squares (contorno externo e furos) -> refino local da
// borda -> simplificação Douglas-Peucker em mm.

// soma em janela quadrada (2r+1), bordas truncadas, O(N)
function boxSum(src, w, h, r) {
  const N = w * h;
  const tmp = new Float32Array(N), out = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) s += src[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      const add = x + r + 1, rem = x - r;
      if (add < w) s += src[row + add];
      if (rem >= 0) s -= src[row + rem];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s;
      const add = y + r + 1, rem = y - r;
      if (add < h) s += tmp[add * w + x];
      if (rem >= 0) s -= tmp[rem * w + x];
    }
  }
  return out;
}

// Otsu em hist[lo..255]; devolve { t, ratio, gap, lowShare } (ratio = variância entre classes / total)
function otsuRange(hist, lo) {
  let n = 0, sum = 0;
  for (let t = lo; t < 256; t++) { n += hist[t]; sum += t * hist[t]; }
  if (n < 50) return null;
  const mean = sum / n;
  let varT = 0;
  for (let t = lo; t < 256; t++) varT += hist[t] * (t - mean) * (t - mean);
  varT /= n;
  let wB = 0, sumB = 0, best = -1, bt = lo, bGap = 0, bLow = 0;
  for (let t = lo; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = (wB / n) * (wF / n) * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bt = t + 0.5; bGap = mF - mB; bLow = wB / n; }
  }
  return { t: bt, ratio: varT > 0 ? best / varT : 0, gap: bGap, lowShare: bLow };
}

// ---- Arcos de raio pequeno (dedos/orelhas com ponta redonda, cantos arredondados) ----
// O vértice com "bulge" começa um arco até o vértice seguinte (como no DXF: bulge = tan(ângulo/4)).

// reamostra polilinha fechada em passo uniforme ds (mm)
function resampleClosed(pts, ds) {
  const n = pts.length;
  const cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(pts[(i + 1) % n].x - pts[i].x, pts[(i + 1) % n].y - pts[i].y));
  const L = cum[n];
  const m = Math.max(8, Math.round(L / ds));
  const out = [];
  let j = 0;
  for (let k = 0; k < m; k++) {
    const t = (k * L) / m;
    while (j < n - 1 && cum[j + 1] < t) j++;
    const seg = cum[j + 1] - cum[j] || 1e-9;
    const u = (t - cum[j]) / seg;
    const a = pts[j], b = pts[(j + 1) % n];
    out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
  }
  return out;
}

function fitCircleXY(pts) {
  const n = pts.length;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let Suu = 0, Suv = 0, Svv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my;
    Suu += u * u; Suv += u * v; Svv += v * v; Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u;
  }
  const det = Suu * Svv - Suv * Suv;
  if (Math.abs(det) < 1e-9) return null;
  const uc = (Svv * (Suuu + Suvv) / 2 - Suv * (Svvv + Svuu) / 2) / det;
  const vc = (Suu * (Svvv + Svuu) / 2 - Suv * (Suuu + Suvv) / 2) / det;
  const cx = mx + uc, cy = my + vc;
  const r = pts.reduce((a, p) => a + Math.hypot(p.x - cx, p.y - cy), 0) / n;
  const maxRes = Math.max(...pts.map((p) => Math.abs(Math.hypot(p.x - cx, p.y - cy) - r)));
  return { cx, cy, r, maxRes };
}

// Reta (TLS) por pontos: devolve ponto médio, direção unitária e normal unitária
function fitLineXY(pts) {
  const n = pts.length;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dx = Math.cos(ang), dy = Math.sin(ang);
  let maxRes = 0;
  for (const p of pts) maxRes = Math.max(maxRes, Math.abs((p.x - mx) * -dy + (p.y - my) * dx));
  return { x: mx, y: my, dx, dy, nx: -dy, ny: dx, maxRes };
}

// Acha trechos curtos de curvatura alta cujo raio é ~3 mm (entre rMin e rMax) e os troca por um
// arco de FILETE de raio rSnap, tangente às duas retas vizinhas (ajustadas nos trechos retos de
// cada lado). Se as retas forem paralelas (ponta de dedo/orelha), o arco é o semicírculo entre
// elas. Sem retas boas dos dois lados, cai num arco ajustado direto ao trecho curvo.
// Retorna { q (reamostrado e girado), arcs: [{ s, e, S, E, bulge }] }.
function detectArcs(base, rSnap, rMin, rMax, orient) {
  const ds = 0.4, K = 4;
  let q = resampleClosed(base, ds);
  const m = q.length;
  const turnAt = (i) => {
    const a = q[(i - K + m) % m], b = q[i], c = q[(i + K) % m];
    const v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - b.x, v2y = c.y - b.y;
    return Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y);
  };
  let flag = new Uint8Array(m);
  const lim = (22 * Math.PI) / 180;
  for (let i = 0; i < m; i++) if (Math.abs(turnAt(i)) > lim) flag[i] = 1;
  for (let i = 0; i < m; i++) { // fecha vãos de até 2 pontos
    if (flag[i]) continue;
    let a = 1; while (a <= 2 && !flag[(i - a + m) % m]) a++;
    let b = 1; while (b <= 2 && !flag[(i + b) % m]) b++;
    if (a <= 2 && b <= 2) flag[i] = 2;
  }
  for (let i = 0; i < m; i++) if (flag[i] === 2) flag[i] = 1;
  // gira pra que o índice 0 fique no MEIO do maior trecho sem curva (nenhum arco cruza o início)
  let bestStart = -1, bestLen = 0;
  for (let i = 0; i < m; i++) {
    if (flag[i] || flag[(i - 1 + m) % m] === 0) continue; // só começos de trecho sem curva
    let len = 0;
    while (len < m && !flag[(i + len) % m]) len++;
    if (len > bestLen) { bestLen = len; bestStart = i; }
  }
  if (bestStart < 0) return { q, arcs: [] };
  const rot = (bestStart + Math.floor(bestLen / 2)) % m;
  q = q.slice(rot).concat(q.slice(0, rot));
  flag = Array.from(flag.slice(rot)).concat(Array.from(flag.slice(0, rot)));

  const arcs = [];
  const TWO = Math.PI * 2;
  let i = 0;
  while (i < m) {
    if (!flag[i]) { i++; continue; }
    let e = i;
    while (e + 1 < m && flag[e + 1]) e++;
    const n = e - i + 1;
    const s0 = i; i = e + 1;
    if (n * ds > 16 || n < 3) continue;
    if (s0 < 3 || e > m - 4) continue;
    const seg = q.slice(s0 - 1, e + 2);
    const c = fitCircleXY(seg);
    if (!c || c.r < rMin || c.r > rMax || c.maxRes > 0.45) continue;
    let phi = 0;
    for (let k = s0; k <= e; k++) {
      const a = q[k - 1], b = q[k], d = q[k + 1];
      phi += Math.atan2((b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x), (b.x - a.x) * (d.x - b.x) + (b.y - a.y) * (d.y - b.y));
    }
    if (Math.abs(phi) < (25 * Math.PI) / 180 || Math.abs(phi) > (200 * Math.PI) / 180) continue;
    // arco côncavo (sentido oposto ao do contorno): o desfoque arredonda quina viva, então exige
    // um ajuste mais rigoroso (raio entre 2,7 e 3,5 mm e resíduo menor) pra não inventar raio
    if (orient && Math.sign(phi) !== orient && (c.r < 2.7 || c.r > 3.5 || c.maxRes > 0.3)) continue;

    // retas vizinhas: pontos retos antes e depois do trecho (até ~7 mm, parando em outra curva)
    const before = [], after = [];
    for (let k = s0 - 3; k >= 0 && !flag[k] && before.length < 18; k--) before.push(q[k]);
    for (let k = e + 3; k < m && !flag[k] && after.length < 18; k++) after.push(q[k]);
    let S = null, E = null, ctr = null, rad = rSnap;
    if (before.length >= 8 && after.length >= 8) {
      const L1 = fitLineXY(before), L2 = fitLineXY(after);
      if (L1.maxRes <= 0.35 && L2.maxRes <= 0.35) {
        const cross = Math.abs(L1.dx * L2.dy - L1.dy * L2.dx);
        const s1 = (c.cx - L1.x) * L1.nx + (c.cy - L1.y) * L1.ny;
        const s2 = (c.cx - L2.x) * L2.nx + (c.cy - L2.y) * L2.ny;
        if (cross < Math.sin((8 * Math.PI) / 180)) {
          // paralelas: semicírculo entre elas (largura deve dar ~2R)
          const dd = Math.abs((L2.x - L1.x) * L1.nx + (L2.y - L1.y) * L1.ny);
          if (Math.abs(dd / 2 - rSnap) <= 0.8) {
            const target = ((L2.x - L1.x) * L1.nx + (L2.y - L1.y) * L1.ny) / 2;
            ctr = { x: c.cx + L1.nx * (target - s1), y: c.cy + L1.ny * (target - s1) };
            rad = dd / 2;
          }
        } else {
          // filete de raio rSnap: centro no cruzamento das retas deslocadas rSnap pro lado do centro
          const o1 = Math.sign(s1) * rSnap, o2 = Math.sign(s2) * rSnap;
          const p1 = { x: L1.x + L1.nx * o1, y: L1.y + L1.ny * o1 }, p2 = { x: L2.x + L2.nx * o2, y: L2.y + L2.ny * o2 };
          const det = L1.dx * L2.dy - L1.dy * L2.dx;
          const t = ((p2.x - p1.x) * L2.dy - (p2.y - p1.y) * L2.dx) / det;
          const cc = { x: p1.x + L1.dx * t, y: p1.y + L1.dy * t };
          if (Math.hypot(cc.x - c.cx, cc.y - c.cy) <= 2.5) { ctr = cc; rad = rSnap; }
        }
        if (ctr) {
          const f1 = (ctr.x - L1.x) * L1.dx + (ctr.y - L1.y) * L1.dy, f2 = (ctr.x - L2.x) * L2.dx + (ctr.y - L2.y) * L2.dy;
          S = { x: L1.x + L1.dx * f1, y: L1.y + L1.dy * f1 };
          E = { x: L2.x + L2.dx * f2, y: L2.y + L2.dy * f2 };
        }
      }
    }
    if (!S) { // sem retas boas: arco ajustado direto ao trecho curvo
      ctr = { x: c.cx, y: c.cy }; rad = rSnap;
      const proj = (p) => { const dx = p.x - c.cx, dy = p.y - c.cy, L = Math.hypot(dx, dy) || 1; return { x: c.cx + (dx / L) * rSnap, y: c.cy + (dy / L) * rSnap }; };
      S = proj(q[s0]); E = proj(q[e]);
    }
    let d = Math.atan2(E.y - ctr.y, E.x - ctr.x) - Math.atan2(S.y - ctr.y, S.x - ctr.x);
    if (phi > 0) d = ((d % TWO) + TWO) % TWO; else d = -((((-d) % TWO) + TWO) % TWO);
    // pontos do caminho entre as extremidades: devem ficar dentro do trecho (s0-6 .. e+6)
    arcs.push({ s: Math.max(1, s0 - 3), e: Math.min(m - 2, e + 3), S, E, bulge: Math.tan(d / 4) });
  }
  return { q, arcs };
}

// pontos densos de um contorno com arcos (pra área, desenho e dimensões)
function expandLoop(pts, perArc) {
  const out = [];
  const n = pts.length;
  const steps = perArc || 12;
  for (let i = 0; i < n; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % n];
    out.push({ x: p0.x, y: p0.y });
    if (!p0.bulge) continue;
    const b = p0.bulge, dx = p1.x - p0.x, dy = p1.y - p0.y, c = Math.hypot(dx, dy) || 1e-9;
    const h = (c / 2) * ((1 - b * b) / (2 * b));
    const cx = (p0.x + p1.x) / 2 + (-dy / c) * h, cy = (p0.y + p1.y) / 2 + (dx / c) * h;
    const a0 = Math.atan2(p0.y - cy, p0.x - cx), sweep = 4 * Math.atan(b), r = Math.hypot(p0.x - cx, p0.y - cy);
    for (let k = 1; k < steps; k++) out.push({ x: cx + r * Math.cos(a0 + (sweep * k) / steps), y: cy + r * Math.sin(a0 + (sweep * k) / steps) });
  }
  return out;
}

function vectorizePiece(data, w, h, pxPerMm, profile, opts) {
  opts = opts || {};
  const N = w * h;
  const g0 = new Uint8Array(N);
  const tape = new Uint8Array(N); // verde saturado = fita adesiva (faz parte da peça: emenda)
  // valor = canal MÁXIMO (não a média): tinta colorida e fita contam como peça
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    g0[i] = Math.max(r, g, b);
    if (g >= r + 35 && g >= b + 35 && g - Math.min(r, b) >= 60) tape[i] = 1;
  }
  // suavização 3x3 (tira ruído de JPEG/textura sem mexer na posição da borda)
  const tmp = new Float32Array(N);
  const gray = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x, xp = x < w - 1 ? x + 1 : x;
      tmp[r + x] = (g0[r + xm] + g0[r + x] + g0[r + xp]) / 3;
    }
  }
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : y) * w, yc = y * w, yp = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) gray[yc + x] = (tmp[ym + x] + tmp[yc + x] + tmp[yp + x]) / 3;
  }

  // máscara: faixa da borda (fita de referência) e marcadores com margem
  const excl = new Uint8Array(N);
  const sc = profile.marker_size_mm / 100;
  const edgePx = opts.noMask ? 0 : Math.ceil(30 * sc * pxPerMm);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < edgePx || y < edgePx || x >= w - edgePx || y >= h - edgePx) excl[y * w + x] = 1;
    }
  }
  for (const m of (opts.noMask ? [] : profile.markers)) {
    const c = markerRealXY(m, profile);
    const half = (profile.marker_size_mm / 2 + 6 * sc) * pxPerMm;
    const x0 = Math.max(0, Math.floor(c.x * pxPerMm - half)), x1 = Math.min(w - 1, Math.ceil(c.x * pxPerMm + half));
    const y0 = Math.max(0, Math.floor(c.y * pxPerMm - half)), y1 = Math.min(h - 1, Math.ceil(c.y * pxPerMm + half));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) excl[y * w + x] = 1;
  }

  // 1º nível (Otsu) e, se houver reflexo claro no tapete, 2º nível pra separar a peça dele
  const hist = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < N; i++) {
    if (excl[i]) continue;
    hist[Math.min(255, gray[i] | 0)]++;
    total++;
  }
  if (total < 1000) return { error: "Imagem pequena demais para vetorizar." };
  const o1 = otsuRange(hist, 0);
  const T = o1 ? o1.t : 128;
  // Reflexo no tapete tem borda SUAVE (gradual); peça tem borda nítida. Mede que fração do
  // contorno da área clara é suave: se for grande, há reflexo colado e o 2º nível separa
  // a peça (bem clara) dele. Sem reflexo, o 2º nível não é usado (peças de brilhos diferentes
  // — papel branco e papelão — não podem ser confundidas com fundo).
  let softB = 0, totB = 0;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (excl[i] || gray[i] <= T) continue;
      if (gray[i - 1] > T && gray[i + 1] > T && gray[i - w] > T && gray[i + w] > T) continue;
      const gx = (gray[i + 2] - gray[i - 2]) / 4, gy = (gray[i + 2 * w] - gray[i - 2 * w]) / 4;
      totB++;
      if (Math.hypot(gx, gy) < 8) softB++;
    }
  }
  const softShare = totB > 200 ? softB / totB : 0;
  let Tseed = T;
  const o2 = otsuRange(hist, Math.ceil(T));
  if (softShare >= 0.3 && o2 && o2.ratio >= 0.25 && o2.gap >= 25 && o2.lowShare >= 0.05) Tseed = o2.t;

  // sementes = parte bem clara. Pedaços pequenos são ignorados (poeira, riscos).
  const seeds = new Float32Array(N);
  let seedCount = 0, seedSum = 0;
  for (let i = 0; i < N; i++) {
    if (!excl[i] && gray[i] > Tseed) { seeds[i] = 1; seedCount++; seedSum += gray[i]; }
  }
  const minAreaPx = 800 * pxPerMm * pxPerMm; // < ~800 mm² (28x28mm) é sujeira/reflexo
  if (seedCount < minAreaPx) return { error: "Não encontrei a peça na imagem (nada claro o bastante sobre o tapete)." };
  const pieceLevel = seedSum / seedCount;

  // região "peça ou perto dela" (sementes dilatadas ~20mm): fica FORA do modelo de fundo
  const rD = Math.max(2, Math.round(20 * pxPerMm));
  const dsum = boxSum(seeds, w, h, rD);
  // modelo de fundo = média local (raio ~40mm) do brilho SÓ dos pixels de fora dessa região:
  // segue o gradiente do reflexo do tapete e não é puxado pela peça
  const wgt = new Float32Array(N), gw = new Float32Array(N);
  let bgSum = 0, bgCnt = 0;
  for (let i = 0; i < N; i++) {
    if (dsum[i] === 0 && !excl[i]) { wgt[i] = 1; gw[i] = gray[i]; bgSum += gray[i]; bgCnt++; }
  }
  const bgGlobal = bgCnt ? bgSum / bgCnt : 60;
  const Rb = Math.max(8, Math.round(40 * pxPerMm));
  const num = boxSum(gw, w, h, Rb), den = boxSum(wgt, w, h, Rb);
  const delta = Math.max(35, 0.35 * (pieceLevel - bgGlobal));
  const excess = new Float32Array(N); // brilho acima do fundo local
  const fg = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (excl[i]) { excess[i] = -255; continue; }
    const bg = den[i] >= 40 ? num[i] / den[i] : bgGlobal;
    excess[i] = gray[i] - bg;
    if (excess[i] > delta || (tape[i] && excess[i] > 25)) fg[i] = 1;
  }

  // componentes conexos da peça
  const labels = new Int32Array(N);
  const stack = new Int32Array(N);
  const areas = [0];
  const sums = [0];
  let nl = 0;
  for (let i = 0; i < N; i++) {
    if (!fg[i] || labels[i]) continue;
    nl++;
    let sp = 0, area = 0, sum = 0;
    stack[sp++] = i;
    labels[i] = nl;
    while (sp) {
      const p = stack[--sp];
      area++;
      sum += gray[p];
      const x = p % w, y = (p - x) / w;
      if (x > 0) { const q = p - 1; if (!labels[q] && fg[q]) { labels[q] = nl; stack[sp++] = q; } }
      if (x < w - 1) { const q = p + 1; if (!labels[q] && fg[q]) { labels[q] = nl; stack[sp++] = q; } }
      if (y > 0) { const q = p - w; if (!labels[q] && fg[q]) { labels[q] = nl; stack[sp++] = q; } }
      if (y < h - 1) { const q = p + w; if (!labels[q] && fg[q]) { labels[q] = nl; stack[sp++] = q; } }
    }
    areas.push(area);
    sums.push(sum);
  }
  let maxArea = 0;
  for (let l = 1; l <= nl; l++) if (areas[l] > maxArea) maxArea = areas[l];
  if (maxArea < minAreaPx) return { error: "Não encontrei a peça na imagem (nada claro o bastante sobre o tapete)." };
  if (maxArea > 0.7 * total) return { error: "A área clara ocupa quase todo o tapete — reflexo forte ou peça escura demais pra separar do fundo." };
  const keepLabel = new Uint8Array(nl + 1);
  for (let l = 1; l <= nl; l++) if (areas[l] >= Math.max(minAreaPx, 0.01 * maxArea)) keepLabel[l] = 1;

  // Contraste com o fundo ao redor: peça de verdade é bem mais clara que o tapete em volta.
  {
    const dist = new Uint8Array(N).fill(255);
    const owner = new Int32Array(N);
    let q = [];
    for (let i = 0; i < N; i++) {
      const l = labels[i];
      if (!l || !keepLabel[l]) continue;
      const x = i % w, y = (i - x) / w;
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        labels[i - 1] !== l || labels[i + 1] !== l || labels[i - w] !== l || labels[i + w] !== l;
      if (edge) { dist[i] = 0; owner[i] = l; q.push(i); }
    }
    const ringSum = new Float64Array(nl + 1), ringCnt = new Float64Array(nl + 1);
    for (let d = 1; d <= 6 && q.length; d++) {
      const nq = [];
      for (const p of q) {
        const x = p % w, y = (p - x) / w, l = owner[p];
        const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
        for (const n of nb) {
          if (n < 0 || dist[n] !== 255 || (labels[n] && keepLabel[labels[n]])) continue;
          dist[n] = d; owner[n] = l; nq.push(n);
          if (d >= 3 && !excl[n] && !fg[n]) { ringSum[l] += gray[n]; ringCnt[l]++; }
        }
      }
      q = nq;
    }
    for (let l = 1; l <= nl; l++) {
      if (!keepLabel[l]) continue;
      const meanIn = sums[l] / areas[l];
      const meanRing = ringCnt[l] ? ringSum[l] / ringCnt[l] : 0;
      if (meanIn - meanRing < 50) keepLabel[l] = 0;
    }
    if (!keepLabel.some((v) => v)) return { error: "Não encontrei a peça: o que tem de claro no tapete parece reflexo (pouco contraste com o fundo)." };
  }

  // região de interesse = componentes mantidos dilatados em 3px
  const R = 3;
  const keep = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (labels[i] && keepLabel[labels[i]]) keep[i] = 1;
  const dil1 = new Uint8Array(N), dil = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -R; k <= R && !v; k++) { const xx = x + k; if (xx >= 0 && xx < w && keep[y * w + xx]) v = 1; }
      dil1[y * w + x] = v;
    }
  }
  let minX = w, maxX = 0, minY = h, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -R; k <= R && !v; k++) { const yy = y + k; if (yy >= 0 && yy < h && dil1[yy * w + x]) v = 1; }
      dil[y * w + x] = v;
      if (v) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
  }
  // campo do marching squares: brilho acima do fundo local menos o limiar (sinal coerente com fg)
  const W = w + 2, H2 = h + 2;
  const f = new Float32Array(W * H2).fill(-255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!dil[i] || excl[i]) continue;
      let v = excess[i] - delta;
      if (fg[i] && v <= 0) v = 0.5;
      else if (!fg[i] && v > 0) v = -0.5;
      f[(y + 1) * W + x + 1] = v;
    }
  }

  const traceLoops = (f) => {
  // marching squares com interpolação linear (sub-pixel)
  const segA = [], segB = [];
  const adj = new Map();
  const addSeg = (ka, kb) => {
    const s = segA.length;
    segA.push(ka); segB.push(kb);
    (adj.get(ka) || adj.set(ka, []).get(ka)).push(s);
    (adj.get(kb) || adj.set(kb, []).get(kb)).push(s);
  };
  const y0 = Math.max(0, minY), y1 = Math.min(H2 - 2, maxY + 2);
  const x0 = Math.max(0, minX), x1 = Math.min(W - 2, maxX + 2);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      const fa = f[i], fb = f[i + 1], fc = f[i + W + 1], fd = f[i + W];
      const code = (fa > 0 ? 1 : 0) | (fb > 0 ? 2 : 0) | (fc > 0 ? 4 : 0) | (fd > 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const T_ = i * 2, B_ = (i + W) * 2, L_ = i * 2 + 1, R_ = (i + 1) * 2 + 1; // topo, base, esquerda, direita
      switch (code) {
        case 1: case 14: addSeg(L_, T_); break;
        case 2: case 13: addSeg(T_, R_); break;
        case 3: case 12: addSeg(L_, R_); break;
        case 4: case 11: addSeg(R_, B_); break;
        case 6: case 9: addSeg(T_, B_); break;
        case 7: case 8: addSeg(L_, B_); break;
        case 5: case 10: {
          const centerIn = (fa + fb + fc + fd) / 4 > 0;
          if ((code === 5) === centerIn) { addSeg(T_, R_); addSeg(L_, B_); } else { addSeg(L_, T_); addSeg(R_, B_); }
          break;
        }
      }
    }
  }
  const keyPt = (k) => {
    const idx = k >> 1;
    const px = idx % W, py = (idx - px) / W;
    if (k & 1) { const a = f[idx], b = f[idx + W]; return [px - 1, py - 1 + a / (a - b)]; }
    const a = f[idx], b = f[idx + 1];
    return [px - 1 + a / (a - b), py - 1];
  };

  // Refino local: pra cada ponto do contorno, mede o perfil de brilho na normal (±4px) e leva
  // o ponto pro cruzamento do MEIO entre o nível claro (peça) e o escuro (fundo) dali.
  const gAt = (x, y) => {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return null;
    const xa = Math.floor(x), ya = Math.floor(y), xb = Math.min(xa + 1, w - 1), yb = Math.min(ya + 1, h - 1);
    const fx = x - xa, fy = y - ya;
    const a = gray[ya * w + xa], b = gray[ya * w + xb], c = gray[yb * w + xa], d = gray[yb * w + xb];
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  };
  const refineLoop = (loop) => {
    const n = loop.length;
    const nx = new Float64Array(n), ny = new Float64Array(n), shifts = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = loop[(i - 3 + n) % n], b = loop[(i + 3) % n];
      const tx = b[0] - a[0], ty = b[1] - a[1], L = Math.hypot(tx, ty) || 1;
      nx[i] = ty / L; ny[i] = -tx / L;
    }
    for (let i = 0; i < n; i++) {
      const p = loop[i];
      const prof = [];
      for (let d = -4; d <= 4.001; d += 0.5) {
        const g = gAt(p[0] + nx[i] * d, p[1] + ny[i] * d);
        if (g === null) { prof.length = 0; break; }
        prof.push([d, g]);
      }
      if (prof.length < 17) continue;
      const vals = prof.map((q) => q[1]).sort((u, v) => u - v);
      const lo = (vals[0] + vals[1] + vals[2]) / 3, hi = (vals[16] + vals[15] + vals[14]) / 3;
      if (hi - lo < 50) continue;
      const mid = (lo + hi) / 2;
      let bestD = null;
      for (let j = 0; j < prof.length - 1; j++) {
        const g0_ = prof[j][1], g1_ = prof[j + 1][1];
        if ((g0_ < mid) !== (g1_ < mid)) {
          const d = prof[j][0] + ((mid - g0_) / (g1_ - g0_)) * (prof[j + 1][0] - prof[j][0]);
          if (bestD === null || Math.abs(d) < Math.abs(bestD)) bestD = d;
        }
      }
      if (bestD !== null && Math.abs(bestD) <= 2.5) shifts[i] = bestD;
    }
    return loop.map((p, i) => {
      let sm = 0;
      for (let k = -3; k <= 3; k++) sm += shifts[(i + k + n) % n];
      sm /= 7;
      return [p[0] + nx[i] * sm, p[1] + ny[i] * sm];
    });
  };

  const visited = new Uint8Array(segA.length);
  const rawLoops = [];
  for (let s = 0; s < segA.length; s++) {
    if (visited[s]) continue;
    visited[s] = 1;
    const start = segA[s];
    let cur = segB[s];
    const loop = [keyPt(start)];
    let closed = false;
    for (let guard = 0; guard < segA.length + 2; guard++) {
      if (cur === start) { closed = true; break; }
      loop.push(keyPt(cur));
      const nexts = adj.get(cur) || [];
      let ns = -1;
      for (const c of nexts) if (!visited[c]) { ns = c; break; }
      if (ns < 0) break;
      visited[ns] = 1;
      cur = segA[ns] === cur ? segB[ns] : segA[ns];
    }
    if (closed && loop.length >= 4) {
      const refined = loop.length >= 12 ? refineLoop(loop) : loop;
      rawLoops.push(refined.map((p) => ({ x: p[0] / pxPerMm, y: p[1] / pxPerMm })));
    }
  }

    return rawLoops;
  };

  // simplificação Douglas-Peucker (tolerância 0,15 mm)
  const TOL = 0.4;
  const dp = (pts) => {
    const n = pts.length;
    const keepIdx = new Uint8Array(n);
    keepIdx[0] = 1; keepIdx[n - 1] = 1;
    const st = [[0, n - 1]];
    while (st.length) {
      const [a, b] = st.pop();
      if (b <= a + 1) continue;
      const pa = pts[a], pb = pts[b];
      const dx = pb.x - pa.x, dy = pb.y - pa.y, len = Math.hypot(dx, dy) || 1e-9;
      let md = -1, mi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((pts[i].x - pa.x) * dy - (pts[i].y - pa.y) * dx) / len;
        if (d > md) { md = d; mi = i; }
      }
      if (md > TOL) { keepIdx[mi] = 1; st.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keepIdx[i]);
  };
  const simplifyClosed = (pts) => {
    let fi = 0, fd = -1;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
      if (d > fd) { fd = d; fi = i; }
    }
    const A = dp(pts.slice(0, fi + 1));
    const B = dp([...pts.slice(fi), pts[0]]);
    return [...A.slice(0, -1), ...B.slice(0, -1)];
  };
  const signedArea = (pts) => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
    return a / 2;
  };
  const perim = (pts) => pts.reduce((s, p, i) => s + Math.hypot(pts[(i + 1) % pts.length].x - p.x, pts[(i + 1) % pts.length].y - p.y), 0);
  const inside = (pt, poly) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if ((poly[i].y > pt.y) !== (poly[j].y > pt.y) &&
          pt.x < ((poly[j].x - poly[i].x) * (pt.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) c = !c;
    }
    return c;
  };

  // Furo redondo (parafuso): circularidade alta + ajuste de círculo com resíduo pequeno vira
  // CIRCLE no DXF. Furos pequenos só passam se forem redondos (senão é sujeira/ponto de tinta).
  const fitCircle = (pts) => {
    const n = pts.length;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= n; my /= n;
    let Suu = 0, Suv = 0, Svv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
    for (const p of pts) {
      const u = p.x - mx, v = p.y - my;
      Suu += u * u; Suv += u * v; Svv += v * v; Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u;
    }
    const det = Suu * Svv - Suv * Suv;
    if (Math.abs(det) < 1e-9) return null;
    const uc = (Svv * (Suuu + Suvv) / 2 - Suv * (Svvv + Svuu) / 2) / det;
    const vc = (Suu * (Svvv + Svuu) / 2 - Suv * (Suuu + Suvv) / 2) / det;
    const cx = mx + uc, cy = my + vc;
    const r = pts.reduce((a, p) => a + Math.hypot(p.x - cx, p.y - cy), 0) / n;
    const maxRes = Math.max(...pts.map((p) => Math.abs(Math.hypot(p.x - cx, p.y - cy) - r)));
    return { cx, cy, r, maxRes };
  };
  // Suaviza o ruído da borda (±0,2 mm) com média móvel de 9 pontos, MAS preserva os cantos:
  // um ponto perto de uma virada brusca (>30° em ±6 pontos) fica onde está. Assim as retas saem
  // retas (poucos nós na simplificação) e os cantos continuam vivos.
  const smoothKeepCorners = (pts) => {
    const n = pts.length;
    if (n < 24) return pts;
    const K = 6, HW = 4;
    const corner = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[(i - K + n) % n], b = pts[i], c = pts[(i + K) % n];
      const v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - b.x, v2y = c.y - b.y;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      if (l1 < 1e-9 || l2 < 1e-9) continue;
      const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
      if (cos < Math.cos((30 * Math.PI) / 180)) corner[i] = 1;
    }
    const near = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!corner[i]) continue;
      for (let k = -HW; k <= HW; k++) near[(i + k + n) % n] = 1;
    }
    return pts.map((p, i) => {
      if (near[i]) return p;
      let sx = 0, sy = 0;
      for (let k = -HW; k <= HW; k++) { const q = pts[(i + k + n) % n]; sx += q.x; sy += q.y; }
      return { x: sx / (2 * HW + 1), y: sy / (2 * HW + 1) };
    });
  };
  // Canto vivo: o desfoque arredonda os cantos e a simplificação deixa 2-3 vértices ali. Onde
  // duas retas LONGAS (>=12 mm) se encontram por um trecho curto (<=8 mm total), o trecho é
  // trocado pelo ponto onde as retas se cruzam — se esse ponto estiver perto do trecho (<=6 mm).
  // Retângulo vira 4 nós e o canto deixa de ser arredondado.
  const sharpenCorners = (pts, open) => {
    const n = pts.length;
    if (n < 5) return pts;
    const seg = (i) => ({ a: pts[i], b: pts[(i + 1) % n], len: Math.hypot(pts[(i + 1) % n].x - pts[i].x, pts[(i + 1) % n].y - pts[i].y) });
    const LONG = 12, SHORT_TOTAL = 8, NEAR = 6;
    const longIdx = [];
    for (let i = 0; i < (open ? n - 1 : n); i++) if (seg(i).len >= LONG) longIdx.push(i);
    if (longIdx.length < 2) return pts;
    const replace = new Map(); // índice do 1º vértice do trecho -> { count, point }
    const skip = new Set();
    for (let k = 0; k < longIdx.length; k++) {
      if (open && k === longIdx.length - 1) continue;
      const ia = longIdx[k], ib = longIdx[(k + 1) % longIdx.length];
      if (ia === ib) continue;
      // trecho curto entre o fim do segmento ia e o início do segmento ib: vértices ia+1 .. ib
      const count = (ib - ia - 1 + n) % n; // nº de segmentos curtos no meio
      if (count < 1) continue;
      let total = 0;
      for (let j = 1; j <= count; j++) total += seg((ia + j) % n).len;
      if (total > SHORT_TOTAL) continue;
      const A = seg(ia), B = seg(ib);
      const d1x = (A.b.x - A.a.x) / A.len, d1y = (A.b.y - A.a.y) / A.len;
      const d2x = (B.b.x - B.a.x) / B.len, d2y = (B.b.y - B.a.y) / B.len;
      const det = d1x * d2y - d1y * d2x;
      if (Math.abs(det) < Math.sin((20 * Math.PI) / 180)) continue; // quase paralelas: não é canto
      const t = ((B.a.x - A.a.x) * d2y - (B.a.y - A.a.y) * d2x) / det;
      const P = { x: A.a.x + d1x * t, y: A.a.y + d1y * t };
      const first = pts[(ia + 1) % n], last = pts[ib % n];
      if (Math.hypot(P.x - first.x, P.y - first.y) > NEAR || Math.hypot(P.x - last.x, P.y - last.y) > NEAR) continue;
      replace.set((ia + 1) % n, { count: count + 1, point: P });
      for (let j = 1; j <= count; j++) skip.add((ia + 1 + j) % n);
    }
    if (!replace.size) return pts;
    const out = [];
    for (let i = 0; i < n; i++) {
      if (skip.has(i)) continue;
      out.push(replace.has(i) ? replace.get(i).point : pts[i]);
    }
    return out.length >= 3 ? out : pts;
  };
  const finishLoops = (rawIn) => {
    const cand = rawIn.map((raw) => {
      const area = Math.abs(signedArea(raw)), per = perim(raw);
      let circle = null;
      if (per > 0 && (4 * Math.PI * area) / (per * per) >= 0.88 && area >= 12 && area <= 4000) {
        const c = fitCircle(raw);
        if (c && c.maxRes <= 0.35) circle = { cx: c.cx, cy: c.cy, r: c.r };
      }
      const base = smoothKeepCorners(raw);
      const det = detectArcs(base, 3, 2.3, 3.9, Math.sign(signedArea(raw)));
      let pts;
      if (!det.arcs.length) {
        pts = sharpenCorners(simplifyClosed(base), false);
      } else {
        // arcos de R=3 + cadeias retas/curvas entre eles (simplificadas e com canto vivo)
        const q = det.q, m = q.length;
        pts = [];
        for (let j = 0; j < det.arcs.length; j++) {
          const a = det.arcs[j], nx = det.arcs[(j + 1) % det.arcs.length];
          pts.push({ x: a.S.x, y: a.S.y, bulge: a.bulge });
          const chain = [a.E];
          let idx = (a.e + 1) % m;
          while (idx !== nx.s) { chain.push(q[idx]); idx = (idx + 1) % m; if (chain.length > m) break; }
          chain.push(nx.S);
          const simp = sharpenCorners(dpSimplify(chain, TOL), true);
          for (let t = 0; t < simp.length - 1; t++) pts.push({ x: simp[t].x, y: simp[t].y });
        }
      }
      return { pts, area, per, circle };
    }).filter((l) => l.pts.length >= 3 && ((l.area >= 50 && l.per >= 30) || l.circle));
    if (!cand.length) return null;
    return cand.map((l, i) => {
      let depth = 0;
      cand.forEach((other, j) => { if (j !== i && inside(l.pts[0], other.pts)) depth++; });
      return { pts: l.pts, circle: l.circle, hole: depth % 2 === 1, areaMm2: l.area, perimeterMm: l.per };
    });
  };
  const loops = finishLoops(traceLoops(f));
  if (!loops) return { error: "Não consegui traçar o contorno da peça." };

  // ---- Silhueta: UMA linha fechada por peça (sem janela interna, sem frestas) ----
  // A = peça detectada. Fecha (closing, raio ~12 mm) e preenche o que fica cercado (janela). Só
  // reaproveita do fechamento o que está LIGADO a esse preenchimento (a fresta que escura da foto
  // abriu na peça) — as concavidades reais da borda externa ficam como estão, sem arredondar.
  // Furos redondos (parafuso) continuam, vindos do contorno detalhado.
  let silhouette = null;
  {
    const rS = Math.max(3, Math.round(12 * pxPerMm));
    const Af = new Float32Array(N);
    for (let i = 0; i < N; i++) Af[i] = keep[i];
    const d1 = boxSum(Af, w, h, rS);
    for (let i = 0; i < N; i++) d1[i] = d1[i] > 0 ? 1 : 0;
    const e1 = boxSum(d1, w, h, rS);
    const fullS = (2 * rS + 1) * (2 * rS + 1) - 0.5;
    const C = new Uint8Array(N);
    for (let i = 0; i < N; i++) C[i] = keep[i] || e1[i] >= fullS ? 1 : 0;
    // fundo alcançável a partir da borda da imagem
    const outside = new Uint8Array(N);
    let sp = 0;
    const pushOut = (i) => { if (!C[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; } };
    for (let x = 0; x < w; x++) { pushOut(x); pushOut((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { pushOut(y * w); pushOut(y * w + w - 1); }
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p - x) / w;
      if (x > 0) pushOut(p - 1);
      if (x < w - 1) pushOut(p + 1);
      if (y > 0) pushOut(p - w);
      if (y < h - 1) pushOut(p + w);
    }
    const extra = new Uint8Array(N); // pixels a juntar à peça
    const isW = (i) => !C[i] && !outside[i];
    for (let i = 0; i < N; i++) if (isW(i)) extra[i] = 1;
    const seen = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!C[i] || keep[i] || seen[i]) continue;
      const comp = [i];
      seen[i] = 1;
      let touchesW = false;
      for (let qi = 0; qi < comp.length; qi++) {
        const p = comp[qi], x = p % w, y = (p - x) / w;
        const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
        for (const n of nb) {
          if (n < 0) continue;
          if (isW(n)) touchesW = true;
          else if (C[n] && !keep[n] && !seen[n]) { seen[n] = 1; comp.push(n); }
        }
      }
      if (touchesW) for (const p of comp) extra[p] = 1;
    }
    const fS = Float32Array.from(f);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (extra[i] && !excl[i]) { const k = (y + 1) * W + x + 1; if (fS[k] < 1) fS[k] = 1; }
      }
    }
    const loopsS = finishLoops(traceLoops(fS));
    if (loopsS) silhouette = [...loopsS.filter((l) => !l.hole), ...loops.filter((l) => l.hole && l.circle)];
  }

  const outer = loops.filter((l) => !l.hole);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const l of outer) for (const p of expandLoop(l.pts)) { bx0 = Math.min(bx0, p.x); by0 = Math.min(by0, p.y); bx1 = Math.max(bx1, p.x); by1 = Math.max(by1, p.y); }
  return {
    loops,
    silhouette,
    bbox: { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 },
    areaMm2: outer.reduce((s, l) => s + l.areaMm2, 0) - loops.filter((l) => l.hole).reduce((s, l) => s + l.areaMm2, 0),
    perimeterMm: loops.reduce((s, l) => s + l.perimeterMm, 0),
    threshold: Tseed,
    internals: opts.keepInternals ? { gray, g0, fg, labels, keepLabel, excl, w, h } : null,
    dbg: { T, Tseed, softShare: +softShare.toFixed(2), pieceLevel: Math.round(pieceLevel), bgGlobal: Math.round(bgGlobal), delta: Math.round(delta), components: nl, kept: keepLabel.reduce((a, b) => a + b, 0), loops: loops.length },
  };
}

// Douglas-Peucker em polilinha aberta (pontos em mm)
function dpSimplify(pts, tol) {
  const n = pts.length;
  if (n < 3) return pts;
  const keepIdx = new Uint8Array(n);
  keepIdx[0] = 1; keepIdx[n - 1] = 1;
  const st = [[0, n - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    if (b <= a + 1) continue;
    const pa = pts[a], pb = pts[b];
    const dx = pb.x - pa.x, dy = pb.y - pa.y, len = Math.hypot(dx, dy) || 1e-9;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i].x - pa.x) * dy - (pts[i].y - pa.y) * dx) / len;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keepIdx[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keepIdx[i]);
}

// máx (isMax) ou mín em janela (2r+1) separável, só dentro da caixa [x0..x1] x [y0..y1]
function slideMinMax(src, w, h, r, isMax, x0, y0, x1, y1) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let v = isMax ? -Infinity : Infinity;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        const a = src[y * w + xx];
        if (isMax ? a > v : a < v) v = a;
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let v = isMax ? -Infinity : Infinity;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        const a = tmp[yy * w + x];
        if (isMax ? a > v : a < v) v = a;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

// Linhas de caneta (verde/azul) desenhadas sobre a peça — o desenhista as traça numa camada
// separada. Acha tinta escura, de tom frio, DENTRO da peça (máscara fechada por closing), afina
// até 1px (esqueleto de Zhang-Suen) e segue os caminhos mais longos de cada componente,
// descartando traços curtos (letras, números, riscos). Devolve [{ pts: [{x,y} em mm] }].
function extractInkLines(data, w, h, pxPerMm, I) {
  const N = w * h;
  const { gray, g0, fg, labels, keepLabel, excl } = I;
  const keepF = new Float32Array(N);
  for (let i = 0; i < N; i++) if (labels[i] && keepLabel[labels[i]]) keepF[i] = 1;
  // peça "fechada": o closing cobre traços de até ~5 mm que furam a máscara da peça
  const rC = Math.max(2, Math.round(2.5 * pxPerMm));
  const dil = boxSum(keepF, w, h, rC);
  for (let i = 0; i < N; i++) dil[i] = dil[i] > 0 ? 1 : 0;
  const ero = boxSum(dil, w, h, rC);
  const full = (2 * rC + 1) * (2 * rC + 1) - 0.5;
  const closedF = new Float32Array(N);
  for (let i = 0; i < N; i++) closedF[i] = ero[i] >= full ? 1 : 0;
  const rE = Math.max(3, Math.round(3 * pxPerMm)); // ignora ~3 mm junto da borda da peça
  const inner = boxSum(closedF, w, h, rE);
  const fullE = (2 * rE + 1) * (2 * rE + 1) - 0.5;
  // brilho local do papel (média dos pixels claros da peça, raio ~8 mm)
  const gwp = new Float32Array(N), fgF = new Float32Array(N);
  for (let i = 0; i < N; i++) if (fg[i]) { gwp[i] = gray[i]; fgF[i] = 1; }
  const Rp = Math.max(6, Math.round(8 * pxPerMm));
  const numP = boxSum(gwp, w, h, Rp), denP = boxSum(fgF, w, h, Rp);

  // linha fina escura = black top-hat do canal máximo bruto (fechamento 7x7 menos a imagem):
  // pega traço de 1px que o suavizado apagaria, sem depender do brilho do papel
  let kx0 = w, ky0 = h, kx1 = 0, ky1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keepF[y * w + x]) { if (x < kx0) kx0 = x; if (x > kx1) kx1 = x; if (y < ky0) ky0 = y; if (y > ky1) ky1 = y; }
  const g0f = new Float32Array(N);
  for (let i = 0; i < N; i++) g0f[i] = g0[i];
  const rc = 3;
  const bx0c = Math.max(rc, kx0 - rc), by0c = Math.max(rc, ky0 - rc), bx1c = Math.min(w - 1 - rc, kx1 + rc), by1c = Math.min(h - 1 - rc, ky1 + rc);
  const dilG = slideMinMax(g0f, w, h, rc, true, bx0c, by0c, bx1c, by1c);
  const clos = slideMinMax(dilG, w, h, rc, false, bx0c + rc, by0c + rc, bx1c - rc, by1c - rc);
  const weak = new Uint8Array(N), strong = [];
  const mask = new Uint8Array(N);
  let bx0 = w, by0 = h, bx1 = 0, by1 = 0, count = 0;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (excl[i] || inner[i] < fullE || denP[i] < 30) continue;
      const bh = clos[i] - g0f[i];
      if (bh < 15) continue;                                  // não é traço fino escuro
      if (g0f[i] >= numP[i] / denP[i] - 20) continue;       // e tem que ser mais escuro que o papel ao redor
      const j = i * 4, r = data[j], g = data[j + 1], b = data[j + 2];
      if (r > g + 20 && r > b + 20) continue;               // tinta vermelha: texto, não linha
      if (b >= g + 15 && b >= r + 25) continue;             // azul forte: escrita à mão
      if (g >= r + 35 && g >= b + 35 && g - Math.min(r, b) >= 60) continue; // fita adesiva
      weak[i] = 1;
      if (bh >= 28) strong.push(i);
    }
  }
  {
    const stk = [];
    for (const i of strong) { mask[i] = 1; stk.push(i); }
    while (stk.length) {
      const p = stk.pop(), x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const n = yy * w + xx;
          if (weak[n] && !mask[n]) { mask[n] = 1; stk.push(n); }
        }
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        count++;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
    }
  }
  if (count < 20) return [];
  {
    const tmpM = new Uint8Array(N);
    for (let y = Math.max(1, by0 - 1); y <= Math.min(h - 2, by1 + 1); y++) {
      for (let x = Math.max(1, bx0 - 1); x <= Math.min(w - 2, bx1 + 1); x++) {
        const i = y * w + x;
        if (mask[i] || mask[i - 1] || mask[i + 1] || mask[i - w] || mask[i + w]) tmpM[i] = 1;
      }
    }
    mask.set(tmpM);
    bx0 = Math.max(1, bx0 - 1); by0 = Math.max(1, by0 - 1); bx1 = Math.min(w - 2, bx1 + 1); by1 = Math.min(h - 2, by1 + 1);
  }

  // afinamento (Zhang-Suen)
  const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = Math.max(1, by0 - 1); y <= Math.min(h - 2, by1 + 1); y++) {
        for (let x = Math.max(1, bx0 - 1); x <= Math.min(w - 2, bx1 + 1); x++) {
          const i = y * w + x;
          if (!mask[i]) continue;
          const p2 = mask[i - w], p3 = mask[i - w + 1], p4 = mask[i + 1], p5 = mask[i + w + 1];
          const p6 = mask[i + w], p7 = mask[i + w - 1], p8 = mask[i - 1], p9 = mask[i - w - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (A !== 1) continue;
          if (pass === 0) { if (p2 * p4 * p6 || p4 * p6 * p8) continue; }
          else if (p2 * p4 * p8 || p2 * p6 * p8) continue;
          del.push(i);
        }
      }
      for (const i of del) mask[i] = 0;
      if (del.length) changed = true;
    }
  }

  // caminhos: maior caminho de cada componente do esqueleto, retirado e repetido nas sobras
  const skel = [];
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) if (mask[y * w + x]) skel.push(y * w + x);
  const alive = mask; // reaproveita: 1 = pixel de esqueleto ainda não usado
  const stamp = new Int32Array(N), par = new Int32Array(N);
  let stp = 0;
  const NB = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  const bfs = (start) => {
    stp++;
    const q = [start];
    stamp[start] = stp; par[start] = -1;
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi], x = p % w, y = (p - x) / w;
      for (const [dx, dy] of NB) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const n = yy * w + xx;
        if (alive[n] && stamp[n] !== stp) { stamp[n] = stp; par[n] = p; q.push(n); }
      }
    }
    return q;
  };
  const minLenMm = 60;
  const lines = [];
  for (const s0 of skel) {
    if (!alive[s0]) continue;
    const q1 = bfs(s0);
    const A = q1[q1.length - 1];
    const q2 = bfs(A);
    const Bn = q2[q2.length - 1];
    const path = [];
    for (let p = Bn; p !== -1; p = par[p]) path.push(p);
    let len = 0;
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1], b = path[k];
      len += Math.hypot((a % w) - (b % w), Math.floor(a / w) - Math.floor(b / w));
    }
    if (len / pxPerMm < minLenMm) { for (const p of q2) alive[p] = 0; continue; } // componente só tem traços curtos
    for (const p of path) alive[p] = 0;
    let pts = path.map((p) => ({ x: (p % w) / pxPerMm, y: Math.floor(p / w) / pxPerMm }));
    // suaviza a escada do esqueleto (média de 5 pontos, extremos fixos) e simplifica
    if (pts.length > 8) {
      pts = pts.map((p, i) => {
        if (i < 2 || i > pts.length - 3) return p;
        let sx = 0, sy = 0;
        for (let k = -2; k <= 2; k++) { sx += pts[i + k].x; sy += pts[i + k].y; }
        return { x: sx / 5, y: sy / 5 };
      });
    }
    pts = dpSimplify(pts, 0.3);
    if (pts.length >= 2) lines.push({ pts });
  }

  // liga fragmentos alinhados (vão de até ~12 mm na direção da linha) — a tinta fraca quebra a linha
  const lenOf = (pts) => pts.reduce((a, p, i) => a + (i ? Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);
  const tangentAt = (pts, atEnd) => {
    const n = pts.length;
    const a = atEnd ? pts[n - 1] : pts[0];
    let b = atEnd ? pts[n - 2] : pts[1];
    for (let k = 2; k < n; k++) {
      const c = atEnd ? pts[n - k] : pts[k - 1];
      if (Math.hypot(a.x - c.x, a.y - c.y) >= 6) { b = c; break; }
      b = c;
    }
    const dx = a.x - b.x, dy = a.y - b.y, L = Math.hypot(dx, dy) || 1;
    return { x: dx / L, y: dy / L };
  };
  const GAP = 30, MAXANG = (30 * Math.PI) / 180;
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        for (const ei of [false, true]) {
          for (const ej of [false, true]) {
            const A = lines[i].pts, B = lines[j].pts;
            const pa = ei ? A[A.length - 1] : A[0], pb = ej ? B[B.length - 1] : B[0];
            const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
            if (d > GAP) continue;
            const ta = tangentAt(A, ei), tb = tangentAt(B, ej);
            const cx = d > 0.5 ? (pb.x - pa.x) / d : ta.x, cy = d > 0.5 ? (pb.y - pa.y) / d : ta.y;
            const angA = Math.acos(Math.max(-1, Math.min(1, ta.x * cx + ta.y * cy)));
            const angB = Math.acos(Math.max(-1, Math.min(1, -(tb.x * cx + tb.y * cy))));
            const angAB = Math.acos(Math.max(-1, Math.min(1, -(ta.x * tb.x + ta.y * tb.y))));
            if (angA > MAXANG || angB > MAXANG || angAB > MAXANG * 1.5) continue;
            const first = ei ? A : [...A].reverse();
            const second = ej ? [...B].reverse() : B;
            lines[i] = { pts: dpSimplify([...first, ...second], 0.3) };
            lines.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
  }

  // tortuosidade: linha de caneta é reta/curva suave; escrita à mão é cheia de voltas
  const out = [];
  const rejected = [];
  for (const ln of lines) {
    const L = lenOf(ln.pts);
    const chord = Math.hypot(ln.pts[0].x - ln.pts[ln.pts.length - 1].x, ln.pts[0].y - ln.pts[ln.pts.length - 1].y) || 1e-9;
    ln.lengthMm = L; ln.tort = L / chord; ln.vertPer10 = (ln.pts.length / L) * 10;
    if (L >= minLenMm && ln.tort <= 1.45 && ln.vertPer10 <= 3) out.push(ln);
    else rejected.push({ x: Math.round(ln.pts[0].x), y: Math.round(ln.pts[0].y), len: Math.round(L), tort: +ln.tort.toFixed(2), v10: +ln.vertPer10.toFixed(1) });
  }
  out.rejected = rejected;
  return out;
}

// DXF (R12, ASCII, polylines fechadas em mm, Y pra cima). Contorno externo na camada
// CONTORNO e furos na camada FURO.
function vectorToDXF(vec, matHeightMm) {
  const L = [];
  const add = (code, val) => { L.push(String(code)); L.push(String(val)); };
  add(0, "SECTION"); add(2, "HEADER"); add(9, "$ACADVER"); add(1, "AC1009"); add(9, "$INSUNITS"); add(70, 4); add(0, "ENDSEC");
  add(0, "SECTION"); add(2, "TABLES");
  add(0, "TABLE"); add(2, "LTYPE"); add(70, 1);
  add(0, "LTYPE"); add(2, "CONTINUOUS"); add(70, 0); add(3, "Solid line"); add(72, 65); add(73, 0); add(40, "0.0");
  add(0, "ENDTAB");
  add(0, "TABLE"); add(2, "LAYER"); add(70, 3);
  add(0, "LAYER"); add(2, "CONTORNO"); add(70, 0); add(62, 7); add(6, "CONTINUOUS");
  add(0, "LAYER"); add(2, "FURO"); add(70, 0); add(62, 1); add(6, "CONTINUOUS");
  add(0, "LAYER"); add(2, "LINHAS"); add(70, 0); add(62, 2); add(6, "CONTINUOUS");
  add(0, "ENDTAB");
  add(0, "ENDSEC");
  add(0, "SECTION"); add(2, "ENTITIES");
  for (const l of vec.loops) {
    const layer = l.hole ? "FURO" : "CONTORNO";
    if (l.circle) {
      add(0, "CIRCLE"); add(8, layer); add(10, l.circle.cx.toFixed(3)); add(20, (matHeightMm - l.circle.cy).toFixed(3)); add(30, "0.0"); add(40, l.circle.r.toFixed(3));
      continue;
    }
    add(0, "POLYLINE"); add(8, layer); add(66, 1); add(70, 1);
    for (const p of l.pts) { add(0, "VERTEX"); add(8, layer); add(10, p.x.toFixed(3)); add(20, (matHeightMm - p.y).toFixed(3)); add(30, "0.0"); if (p.bulge) add(42, (-p.bulge).toFixed(6)); }
    add(0, "SEQEND"); add(8, layer);
  }
  for (const ln of (vec.lines || [])) {
    add(0, "POLYLINE"); add(8, "LINHAS"); add(66, 1); add(70, 0);
    for (const p of ln.pts) { add(0, "VERTEX"); add(8, "LINHAS"); add(10, p.x.toFixed(3)); add(20, (matHeightMm - p.y).toFixed(3)); add(30, "0.0"); }
    add(0, "SEQEND"); add(8, "LINHAS");
  }
  add(0, "ENDSEC"); add(0, "EOF");
  return L.join("\n") + "\n";
}

// SVG em mm (mesma orientação da imagem, Y pra baixo).
function vectorToSVG(vec, matWidthMm, matHeightMm) {
  const path = (pts, close) => {
    let d = "M" + pts[0].x.toFixed(3) + " " + pts[0].y.toFixed(3);
    const n = pts.length;
    const last = close ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % n];
      if (p0.bulge) {
        const sweep = 4 * Math.atan(p0.bulge), c = Math.hypot(p1.x - p0.x, p1.y - p0.y);
        const r = Math.abs(c / (2 * Math.sin(sweep / 2)));
        d += " A" + r.toFixed(3) + " " + r.toFixed(3) + " 0 " + (Math.abs(sweep) > Math.PI ? 1 : 0) + " " + (sweep > 0 ? 1 : 0) + " " + p1.x.toFixed(3) + " " + p1.y.toFixed(3);
      } else d += " L" + p1.x.toFixed(3) + " " + p1.y.toFixed(3);
    }
    return d + (close ? " Z" : "");
  };
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + matWidthMm.toFixed(1) + 'mm" height="' + matHeightMm.toFixed(1) + 'mm" viewBox="0 0 ' + matWidthMm.toFixed(3) + " " + matHeightMm.toFixed(3) + '">');
  for (const l of vec.loops) {
    if (l.circle) out.push('  <circle cx="' + l.circle.cx.toFixed(3) + '" cy="' + l.circle.cy.toFixed(3) + '" r="' + l.circle.r.toFixed(3) + '" fill="none" stroke="#ff0000" stroke-width="0.25"/>');
    else out.push('  <path d="' + path(l.pts, true) + '" fill="none" stroke="' + (l.hole ? "#ff0000" : "#000000") + '" stroke-width="0.25"/>');
  }
  for (const ln of (vec.lines || [])) out.push('  <path d="' + path(ln.pts, false) + '" fill="none" stroke="#c8a000" stroke-width="0.25"/>');
  out.push("</svg>");
  return out.join("\n") + "\n";
}
/* VECTOR-END */

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
  // A fita é gerada nas medidas do projeto; se o tapete tem escala de impressão
  // medida, as células (posição e tamanho) encolhem/esticam junto com ele.
  let ribbonCells = Ribbon.buildRibbonCells(profile.nominal || profile, seqBits);
  if (profile.nominal) {
    const fx = profile.width_mm / profile.nominal.width_mm, fy = profile.height_mm / profile.nominal.height_mm;
    ribbonCells = ribbonCells.map((c) => ({ ...c, x: c.x * fx, y: c.y * fy, w: c.w * fx, h: c.h * fy, cx: c.cx * fx, cy: c.cy * fy }));
  }

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
    const halfBand = Math.min(cell.w, cell.h) / 2; // meia largura da faixa (10mm no projeto)
    const [expPxV, expPyV] = applyH(HroughInv, (cell.cx + vx * halfBand) * pxPerMm, (cell.cy + vy * halfBand) * pxPerMm);
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
  const nCorners = cornerSrcPts.length;
  const undist = (pts, lens) => (lens ? pts.map((p) => { const [x, y] = lensUndistort(lens, p.x, p.y); return { x, y }; }) : pts);

  // Ajusta a homografia descartando os 15% piores pontos por resíduo (os cantos
  // dos marcadores sempre ficam): um ponto da fita às vezes cai numa posição ruim
  // e sem isso ele puxa a calibração toda.
  const trimFit = (lens) => {
    const u = undist(allSrc, lens);
    const H0 = computeHomography(u, allDst);
    const residuals = u.map((p, i) => {
      const [px, py] = applyH(H0, p.x, p.y);
      return Math.hypot(px - allDst[i].x, py - allDst[i].y);
    });
    const sortedRes = [...residuals].sort((x, y) => x - y);
    const cutoff = sortedRes[Math.floor(sortedRes.length * 0.85)];
    const keptSrc = [], keptDst = [];
    for (let i = 0; i < allSrc.length; i++) {
      if (i < nCorners || residuals[i] <= cutoff) { keptSrc.push(allSrc[i]); keptDst.push(allDst[i]); }
    }
    return { H: computeHomography(undist(keptSrc, lens), keptDst), keptSrc, keptDst };
  };

  // Distorção radial da lente (k1): a fita corre ao longo das 4 bordas, então uma lente
  // com distorção entorta essas "retas" e a homografia sozinha não consegue explicar.
  // Só aceita a correção se ela reduzir bem o resíduo (senão é ruído).
  let fitted = trimFit(null);
  let lens = null;
  const fit = fitLensK1(fitted.keptSrc, fitted.keptDst, srcW, srcH);
  if (Math.abs(fit.k1) >= LENS_MIN_K1 && fit.cost1 <= fit.cost0 * 0.85) {
    lens = { k1: fit.k1, cx: srcW / 2, cy: srcH / 2, R: Math.hypot(srcW / 2, srcH / 2) };
    fitted = trimFit(lens);
  }
  const Hfinal = fitted.H;

  // Concordância em mm: onde a fita aparece na foto vs onde deveria estar segundo a
  // calibração (final e só-4-cantos). Mede consistência geométrica do conjunto (ruído,
  // distorção da lente, inclinação) — NÃO enxerga erro de escala de impressão do tapete,
  // que afeta tudo por igual.
  const Hrough = invert3x3(HroughInv);
  const residMm = (H, pts) => pts.map((p, i) => {
    const [px, py] = applyH(H, p.x, p.y);
    return Math.hypot(px - extraDst[i].x, py - extraDst[i].y) / pxPerMm;
  });
  const stats = (arr) => {
    const sorted = [...arr].sort((x, y) => x - y);
    return {
      mean: arr.reduce((x, y) => x + y, 0) / arr.length,
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    };
  };
  const resid = {
    final: stats(residMm(Hfinal, undist(extraSrc, lens))),
    cornersOnly: stats(residMm(Hrough, extraSrc)),
  };
  return { Hfinal, pointsUsed: extraSrc.length, resid, lens };
}

/* Distorção radial simples: ponto_foto = centro + (ideal - centro) * (1 + k1 * r²),
   com r = distância ao centro / meia-diagonal da imagem. */
const LENS_MIN_K1 = 0.0008;

function lensDistort(lens, ux, uy) {
  const r2 = ((ux - lens.cx) ** 2 + (uy - lens.cy) ** 2) / (lens.R * lens.R);
  const f = 1 + lens.k1 * r2;
  return [lens.cx + (ux - lens.cx) * f, lens.cy + (uy - lens.cy) * f];
}

function lensUndistort(lens, x, y) {
  let ux = x, uy = y;
  for (let i = 0; i < 5; i++) {
    const r2 = ((ux - lens.cx) ** 2 + (uy - lens.cy) ** 2) / (lens.R * lens.R);
    const f = 1 + lens.k1 * r2;
    ux = lens.cx + (x - lens.cx) / f;
    uy = lens.cy + (y - lens.cy) / f;
  }
  return [ux, uy];
}

function undistortFound(found, lens) {
  if (!lens) return found;
  const out = new Map();
  for (const [id, m] of found) {
    out.set(id, { id, corners: m.corners.map((c) => { const [x, y] = lensUndistort(lens, c.x, c.y); return { x, y }; }) });
  }
  return out;
}

// Acha o k1 que minimiza o resíduo da homografia (busca por seção áurea em ±4%).
function fitLensK1(src, dst, w, h) {
  const base = { cx: w / 2, cy: h / 2, R: Math.hypot(w / 2, h / 2) };
  const cost = (k1) => {
    const lens = { ...base, k1 };
    const u = src.map((p) => { const [x, y] = lensUndistort(lens, p.x, p.y); return { x, y }; });
    let H;
    try { H = computeHomography(u, dst); } catch (e) { return Infinity; }
    let sum = 0;
    for (let i = 0; i < u.length; i++) {
      const [px, py] = applyH(H, u[i].x, u[i].y);
      sum += (px - dst[i].x) ** 2 + (py - dst[i].y) ** 2;
    }
    return Math.sqrt(sum / u.length);
  };
  let lo = -0.04, hi = 0.04;
  const gr = (Math.sqrt(5) - 1) / 2;
  let c = hi - gr * (hi - lo), d = lo + gr * (hi - lo);
  let fc = cost(c), fd = cost(d);
  for (let i = 0; i < 26; i++) {
    if (fc < fd) { hi = d; d = c; fd = fc; c = hi - gr * (hi - lo); fc = cost(c); }
    else { lo = c; c = d; fc = fd; d = lo + gr * (hi - lo); fd = cost(d); }
  }
  const k1 = (lo + hi) / 2;
  return { k1, cost0: cost(0), cost1: cost(k1) };
}

async function warpPerspective(srcData, outImageData, Hinv, srcW, srcH, onProgress, lens) {
  const outW = outImageData.width;
  const outH = outImageData.height;
  const out = outImageData.data;
  const ROWS_PER_CHUNK = 40;

  for (let yStart = 0; yStart < outH; yStart += ROWS_PER_CHUNK) {
    const yEnd = Math.min(yStart + ROWS_PER_CHUNK, outH);
    for (let y = yStart; y < yEnd; y++) {
      for (let x = 0; x < outW; x++) {
        let [sx, sy] = applyH(Hinv, x, y);
        if (lens) [sx, sy] = lensDistort(lens, sx, sy);
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
  currentResult = null; // refazer: descarta esta foto (não vai pro lote)
  stepResult.classList.add("hidden");
  stepProcess.classList.add("hidden");
  openCamera(false);
});

/* ------------------------------------------------------------------ *
 * Vetorização automática das peças (DXF / SVG em mm reais)
 * Padrão: UMA linha fechada por peça (silhueta). Janela interna e linhas de caneta são opções.
 * ------------------------------------------------------------------ */

const vectorToggle = el("vectorToggle");
const vectorInfo = el("vectorInfo");
const vectorActions = el("vectorActions");
const vectorShow = el("vectorShow");
const vectorWindows = el("vectorWindows");
const vectorInk = el("vectorInk");
const vectorOverlay = el("vectorOverlay");
const btnDxf = el("btnDxf");
const btnSvg = el("btnSvg");

function bindFlag(cb, key, onChange) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) cb.checked = v === "1";
  } catch (e) { /* usa o padrão do HTML */ }
  cb.addEventListener("change", () => {
    try { localStorage.setItem(key, cb.checked ? "1" : "0"); } catch (e) { /* ok */ }
    onChange();
  });
}
const rerunVector = () => { if (currentResult) currentResult.vectorPromise = runVectorization(currentResult); };
bindFlag(vectorToggle, "moldeflat_vector_auto", rerunVector);
bindFlag(vectorInk, "moldeflat_vector_ink", rerunVector);
bindFlag(vectorWindows, "moldeflat_vector_windows", () => { if (currentResult && currentResult.vectorRaw) buildVectorView(currentResult); });
vectorShow.addEventListener("change", () => vectorOverlay.classList.toggle("hidden", !vectorShow.checked));

function clearVectorUI() {
  vectorActions.classList.add("hidden");
  vectorInfo.textContent = "";
  vectorOverlay.getContext("2d").clearRect(0, 0, vectorOverlay.width, vectorOverlay.height);
}

function drawVectorOverlay(view, pxPerMm) {
  const W = resultCanvas.width, H = resultCanvas.height;
  vectorOverlay.width = W;
  vectorOverlay.height = H;
  const ctx = vectorOverlay.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  ctx.lineWidth = Math.max(2, W / 450);
  ctx.lineJoin = "round";
  const X = (v) => v * pxPerMm + 0.5;
  for (const l of view.loops) {
    ctx.strokeStyle = l.hole ? "#ff3b3b" : "#18ff6d";
    ctx.beginPath();
    if (l.circle) {
      ctx.arc(X(l.circle.cx), X(l.circle.cy), l.circle.r * pxPerMm, 0, Math.PI * 2);
    } else {
      expandLoop(l.pts, 10).forEach((p, i) => (i ? ctx.lineTo(X(p.x), X(p.y)) : ctx.moveTo(X(p.x), X(p.y))));
      ctx.closePath();
    }
    ctx.stroke();
  }
  ctx.strokeStyle = "#ffb300";
  for (const ln of view.lines) {
    ctx.beginPath();
    ln.pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), X(p.y)) : ctx.moveTo(X(p.x), X(p.y))));
    ctx.stroke();
  }
  vectorOverlay.classList.toggle("hidden", !vectorShow.checked);
}

async function runVectorization(holder) {
  const isCurrent = () => currentResult === holder;
  holder.vector = null;
  holder.vectorRaw = null;
  if (isCurrent()) clearVectorUI();
  if (!vectorToggle.checked) {
    if (isCurrent()) vectorInfo.textContent = "Vetorização automática desligada.";
    return;
  }
  if (isCurrent()) vectorInfo.textContent = "Vetorizando as peças…";
  await nextFrame();
  const { canvas, outW, outH, pxPerMm, profile } = holder.geo;
  let vec;
  try {
    const img = canvas.getContext("2d").getImageData(0, 0, outW, outH);
    vec = vectorizePiece(img.data, outW, outH, pxPerMm, profile, { keepInternals: vectorInk.checked });
    if (!vec.error && vectorInk.checked && vec.internals) vec.lines = extractInkLines(img.data, outW, outH, pxPerMm, vec.internals);
    vec.internals = null;
  } catch (e) {
    vec = { error: "Erro ao vetorizar: " + e.message };
  }
  if (vec.error) {
    if (isCurrent()) vectorInfo.textContent = vec.error;
    return;
  }
  holder.vectorRaw = vec;
  buildVectorView(holder);
}

// Monta o que será exportado a partir do resultado bruto e das opções marcadas.
function buildVectorView(holder) {
  const raw = holder.vectorRaw;
  const { outW, outH, pxPerMm } = holder.geo;
  let loops;
  if (vectorWindows.checked) loops = raw.loops.filter((l) => !l.hole || l.circle || l.areaMm2 >= 300);
  else loops = raw.silhouette || raw.loops.filter((l) => !l.hole || l.circle);
  const view = { loops, lines: vectorInk.checked ? (raw.lines || []) : [] };
  view.dxf = vectorToDXF(view, outH / pxPerMm);
  view.svg = vectorToSVG(view, outW / pxPerMm, outH / pxPerMm);
  holder.vector = view;
  if (currentResult !== holder) return;
  drawVectorOverlay(view, pxPerMm);
  const fmt = (v) => v.toFixed(1).replace(".", ",");
  const outer = loops.filter((l) => !l.hole);
  const holes = loops.length - outer.length;
  const nodes = loops.reduce((a, l) => a + (l.circle ? 1 : l.pts.length), 0) + view.lines.reduce((a, l) => a + l.pts.length, 0);
  const arcCount = loops.reduce((a, l) => a + (l.circle ? 0 : l.pts.filter((p) => p.bulge).length), 0);
  const dims = outer.slice(0, 8).map((l, i) => {
    const dense = expandLoop(l.pts, 10);
    const xs = dense.map((p) => p.x), ys = dense.map((p) => p.y);
    return "Peça " + (i + 1) + ": " + fmt(Math.max(...xs) - Math.min(...xs)) + " x " + fmt(Math.max(...ys) - Math.min(...ys)) + " mm";
  });
  vectorInfo.textContent =
    outer.length + " peça(s), uma linha fechada cada" + (holes ? ", " + holes + " furo(s)" : "") +
    (arcCount ? ", " + arcCount + " arco(s) R3" : "") + (view.lines.length ? ", " + view.lines.length + " linha(s) de caneta" : "") + " · " + nodes + " nós no total\n" +
    dims.join("\n") + "\nConfira o desenho verde sobre a imagem antes de mandar cortar.";
  vectorActions.classList.remove("hidden");
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
btnDxf.addEventListener("click", () => {
  if (currentResult && currentResult.vector) downloadText(currentResult.vector.dxf, "molde_" + fileStamp(new Date()) + ".dxf");
});
btnSvg.addEventListener("click", () => {
  if (currentResult && currentResult.vector) downloadText(currentResult.vector.svg, "molde_" + fileStamp(new Date()) + ".svg");
});

/* ------------------------------------------------------------------ *
 * Lote de fotos: guarda cada foto aprovada (no aparelho, em IndexedDB —
 * sobrevive a fechar/recarregar o app) e envia/baixa tudo de uma vez.
 * ------------------------------------------------------------------ */

const btnMoreYes = el("btnMoreYes");
const btnMoreNo = el("btnMoreNo");
const batchSection = el("step-batch");
const batchTitle = el("batchTitle");
const batchList = el("batchList");
const btnBatchShare = el("btnBatchShare");
const btnBatchZip = el("btnBatchZip");
const btnBatchShareZip = el("btnBatchShareZip");
const btnBatchMore = el("btnBatchMore");
const btnBatchClear = el("btnBatchClear");

let currentResult = null; // { canvas, profileName, errPct } da foto que está na tela de resultado
let batch = [];           // { id, seq, name, blob, thumbUrl, profile, errPct }
let memoryOnlyId = 0;

const DB_NAME = "moldeflat";
const DB_STORE = "photos";
let dbPromise = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE, { keyPath: "id", autoIncrement: true });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  return dbPromise;
}
async function dbRun(mode, fn) {
  const db = await getDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const store = db.transaction(DB_STORE, mode).objectStore(DB_STORE);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result === undefined ? true : req.result);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}
const dbAll = async () => (await dbRun("readonly", (st) => st.getAll())) || [];
const dbAdd = (rec) => dbRun("readwrite", (st) => st.add(rec));
const dbDelete = (id) => dbRun("readwrite", (st) => st.delete(id));
const dbClear = () => dbRun("readwrite", (st) => st.clear());

function makeThumb(canvas) {
  const t = document.createElement("canvas");
  t.width = 240;
  t.height = Math.round(canvas.height * (240 / canvas.width));
  t.getContext("2d").drawImage(canvas, 0, 0, t.width, t.height);
  return new Promise((res) => t.toBlob(res, "image/jpeg", 0.7));
}

function fileStamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function addToBatchList(rec) {
  batch.push({
    id: rec.id, seq: rec.seq, name: rec.name, blob: rec.blob,
    thumbUrl: URL.createObjectURL(rec.thumb), profile: rec.profile, errPct: rec.errPct,
    dxf: rec.dxf || null, svg: rec.svg || null,
  });
}

async function saveCurrentToBatch() {
  if (!currentResult) return;
  const r = currentResult;
  currentResult = null;
  if (r.vectorPromise) { try { await r.vectorPromise; } catch (e) { /* segue sem vetor */ } }
  const blob = await new Promise((res) => r.canvas.toBlob(res, "image/png"));
  const thumb = await makeThumb(r.canvas);
  const seq = batch.reduce((m, b) => Math.max(m, b.seq), 0) + 1;
  const name = `molde_${String(seq).padStart(2, "0")}_${fileStamp(new Date())}.png`;
  const rec = {
    seq, name, blob, thumb, profile: r.profileName, errPct: r.errPct, createdAt: Date.now(),
    dxf: r.vector ? r.vector.dxf : null, svg: r.vector ? r.vector.svg : null,
  };
  const id = await dbAdd(rec);
  rec.id = id != null ? id : --memoryOnlyId; // sem IndexedDB: fica só na memória da sessão
  addToBatchList(rec);
  renderBatch();
}

async function loadBatch() {
  const recs = (await dbAll()).sort((a, b) => a.seq - b.seq);
  for (const rec of recs) addToBatchList(rec);
  renderBatch();
}

function renderBatch() {
  batchList.innerHTML = "";
  for (const b of batch) {
    const item = document.createElement("div");
    item.className = "batch-item";
    const img = document.createElement("img");
    img.src = b.thumbUrl;
    img.alt = b.name;
    const label = document.createElement("span");
    label.textContent = "#" + String(b.seq).padStart(2, "0") + " · " + b.errPct.toFixed(2).replace(".", ",") + "%" + (b.dxf ? " · DXF" : "");
    const del = document.createElement("button");
    del.className = "batch-del";
    del.type = "button";
    del.setAttribute("aria-label", "Remover foto " + b.seq);
    del.textContent = "×";
    del.addEventListener("click", () => removeFromBatch(b.id));
    item.append(img, label, del);
    batchList.appendChild(item);
  }
  batchTitle.textContent = "Fotos guardadas (" + batch.length + ")";
  batchSection.classList.toggle("hidden", batch.length === 0);
}

async function removeFromBatch(id) {
  const b = batch.find((x) => x.id === id);
  if (!b || !confirm("Remover a foto #" + b.seq + " do lote?")) return;
  await dbDelete(id);
  URL.revokeObjectURL(b.thumbUrl);
  batch = batch.filter((x) => x.id !== id);
  renderBatch();
}

async function answerMore(more) {
  btnMoreYes.disabled = true;
  btnMoreNo.disabled = true;
  try { await saveCurrentToBatch(); } catch (e) { /* segue mesmo assim */ }
  stepResult.classList.add("hidden");
  stepProcess.classList.add("hidden");
  if (more) openCamera(false);
  else batchSection.scrollIntoView({ behavior: "smooth", block: "start" });
}
btnMoreYes.addEventListener("click", () => answerMore(true));
btnMoreNo.addEventListener("click", () => answerMore(false));

btnBatchMore.addEventListener("click", () => {
  stepResult.classList.add("hidden");
  stepProcess.classList.add("hidden");
  openCamera(false);
});

btnBatchShare.addEventListener("click", async () => {
  const files = batch.map((b) => new File([b.blob], b.name, { type: "image/png" }));
  if (!files.length) return;
  if (!(navigator.canShare && navigator.canShare({ files }))) {
    alert("Este navegador não consegue compartilhar várias fotos de uma vez. Use \"Baixar todas (.zip)\".");
    return;
  }
  try {
    await navigator.share({ files, title: "Moldes digitalizados (" + files.length + ")" });
  } catch (e) {
    if (e && e.name !== "AbortError") alert("Não foi possível compartilhar: " + e.message);
  }
});

async function buildBatchZip() {
  const files = [];
  for (const b of batch) {
    files.push({ name: b.name, blob: b.blob });
    const base = b.name.replace(/\.png$/, "");
    if (b.dxf) files.push({ name: base + ".dxf", blob: new Blob([b.dxf]) });
    if (b.svg) files.push({ name: base + ".svg", blob: new Blob([b.svg]) });
  }
  return buildZip(files);
}

btnBatchShareZip.addEventListener("click", async () => {
  if (!batch.length) return;
  const zip = await buildBatchZip();
  const file = new File([zip], "moldes_" + fileStamp(new Date()) + ".zip", { type: "application/zip" });
  if (!(navigator.canShare && navigator.canShare({ files: [file] }))) {
    alert("Este navegador não consegue compartilhar o .zip direto. Use \"Baixar todas (.zip)\" e envie o arquivo baixado.");
    return;
  }
  try {
    await navigator.share({ files: [file], title: "Moldes digitalizados (" + batch.length + ")" });
  } catch (e) {
    if (e && e.name !== "AbortError") alert("Não foi possível compartilhar: " + e.message);
  }
});

btnBatchZip.addEventListener("click", async () => {
  if (!batch.length) return;
  const zip = await buildBatchZip();
  const url = URL.createObjectURL(zip);
  const a = document.createElement("a");
  a.href = url;
  a.download = "moldes_" + fileStamp(new Date()) + ".zip";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

btnBatchClear.addEventListener("click", async () => {
  if (!batch.length || !confirm("Apagar as " + batch.length + " fotos guardadas? Isso não pode ser desfeito.")) return;
  await dbClear();
  for (const b of batch) URL.revokeObjectURL(b.thumbUrl);
  batch = [];
  renderBatch();
});

/* ZIP-BEGIN — gerador de .zip simples (sem compressão: PNG já é comprimido) */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function buildZip(files) {
  const enc = new TextEncoder();
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((n, p) => n + (p.byteLength !== undefined ? p.byteLength : p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
/* ZIP-END */

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
  loadBatch().catch(() => {});
  loadProfiles().catch((err) => {
    alert("Erro ao carregar os perfis do tapete (mat-profiles.json): " + err.message);
  });
};
