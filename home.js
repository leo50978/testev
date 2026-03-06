import "./firebase-init.js";
import { auth, watchAuthState } from "./auth.js";

const AUTH_SUCCESS_NOTICE_STORAGE_KEY = "domino_auth_success_notice_v1";
let lastRenderedStateKey = "__initial__";
let homeAuthBootstrapTimer = null;
let homeInitialAuthResolved = false;
let homeRenderToken = 0;
let page2ModulePromise = null;
let pwaSupportModulePromise = null;
const HOME_AUTH_BOOTSTRAP_TIMEOUT_MS = 900;
const HOME_AUTH_SUCCESS_TIMEOUT_MS = 2600;

function homeDebug(event, data = {}) {
  try {
    console.log(`[AUTH_DEBUG][HOME] ${event}`, {
      ts: new Date().toISOString(),
      href: String(window.location?.href || ""),
      currentUid: String(auth.currentUser?.uid || ""),
      ...data,
    });
  } catch (_) {}
}

function readRecentAuthSuccessNotice() {
  try {
    const raw = sessionStorage.getItem(AUTH_SUCCESS_NOTICE_STORAGE_KEY) || "";
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const ts = Number(parsed?.ts || 0);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    if ((Date.now() - ts) > 60_000) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function getHomeShell() {
  return document.getElementById("domino-app-shell") || document.body;
}

function ensureHomeLoadingOverlay() {
  const shell = getHomeShell();
  let overlay = document.getElementById("homeBootstrapOverlay");
  if (overlay && shell.contains(overlay)) return overlay;

  overlay = document.createElement("div");
  overlay.id = "homeBootstrapOverlay";
  overlay.className = "fixed inset-0 z-[3600] hidden items-center justify-center bg-[#3F4766]/74 px-5 text-white backdrop-blur-md";
  overlay.innerHTML = `
    <div class="rounded-3xl border border-white/15 bg-white/10 px-6 py-5 text-center shadow-[12px_12px_28px_rgba(25,30,44,0.42),-10px_-10px_24px_rgba(97,110,150,0.16)]">
      <div class="mx-auto mb-3 h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-[#ffb26e]"></div>
      <div id="homeBootstrapOverlayMessage" class="text-sm font-semibold tracking-wide">Chargement...</div>
    </div>
  `;
  shell.appendChild(overlay);
  return overlay;
}

function showHomeLoadingOverlay(message = "Chargement...") {
  const overlay = ensureHomeLoadingOverlay();
  const label = document.getElementById("homeBootstrapOverlayMessage");
  if (label) label.textContent = String(message || "Chargement...");
  overlay.classList.remove("hidden");
  overlay.classList.add("flex");
}

function hideHomeLoadingOverlay() {
  const overlay = document.getElementById("homeBootstrapOverlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.classList.remove("flex");
}

async function ensurePage2Module() {
  if (!page2ModulePromise) {
    page2ModulePromise = import("./page2.js");
  }
  return page2ModulePromise;
}

function warmPage2ModuleSoon() {
  const warm = () => {
    window.setTimeout(() => {
      void ensurePage2Module();
    }, 120);
  };
  if ("requestAnimationFrame" in window) {
    window.requestAnimationFrame(warm);
    return;
  }
  warm();
}

async function registerPwaSupportWhenIdle() {
  if (!pwaSupportModulePromise) {
    pwaSupportModulePromise = import("./pwa-install.js");
  }
  const { registerPwaSupport } = await pwaSupportModulePromise;
  registerPwaSupport();
}

function schedulePwaSupportRegistration() {
  const run = () => {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(() => {
        void registerPwaSupportWhenIdle();
      }, { timeout: 1600 });
      return;
    }
    window.setTimeout(() => {
      void registerPwaSupportWhenIdle();
    }, 280);
  };

  if (document.readyState === "complete") {
    run();
    return;
  }

  window.addEventListener("load", run, { once: true });
}

async function renderHomeFromAuth(user, options = {}) {
  const uid = String(user?.uid || "");
  const optimistic = options?.optimistic === true;
  const stateKey = `${uid}|${optimistic ? "1" : "0"}`;
  homeDebug("renderHomeFromAuth:enter", {
    uid,
    optimistic,
    stateKey,
    lastRenderedStateKey,
  });
  if (!options?.force && stateKey === lastRenderedStateKey) return;
  lastRenderedStateKey = stateKey;
  const renderToken = ++homeRenderToken;
  homeDebug("renderHomeFromAuth:loadPage2", { uid, optimistic, renderToken });
  const { renderPage2 } = await ensurePage2Module();
  if (renderToken !== homeRenderToken) {
    homeDebug("renderHomeFromAuth:staleRenderAbort", { uid, optimistic, renderToken });
    return;
  }
  hideHomeLoadingOverlay();
  homeDebug("renderHomeFromAuth:renderPage2", { uid, optimistic, renderToken });
  renderPage2(user || null, { optimisticAuth: optimistic });
}

function renderHomeLoading(message = "Chargement...") {
  showHomeLoadingOverlay(message);
}

function clearHomeAuthBootstrapTimer() {
  if (!homeAuthBootstrapTimer) return;
  window.clearTimeout(homeAuthBootstrapTimer);
  homeAuthBootstrapTimer = null;
}

homeDebug("bootstrap:start");
schedulePwaSupportRegistration();
warmPage2ModuleSoon();
const immediateUser = auth.currentUser || null;
if (immediateUser?.uid) {
  homeDebug("bootstrap:currentUserImmediate", { uid: String(immediateUser.uid || "") });
  homeInitialAuthResolved = true;
  renderHomeLoading("Préparation de votre espace...");
  void renderHomeFromAuth(immediateUser, { optimistic: false });
} else {
  const successNotice = readRecentAuthSuccessNotice();
  if (successNotice) {
    homeDebug("bootstrap:optimisticAuthRender", { successType: String(successNotice?.type || "") });
    renderHomeLoading("Connexion réussie. Préparation de votre espace...");
  } else {
    homeDebug("bootstrap:waitFirstAuthState");
    hideHomeLoadingOverlay();
  }
  homeAuthBootstrapTimer = window.setTimeout(() => {
    homeAuthBootstrapTimer = null;
    if (homeInitialAuthResolved) return;
    homeDebug("bootstrap:timeoutRenderGuest", { timeoutMs: HOME_AUTH_BOOTSTRAP_TIMEOUT_MS });
    homeInitialAuthResolved = true;
    void renderHomeFromAuth(null, { optimistic: false, force: true });
  }, successNotice ? HOME_AUTH_SUCCESS_TIMEOUT_MS : HOME_AUTH_BOOTSTRAP_TIMEOUT_MS);
}

watchAuthState((user) => {
  homeInitialAuthResolved = true;
  clearHomeAuthBootstrapTimer();
  homeDebug("watchAuthState:callback", {
    hasUser: Boolean(user),
    uid: String(user?.uid || ""),
  });
  if (user?.uid) {
    renderHomeLoading("Préparation de votre espace...");
  }
  void renderHomeFromAuth(user || null, { optimistic: false });
});
