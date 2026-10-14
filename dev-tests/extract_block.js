// Extrai o bloco de vetorização (entre /* VECTOR-BEGIN */ e /* VECTOR-END */) de web/app.js
// para dev-tests/vector_block.js, que é o que os testes carregam. Rode antes dos testes:
//   node dev-tests/extract_block.js
const fs = require("fs");
const path = require("path");
const app = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");
const a = app.indexOf("/* VECTOR-BEGIN */");
const b = app.indexOf("/* VECTOR-END */");
if (a < 0 || b < a) throw new Error("marcadores VECTOR-BEGIN/END não encontrados em web/app.js");
fs.writeFileSync(path.join(__dirname, "vector_block.js"), app.slice(a, b + "/* VECTOR-END */".length) + "\n");
console.log("vector_block.js atualizado (" + (b - a) + " caracteres)");
