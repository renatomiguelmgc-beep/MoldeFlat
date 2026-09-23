"use strict";

/* ------------------------------------------------------------------ *
 * Configuração / estado
 * ------------------------------------------------------------------ */

const DETECT_MAX_SIDE = 1400;   // downscale para detecção dos marcadores (velocidade)
const OUTPUT_TARGET_LONG = 2400; // lado maior da imagem retificada final (qualidade x tamanho de arquivo)
const LEGEND_HEIGHT_MM = 25;     // faixa extra no rodapé da imagem final para a régua de escala

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

/* ------------------------------------------------------------------ *
 * Carregar perfis do tapete
 * ------------------------------------------------------------------ */

async function loadProfiles() {
  const res = await fetch("mat-profiles.json");
  matConfig = await res.json();
  profileSelect.innerHTML = "";
  for (const p of matConfig.profiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.nome;
    profileSelect.appendChild(opt);
  }
  profileSelect.addEventListener("change", updateProfileInfo);
  currentProfile = matConfig.profiles[0];
  updateProfileInfo();
}

function updateProfileInfo() {
  currentProfile = matConfig.profiles.find((p) => p.id === profileSelect.value);
  const p = currentProfile;
  profileInfo.textContent =
    `${p.width_mm / 10} x ${p.height_mm / 10} cm · marcadores de ${p.marker_size_mm / 10} cm nos 4 cantos.` +
    (p.descricao ? ` ${p.descricao}` : "");
}

/* ------------------------------------------------------------------ *
 * Geometria do tapete (tem que espelhar generate_mat.js)
 * ------------------------------------------------------------------ */

function cornerXY(corner, profile) {
  const { width_mm, height_mm, margin_mm } = profile;
  switch (corner) {
    case "top-left": return { x: margin_mm, y: margin_mm };
    case "top-right": return { x: width_mm - margin_mm, y: margin_mm };
    case "bottom-right": return { x: width_mm - margin_mm, y: height_mm - margin_mm };
    case "bottom-left": return { x: margin_mm, y: height_mm - margin_mm };
    default: throw new Error(`Canto desconhecido: ${corner}`);
  }
}

/* ------------------------------------------------------------------ *
 * Câmera
 * ------------------------------------------------------------------ */

btnOpenCamera.addEventListener("click", async () => {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
      audio: false,
    });
    video.srcObject = mediaStream;
    cameraWrap.classList.remove("hidden");
  } catch (err) {
    alert("Não foi possível abrir a câmera: " + err.message);
  }
});

btnStopCamera.addEventListener("click", stopCamera);

function stopCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  cameraWrap.classList.add("hidden");
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

async function processImage() {
  stepProcess.classList.remove("hidden");
  stepResult.classList.add("hidden");
  stepProcess.scrollIntoView({ behavior: "smooth", block: "start" });

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
  await nextFrame();

  let markers;
  try {
    const detector = new AR.Detector({ dictionaryName: matConfig.dictionary });
    markers = detector.detect(imageData);
  } catch (err) {
    setStatus("Erro ao detectar marcadores: " + err.message, "error");
    return;
  }

  const found = new Map(); // id -> marker
  for (const m of markers) found.set(m.id, m);

  const missing = currentProfile.markers.filter((m) => !found.has(m.id));
  if (missing.length > 0) {
    setStatus(
      `Só encontrei ${currentProfile.markers.length - missing.length} de ${currentProfile.markers.length} marcadores ` +
      `(faltando ID ${missing.map((m) => m.id).join(", ")}). ` +
      `Tente novamente com todos os 4 cantos do tapete visíveis, bem iluminados e sem reflexo.`,
      "error"
    );
    return;
  }

  setStatus("Marcadores encontrados. Calculando correção de perspectiva e escala...");
  await nextFrame();

  // Pontos de origem (na foto em resolução total) e destino (mm reais, escalados para px)
  const pxPerMm = OUTPUT_TARGET_LONG / Math.max(currentProfile.width_mm, currentProfile.height_mm);
  const outW = Math.round(currentProfile.width_mm * pxPerMm);
  const outH = Math.round(currentProfile.height_mm * pxPerMm);

  const srcPts = [];
  const dstPts = [];
  for (const m of currentProfile.markers) {
    const marker = found.get(m.id);
    const center = markerCenter(marker.corners);
    // volta pra escala da foto original (a detecção rodou numa cópia reduzida)
    srcPts.push({ x: center.x / scaleDetect, y: center.y / scaleDetect });
    const mm = cornerXY(m.corner, currentProfile);
    dstPts.push({ x: mm.x * pxPerMm, y: mm.y * pxPerMm });
  }

  const H = computeHomography(srcPts, dstPts);
  const Hinv = invert3x3(H);

  setStatus("Gerando imagem corrigida (pode levar alguns segundos)...");
  await nextFrame();

  const legendPx = Math.round(LEGEND_HEIGHT_MM * pxPerMm);
  const finalCanvas = document.createElement("canvas");
  finalCanvas.width = outW;
  finalCanvas.height = outH + legendPx;
  const fctx = finalCanvas.getContext("2d");
  fctx.fillStyle = "#ffffff";
  fctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);

  const srcCtx = sourceCanvas.getContext("2d");
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH);
  const outImageData = fctx.getImageData(0, 0, outW, outH);

  await warpPerspective(srcData, outImageData, Hinv, srcW, srcH, (progress) => {
    setStatus(`Gerando imagem corrigida... ${Math.round(progress * 100)}%`);
  });
  fctx.putImageData(outImageData, 0, 0);

  drawLegend(fctx, outW, outH, legendPx, pxPerMm, currentProfile);

  resultCanvas.width = finalCanvas.width;
  resultCanvas.height = finalCanvas.height;
  resultCanvas.getContext("2d").drawImage(finalCanvas, 0, 0);

  const mmPerPx = 1 / pxPerMm;
  resultInfo.textContent =
    `Escala: 1 px = ${mmPerPx.toFixed(3)} mm (1 cm real = ${(pxPerMm * 10).toFixed(1)} px). ` +
    `Use a régua de ${100} mm no rodapé da imagem para conferir/ajustar a escala no AutoCAD.`;

  setStatus("Concluído!", "ok");
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
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/* ------------------------------------------------------------------ *
 * Homografia (DLT de 4 pontos) + warp
 * ------------------------------------------------------------------ */

function computeHomography(src, dst) {
  // Resolve h = [h11,h12,h13,h21,h22,h23,h31,h32] (h33 = 1) via DLT com 4 correspondências.
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const h = solveLinear(A, b);
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
  el("step-capture").scrollIntoView({ behavior: "smooth", block: "start" });
});

/* ------------------------------------------------------------------ */

loadProfiles().catch((err) => {
  alert("Erro ao carregar os perfis do tapete (mat-profiles.json): " + err.message);
});
