// Service worker mínimo — só existe para o app ser instalável na tela inicial
// (Chrome/Android exige um service worker com um handler de "fetch" pra isso).
// De propósito, NÃO fazemos cache de nada: toda vez que o app abre, ele busca
// a versão mais nova direto da rede. Assim, qualquer atualização publicada
// aparece automaticamente no app instalado, sem versão presa em cache velho.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
