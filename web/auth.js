"use strict";

/* ------------------------------------------------------------------ *
 * Login (Firebase Authentication, via REST — sem precisar do SDK
 * inteiro). Time pequeno (poucas contas, criadas manualmente no
 * Console do Firebase) — isso é só um portão de acesso, não um sistema
 * de permissões por usuário.
 *
 * A apiKey abaixo é pública de propósito (é assim que o Firebase
 * funciona no navegador) — ela só identifica o projeto, quem entra ou
 * não depende do login em si, verificado pelo próprio Firebase.
 * ------------------------------------------------------------------ */

const FIREBASE_API_KEY = "AIzaSyCp6J90yeX6l4sYPkG7xUWD1XcJvbAmKBM";
const AUTH_STORAGE_KEY = "moldeflat_auth_session";
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // renova se faltar menos de 5 min pro token expirar
const REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

const loginScreen = document.getElementById("loginScreen");
const appRoot = document.getElementById("appRoot");
const loginForm = document.getElementById("loginForm");
const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");
const loginError = document.getElementById("loginError");
const btnLogin = document.getElementById("btnLogin");
const btnLogout = document.getElementById("btnLogout");

function loadSession() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveSession(session) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}
function clearSession() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

function showApp() {
  loginScreen.classList.add("hidden");
  appRoot.classList.remove("hidden");
}
function showLogin() {
  appRoot.classList.add("hidden");
  loginScreen.classList.remove("hidden");
}

const ERROR_MESSAGES = {
  EMAIL_NOT_FOUND: "Email não cadastrado.",
  INVALID_PASSWORD: "Senha incorreta.",
  INVALID_LOGIN_CREDENTIALS: "Email ou senha incorretos.",
  USER_DISABLED: "Esta conta foi desativada.",
  TOO_MANY_ATTEMPTS_TRY_LATER: "Muitas tentativas. Aguarde um pouco e tente de novo.",
  INVALID_EMAIL: "Email inválido.",
  MISSING_PASSWORD: "Digite a senha.",
};
function friendlyError(code) {
  return ERROR_MESSAGES[code] || `Não foi possível entrar (${code || "erro desconhecido"}).`;
}

async function signIn(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(friendlyError(data.error && data.error.message));
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    email: data.email,
    expiresAt: Date.now() + Number(data.expiresIn) * 1000,
  };
}

async function refreshSession(session) {
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(session.refreshToken)}`,
  });
  const data = await res.json();
  if (!res.ok) throw new Error("refresh falhou");
  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    email: session.email,
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
  };
}

let appStarted = false;
let refreshTimer = null;

function startApp(session) {
  btnLogout.title = "Conectado como " + session.email;
  showApp();
  if (!appStarted) {
    appStarted = true;
    window.MoldeFlatInit();
  }
  // Renova o token silenciosamente enquanto o app fica aberto — o idToken do
  // Firebase dura só 1h, e não queremos derrubar alguém no meio de uma foto.
  clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    const s = loadSession();
    if (!s) return;
    if (Date.now() > s.expiresAt - REFRESH_MARGIN_MS) {
      try { saveSession(await refreshSession(s)); } catch { /* mantém a sessão atual até expirar de vez */ }
    }
  }, REFRESH_CHECK_INTERVAL_MS);
}

async function init() {
  let session = loadSession();
  if (!session) { showLogin(); return; }

  if (Date.now() > session.expiresAt - REFRESH_MARGIN_MS) {
    try {
      session = await refreshSession(session);
      saveSession(session);
    } catch {
      clearSession();
      showLogin();
      return;
    }
  }
  startApp(session);
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.classList.add("hidden");
  btnLogin.disabled = true;
  btnLogin.textContent = "Entrando...";
  try {
    const session = await signIn(loginEmail.value.trim(), loginPassword.value);
    saveSession(session);
    loginPassword.value = "";
    startApp(session);
  } catch (err) {
    loginError.textContent = err.message;
    loginError.classList.remove("hidden");
  } finally {
    btnLogin.disabled = false;
    btnLogin.textContent = "Entrar";
  }
});

btnLogout.addEventListener("click", () => {
  clearSession();
  clearInterval(refreshTimer);
  location.reload();
});

init();
