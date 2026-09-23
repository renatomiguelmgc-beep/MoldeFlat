// Rasteriza o SVG do tapete (gerado por generate_mat.js) em PNG, em escala real.
// Uso: node render_mat_png.js <profileId> [dpi]
//
// IMPORTANTE: o PNG é gerado para imprimir/plotar em TAMANHO REAL (não "ajustar
// à página"). O DPI escolhido define a qualidade e o tamanho do arquivo, não a
// escala física do tapete (essa é sempre a definida em mat-profiles.json).

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const profilesPath = path.join(__dirname, "web", "mat-profiles.json");
const config = JSON.parse(fs.readFileSync(profilesPath, "utf8"));

const profileId = process.argv[2];
const dpi = parseFloat(process.argv[3]) || 150;

if (!profileId) {
  console.error("Uso: node render_mat_png.js <profileId> [dpi]");
  console.error("Perfis disponíveis:", config.profiles.map((p) => p.id).join(", "));
  process.exit(1);
}

const profile = config.profiles.find((p) => p.id === profileId);
if (!profile) {
  console.error(`Perfil "${profileId}" não encontrado.`);
  process.exit(1);
}

const svgPath = path.join(__dirname, "web", "mats", `${profile.id}.svg`);
if (!fs.existsSync(svgPath)) {
  console.error(`SVG não encontrado (${svgPath}). Rode antes: node generate_mat.js ${profile.id}`);
  process.exit(1);
}

const pxPerMm = dpi / 25.4;
const outW = Math.round(profile.width_mm * pxPerMm);
const outH = Math.round(profile.height_mm * pxPerMm);

const outDir = path.join(__dirname, "web", "mats");
const outPath = path.join(outDir, `${profile.id}_${dpi}dpi.png`);

sharp(fs.readFileSync(svgPath), { density: dpi })
  .resize(outW, outH)
  .png()
  .toFile(outPath)
  .then(() => {
    console.log("Gerado:", outPath);
    console.log(`${outW} x ${outH} px @ ${dpi} DPI — imprimir em TAMANHO REAL (${profile.width_mm} x ${profile.height_mm} mm), sem "ajustar à página".`);
  })
  .catch((err) => { console.error(err); process.exit(1); });
