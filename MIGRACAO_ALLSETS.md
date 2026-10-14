# MoldeFlat — migração para o domínio da AllSets (nova máquina, Firebase novo)

Guia para levar o app para outra máquina, criar um **projeto Firebase novo da empresa** e publicar o app num site
oficial com o domínio da AllSets. Atualizado em 2026-10-14, versão **2026-10-14.1**.

## 1. O que é o app, em uma frase

Site 100% estático (HTML + JS + CSS, **sem servidor próprio**). Só a pasta `web/` é publicada.
O processamento das fotos roda no navegador. A única coisa "de fora" é o **login**, feito pelo Firebase
Authentication (REST, `web/auth.js`). A chave do projeto Firebase fica em **`web/firebase-config.js`**.

**Qualquer hospedagem de arquivos estáticos com HTTPS serve** (HTTPS é obrigatório, senão a câmera do celular
não abre). Os caminhos no código são relativos: funciona em `https://dominio.com/`, em subpasta ou em subdomínio.

## 2. Ordem das tarefas (resumo)

1. Copiar a pasta do pen drive para a máquina nova e instalar Git e Node (seção 3).
2. Criar o **Firebase novo** com a conta Google da empresa e os usuários (seção 4).
3. Colocar a chave nova em `web/firebase-config.js` e testar local (seção 4, passo 6).
4. Criar o repositório da empresa e enviar o código (seção 5).
5. Publicar no domínio (seção 6).
6. Avisar a equipe para reinstalar o app (seção 7).

## 3. Preparar a máquina nova

