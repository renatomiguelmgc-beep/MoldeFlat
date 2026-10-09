"use strict";

/* ------------------------------------------------------------------ *
 * Configuração / estado
 * ------------------------------------------------------------------ */

const APP_VERSION = "2026-10-09.2";
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
    let H = Hrough, ribbonPts = 0;
    if (currentProfile.ribbon) {
      const r = refineHomographyWithRibbon(currentProfile, invert3x3(Hrough), fullData, vw, vh, pxPerMm, srcPts, dstPts);
      if (r && r.Hfinal) { H = r.Hfinal; ribbonPts = r.pointsUsed; }
    }
    const cal = checkCalibrationQuality(H, used, found, 1, pxPerMm, currentProfile.marker_size_mm);
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
  currentResult = { canvas: finalCanvas, profileName: currentProfile.nome, errPct: calibration.maxAbsErrorPct };
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
  currentResult = null; // refazer: descarta esta foto (não vai pro lote)
  stepResult.classList.add("hidden");
  stepProcess.classList.add("hidden");
  openCamera(false);
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
  });
}

async function saveCurrentToBatch() {
  if (!currentResult) return;
  const r = currentResult;
  currentResult = null;
  const blob = await new Promise((res) => r.canvas.toBlob(res, "image/png"));
  const thumb = await makeThumb(r.canvas);
  const seq = batch.reduce((m, b) => Math.max(m, b.seq), 0) + 1;
  const name = `molde_${String(seq).padStart(2, "0")}_${fileStamp(new Date())}.png`;
  const rec = { seq, name, blob, thumb, profile: r.profileName, errPct: r.errPct, createdAt: Date.now() };
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
    label.textContent = "#" + String(b.seq).padStart(2, "0") + " · " + b.errPct.toFixed(2).replace(".", ",") + "%";
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

btnBatchZip.addEventListener("click", async () => {
  if (!batch.length) return;
  const zip = await buildZip(batch.map((b) => ({ name: b.name, blob: b.blob })));
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
