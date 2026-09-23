// Gera o SVG de impressão do tapete de calibração (marcadores ArUco nos 4 cantos).
// Uso: node generate_mat.js <profileId>
// Ex.:  node generate_mat.js padrao_1000x700
//
// O SVG resultante usa unidades em milímetros (width/height/viewBox em "mm"),
// então deve ser aberto e plotado em escala 100% (sem "ajustar à página") em
// software vetorial (Illustrator, CorelDraw, Inkscape) ou direto na gráfica/plotter.

const fs = require("fs");
const path = require("path");
const { AR } = require("./web/lib/aruco.js");

const profilesPath = path.join(__dirname, "web", "mat-profiles.json");
const config = JSON.parse(fs.readFileSync(profilesPath, "utf8"));

const profileId = process.argv[2];
if (!profileId) {
  console.error("Uso: node generate_mat.js <profileId>");
  console.error("Perfis disponíveis:", config.profiles.map((p) => p.id).join(", "));
  process.exit(1);
}

const profile = config.profiles.find((p) => p.id === profileId);
if (!profile) {
  console.error(`Perfil "${profileId}" não encontrado em mat-profiles.json`);
  console.error("Perfis disponíveis:", config.profiles.map((p) => p.id).join(", "));
  process.exit(1);
}

const dictionary = new AR.Dictionary(config.dictionary);

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

function markerGroup(markerId, center, markerSizeMm) {
  const svg = dictionary.generateSVG(markerId);
  const viewBoxMatch = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  if (!viewBoxMatch) throw new Error("Não foi possível ler o viewBox do marcador gerado.");
  const nativeSize = parseFloat(viewBoxMatch[1]);
  const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  const scale = markerSizeMm / nativeSize;
  const topLeftX = center.x - markerSizeMm / 2;
  const topLeftY = center.y - markerSizeMm / 2;
  return `
  <g transform="translate(${topLeftX} ${topLeftY}) scale(${scale})">
    ${inner}
  </g>
  <text x="${center.x}" y="${center.y + markerSizeMm / 2 + 10}" font-family="Arial" font-size="7"
        text-anchor="middle" fill="#999">ID ${markerId}</text>`;
}

const { width_mm, height_mm, marker_size_mm, markers } = profile;

let markerGroups = "";
for (const m of markers) {
  const center = cornerXY(m.corner, profile);
  markerGroups += markerGroup(m.id, center, marker_size_mm);
}

const svgDoc = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Tapete de calibração "${profile.nome}" (perfil "${profile.id}").
     IMPRIMIR/PLOTAR EM ESCALA 100% - NÃO AJUSTAR À PÁGINA.
     Dimensões reais: ${width_mm} x ${height_mm} mm. -->
<svg xmlns="http://www.w3.org/2000/svg" width="${width_mm}mm" height="${height_mm}mm"
     viewBox="0 0 ${width_mm} ${height_mm}">
  <rect x="0" y="0" width="${width_mm}" height="${height_mm}" fill="white" />
  <rect x="1" y="1" width="${width_mm - 2}" height="${height_mm - 2}" fill="none"
        stroke="#cccccc" stroke-width="1" stroke-dasharray="6 4" />
  ${markerGroups}
  <text x="${width_mm / 2}" y="${height_mm - 15}" font-family="Arial" font-size="10"
        text-anchor="middle" fill="#999">${profile.nome} — Digitalizador de Moldes CNC — imprimir em escala 100%</text>
</svg>
`;

const outDir = path.join(__dirname, "web", "mats");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${profile.id}.svg`);
fs.writeFileSync(outPath, svgDoc, "utf8");
console.log("Gerado:", outPath);
console.log(`Tamanho real: ${width_mm} x ${height_mm} mm — lembrar de plotar em escala 100%.`);