1. Instale: **Git** (https://git-scm.com/download/win), **Node.js LTS** (https://nodejs.org; só é necessário para gerar tapetes, rodar testes e usar o Firebase CLI) e, se for usar o Claude Code, o app do Claude.
2. Copie a pasta `MoldeFlat` do pen drive para a máquina, por exemplo `C:\Projetos\MoldeFlat`.
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
   Abra `http://localhost:8080`. Enquanto a chave do Firebase **não** for trocada, o login vale para o projeto
   antigo (pessoal). Faça a seção 4 antes de usar de verdade.

## 4. Criar o Firebase novo (conta Google da empresa)

Faça logado com a conta Google **da empresa** (ela será a dona do projeto).

1. Abra https://console.firebase.google.com → **Criar um projeto** → nome sugerido: `allsets-moldeflat`.
   Pode desligar o Google Analytics (não é usado).
2. No menu **Criação (Build) → Authentication → Vamos começar → Método de login**, ative **E-mail/senha**
   (só a primeira chave; "link por e-mail" fica desligado).
3. Em **Authentication → Usuários → Adicionar usuário**, crie as 2–5 pessoas (e-mail + senha). Anote as senhas
   num lugar seguro: o Firebase não mostra senha depois, só permite redefinir.
4. Engrenagem ao lado de "Visão geral do projeto" → **Configurações do projeto → Geral** → copie a
   **Chave de API da Web** (começa com `AIza...`).
5. Em **Configurações do projeto → Usuários e permissões**, adicione outros administradores da empresa como **Proprietário**,
   para o projeto não depender de uma pessoa só.
6. Abra o arquivo **`web/firebase-config.js`** e troque o valor de `FIREBASE_API_KEY` pela chave copiada.
   É o único arquivo a editar. Teste local (seção 3, passo 4) entrando com um dos usuários novos.
7. Depois de publicar no domínio (seção 6): em **Authentication → Settings → Domínios autorizados**, adicione o domínio novo
   (`localhost` e os endereços `*.web.app`/`*.firebaseapp.com` do próprio projeto já vêm autorizados).
8. (Opcional, mais seguro) Google Cloud Console → APIs e serviços → Credenciais → abra a chave de navegador do projeto
   → **Restrições de aplicativo: sites (HTTP referrers)** → adicione `https://SEUSUBDOMINIO/*` e `http://localhost:*/*`.
   Se essa restrição for ligada e o domínio não estiver na lista, o login falha com erro de "referrer bloqueado".

Observação: o projeto Firebase antigo (conta pessoal) continua existindo e o site antigo continua funcionando com ele
até você desligá-lo. Quando a equipe tiver migrado, apague os usuários dele ou o projeto.

## 5. Repositório da empresa

Hoje o código está em `https://github.com/renatomiguelmgc-beep/MoldeFlat` (conta pessoal, **repositório público**).
Para o uso oficial, crie um repositório **privado** numa conta/organização da empresa:

```bash
git remote set-url origin https://github.com/ORGANIZACAO/REPOSITORIO.git
git push -u origin main
```

(Se for usar o GitHub Pages, repositório privado exige plano pago. Com Firebase Hosting não há essa limitação.)

## 6. Publicar no domínio da AllSets

Escolha um **subdomínio** (ex.: `moldes.SEUDOMINIO.com.br`) e avise quem cuida do DNS.

### Opção A (recomendada): Firebase Hosting — no mesmo projeto Firebase novo

Grátis no volume deste app, HTTPS automático, funciona com repositório privado. O `firebase.json` já está pronto (publica `web/`).

```bash
npm install -g firebase-tools
firebase login
firebase use --add          # escolha o projeto allsets-moldeflat
firebase deploy --only hosting
```

Depois, no console: **Hosting → Adicionar domínio personalizado** → digite o subdomínio. O console mostra os registros DNS
(TXT e A/CNAME) para o responsável do DNS criar. O certificado HTTPS sai sozinho (de minutos a algumas horas).
Enquanto o domínio não valida, o site já fica disponível em `https://allsets-moldeflat.web.app` (ou o nome do seu projeto).

### Opção B: GitHub Pages com domínio próprio

O workflow `.github/workflows/pages.yml` publica `web/` a cada `git push` na `main`. Em **Settings → Pages → Custom domain**,
informe o subdomínio e crie no DNS um **CNAME** para `ORGANIZACAO.github.io`. Marque "Enforce HTTPS".

### Opção C: servidor da própria AllSets

Sirva a pasta `web/` por HTTPS (nginx, IIS, Apache). Só arquivos estáticos.

## 7. Quando o endereço do site mudar

O navegador trata cada endereço como um site diferente. No endereço novo:
- quem instalou o app na tela inicial precisa **instalar de novo** a partir do novo endereço;
- as **fotos guardadas no aparelho** (lote) e as preferências (e-mail de destino, opções de vetorização) **não passam**.
Peça para a equipe **enviar ou baixar o lote** antes de trocar. Mantenha o endereço antigo no ar por um tempo e avise todos.
Todos entram de novo com os usuários criados no Firebase novo (os do projeto antigo não valem nele).

## 8. Como publicar uma atualização

1. Edite os arquivos em `web/`.
2. Suba o número da versão em **3 lugares** (iguais): `APP_VERSION` no topo de `web/app.js`, os `?v=...` dos scripts em
   `web/index.html` e o texto "versão ..." do rodapé. Isso força os celulares a baixarem a versão nova.
3. Teste (opcional: `dev-tests/LEIA-ME.md`).
4. `git add`, `git commit`, `git push`. Na Opção A, depois `firebase deploy --only hosting`; na Opção B o push já publica.

## 9. Claude Code na máquina nova

Abra a pasta do projeto no Claude. Ele lê o `CLAUDE.md` e já sabe o que o app faz, as decisões tomadas, a estrutura
do código e as pendências. A memória antiga do Claude desta máquina não vai junto (o `CLAUDE.md` substitui).

## 10. Checklist de aceite depois de publicar

- [ ] `https://SEUSUBDOMINIO` abre com cadeado (HTTPS) e mostra a tela de login.
- [ ] Login com um usuário do Firebase **novo** funciona; um usuário do projeto antigo é recusado.
- [ ] O rodapé mostra a versão esperada.
- [ ] No celular: a câmera abre e a detecção dos 4 marcadores funciona.
- [ ] Foto de teste: erro % aparece, DXF baixa, "Enviar por e-mail" abre o compartilhamento.
- [ ] Instalar na tela inicial do celular funciona (é um PWA).
- [ ] Senha errada mostra mensagem de erro.
- [ ] Equipe avisada do endereço novo e de reinstalar o app.

## 11. Pendências abertas do projeto (não bloqueiam a migração)

- Descobrir por que o botão de **baixar DXF** sumiu no celular de um usuário (não reproduzido; há uma faixa de erro na tela).
- Confirmar o **raio nominal** do "raio mais aberto" das peças (medido ~8,0–8,7 mm; é 8 ou 10?).
- Medir o tapete **90x120 cm** impresso (perfil `tapete_900x1200_fita`) e calibrar o `print_scale`, como foi feito com o 100x150.
- Validar com **medição física** de uma peça real a exigência de erro máximo de 1 mm.
- Validar a **simetria** com peças reais.
