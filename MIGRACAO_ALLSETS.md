# MoldeFlat — migração para o domínio da AllSets (nova máquina)

Guia para levar o app para outra máquina e publicá-lo num site oficial com o domínio da AllSets.
Escrito em 2026-10-14, a partir do estado do projeto na versão **2026-10-13.1**.

## 1. O que é o app, em uma frase

Site 100% estático (HTML + JS + CSS, **sem servidor próprio**). Só a pasta `web/` é publicada.
O processamento das fotos roda no navegador. A única coisa "de fora" é o **login**, que usa o
Firebase Authentication (projeto Firebase já existente) por chamadas REST em `web/auth.js`.

Consequência boa: **qualquer hospedagem de arquivos estáticos com HTTPS serve** (HTTPS é obrigatório,
senão a câmera do celular não abre). Os caminhos no código são relativos, então o app funciona em
`https://dominio.com/`, em `https://dominio.com/moldes/` ou em qualquer subdomínio, sem mudar código.

## 2. O que levar para a máquina nova

| Item | De onde | Observação |
|---|---|---|
| Pasta do projeto inteira | `C:\Users\raque\Desktop\projetos renato\digitalizador-moldes-cnc\` | Já inclui o histórico do git (`.git`). Não precisa levar `node_modules` (reinstala com `npm install`). |
| `firebase.txt` | `...\TAREFAS ALLSETS\MoldeFlat\firebase.txt` | Dados do projeto Firebase. **Não está no git, de propósito.** Copie à parte e não publique. |
| PDFs dos tapetes | `web/mats/*.pdf` | Estão na pasta mas fora do git. Vão junto se você copiar a pasta. |
| Zip pronto | `...\TAREFAS ALLSETS\MoldeFlat_para_nova_maquina.zip` | Pasta do projeto sem `node_modules`, já pronta para copiar. |

O que **não** viaja com os arquivos:
- **Os usuários e senhas do login**: ficam no Firebase (nuvem), não na pasta. Continuam valendo se o app seguir usando o mesmo projeto Firebase (ver seção 5).
- **A memória do Claude Code** desta máquina. O contexto do projeto foi gravado em `CLAUDE.md` (na raiz da pasta), então a sessão do Claude na máquina nova já abre sabendo o essencial.

## 3. Preparar a máquina nova

1. Instale: **Git**, **Node.js LTS** (só é necessário para gerar tapetes e rodar os testes de `dev-tests/`) e, se for usar o Claude Code, o app do Claude.
2. Copie a pasta do projeto (ou extraia o zip) para, por exemplo, `C:\Projetos\MoldeFlat`.
3. No terminal, dentro da pasta:
   ```bash
   npm install
   git config user.name "Seu Nome"
   git config user.email "seu-email@allsets.com.br"
   ```
4. Teste local (a câmera funciona em `localhost`):
   ```bash
   cd web
   python -m http.server 8080
   ```
   Abra `http://localhost:8080`. O login pede e-mail e senha de um usuário do Firebase.

## 4. Repositório e hospedagem no domínio da AllSets

Hoje o código está em `https://github.com/renatomiguelmgc-beep/MoldeFlat` (conta pessoal) e o site em
`https://renatomiguelmgc-beep.github.io/MoldeFlat/`. **O repositório é público** (o GitHub Pages grátis exige isso).
Para o uso oficial, o recomendado é um repositório **privado numa conta/organização da empresa**.

```bash
git remote set-url origin https://github.com/ORGANIZACAO/REPOSITORIO.git
git push -u origin main
```

### Opção A (recomendada): Firebase Hosting — mesmo projeto do login

Grátis no volume deste app, HTTPS automático, domínio próprio, funciona com repositório privado.
O arquivo `firebase.json` já está pronto na raiz (publica a pasta `web/`).

```bash
npm install -g firebase-tools
firebase login
firebase use --add          # escolha o projeto Firebase do MoldeFlat
firebase deploy --only hosting
```

Depois, no console do Firebase: **Hosting → Adicionar domínio personalizado** → digite o endereço
(sugestão: um subdomínio, como `moldes.SEUDOMINIO.com.br`). O console mostra os registros DNS (TXT e A/CNAME)
para quem administra o DNS da AllSets criar. O certificado HTTPS sai sozinho (pode levar de minutos a algumas horas).

### Opção B: GitHub Pages com domínio próprio

O workflow `.github/workflows/pages.yml` já publica a pasta `web/` a cada `git push` na `main`.
Em **Settings → Pages → Custom domain**, informe o subdomínio e crie no DNS um registro **CNAME**
apontando para `ORGANIZACAO.github.io`. Marque "Enforce HTTPS". Repositório privado só publica Pages em plano pago.

### Opção C: servidor da própria AllSets

Sirva a pasta `web/` por HTTPS (nginx, IIS, Apache). Não precisa de nada além de arquivos estáticos.

> Em qualquer opção, avise quem cuida do DNS **qual subdomínio** será usado antes de começar.

## 5. Login (Firebase Authentication) — o ponto que mais quebra numa migração

O app usa a chave de API web do Firebase que está no topo de `web/auth.js` (`FIREBASE_API_KEY`).
Essa chave é pública por natureza (todo site com Firebase a expõe); quem protege o acesso é o login.
Mantendo o **mesmo projeto Firebase**, os usuários continuam existindo. Faça estes 3 passos:

1. **Domínios autorizados.** Console Firebase → Authentication → Settings → **Authorized domains** → adicione o novo domínio.
2. **Restrição da chave.** Google Cloud Console → APIs e serviços → Credenciais → abra a chave de navegador
   do projeto. **Se** ela tiver "Restrições de sites (HTTP referrers)", adicione `https://SEUSUBDOMINIO/*`.
   Se isso for esquecido, o login passa a falhar no domínio novo com erro de "referrer bloqueado".
   (Não consegui ver de dentro do projeto se essa restrição existe; confira.)
3. **Quem é dono do projeto.** Console Firebase → Configurações do projeto → **Usuários e permissões** → adicione a
   conta Google da empresa como **Proprietário**. Hoje o projeto está ligado à conta pessoal de quem o criou.

Usuários (2–5 pessoas) são criados à mão em Authentication → Users → **Add user**. Senhas não podem ser lidas,
só redefinidas.

**Se preferirem um projeto Firebase novo** da empresa: crie o projeto, ative **Authentication → Email/senha**,
crie os usuários, copie a *Web API key* (Configurações do projeto → Geral) e troque `FIREBASE_API_KEY` no topo de
`web/auth.js`. Depois suba a versão nova (seção 7).

## 6. Quando o endereço do site mudar

O navegador trata cada endereço como um site diferente. No endereço novo:
- quem instalou o app na tela inicial precisa **instalar de novo** a partir do novo endereço;
- as **fotos guardadas no aparelho** (lote) e as preferências (e-mail de destino, opções de vetorização) **não passam** para o endereço novo.
Peça para a equipe **enviar ou baixar o lote** antes de trocar. Mantenha o endereço antigo no ar por um tempo e avise a equipe.

## 7. Como publicar uma atualização

1. Edite os arquivos em `web/`.
2. Suba o número da versão em **3 lugares** (têm que ser iguais): `APP_VERSION` no topo de `web/app.js`,
   os `?v=...` dos scripts em `web/index.html` e o texto "versão ..." no rodapé do `index.html`.
   Isso força os celulares a baixarem a versão nova.
3. Rode os testes do vetorizador (opcional, ver `dev-tests/LEIA-ME.md`).
4. `git add`, `git commit`, `git push`. Na Opção A, depois `firebase deploy --only hosting`
   (na Opção B o push já publica).

## 8. Claude Code na máquina nova

Abra a pasta do projeto no Claude. Ele lê o `CLAUDE.md` e já sabe o que o app faz, as decisões tomadas,
a estrutura do código e as pendências. Se quiser levar também a memória antiga do Claude, copie a pasta
`C:\Users\raque\.claude\projects\C--Users-raque-Desktop-projetos-renato-TAREFAS-ALLSETS\memory\` para o
equivalente na máquina nova (o nome da pasta muda conforme o caminho do projeto).

## 9. Checklist de aceite depois de publicar

- [ ] `https://SEUSUBDOMINIO` abre com cadeado (HTTPS) e mostra a tela de login.
- [ ] Login com um usuário real funciona (abre o app, rodapé mostra a versão esperada).
- [ ] No celular: a câmera abre e a detecção dos 4 marcadores funciona.
- [ ] Foto de teste: erro % aparece, DXF baixa, "Enviar por e-mail" abre o compartilhamento.
- [ ] Instalar na tela inicial do celular funciona (é um PWA).
- [ ] Sair e entrar de novo; testar com senha errada mostra mensagem de erro.
- [ ] Equipe avisada do endereço novo e de reinstalar o app.

## 10. Pendências abertas do projeto (não bloqueiam a migração)

- Descobrir por que o botão de **baixar DXF** sumiu no celular de um usuário (não reproduzido; foi adicionada uma faixa de erro na tela).
- Confirmar o **raio nominal** do "raio mais aberto" das peças (medido ~8,0–8,7 mm; é 8 ou 10?).
- Medir o tapete **90x120 cm** impresso (perfil `tapete_900x1200_fita`) e calibrar o `print_scale` como foi feito com o 100x150.
- Validar com **medição física** de uma peça real a exigência de erro máximo de 1 mm.
- Validar a **simetria** com peças reais.
