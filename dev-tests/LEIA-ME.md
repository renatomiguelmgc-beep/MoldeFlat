# Testes do vetorizador (Node)

Testes sintéticos: geram fotos/contornos com resposta conhecida e medem o erro do vetorizador, dos arcos e da simetria.
Precisam de `npm install` na raiz do projeto (usam `sharp`).

```bash
node dev-tests/extract_block.js          # copia o bloco VECTOR de web/app.js para dev-tests/vector_block.js
cd dev-tests
node test_vector_accuracy.js             # contorno + furo contra a verdade (mm)
node test_arcs.js ; node test_arcs2.js   # arcos R3 e raios abertos
node test_sym.js                         # simetria (aceita amplitude da "mão", ex.: node test_sym.js 1)
node count_nodes.js                      # quantidade de nós
node make_synthetic_hand_run.js          # gera synthetic_hand.jpg (foto sintética de peça feita à mão)
node make_synthetic_arcs.js              # gera synthetic_arcs.jpg
```

- `vector_block.js` e as saídas (`*.dxf`, `*.svg`, `*.jpg`, `*_gt.json`) são gerados e ficam fora do git.
- Rode sempre `extract_block.js` primeiro: os testes carregam essa cópia, não o `app.js` inteiro.
- Não são testes automáticos com "passou/falhou": imprimem números (erro médio/máximo em mm) para você comparar com a execução anterior.
