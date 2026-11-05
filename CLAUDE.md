# MoldeFlat — contexto do projeto (para o Claude Code)

Responda ao usuário em **português do Brasil**, de forma direta. O usuário (Renato, fábrica de blindagem/peças de carro, AllSets) não é programador: explique o que mudou e o que ele precisa testar.

## O que é

PWA estático (instalável no celular, GitHub Pages hoje; migrando para o domínio da AllSets — ver `MIGRACAO_ALLSETS.md`).
Fotografa moldes de peças de carro traçados à mão em papel/papelão (cortados com tesoura, nunca perfeitos) sobre um **tapete de calibração preto impresso**
(4 marcadores ArUco nos cantos + fita De Bruijn na borda), corrige perspectiva e escala (homografia + distorção da lente + `print_scale`),
e **vetoriza o contorno** em DXF/SVG (mm reais) para o AutoCAD e o corte a laser CNC.
Tudo roda no navegador. Login por usuário via Firebase Auth (REST, `web/auth.js`); a chave do projeto fica só em `web/firebase-config.js`; usuários criados à mão no console Firebase. A migração está trocando para um projeto Firebase novo da empresa.

Ordem dos scripts no `index.html` importa: `lib/cv.js`, `lib/aruco.js`, `lib/ribbon.js`, `app.js`, `auth.js`.

## Estrutura

- `web/` — o site (só isso é publicado). `app.js` tem tudo: câmera/ao vivo, detecção, fita, lente, lote (IndexedDB), ZIP, e-mail, vetorização, simetria.
- `web/mat-profiles.json` — perfis de tapete. Padrão: `tapete_1000x1500_fita` (100x150 cm, com `print_scale` medido). Outro: `tapete_900x1200_fita`. O app só deve oferecer esses dois.
- `generate_mat.js`, `build_profile.js`, `render_mat_png.js`, `make_icons.js` — geram tapetes/ícones (Node). `web/mats/*.svg` versionados; PDF/PNG não.
- `dev-tests/` — testes sintéticos do vetorizador (ver `dev-tests/LEIA-ME.md`).
- `firebase.json` — pronto para Firebase Hosting (pasta `web`).

## Regras de trabalho

- **Versão em 3 lugares, sempre iguais**: `APP_VERSION` em `web/app.js`, `?v=` dos scripts em `web/index.html`, texto "versão ..." do rodapé. Formato `AAAA-MM-DD.N`. Suba a cada publicação (força o celular a pegar o novo).
- O bloco de vetorização fica em `web/app.js` entre `/* VECTOR-BEGIN */` e `/* VECTOR-END */` (funções puras, sem DOM). Os testes carregam esse bloco: rode `node dev-tests/extract_block.js` antes.
- Sem backend e sem cache no service worker (de propósito). Não adicione envio de foto a servidor sem o usuário pedir.
- Ao criar patches por script, use Write + `node arquivo.js` (aspas/crases quebram em heredoc no bash).
- Valide DXF com `ezdxf` (Python) quando mexer em `vectorToDXF`: R12, uma polilinha fechada por peça, arcos como bulge (grupo 42, sinal invertido pelo eixo Y).

## Decisões já tomadas pelo usuário

- Margem de erro aceitável: ≤ **1 mm de fora a fora** na peça; captura automática quando o erro estimado ≤ **0,8%**; uso liberado até **1%**.
- Várias peças por sessão: depois de cada foto pergunta "tem mais moldes?", guarda as fotos no aparelho e envia tudo de uma vez (compartilhar, ZIP, e-mail).
- Vetorização automática ligada por padrão. **Uma linha fechada por peça**, poucos nós (CAD: o usuário seleciona e vê as alças; nada de centenas de pontos).
  Janela interna e linhas de caneta são opcionais. Fita adesiva verde na peça = parte da peça (emenda). Linhas de caneta verde/azul viram camada LINHAS (opção).
- Pontas de aba/ranhura e cantos arredondados = **raio R3 mm**. Há outro local com **"raio mais aberto"** (medido ~8,0–8,7 mm; nominal ainda não confirmado, 8 ou 10).
- **Simetria**: o molde é feito à mão, então o app acha o eixo e impõe simetria exata (metade espelhada). Só aplica se a peça for ≥ 90% simétrica e a correção ≤ 5 mm; senão avisa ("detalhe só de um lado") e mantém. Opções: automática / 2º eixo / forçar / desligada.
- Envio por e-mail: compartilha o .zip pelo app de e-mail do celular; fallback baixa o zip e abre `mailto:`. Sem servidor.

## Impressão do quadro (decidido em 05/11/2026)
- Quadro físico: rígido, fosco, **1000 x 1500 mm**, fundo preto, **com a fita** (a fita dá a precisão de 1 mm). Só a linha pontilhada de dobra/corte foi removida.
- Arquivo para a gráfica: `node generate_mat.js tapete_1000x1500_fita --sangria=10` → página **1020 x 1520 mm** (10 mm de folga por lado), PDF via PyMuPDF (`fitz`/`pymupdf`: `open(svg).convert_to_pdf()`). Linha pontilhada só com `--guia`.
- A gráfica **não pode alterar o arquivo** (escala 100%, sem "ajustar à página", sem etiquetas): a impressão anterior foi mexida (tile 101 mm, célula da fita 25 mm, mas distâncias entre marcadores ~3,5% menores) e a calibração pela fita fica inválida assim.
- Conferir o quadro impresso com trena (mesma borda do quadrado branco): ID0→ID1 = 840 mm, ID0→ID3 = 1340 mm. Se não bater, gravar `print_scale` no perfil (hoje o perfil 100x150 está no tamanho nominal, sem `print_scale`).
- Perfil `teste_quadro_atual` = quadro impresso errado (só 4 marcadores, 811 x 1302 mm), só para testes; remover quando o quadro novo for validado.

## Pendências

- O botão de baixar DXF sumiu no celular de um usuário (não reproduzido; há faixa de erro na tela e vetorização com fallback sem arcos).
- Confirmar raio nominal do "raio mais aberto"; medir o tapete 90x120 impresso e calibrar `print_scale`; validar com peça física real (≤ 1 mm) e a simetria com peças reais.
- Possíveis melhorias (não pedidas): retificar bordas onduladas de peça cortada à mão, README mais completo.
- Migração para o domínio da AllSets: `MIGRACAO_ALLSETS.md`.
