# MoldeFlat — Digitalizador de Moldes CNC

App web (instalável como app na tela inicial, sem loja de aplicativos) que
fotografa um molde de peça de carro traçado em cartolina/papelão sobre um
**tapete de calibração impresso**, e devolve uma imagem corrigida:

- sem distorção de perspectiva (foto tirada em ângulo é "endireitada");
- em escala real conhecida (o desenhista sabe exatamente o tamanho real de
  cada pixel para vetorizar no AutoCAD).

Todo o processamento roda **no navegador (client-side)**, sem backend, sem
login, sem upload da foto para servidor nenhum.

**Publicado em:** https://renatomiguelmgc-beep.github.io/MoldeFlat/
(GitHub Pages, deploy automático a cada `git push` na branch `main` via
GitHub Actions — ver `.github/workflows/pages.yml`).

## Como funciona

1. Imprime-se um **tapete de calibração**: uma folha/lona com vários
   marcadores ArUco (padrões pretos e brancos, tipo QR code, cada um com um
   ID único) distribuídos ao redor de toda a borda, em posições reais
   conhecidas (em mm).
2. O molde é colocado sobre o tapete e fotografado (câmera do celular direto
   pelo navegador, ou foto tirada pelo app nativo de câmera do celular e
   carregada no site). Não precisa ver todos os marcadores — **basta pelo
   menos 4 visíveis**, então uma peça grande pode cobrir parte da borda sem
   quebrar a calibração.
