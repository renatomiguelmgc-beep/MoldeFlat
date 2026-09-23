const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const OUT = path.join(
  "C:\\Users\\raque\\Desktop\\projetos renato\\digitalizador-moldes-cnc\\web\\icons\\v2"
);
fs.mkdirSync(OUT, { recursive: true });

// Ícone "any" (com fundo, cantos arredondados) - para a maioria dos usos.
function iconSvg({ bg = "#2563eb" } = {}) {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect x="0" y="0" width="512" height="512" rx="96" fill="${bg}"/>
  <g stroke="#ffffff" stroke-width="26" stroke-linecap="round" fill="none">
    <path d="M 96 170 L 96 96 L 170 96"/>
    <path d="M 342 96 L 416 96 L 416 170"/>
    <path d="M 96 342 L 96 416 L 170 416"/>
    <path d="M 342 416 L 416 416 L 416 342"/>
  </g>
  <rect x="196" y="196" width="120" height="120" rx="14" fill="none" stroke="#ffffff" stroke-width="16"/>
</svg>`;
}

// Versão "maskable": conteúdo recuado pra caber na safe-zone circular (Android aplica sua própria máscara).
function maskableSvg() {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect x="0" y="0" width="512" height="512" fill="#2563eb"/>
  <g stroke="#ffffff" stroke-width="22" stroke-linecap="round" fill="none">
    <path d="M 150 214 L 150 150 L 214 150"/>
    <path d="M 298 150 L 362 150 L 362 214"/>
    <path d="M 150 298 L 150 362 L 214 362"/>
    <path d="M 298 362 L 362 362 L 362 298"/>
  </g>
  <rect x="221" y="221" width="70" height="70" rx="10" fill="none" stroke="#ffffff" stroke-width="14"/>
</svg>`;
}

async function main() {
  const base = iconSvg();
  const maskable = maskableSvg();

  const targets = [
    { name: "icon-192.png", size: 192, svg: base },
    { name: "icon-512.png", size: 512, svg: base },
    { name: "apple-touch-icon.png", size: 180, svg: base },
    { name: "icon-maskable-512.png", size: 512, svg: maskable },
    { name: "favicon-32.png", size: 32, svg: base },
  ];

  for (const t of targets) {
    const outPath = path.join(OUT, t.name);
    await sharp(Buffer.from(t.svg)).resize(t.size, t.size).png().toFile(outPath);
    console.log("gerado:", outPath);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
