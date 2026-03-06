import "./firebase-init.js";
import { auth, watchAuthState } from "./auth.js";
import { renderPage2 } from "./page2.js";

const AUTH_SUCCESS_NOTICE_STORAGE_KEY = "domino_auth_success_notice_v1";
let lastRenderedStateKey = "__initial__";
let homeAuthBootstrapTimer = null;
let homeInitialAuthResolved = false;
const HOME_AUTH_BOOTSTRAP_TIMEOUT_MS = 900;

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

function renderHomeFromAuth(user, options = {}) {
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
  homeDebug("renderHomeFromAuth:renderPage2", { uid, optimistic });
  renderPage2(user || null, { optimisticAuth: optimistic });
}

function renderHomeLoading() {
  getHomeShell().innerHTML = `
    <div class="min-h-screen grid place-items-center bg-[#3F4766] text-white font-['Poppins']">
      <div class="rounded-3xl border border-white/15 bg-white/10 px-6 py-5 text-center shadow-[12px_12px_28px_rgba(25,30,44,0.42),-10px_-10px_24px_rgba(97,110,150,0.16)] backdrop-blur-md">
        <div class="text-sm font-semibold tracking-wide">Chargement...</div>
      </div>
    </div>
  `;
}

function clearHomeAuthBootstrapTimer() {
  if (!homeAuthBootstrapTimer) return;
  window.clearTimeout(homeAuthBootstrapTimer);
  homeAuthBootstrapTimer = null;
}

homeDebug("bootstrap:start");
const immediateUser = auth.currentUser || null;
if (immediateUser?.uid) {
  homeDebug("bootstrap:currentUserImmediate", { uid: String(immediateUser.uid || "") });
  homeInitialAuthResolved = true;
  renderHomeFromAuth(immediateUser, { optimistic: false });
} else {
  const successNotice = readRecentAuthSuccessNotice();
  if (successNotice) {
    homeDebug("bootstrap:optimisticAuthRender", { successType: String(successNotice?.type || "") });
    renderHomeFromAuth({ uid: "__pending_auth__", email: "" }, { optimistic: true, force: true });
  } else {
    homeDebug("bootstrap:waitFirstAuthState");
    renderHomeLoading();
  }
  homeAuthBootstrapTimer = window.setTimeout(() => {
    homeAuthBootstrapTimer = null;
    if (homeInitialAuthResolved) return;
    homeDebug("bootstrap:timeoutRenderGuest", { timeoutMs: HOME_AUTH_BOOTSTRAP_TIMEOUT_MS });
    homeInitialAuthResolved = true;
    renderHomeFromAuth(null, { optimistic: false, force: true });
  }, HOME_AUTH_BOOTSTRAP_TIMEOUT_MS);
}

watchAuthState((user) => {
  homeInitialAuthResolved = true;
  clearHomeAuthBootstrapTimer();
  homeDebug("watchAuthState:callback", {
    hasUser: Boolean(user),
    uid: String(user?.uid || ""),
  });
  renderHomeFromAuth(user || null, { optimistic: false });
});