3. O app detecta os marcadores visíveis na foto (biblioteca
   [js-aruco2](https://github.com/damianofalcioni/js-aruco2), 100% JavaScript,
   sem servidor), calcula a homografia (transformação de perspectiva) entre a
   posição deles na foto e a posição real deles no tapete — por mínimos
   quadrados quando há mais de 4 visíveis — e usa essa transformação para
   "retificar" a foto inteira.
4. **Autoverificação de calibração**: como cada marcador tem um tamanho real
   conhecido, o app mede o próprio marcador depois de corrigido e compara.
   Se o erro for grande, avisa antes de você confiar na imagem (isso pega
   automaticamente casos como perfil de tapete errado selecionado, marcador
   mal posicionado etc.).
5. O resultado é uma imagem onde o molde está sem distorção e em escala real
   conhecida (uma régua de 100 mm é desenhada no rodapé da imagem para
   conferência). O desenhista baixa essa imagem e traça o contorno por cima no
   AutoCAD (vetorização automática do contorno fica para uma fase futura).

## Estrutura do projeto

```
digitalizador-moldes-cnc/
├── generate_mat.js          # gera o SVG de impressão de um tapete (Node)
├── build_profile.js         # calcula o layout de marcadores ao redor da borda
│                             # e cria/atualiza um perfil em mat-profiles.json
├── render_mat_png.js        # rasteriza o SVG do tapete em PNG (pra imprimir)
├── make_icons.js            # gera os ícones do app (PWA)
├── .github/workflows/pages.yml  # deploy automático pro GitHub Pages
├── web/                     # o site em si (é só isso que é publicado)
│   ├── index.html
│   ├── style.css
│   ├── app.js                # toda a lógica: câmera, detecção, homografia, warp
│   ├── manifest.json          # manifest do PWA (instalar na tela inicial)
│   ├── sw.js                  # service worker mínimo (só pra ser instalável —
│   │                           # não cacheia nada, sempre busca a versão mais nova)
│   ├── icons/v2/               # ícones do app
│   ├── mat-profiles.json     # tamanhos/layouts de tapete disponíveis (ver abaixo)
│   ├── mats/                 # SVGs + PNGs gerados dos tapetes, prontos pra plotar
│   └── lib/                  # js-aruco2 vendorizado (aruco.js + cv.js)
└── README.md
```

## Rodando localmente (para testar)

```bash
cd web
python -m http.server 8080
```

Abra `http://localhost:8080` no navegador do computador. **Importante:** a
câmera (`getUserMedia`) só funciona em contexto seguro — `localhost` funciona
para teste no computador, mas para usar no **celular** o site precisa estar em
**HTTPS**. O site publicado no GitHub Pages já resolve isso (é sempre HTTPS).

Alternativa: mesmo sem câmera ao vivo, o botão **"Carregar foto"** sempre
funciona, porque abre o seletor de arquivo/galeria (ou o app de câmera
nativo) do celular e só envia a foto já tirada.

## Tapete de calibração

Hoje existem dois esquemas de tapete, ambos no mesmo `mat-profiles.json`,
selecionáveis no app:

- **4 cantos** (`corner`: `top-left`/`top-right`/`bottom-right`/`bottom-left`)
  — esquema original, 4 marcadores só nos cantos. Todos precisam estar
  visíveis.
- **Borda toda** (`x_mm`/`y_mm` explícitos por marcador) — vários marcadores
  distribuídos ao redor de todo o perímetro. Só precisa de 4 visíveis (não
  precisam ser os cantos), então tolera peças grandes cobrindo parte do
  tapete. É o esquema recomendado para tapetes novos.

Perfis também podem ter `"background": "black"` para tapete de fundo preto
(cada marcador continua com fundo branco próprio — é isso que garante que
ele continua detectável mesmo num tapete preto).

### Criando um tapete novo (esquema borda, recomendado)

```bash
node build_profile.js <profileId> "<nome>" <width_mm> <height_mm> <margin_mm> <marker_size_mm> <spacing_mm> [black]
node generate_mat.js <profileId>
node render_mat_png.js <profileId> 150
```

Exemplo (tapete 50x100cm, fundo preto, marcador a cada ~200mm de borda):

```bash
node build_profile.js tapete_500x1000_borda "50 x 100 cm (borda)" 500 1000 80 100 200 black
node generate_mat.js tapete_500x1000_borda
```

`build_profile.js` calcula quantos marcadores cabem em cada lado (respeitando
o espaçamento pedido), gera um ID único pra cada um e grava tudo em
`mat-profiles.json` — não precisa editar o JSON à mão. `generate_mat.js` lê
esse perfil e desenha o SVG (funciona tanto pra esse esquema quanto pro
esquema antigo de 4 cantos).

O SVG usa unidades físicas em mm — ao abrir em software vetorial
(Illustrator, CorelDraw, Inkscape) ou mandar plotar/imprimir, **usar escala
100% (não ajustar à página)**, senão a escala real calculada pelo app fica
errada.

### Criando um tapete só com 4 cantos (esquema antigo)

Copie um perfil existente com `corner` em `mat-profiles.json`, mude
`id`/`nome`/`width_mm`/`height_mm`/`margin_mm`, rode
`node generate_mat.js <id>`.

## Calibração: se a escala sair errada

Se as peças digitalizadas saírem consistentemente maiores/menores que o
real, o problema quase sempre é que a distância real entre os marcadores no
tapete físico não bate com `width_mm`/`height_mm`/`margin_mm` no perfil
(impressão que não saiu em escala 100%, marcador colado fora do lugar
etc.). O app já avisa isso automaticamente (autoverificação de calibração,
acima) — mas pra corrigir de vez, meça com trena a distância real entre dois
marcadores adjacentes no tapete físico e ajuste o perfil pra bater com a
mesa real, não com o arquivo original.

## Limitações da v1 (por decisão, não por esquecimento)

- **Sem vetorização automática**: a saída é uma imagem raster corrigida, não
  um DXF/SVG do contorno do molde. O desenhista traça por cima no AutoCAD.
  Ficou de fora da v1 porque bordas de papelão cortado à mão, recortes
  internos e sombras tornam a extração automática de contorno arriscada
  tecnicamente — fica para uma fase futura, com mais dado real pra testar.
- **Sem histórico/persistência**: cada foto é processada e baixada na hora,
  nada fica salvo (nem localmente, nem em servidor). Sem login, sem lista de
  projetos.

## Testes

O pipeline completo (detecção de marcador → homografia por mínimos
quadrados → correção de perspectiva e escala → autoverificação) foi validado
com fotos sintéticas geradas com distorção de perspectiva conhecida e um
"molde" de tamanho real conhecido:

- Esquema de 4 cantos: resultado bateu com o esperado (diferença de poucos
  pixels, compatível com a espessura do traço desenhado).
- Esquema de borda com **oclusão simulada** (4 de 14 marcadores cobertos por
  um "molde" propositalmente grande): calibração confirmada com ~1.4% de
  erro, resultado bateu com o tamanho real esperado (728×1689px medidos vs.
  720×1680px esperados) — confirma que a tolerância a oclusão parcial
  funciona sem perda de precisão.

Também testado com fotos reais de celular; um caso de escala incorreta foi
investigado e determinado como causado por diferença entre o tapete físico
(marcadores impressos separadamente e colados à mão) e o arquivo original —
ver histórico de commits e conversa do projeto para detalhes.
