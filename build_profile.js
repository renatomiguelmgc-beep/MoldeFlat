// Cria/atualiza um perfil de tapete com marcadores ArUco distribuídos ao redor
// de TODA a borda (não só nos 4 cantos) — mais pontos de referência, robusto a
// oclusão parcial (uma peça grande pode cobrir alguns marcadores sem quebrar a
// calibração, desde que pelo menos 4 fiquem visíveis).
//
// Uso: node build_profile.js <profileId> <nome> <width_mm> <height_mm> <margin_mm> <marker_size_mm> <spacing_mm> [background]
// Ex.:  node build_profile.js tapete_500x1000_borda "50 x 100 cm (borda)" 500 1000 80 100 200 black

const fs = require("fs");
const path = require("path");

const [, , profileId, nome, widthArg, heightArg, marginArg, markerArg, spacingArg, background] = process.argv;

if (!profileId || !nome || !widthArg) {
  console.error("Uso: node build_profile.js <profileId> <nome> <width_mm> <height_mm> <margin_mm> <marker_size_mm> <spacing_mm> [background]");
  process.exit(1);
}

const width_mm = parseFloat(widthArg);
const height_mm = parseFloat(heightArg);
const margin_mm = parseFloat(marginArg);
const marker_size_mm = parseFloat(markerArg);
const spacing_mm = parseFloat(spacingArg);

// Retângulo onde os marcadores ficam (cantos a margin_mm da borda do tapete).
const corners = [
  { x: margin_mm, y: margin_mm },                       // top-left
  { x: width_mm - margin_mm, y: margin_mm },             // top-right
  { x: width_mm - margin_mm, y: height_mm - margin_mm }, // bottom-right
  { x: margin_mm, y: height_mm - margin_mm },            // bottom-left
];

const markers = [];
let id = 0;
for (let e = 0; e < 4; e++) {
  const a = corners[e];
  const b = corners[(e + 1) % 4];
  const edgeLen = Math.hypot(b.x - a.x, b.y - a.y);
  const count = Math.max(1, Math.ceil(edgeLen / spacing_mm));
  for (let k = 0; k < count; k++) {
    const t = k / count;
    markers.push({
      id: id++,
      x_mm: Math.round((a.x + (b.x - a.x) * t) * 10) / 10,
      y_mm: Math.round((a.y + (b.y - a.y) * t) * 10) / 10,
    });
  }
}

const profilesPath = path.join(__dirname, "web", "mat-profiles.json");
const config = JSON.parse(fs.readFileSync(profilesPath, "utf8"));

const newProfile = {
  id: profileId,
  nome,
  descricao: `Marcadores distribuídos ao redor de toda a borda (${markers.length} no total), não só nos 4 cantos — robusto a oclusão parcial (basta ~4 visíveis pra calibrar). Fundo ${background === "black" ? "preto" : "branco"}.`,
  width_mm, height_mm, marker_size_mm, margin_mm,
  background: background === "black" ? "black" : "white",
  markers,
};

const idx = config.profiles.findIndex((p) => p.id === profileId);
if (idx >= 0) config.profiles[idx] = newProfile;
else config.profiles.push(newProfile);

fs.writeFileSync(profilesPath, JSON.stringify(config, null, 2), "utf8");
console.log(`Perfil "${profileId}" ${idx >= 0 ? "atualizado" : "criado"} com ${markers.length} marcadores (IDs 0-${markers.length - 1}).`);
console.log("Rode: node generate_mat.js " + profileId);
