# Digitalizador de Moldes CNC

App web (sem instalação, roda no navegador do celular) que fotografa um molde de
peça de carro traçado em cartolina/papelão sobre um **tapete de calibração
impresso**, e devolve uma imagem corrigida:

- sem distorção de perspectiva (foto tirada em ângulo é "endireitada");
- em escala real conhecida (o desenhista sabe exatamente o tamanho real de
  cada pixel para vetorizar no AutoCAD).

Todo o processamento roda **no navegador (client-side)**, sem backend, sem
login, sem upload da foto para servidor nenhum.

## Como funciona

1. Imprime-se um **tapete de calibração**: uma folha/lona com 4 marcadores
   ArUco (padrões pretos e brancos, tipo QR code) nos 4 cantos, em posições
   reais conhecidas (em mm).
2. O molde é colocado sobre o tapete, com os 4 marcadores visíveis, e
   fotografado (câmera do celular direto pelo navegador, ou foto tirada pelo
   app nativo de câmera do celular e carregada no site).
3. O app detecta os 4 marcadores na foto (biblioteca
   [js-aruco2](https://github.com/damianofalcioni/js-aruco2), 100% JavaScript,
   sem servidor), calcula a homografia (transformação de perspectiva) entre a
   posição dos marcadores na foto e a posição real deles no tapete, e usa essa
   transformação para "retificar" a foto inteira.
4. O resultado é uma imagem onde o molde está sem distorção e em escala real
   conhecida (uma régua de 100 mm é desenhada no rodapé da imagem para
   conferência). O desenhista baixa essa imagem e traça o contorno por cima no
   AutoCAD (vetorização automática do contorno fica para uma fase futura).

## Estrutura do projeto

```
digitalizador-moldes-cnc/
├── generate_mat.js          # gera o SVG de impressão do tapete (Node, zero deps)
├── web/                     # o site em si (é só isso que precisa ser hospedado)
│   ├── index.html
│   ├── style.css
│   ├── app.js                # toda a lógica: câmera, detecção, homografia, warp
│   ├── mat-profiles.json     # tamanhos de tapete disponíveis (ver abaixo)
│   ├── mats/                 # SVGs gerados dos tapetes, prontos para plotar
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
**HTTPS** (não funciona em `http://` puro nem acessando o IP da rede local sem
certificado). O caminho mais simples é publicar a pasta `web/` em um hospedeiro
estático gratuito com HTTPS automático (Netlify, Vercel, GitHub Pages, Cloudflare
Pages) e abrir a URL publicada no celular. Posso ajudar a publicar quando
quiser.

Alternativa: mesmo sem câmera ao vivo, o botão **"Carregar foto"** sempre
funciona (inclusive em `http://`), porque abre o app de câmera nativo do
celular e só envia a foto já tirada — é o caminho recomendado, inclusive
porque normalmente dá mais resolução/qualidade que a captura ao vivo pelo
navegador.

## Tapete de calibração

O tamanho do tapete **ainda não foi definido** — o projeto está pronto para
qualquer tamanho, é só configurar. O perfil inicial em
`web/mat-profiles.json` (`padrao_1000x700`, 100 x 70 cm, provisório) existe
para o app funcionar desde já.

### Gerando o arquivo de impressão

```bash
node generate_mat.js padrao_1000x700
```

Gera `web/mats/padrao_1000x700.svg`. O SVG usa unidades físicas em mm — ao
abrir em software vetorial (Illustrator, CorelDraw, Inkscape) ou mandar
plotar/imprimir, **usar escala 100% (não ajustar à página)**, senão a escala
real calculada pelo app fica errada.

### Adicionando um novo tamanho

Edite `web/mat-profiles.json` e adicione um novo objeto em `"profiles"`,
copiando a estrutura do `padrao_1000x700` e mudando `id`, `nome`, `width_mm`,
`height_mm` (e `margin_mm`/`marker_size_mm` se quiser marcadores maiores/
menores — tapetes muito grandes pedem marcadores maiores para serem
detectados de longe). Depois rode `node generate_mat.js <novo_id>` para gerar
o SVG. Não precisa mexer em nenhum outro arquivo — o app lê os perfis
disponíveis direto do JSON e mostra num seletor na tela.

**Ideia para múltiplos tamanhos:** como os 4 marcadores de cada perfil têm
IDs fixos (0, 1, 2, 3, sempre nos cantos), o app precisa saber qual perfil
está em uso — por isso hoje é um seletor manual na tela 1. Se no futuro
quiser detecção automática do tamanho do tapete, dá pra usar IDs de
marcador diferentes por tamanho (ex.: tapete P usa IDs 0-3, tapete G usa IDs
4-7) e o app identifica sozinho qual tapete está sendo fotografado.

## Limitações da v1 (por decisão, não por esquecimento)

- **Sem vetorização automática**: a saída é uma imagem raster corrigida, não
  um DXF/SVG do contorno do molde. O desenhista traça por cima no AutoCAD.
  Ficou de fora da v1 porque bordas de papelão cortado à mão, recortes
  internos e sombras tornam a extração automática de contorno arriscada
  tecnicamente — fica para uma fase futura, com mais dado real pra testar.
- **Sem histórico/persistência**: cada foto é processada e baixada na hora,
  nada fica salvo (nem localmente, nem em servidor). Sem login, sem lista de
  projetos.
- **Tamanho do tapete provisório**: ver seção acima.

## Testes

O pipeline (detecção de marcador → homografia → correção de perspectiva e
escala) foi validado com uma foto sintética gerada com distorção de
perspectiva conhecida e um "molde" de tamanho real conhecido (retângulo de
300 x 200 mm): o resultado corrigido bateu com o tamanho e a posição
esperados (diferença de poucos pixels, compatível com a espessura do traço
desenhado). Ainda não foi testado com fotos reais de celular — vale validar
com o tapete impresso assim que o tamanho for definido.
