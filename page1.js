import "./firebase-init.js";
import {
  auth,
  formatAuthError,
  isValidEmail,
  isValidUsername,
  normalizeUsername,
  isOneClickAuthEmail,
  createOneClickAccountId,
  isValidPassword,
  loginWithEmail,
  loginWithUsername,
  signupWithEmail,
  signupWithUsername,
  sendPasswordReset,
  sendSignupVerificationEmail,
  refreshCurrentUser,
  isEmailPasswordUser,
  logoutCurrentUser,
  watchAuthState,
} from "./auth.js";
import { ensureAnimeRuntime } from "./anime-loader.js";
import {
  withButtonLoading,
  showGlobalLoading,
  hideGlobalLoading,
} from "./loading-ui.js";
import {
  getReferralContextFromUrl,
  normalizeCode,
} from "./referral.js";
import { updateClientProfileSecure } from "./secure-functions.js";

let authMode = "signin";
let authFlowBusy = false;
let redirectingToApp = false;
let referralBootstrapPromise = null;
let authBootstrapReady = false;
let authStateResolved = false;
let latestObservedUser = undefined;
let authFallbackRenderTimer = null;
let authBootstrapMessage = "";
let authBootstrapTone = "info";
const PENDING_PROMO_STORAGE_KEY = "domino_pending_promo_code";
const PENDING_USERNAME_STORAGE_KEY = "domino_pending_username";
const PENDING_ONECLICK_ID_STORAGE_KEY = "domino_pending_oneclick_id";
const CLIENT_DEVICE_STORAGE_KEY = "domino_device_id_v1";
const AUTH_SUCCESS_NOTICE_STORAGE_KEY = "domino_auth_success_notice_v1";
const verificationEmailSentByUid = new Set();
const APP_HOME_ROUTE = "./index.html";
const TERMS_ROUTE = "./conditions-utilisation.html";
const PRIVACY_ROUTE = "./politique-confidentialite.html";
const LEGAL_ROUTE = "./mentions-legales.html";
let page2ModulePromise = null;

function pageAuthDebug(event, data = {}) {
  try {
    const payload = {
      ts: new Date().toISOString(),
      href: String(window.location?.href || ""),
      authMode,
      authFlowBusy,
      redirectingToApp,
      authBootstrapReady,
      authStateResolved,
      latestObservedUser: latestObservedUser === undefined ? "undefined" : (latestObservedUser ? String(latestObservedUser?.uid || "user") : "null"),
      ...data,
    };
    console.log(`[AUTH_DEBUG][PAGE1] ${event}`, payload);
  } catch (error) {
    console.log(`[AUTH_DEBUG][PAGE1] ${event}`, { ts: new Date().toISOString(), logError: String(error?.message || error) });
  }
}

function getAuthShell() {
  return document.getElementById("domino-app-shell") || document.body;
}

function updateAuthModalBodyLock() {
  const modalIds = [
    "oneClickAuthOverlay",
    "emailVerificationOverlay",
  ];
  const shouldLock = modalIds.some((id) => {
    const node = document.getElementById(id);
    return Boolean(node) && !node.classList.contains("hidden");
  });
  document.documentElement.classList.toggle("overflow-hidden", shouldLock);
  document.body.classList.toggle("overflow-hidden", shouldLock);
  document.documentElement.style.overflow = shouldLock ? "hidden" : "";
  document.body.style.overflow = shouldLock ? "hidden" : "";
}

async function ensurePage2Module() {
  if (!page2ModulePromise) {
    page2ModulePromise = import("./page2.js");
  }
  return page2ModulePromise;
}

function escapeAttr(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function savePendingPromoCode(code) {
  const normalized = normalizeCode(code || "");
  if (!normalized) {
    sessionStorage.removeItem(PENDING_PROMO_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(PENDING_PROMO_STORAGE_KEY, normalized);
}

function consumePendingPromoCode() {
  const raw = sessionStorage.getItem(PENDING_PROMO_STORAGE_KEY) || "";
  sessionStorage.removeItem(PENDING_PROMO_STORAGE_KEY);
  return normalizeCode(raw);
}

function savePendingUsername(username) {
  const normalized = normalizeUsername(username || "");
  if (!normalized) {
    sessionStorage.removeItem(PENDING_USERNAME_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(PENDING_USERNAME_STORAGE_KEY, normalized);
}

function consumePendingUsername() {
  const raw = sessionStorage.getItem(PENDING_USERNAME_STORAGE_KEY) || "";
  sessionStorage.removeItem(PENDING_USERNAME_STORAGE_KEY);
  return normalizeUsername(raw);
}

function savePendingOneClickId(oneClickId) {
  const clean = String(oneClickId || "").trim().toUpperCase().slice(0, 64);
  if (!clean) {
    sessionStorage.removeItem(PENDING_ONECLICK_ID_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(PENDING_ONECLICK_ID_STORAGE_KEY, clean);
}

function consumePendingOneClickId() {
  const raw = sessionStorage.getItem(PENDING_ONECLICK_ID_STORAGE_KEY) || "";
  sessionStorage.removeItem(PENDING_ONECLICK_ID_STORAGE_KEY);
  return String(raw || "").trim().toUpperCase().slice(0, 64);
}

function randomToken(size = 10) {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < size; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function countLetters(text) {
  return (String(text || "").match(/[a-z]/gi) || []).length;
}

function countDigits(text) {
  return (String(text || "").match(/\d/g) || []).length;
}

function isValidOneClickUsername(username) {
  const normalized = normalizeUsername(username || "");
  return isValidUsername(normalized) && countLetters(normalized) >= 4 && countDigits(normalized) >= 1;
}

function isValidOneClickPassword(password) {
  const raw = String(password || "");
  return isValidPassword(raw) && countLetters(raw) >= 1 && countDigits(raw) >= 1;
}

function getOrCreateDeviceId() {
  try {
    const existing = window.localStorage?.getItem(CLIENT_DEVICE_STORAGE_KEY) || "";
    if (existing) return existing;
    const created = `web_${Date.now().toString(36)}_${randomToken(8)}`;
    window.localStorage?.setItem(CLIENT_DEVICE_STORAGE_KEY, created);
    return created;
  } catch (_) {
    return `web_${Date.now().toString(36)}_${randomToken(8)}`;
  }
}

function detectBrowserName() {
  const ua = String(window.navigator?.userAgent || "");
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("OPR/") || ua.includes("Opera")) return "Opera";
  if (ua.includes("Firefox/")) return "Firefox";
  if (ua.includes("Chrome/")) return "Chrome";
  if (ua.includes("Safari/")) return "Safari";
  return "Unknown";
}

function inferCountryCode() {
  const locale = String(
    window.navigator?.language ||
    Intl.DateTimeFormat().resolvedOptions().locale ||
    ""
  ).trim();
  const parts = locale.split(/[-_]/).filter(Boolean);
  if (parts.length > 1) {
    return String(parts[parts.length - 1] || "").toUpperCase();
  }
  return "";
}

function collectAnalyticsContext() {
  const params = new URLSearchParams(window.location.search || "");
  return {
    deviceId: getOrCreateDeviceId(),
    appVersion: "web-public",
    country: inferCountryCode(),
    browser: detectBrowserName(),
    landingPage: String(window.location.pathname || "/"),
    utmSource: String(params.get("utm_source") || ""),
    utmCampaign: String(params.get("utm_campaign") || ""),
    creativeId: String(params.get("creative_id") || params.get("creativeId") || ""),
  };
}

function clearAuthFallbackRenderTimer() {
  if (authFallbackRenderTimer) {
    window.clearTimeout(authFallbackRenderTimer);
    authFallbackRenderTimer = null;
  }
}

function setAuthBootstrapMessage(message = "", tone = "info") {
  authBootstrapMessage = String(message || "").trim();
  authBootstrapTone = tone || "info";
  pageAuthDebug("setBootstrapMessage", {
    tone: authBootstrapTone,
    message: authBootstrapMessage,
  });
}

function storeAuthSuccessNotice() {
  try {
    sessionStorage.setItem(
      AUTH_SUCCESS_NOTICE_STORAGE_KEY,
      JSON.stringify({ ts: Date.now(), type: "auth_success" })
    );
  } catch (_) {}
}

function scheduleAuthFallbackRender(delayMs = 1200) {
  pageAuthDebug("scheduleAuthFallbackRender", { delayMs });
  clearAuthFallbackRenderTimer();
  authFallbackRenderTimer = window.setTimeout(() => {
    authFallbackRenderTimer = null;
    pageAuthDebug("scheduleAuthFallbackRender:tick");
    if (redirectingToApp) return;
    if (auth.currentUser) return;
    if (latestObservedUser !== null) return;
    if (authBootstrapReady !== true || authStateResolved !== true) return;
    pageAuthDebug("scheduleAuthFallbackRender:renderPage1");
    renderPage1();
  }, Math.max(250, Number(delayMs) || 1200));
}

function userRequiresEmailVerification(user) {
  if (!user || !isEmailPasswordUser(user)) return false;
  const email = String(user?.email || "").trim().toLowerCase();
  if (isOneClickAuthEmail(email)) return false;
  return user.emailVerified !== true;
}

function setVerificationStatus(message, tone = "info") {
  const statusEl = document.getElementById("emailVerifyStatus");
  if (!statusEl) return;

  const toneClassMap = {
    info: "border-white/20 bg-white/10 text-white/90",
    success: "border-emerald-300/40 bg-emerald-500/15 text-emerald-100",
    warning: "border-amber-300/40 bg-amber-500/15 text-amber-100",
    error: "border-red-300/40 bg-red-500/15 text-red-100",
  };
  const toneClass = toneClassMap[tone] || toneClassMap.info;

  statusEl.className = `mt-4 rounded-2xl border px-4 py-3 text-xs sm:text-sm ${toneClass}`;
  statusEl.textContent = message || "";
}

function closeEmailVerificationModal() {
  const overlay = document.getElementById("emailVerificationOverlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.classList.remove("flex");
  updateAuthModalBodyLock();
}

function syncOneClickModalStep(requestedStep = 0) {
  const overlay = document.getElementById("oneClickAuthOverlay");
  if (!overlay) return 0;
  const modalCard = document.getElementById("oneClickAuthCard");
  const steps = Array.from(overlay.querySelectorAll("[data-oneclick-step]"));
  const totalSteps = steps.length;
  if (totalSteps === 0) return 0;
  const safeStep = Math.max(0, Math.min(Number(requestedStep) || 0, totalSteps - 1));
  overlay.dataset.step = String(safeStep);
  if (modalCard) {
    const isMobile = window.matchMedia("(max-width: 640px)").matches;
    const mobileHeights = ["24.5rem", "25.5rem", "25.5rem", "25rem", "28rem"];
    const desktopHeights = ["24rem", "25rem", "25rem", "24.5rem", "26.5rem"];
    const targetHeight = (isMobile ? mobileHeights : desktopHeights)[safeStep] || (isMobile ? "25rem" : "24.5rem");
    modalCard.style.height = targetHeight;
    modalCard.style.minHeight = targetHeight;
    modalCard.style.maxHeight = "calc(100dvh - 1.5rem)";
  }

  steps.forEach((stepNode, index) => {
    const active = index === safeStep;
    stepNode.classList.toggle("hidden", !active);
    stepNode.setAttribute("aria-hidden", active ? "false" : "true");
  });

  overlay.querySelectorAll("[data-oneclick-dot]").forEach((dot, index) => {
    const active = index === safeStep;
    dot.classList.toggle("bg-[#f48f45]", active);
    dot.classList.toggle("border-[#f7c08d]", active);
    dot.classList.toggle("bg-white/12", !active);
    dot.classList.toggle("border-white/10", !active);
  });

  const label = overlay.querySelector("#oneClickStepLabel");
  if (label) label.textContent = `Étape ${safeStep + 1} sur ${totalSteps}`;

  const prevBtn = overlay.querySelector("#oneClickStepPrevBtn");
  if (prevBtn) {
    prevBtn.classList.toggle("hidden", safeStep === 0);
  }

  const nextBtn = overlay.querySelector("#oneClickStepNextBtn");
  if (nextBtn) {
    nextBtn.classList.toggle("hidden", safeStep === totalSteps - 1);
  }

  const submitBtn = overlay.querySelector("#oneClickAuthSubmitBtn");
  if (submitBtn) {
    submitBtn.classList.toggle("hidden", safeStep !== totalSteps - 1);
  }

  return safeStep;
}

function ensureOneClickModal() {
  let overlay = document.getElementById("oneClickAuthOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "oneClickAuthOverlay";
    overlay.className = "fixed inset-0 z-[5400] hidden items-center justify-center bg-black/65 p-3 backdrop-blur-md sm:p-4";
    overlay.innerHTML = `
      <div id="oneClickAuthCard" class="relative flex h-[24.5rem] min-h-[24.5rem] w-full max-w-[22.5rem] flex-col overflow-hidden rounded-[26px] border border-white/18 bg-[radial-gradient(circle_at_top,rgba(85,98,139,0.45),rgba(18,24,40,0.96)_58%)] p-4 text-white shadow-[18px_18px_44px_rgba(11,16,29,0.58),-12px_-12px_28px_rgba(99,112,152,0.16)] backdrop-blur-xl sm:max-w-[30rem] sm:rounded-[28px] sm:p-5">
        <button
          id="oneClickAuthCloseBtn"
          type="button"
          aria-label="Fermer"
          title="Fermer"
          class="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-full border border-white/12 bg-white/6 text-white/80 transition hover:border-white/25 hover:bg-white/12"
        >
          <i class="fa-solid fa-xmark text-base"></i>
        </button>
        <div class="flex items-center gap-3 pr-12">
          <div class="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-[#ffb26e]/30 bg-[#f57c00]/14 text-[#ffd2ac] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
            <i class="fa-solid fa-key text-base"></i>
          </div>
          <div class="min-w-0">
            <div class="text-[15px] font-semibold tracking-[0.01em] text-white">Auth en un click</div>
          </div>
        </div>
        <div class="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-2.5">
          <div class="flex items-center justify-between gap-4">
            <div id="oneClickStepLabel" class="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/60">Étape 1 sur 5</div>
            <div class="flex items-center gap-1.5 sm:gap-2">
              <span data-oneclick-dot class="h-2.5 w-2.5 rounded-full border border-[#f7c08d] bg-[#f48f45] shadow-[0_0_14px_rgba(244,143,69,0.45)]"></span>
              <span data-oneclick-dot class="h-2.5 w-2.5 rounded-full border border-white/10 bg-white/12"></span>
              <span data-oneclick-dot class="h-2.5 w-2.5 rounded-full border border-white/10 bg-white/12"></span>
              <span data-oneclick-dot class="h-2.5 w-2.5 rounded-full border border-white/10 bg-white/12"></span>
              <span data-oneclick-dot class="h-2.5 w-2.5 rounded-full border border-white/10 bg-white/12"></span>
            </div>
          </div>
        </div>
        <div class="mt-4 min-h-0 flex-1 overflow-hidden">
          <div data-oneclick-step="0" class="space-y-3">
            <div>
              <label for="oneClickUsername" class="mb-1.5 block text-xs font-medium text-white/70">Nom du player</label>
              <input id="oneClickUsername" type="text" autocomplete="off" placeholder="ex: player509" class="block w-full rounded-2xl border border-white/16 bg-white/[0.08] px-4 py-3 text-sm text-white placeholder-white/45 shadow-[inset_6px_6px_12px_rgba(8,12,22,0.35),inset_-4px_-4px_10px_rgba(84,96,136,0.12)] outline-none transition focus:border-[#f48f45]" />
              <div class="mt-1.5 text-[11px] leading-5 text-white/55">3 à 24 caractères, avec au moins 4 lettres et 1 chiffre.</div>
            </div>
          </div>
          <div data-oneclick-step="1" class="hidden space-y-3">
            <div>
              <label for="oneClickPassword" class="mb-1.5 block text-xs font-medium text-white/70">Passcode</label>
              <div class="relative">
                <input id="oneClickPassword" type="password" autocomplete="new-password" placeholder="Minimum 6 caractères" class="block w-full rounded-2xl border border-white/16 bg-white/[0.08] px-4 py-3 pr-12 text-sm text-white placeholder-white/45 shadow-[inset_6px_6px_12px_rgba(8,12,22,0.35),inset_-4px_-4px_10px_rgba(84,96,136,0.12)] outline-none transition focus:border-[#f48f45]" />
                <button
                  id="oneClickPasswordToggleBtn"
                  type="button"
                  aria-label="Afficher le mot de passe"
                  title="Afficher le mot de passe"
                  class="absolute inset-y-0 right-2 my-auto grid h-9 w-9 place-items-center rounded-xl border border-white/16 bg-white/[0.08] text-white/82 transition hover:bg-white/14"
                >
                  <i class="fa-regular fa-eye"></i>
                </button>
              </div>
              <div class="mt-1.5 text-[11px] leading-5 text-white/55">Le passcode doit contenir au moins 1 lettre et 1 chiffre.</div>
            </div>
          </div>
          <div data-oneclick-step="2" class="hidden space-y-3">
            <div class="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-[12px] leading-5 text-white/62">
              Réécris exactement le passcode précédent pour confirmer qu’il est correct.
            </div>
            <div>
              <label for="oneClickPasswordConfirm" class="mb-1.5 block text-xs font-medium text-white/70">Vérification du passcode</label>
              <div class="relative">
                <input id="oneClickPasswordConfirm" type="password" autocomplete="new-password" placeholder="Confirme ton passcode" class="block w-full rounded-2xl border border-white/16 bg-white/[0.08] px-4 py-3 pr-12 text-sm text-white placeholder-white/45 shadow-[inset_6px_6px_12px_rgba(8,12,22,0.35),inset_-4px_-4px_10px_rgba(84,96,136,0.12)] outline-none transition focus:border-[#f48f45]" />
                <button
                  id="oneClickPasswordConfirmToggleBtn"
                  type="button"
                  aria-label="Afficher le mot de passe de confirmation"
                  title="Afficher le mot de passe de confirmation"
                  class="absolute inset-y-0 right-2 my-auto grid h-9 w-9 place-items-center rounded-xl border border-white/16 bg-white/[0.08] text-white/82 transition hover:bg-white/14"
                >
                  <i class="fa-regular fa-eye"></i>
                </button>
              </div>
            </div>
          </div>
          <div data-oneclick-step="3" class="hidden space-y-2.5">
            <div class="rounded-2xl border border-[#ffb26e]/22 bg-[#f57c00]/10 px-4 py-3.5 text-sm leading-6 text-white/80">
              Tu peux ajouter un code promo si tu en as un. <span class="font-semibold text-white">Cette étape est facultative.</span>
            </div>
            <div>
              <label for="oneClickPromoInput" class="mb-1.5 block text-xs font-medium text-white/70">Code promo optionnel</label>
              <input
                id="oneClickPromoInput"
                type="text"
                placeholder="Ex: BONUS25"
                autocapitalize="characters"
                autocomplete="off"
                spellcheck="false"
                class="block w-full rounded-2xl border border-white/16 bg-white/[0.08] px-4 py-3.5 text-sm uppercase text-white placeholder-white/45 shadow-[inset_6px_6px_12px_rgba(8,12,22,0.35),inset_-4px_-4px_10px_rgba(84,96,136,0.12)] outline-none transition focus:border-[#f48f45]"
              />
            </div>
            <div class="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-[12px] leading-5 text-white/56">
              Si tu n’as pas de code promo, passe directement à l’étape suivante.
            </div>
          </div>
          <div data-oneclick-step="4" class="hidden space-y-2.5">
            <div class="space-y-3 rounded-2xl border border-white/12 bg-white/[0.05] px-4 py-3.5">
              <label class="flex items-start gap-3 text-sm text-white/90">
                <input
                  id="oneClickAgeCheckbox"
                  type="checkbox"
                  class="mt-1 h-4 w-4 rounded border-white/30 bg-white/10 text-[#f48f45]"
                />
                <span>J'ai 18 ans ou plus.</span>
              </label>
              <label class="flex items-start gap-3 text-sm text-white/90">
                <input
                  id="oneClickTermsCheckbox"
                  type="checkbox"
                  class="mt-1 h-4 w-4 rounded border-white/30 bg-white/10 text-[#f48f45]"
                />
                <span>
                  J'accepte les
                  <a href="${TERMS_ROUTE}" target="_blank" rel="noopener noreferrer" class="font-semibold text-[#ffd8b5] underline underline-offset-2">conditions d'utilisation</a>.
                </span>
              </label>
              <div class="text-[11px] leading-5 text-white/62 sm:text-xs">
                Tu confirmes aussi avoir lu la
                <a href="${PRIVACY_ROUTE}" target="_blank" rel="noopener noreferrer" class="text-[#ffd8b5] underline underline-offset-2">politique de confidentialité</a>
                et les
                <a href="${LEGAL_ROUTE}" target="_blank" rel="noopener noreferrer" class="text-[#ffd8b5] underline underline-offset-2">mentions légales</a>.
              </div>
            </div>
          </div>
        </div>
        <div id="oneClickAuthError" class="mt-2.5 min-h-5 text-sm text-[#ffb0b0]"></div>
        <div class="mt-3 flex flex-col gap-3 sm:flex-row">
          <button id="oneClickAuthCancelBtn" type="button" class="h-11 flex-1 rounded-2xl border border-white/12 bg-white/[0.06] text-sm font-semibold text-white/82 transition hover:bg-white/[0.1]">
            Annuler
          </button>
          <button id="oneClickStepPrevBtn" type="button" class="hidden h-11 flex-1 rounded-2xl border border-white/12 bg-white/[0.06] text-sm font-semibold text-white/82 transition hover:bg-white/[0.1]">
            Précédent
          </button>
          <button id="oneClickStepNextBtn" type="button" class="h-11 flex-1 rounded-2xl border border-[#ffb26e]/80 bg-[#F57C00] text-sm font-semibold text-white shadow-[8px_8px_18px_rgba(163,82,27,0.45),-6px_-6px_14px_rgba(255,175,102,0.22)] transition hover:-translate-y-0.5 hover:bg-[#ff9549]">
            Suivant
          </button>
          <button id="oneClickAuthSubmitBtn" type="button" class="hidden h-11 flex-1 rounded-2xl border border-[#ffb26e]/80 bg-[#F57C00] text-sm font-semibold text-white shadow-[8px_8px_18px_rgba(163,82,27,0.45),-6px_-6px_14px_rgba(255,175,102,0.22)] transition hover:-translate-y-0.5 hover:bg-[#ff9549]">
            S'inscrire
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  }
  return overlay;
}

function openOneClickModal() {
  const overlay = ensureOneClickModal();
  const usernameInput = document.getElementById("oneClickUsername");
  const passwordInput = document.getElementById("oneClickPassword");
  const passwordConfirmInput = document.getElementById("oneClickPasswordConfirm");
  const promoInput = document.getElementById("oneClickPromoInput");
  const errorEl = document.getElementById("oneClickAuthError");
  if (usernameInput) usernameInput.value = "";
  if (passwordInput) passwordInput.value = "";
  if (passwordConfirmInput) passwordConfirmInput.value = "";
  if (promoInput) promoInput.value = String(document.getElementById("promoCodeInput")?.value || "");
  if (passwordInput) passwordInput.type = "password";
  if (passwordConfirmInput) passwordConfirmInput.type = "password";
  const resetEyeState = (btnId) => {
    const btn = document.getElementById(btnId);
    const icon = btn?.querySelector("i");
    if (!btn) return;
    btn.setAttribute("aria-label", "Afficher le mot de passe");
    btn.setAttribute("title", "Afficher le mot de passe");
    if (icon) {
      icon.classList.add("fa-eye");
      icon.classList.remove("fa-eye-slash");
    }
  };
  resetEyeState("oneClickPasswordToggleBtn");
  resetEyeState("oneClickPasswordConfirmToggleBtn");
  const pageAgeCheckbox = document.getElementById("signupAgeCheckbox");
  const pageTermsCheckbox = document.getElementById("signupTermsCheckbox");
  const modalAgeCheckbox = document.getElementById("oneClickAgeCheckbox");
  const modalTermsCheckbox = document.getElementById("oneClickTermsCheckbox");
  if (modalAgeCheckbox) modalAgeCheckbox.checked = pageAgeCheckbox?.checked === true;
  if (modalTermsCheckbox) modalTermsCheckbox.checked = pageTermsCheckbox?.checked === true;
  if (errorEl) errorEl.textContent = "";
  syncOneClickModalStep(0);
  overlay.classList.remove("hidden");
  overlay.classList.add("flex");
  updateAuthModalBodyLock();
}

function closeOneClickModal() {
  const overlay = document.getElementById("oneClickAuthOverlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.classList.remove("flex");
  updateAuthModalBodyLock();
}

function ensureEmailVerificationModal() {
  let overlay = document.getElementById("emailVerificationOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "emailVerificationOverlay";
    overlay.className = "fixed inset-0 z-[5200] hidden items-center justify-center bg-black/60 p-4 backdrop-blur-md";
    overlay.innerHTML = `
      <div class="w-[min(94vw,34rem)] rounded-3xl border border-white/20 bg-[#3F4766]/85 p-5 text-white shadow-[14px_14px_34px_rgba(16,23,40,0.5),-10px_-10px_24px_rgba(112,126,165,0.2)] backdrop-blur-xl sm:p-6">
        <h2 class="text-xl font-bold tracking-wide sm:text-2xl">Vérifie ton email</h2>
        <p class="mt-2 text-sm text-white/85">
          Un email de vérification a été envoyé à <span id="emailVerifyTarget" class="font-semibold text-[#ffd8b5]">ton adresse</span>.
        </p>
        <p class="mt-1 text-xs text-amber-200/95">
          Important: regarde aussi dans les dossiers <span class="font-semibold">Spam</span> ou <span class="font-semibold">Courrier indésirable</span> si tu ne le vois pas.
        </p>
        <div class="mt-4 rounded-2xl border border-white/20 bg-white/10 p-4 text-xs text-white/80 sm:text-sm">
          Ouvre l'email reçu, clique sur le lien de confirmation, puis reviens ici. Si le message tarde, attends quelques secondes avant de recliquer.
        </div>
        <div id="emailVerifyStatus" class="mt-4 rounded-2xl border border-white/20 bg-white/10 px-4 py-3 text-xs text-white/90 sm:text-sm">
          Vérification en attente.
        </div>
        <div class="mt-4">
          <button id="emailVerifyRefreshBtn" type="button" class="h-11 w-full rounded-2xl border border-[#ffb26e] bg-[#F57C00] text-sm font-semibold text-white shadow-[8px_8px_18px_rgba(163,82,27,0.45),-6px_-6px_14px_rgba(255,175,102,0.22)] transition hover:-translate-y-0.5">
            J'ai vérifié mon email
          </button>
        </div>
        <button id="emailVerifyWrongEmailBtn" type="button" class="mt-3 w-full rounded-2xl border border-white/15 bg-white/6 px-4 py-3 text-sm font-semibold text-white/88 transition hover:bg-white/10">
          Ce n'etait pas mon email
        </button>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  const refreshBtn = document.getElementById("emailVerifyRefreshBtn");
  const wrongEmailBtn = document.getElementById("emailVerifyWrongEmailBtn");

  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = "1";
    refreshBtn.addEventListener("click", async () => {
      try {
        await withButtonLoading(refreshBtn, async () => {
          const verified = await checkEmailVerificationAndContinue("", { showWaitingMessage: true });
          if (!verified) {
            setVerificationStatus("Email pas encore vérifié. Ouvre le mail reçu, clique le lien puis recommence.", "warning");
          }
        }, { loadingLabel: "Vérification..." });
      } catch (err) {
        setVerificationStatus(formatAuthError(err, "Impossible de vérifier pour le moment."), "error");
      }
    });
  }

  if (wrongEmailBtn && !wrongEmailBtn.dataset.bound) {
    wrongEmailBtn.dataset.bound = "1";
    wrongEmailBtn.addEventListener("click", async () => {
      try {
        await withButtonLoading(wrongEmailBtn, async () => {
          authMode = "signup";
          redirectingToApp = false;
          savePendingPromoCode("");
          await logoutCurrentUser();
          closeEmailVerificationModal();
          renderPage1();
        }, { loadingLabel: "Retour..." });
      } catch (err) {
        setVerificationStatus(formatAuthError(err, "Impossible de revenir au formulaire pour le moment."), "error");
      }
    });
  }

  return overlay;
}

async function sendVerificationEmailIfNeeded(user) {
  if (!user || !user.uid || verificationEmailSentByUid.has(user.uid)) return;
  try {
    await sendSignupVerificationEmail(user);
    verificationEmailSentByUid.add(user.uid);
    setVerificationStatus("Email envoyé. Vérifie ta boîte de réception et le dossier Spam/Indésirable.", "success");
  } catch (err) {
    setVerificationStatus(formatAuthError(err, "Impossible d'envoyer l'email de vérification."), "error");
  }
}

async function showEmailVerificationModal(user) {
  pageAuthDebug("showEmailVerificationModal", {
    uid: String(user?.uid || ""),
    email: String(user?.email || ""),
  });
  hideGlobalLoading();
  const overlay = ensureEmailVerificationModal();
  const emailTarget = document.getElementById("emailVerifyTarget");
  if (emailTarget) emailTarget.textContent = user?.email || "ton adresse email";
  overlay.classList.remove("hidden");
  overlay.classList.add("flex");
  updateAuthModalBodyLock();

  setVerificationStatus("Confirme ton email puis reviens ici et clique sur le bouton ci-dessous.", "info");
  await sendVerificationEmailIfNeeded(user);
}

async function checkEmailVerificationAndContinue(explicitPromoCode = "", options = {}) {
  pageAuthDebug("checkEmailVerificationAndContinue:start", {
    explicitPromoCode: String(explicitPromoCode || ""),
    showWaitingMessage: options?.showWaitingMessage === true,
  });
  const refreshedUser = await refreshCurrentUser(auth.currentUser);
  if (!refreshedUser) {
    pageAuthDebug("checkEmailVerificationAndContinue:noRefreshedUser");
    closeEmailVerificationModal();
    return false;
  }
  if (userRequiresEmailVerification(refreshedUser)) {
    pageAuthDebug("checkEmailVerificationAndContinue:stillUnverified", {
      uid: String(refreshedUser?.uid || ""),
      emailVerified: refreshedUser?.emailVerified === true,
    });
    if (options.showWaitingMessage) {
      setVerificationStatus("Toujours en attente de vérification. Ouvre le mail reçu et clique le lien de confirmation.", "warning");
    }
    return false;
  }
  pageAuthDebug("checkEmailVerificationAndContinue:verified", {
    uid: String(refreshedUser?.uid || ""),
  });
  closeEmailVerificationModal();
  await bootstrapReferralBeforeRedirect(refreshedUser, explicitPromoCode);
  redirectToHomeApp(refreshedUser);
  return true;
}

function redirectToHomeApp(user) {
  pageAuthDebug("redirectToHomeApp:enter", {
    uid: String(user?.uid || auth.currentUser?.uid || ""),
  });
  if (redirectingToApp) return;
  redirectingToApp = true;
  showGlobalLoading("Connexion réussie. Chargement de l'accueil...");
  storeAuthSuccessNotice();
  setAuthBootstrapMessage("Connexion réussie. Redirection vers l'accueil...", "success");
  const currentPath = String(window.location.pathname || "");
  const onHomePage =
    currentPath.endsWith("/inedex.html") ||
    currentPath.endsWith("inedex.html") ||
    currentPath.endsWith("/index.html") ||
    currentPath.endsWith("index.html") ||
    currentPath === "/" ||
    currentPath === "";
  pageAuthDebug("redirectToHomeApp:pathCheck", {
    currentPath,
    onHomePage,
    target: APP_HOME_ROUTE,
  });
  if (onHomePage) {
    pageAuthDebug("redirectToHomeApp:renderPage2Inline");
    void ensurePage2Module()
      .then(({ renderPage2 }) => {
        hideGlobalLoading();
        renderPage2(user || auth.currentUser);
      })
      .catch((error) => {
        pageAuthDebug("redirectToHomeApp:renderPage2InlineError", {
          error: String(error?.message || error),
        });
        window.location.replace(APP_HOME_ROUTE);
      });
    return;
  }
  pageAuthDebug("redirectToHomeApp:replace");
  window.location.replace(APP_HOME_ROUTE);
  window.setTimeout(() => {
    const path = String(window.location.pathname || "");
    pageAuthDebug("redirectToHomeApp:fallbackCheck", { path });
    if (path.endsWith("/auth.html") || path.endsWith("auth.html")) {
      pageAuthDebug("redirectToHomeApp:fallbackAssign");
      window.location.assign(APP_HOME_ROUTE);
    }
  }, 1200);
}

async function bootstrapReferralBeforeRedirect(user, explicitPromoCode = "") {
  if (!user) return;
  const urlCtx = getReferralContextFromUrl(window.location.search);
  const typedPromoCode = normalizeCode(explicitPromoCode || "");
  const pendingPromoCode = consumePendingPromoCode();
  const pendingUsername = consumePendingUsername();
  const pendingOneClickId = consumePendingOneClickId();
  const queryPromoCode = normalizeCode(urlCtx.promoCodeFromQuery || "");
  const linkReferralCode = normalizeCode(urlCtx.userCodeFromLink || "");

  let referralPayload = {};
  if (typedPromoCode) {
    referralPayload = { promoCode: typedPromoCode, referralSource: "promo" };
  } else if (pendingPromoCode) {
    referralPayload = { promoCode: pendingPromoCode, referralSource: "promo" };
  } else if (queryPromoCode) {
    referralPayload = { promoCode: queryPromoCode, referralSource: "promo" };
  } else if (linkReferralCode) {
    referralPayload = { promoCode: linkReferralCode, referralSource: "link" };
  }

  if (!referralBootstrapPromise) {
    pageAuthDebug("bootstrapReferralBeforeRedirect:start", {
      uid: String(user?.uid || ""),
      explicitPromoCode: typedPromoCode,
      pendingPromoCode,
      pendingUsername,
      pendingOneClickId,
      queryPromoCode,
      linkReferralCode,
      referralPayload,
    });
    referralBootstrapPromise = updateClientProfileSecure({
      ...collectAnalyticsContext(),
      ...referralPayload,
      username: pendingUsername || undefined,
      oneClickId: pendingOneClickId || undefined,
    })
      .catch((err) => {
        console.error("Secure profile bootstrap error:", err);
        pageAuthDebug("bootstrapReferralBeforeRedirect:error", {
          error: String(err?.message || err),
          code: String(err?.code || ""),
        });
      })
      .finally(() => {
        pageAuthDebug("bootstrapReferralBeforeRedirect:done");
        referralBootstrapPromise = null;
      });
  }

  await referralBootstrapPromise;
}

async function handleAuthenticatedUser(user, explicitPromoCode = "") {
  pageAuthDebug("handleAuthenticatedUser:start", {
    uid: String(user?.uid || ""),
    email: String(user?.email || ""),
    emailVerified: user?.emailVerified === true,
    explicitPromoCode: String(explicitPromoCode || ""),
  });
  if (!user) return;
  showGlobalLoading("Connexion en cours...");
  clearAuthFallbackRenderTimer();
  if (userRequiresEmailVerification(user)) {
    pageAuthDebug("handleAuthenticatedUser:requiresEmailVerification");
    await showEmailVerificationModal(user);
    return;
  }
  closeEmailVerificationModal();
  const hasPendingPromo = Boolean(sessionStorage.getItem(PENDING_PROMO_STORAGE_KEY));
  const hasPendingUsername = Boolean(sessionStorage.getItem(PENDING_USERNAME_STORAGE_KEY));
  const hasPendingOneClickId = Boolean(sessionStorage.getItem(PENDING_ONECLICK_ID_STORAGE_KEY));
  const shouldBlockRedirectForReferral =
    Boolean(normalizeCode(explicitPromoCode || "")) ||
    hasPendingPromo ||
    hasPendingUsername ||
    hasPendingOneClickId;

  pageAuthDebug("handleAuthenticatedUser:bootstrapMode", {
    shouldBlockRedirectForReferral,
    hasPendingPromo,
    hasPendingUsername,
    hasPendingOneClickId,
  });

  if (shouldBlockRedirectForReferral) {
    await bootstrapReferralBeforeRedirect(user, explicitPromoCode);
  } else {
    void bootstrapReferralBeforeRedirect(user, explicitPromoCode).catch((err) => {
      pageAuthDebug("handleAuthenticatedUser:bootstrapBackgroundError", {
        error: String(err?.message || err),
        code: String(err?.code || ""),
      });
    });
  }
  pageAuthDebug("handleAuthenticatedUser:redirectToHome");
  redirectToHomeApp(user);
}

function renderAuthLoading() {
  getAuthShell().innerHTML = `
    <div class="min-h-screen grid place-items-center bg-[#3f4766] text-white font-['Poppins']">
      <div class="rounded-3xl border border-white/15 bg-white/10 px-6 py-5 text-center shadow-[12px_12px_28px_rgba(25,30,44,0.42),-10px_-10px_24px_rgba(97,110,150,0.16)] backdrop-blur-md">
        <div class="text-base font-semibold tracking-wide">Connexion en cours...</div>
      </div>
    </div>
  `;
}

function renderPage1() {
  pageAuthDebug("renderPage1");
  hideGlobalLoading();
  const modeTitle = authMode === "signin" ? "SE CONNECTER" : "S'INSCRIRE";
  const helperPrefix = authMode === "signin" ? "Pas encore de compte ?" : "Déjà un compte ?";
  const helperAction = authMode === "signin" ? "S'inscrire" : "Se connecter";
  const identifierPlaceholder = authMode === "signin" ? "Username ou email" : "Email";
  const referralCtx = getReferralContextFromUrl(window.location.search);
  const hintCode = referralCtx.userCodeFromLink;
  const promoPrefill = normalizeCode(
    referralCtx.promoCodeFromQuery ||
    referralCtx.userCodeFromLink ||
    ""
  );
  const referralHint = authMode === "signup" && hintCode
    ? `
      <div class="mt-3 rounded-2xl border border-[#ffb26e]/45 bg-[#f57c00]/15 px-4 py-3 text-xs text-white/90 sm:text-sm">
        Parrain détecté automatiquement: <span class="font-semibold text-[#ffd8b5]">${escapeAttr(hintCode)}</span>
      </div>
    `
    : "";
  const bootstrapInfo = authBootstrapMessage
    ? `<div id="authInfo" class="mt-2 min-h-5 text-xs ${authBootstrapTone === "success" ? "text-emerald-200" : authBootstrapTone === "error" ? "text-[#ffb0b0]" : "text-amber-200"}">${escapeAttr(authBootstrapMessage)}</div>`
    : `<div id="authInfo" class="mt-2 min-h-5 text-xs text-amber-200"></div>`;
  const oneClickHero = authMode === "signup"
    ? `
      <div class="mt-6">
        <button
          id="oneClickAuthBtn"
          type="button"
          class="w-full rounded-full border border-white/18 bg-white/8 px-6 py-3 text-sm font-semibold tracking-wide text-white shadow-[8px_8px_18px_rgba(22,29,45,0.28),-6px_-6px_14px_rgba(118,131,172,0.12)] backdrop-blur-md transition hover:bg-white/12 sm:text-base"
        >
          Auth en un click
        </button>
      </div>
    `
    : "";

  getAuthShell().innerHTML = `
    <div id="appRoot" class="bg-[#3f4766] text-white font-['Poppins']" style="min-height:100svh;">
      <div class="lg:grid lg:h-[100svh] lg:grid-cols-[1.05fr_0.95fr]" style="min-height:100svh;">
        <section class="auth-scroll-pane flex h-[100svh] max-h-[100svh] flex-col px-6 pb-8 pt-8 sm:px-10 lg:min-h-0 lg:max-h-[100svh] lg:px-0 lg:pl-24 lg:pr-16 lg:pt-10" style="min-height:100svh;">
          <div class="mx-auto w-full max-w-xl rounded-3xl border border-white/10 bg-white/5 p-6 shadow-[12px_12px_28px_rgba(25,30,44,0.42),-10px_-10px_24px_rgba(97,110,150,0.16)] backdrop-blur-md lg:mx-0 lg:bg-transparent lg:p-0 lg:shadow-none lg:backdrop-blur-0">
            <img src="logo.png" alt="Logo" class="h-auto w-[152px] max-w-full object-contain sm:w-[168px] lg:hidden" />

            <h1 class="mt-8 text-5xl font-extrabold leading-none tracking-tight sm:text-6xl lg:mt-10 lg:text-7xl">
              Dominoes
            </h1>

            <p class="mt-5 text-sm text-white/80 sm:text-base">
              ${helperPrefix}
              <button id="switchAuthMode" type="button" class="font-semibold text-[#f48f45] hover:text-[#ff9f58]">${helperAction}</button>
            </p>
            ${referralHint}
            ${oneClickHero}

            <form id="authForm" class="mt-7 space-y-4 sm:space-y-5">
              <input
                id="emailInput"
                type="${authMode === "signin" ? "text" : "email"}"
                placeholder="${identifierPlaceholder}"
                autocomplete="email"
                class="block w-full rounded-2xl border border-white/20 bg-white/10 px-5 py-3.5 text-sm text-white placeholder-white/60 shadow-[inset_6px_6px_12px_rgba(34,40,59,0.45),inset_-6px_-6px_12px_rgba(93,105,143,0.28)] backdrop-blur-md outline-none ring-0 transition focus:border-[#f48f45] sm:text-base"
              />
              <div class="relative">
                <input
                  id="passwordInput"
                  type="password"
                  placeholder="Mot de passe"
                  autocomplete="current-password"
                  class="block w-full rounded-2xl border border-white/20 bg-white/10 px-5 py-3.5 pr-14 text-sm text-white placeholder-white/60 shadow-[inset_6px_6px_12px_rgba(34,40,59,0.45),inset_-6px_-6px_12px_rgba(93,105,143,0.28)] backdrop-blur-md outline-none ring-0 transition focus:border-[#f48f45] sm:text-base"
                />
                <button
                  id="togglePasswordBtn"
                  type="button"
                  aria-label="Afficher le mot de passe"
                  title="Afficher le mot de passe"
                  class="absolute inset-y-0 right-3 my-auto grid h-9 w-9 place-items-center rounded-xl border border-white/20 bg-white/10 text-white/90 transition hover:bg-white/20"
                >
                  <i class="fa-regular fa-eye"></i>
                </button>
              </div>
              ${authMode === "signup" ? `
                <div class="relative">
                  <input
                    id="passwordConfirmInput"
                    type="password"
                    placeholder="Confirmer le mot de passe"
                    autocomplete="new-password"
                    class="block w-full rounded-2xl border border-white/20 bg-white/10 px-5 py-3.5 pr-14 text-sm text-white placeholder-white/60 shadow-[inset_6px_6px_12px_rgba(34,40,59,0.45),inset_-6px_-6px_12px_rgba(93,105,143,0.28)] backdrop-blur-md outline-none ring-0 transition focus:border-[#f48f45] sm:text-base"
                  />
                  <button
                    id="togglePasswordConfirmBtn"
                    type="button"
                    aria-label="Afficher le mot de passe de confirmation"
                    title="Afficher le mot de passe de confirmation"
                    class="absolute inset-y-0 right-3 my-auto grid h-9 w-9 place-items-center rounded-xl border border-white/20 bg-white/10 text-white/90 transition hover:bg-white/20"
                  >
                    <i class="fa-regular fa-eye"></i>
                  </button>
                </div>
              ` : ""}
              ${authMode === "signup" ? `
                <div>
                  <input
                    id="promoCodeInput"
                    type="text"
                    placeholder="Code promo (optionnel)"
                    autocapitalize="characters"
                    autocomplete="off"
                    spellcheck="false"
                    value="${escapeAttr(promoPrefill)}"
                    class="block w-full rounded-2xl border border-white/20 bg-white/10 px-5 py-3.5 text-sm uppercase text-white placeholder-white/60 shadow-[inset_6px_6px_12px_rgba(34,40,59,0.45),inset_-6px_-6px_12px_rgba(93,105,143,0.28)] backdrop-blur-md outline-none ring-0 transition focus:border-[#f48f45] sm:text-base"
                  />
                  <div class="mt-2 px-1 text-[11px] text-white/65 sm:text-xs">
                    Utilisé lors de la création du compte.
                  </div>
                </div>
              ` : ""}
              ${authMode === "signup" ? `
                <div class="space-y-3 rounded-2xl border border-white/15 bg-white/6 px-4 py-4">
                  <label class="flex items-start gap-3 text-sm text-white/90">
                    <input
                      id="signupAgeCheckbox"
                      type="checkbox"
                      class="mt-1 h-4 w-4 rounded border-white/30 bg-white/10 text-[#f48f45]"
                    />
                    <span>J'ai 18 ans ou plus.</span>
                  </label>
                  <label class="flex items-start gap-3 text-sm text-white/90">
                    <input
                      id="signupTermsCheckbox"
                      type="checkbox"
                      class="mt-1 h-4 w-4 rounded border-white/30 bg-white/10 text-[#f48f45]"
                    />
                    <span>
                      J'accepte les
                      <a href="${TERMS_ROUTE}" target="_blank" rel="noopener noreferrer" class="font-semibold text-[#ffd8b5] underline underline-offset-2">conditions d'utilisation</a>.
                    </span>
                  </label>
                  <div class="text-[11px] text-white/65 sm:text-xs">
                    En créant un compte, tu confirmes aussi avoir lu la
                    <a href="${PRIVACY_ROUTE}" target="_blank" rel="noopener noreferrer" class="text-[#ffd8b5] underline underline-offset-2">politique de confidentialité</a>
                    et les
                    <a href="${LEGAL_ROUTE}" target="_blank" rel="noopener noreferrer" class="text-[#ffd8b5] underline underline-offset-2">mentions légales</a>.
                  </div>
                </div>
              ` : ""}
            </form>

            <div class="mt-3 ${authMode === "signup" ? "hidden" : ""}">
              <button id="forgotPasswordBtn" type="button" class="text-sm font-medium text-[#f48f45] hover:text-[#ff9f58]">Mot de passe oublié ?</button>
              <div id="forgotPasswordStatus" class="mt-2 min-h-5 text-xs text-white/75"></div>
            </div>

            <div id="authError" class="mt-4 min-h-5 text-sm text-[#ffb0b0]"></div>
            ${bootstrapInfo}

            <button
              id="authSubmitBtn"
              type="button"
              class="mt-2 w-full rounded-full bg-[#f48f45] px-6 py-3.5 text-sm font-bold tracking-wide text-white shadow-[8px_8px_18px_rgba(179,92,34,0.45),-6px_-6px_14px_rgba(255,182,120,0.22)] transition hover:-translate-y-0.5 hover:bg-[#ff9a4f] sm:text-base"
            >
              ${modeTitle}
            </button>
          </div>

          <div class="mt-auto pt-8 text-[11px] leading-relaxed text-white/70 sm:text-xs">
            <div class="flex flex-wrap gap-x-4 gap-y-1">
              <a href="${TERMS_ROUTE}" target="_blank" rel="noopener noreferrer" class="hover:text-white">Conditions d'utilisation</a>
              <a href="${PRIVACY_ROUTE}" target="_blank" rel="noopener noreferrer" class="hover:text-white">Politique de confidentialité</a>
              <a href="${LEGAL_ROUTE}" target="_blank" rel="noopener noreferrer" class="hover:text-white">Mentions légales</a>
            </div>
          </div>
        </section>

        <aside class="relative hidden items-center justify-center border-l border-white/10 bg-white/5 backdrop-blur-md lg:flex lg:h-[100svh]" style="min-height:100svh;">
          <img id="rightLogo" src="logo.png" alt="Logo" class="h-auto w-[220px] max-w-[70%] object-contain opacity-95" />
        </aside>
      </div>

      <div class="fixed bottom-4 left-4 z-[3400]">
        <button
          id="loginDiscussionFabBtn"
          type="button"
          class="grid h-14 w-14 place-items-center rounded-full border border-white/25 bg-[#3F4766]/75 text-white shadow-[10px_10px_22px_rgba(16,23,40,0.45),-8px_-8px_18px_rgba(112,126,165,0.2)] backdrop-blur-xl transition hover:-translate-y-0.5"
          aria-label="Ouvrir la discussion"
        >
          <i class="fa-solid fa-comments text-xl"></i>
        </button>
      </div>
    </div>
  `;

  bindPage1Events();
  animatePage1();
  updateAuthModalBodyLock();
}

function bindPage1Events() {
  const switchBtn = document.getElementById("switchAuthMode");
  const submitBtn = document.getElementById("authSubmitBtn");
  const oneClickAuthBtn = document.getElementById("oneClickAuthBtn");
  const form = document.getElementById("authForm");
  const emailInput = document.getElementById("emailInput");
  const passwordInput = document.getElementById("passwordInput");
  const passwordConfirmInput = document.getElementById("passwordConfirmInput");
  const togglePasswordBtn = document.getElementById("togglePasswordBtn");
  const togglePasswordConfirmBtn = document.getElementById("togglePasswordConfirmBtn");
  const promoCodeInput = document.getElementById("promoCodeInput");
  const forgotPasswordBtn = document.getElementById("forgotPasswordBtn");
  const forgotPasswordStatus = document.getElementById("forgotPasswordStatus");
  const discussionFabBtn = document.getElementById("loginDiscussionFabBtn");

  const getSignupConsentState = () => {
    const ageCheckbox = document.getElementById("signupAgeCheckbox");
    const termsCheckbox = document.getElementById("signupTermsCheckbox");
    return {
      ageCheckbox,
      termsCheckbox,
      ageAccepted: ageCheckbox?.checked === true,
      termsAccepted: termsCheckbox?.checked === true,
    };
  };

  const setForgotPasswordStatus = (text = "", tone = "neutral") => {
    if (!forgotPasswordStatus) return;
    const toneClass = tone === "success"
      ? "text-emerald-200"
      : tone === "error"
        ? "text-[#ffb0b0]"
        : "text-white/75";
    forgotPasswordStatus.className = `mt-2 min-h-5 text-xs ${toneClass}`;
    forgotPasswordStatus.textContent = text;
  };

  const bindPasswordToggle = (inputEl, buttonEl, hiddenLabel, visibleLabel) => {
    if (!inputEl || !buttonEl || buttonEl.dataset.bound === "1") return;
    buttonEl.dataset.bound = "1";
    const icon = buttonEl.querySelector("i");
    buttonEl.addEventListener("click", () => {
      const isHidden = inputEl.type === "password";
      inputEl.type = isHidden ? "text" : "password";
      const nextLabel = isHidden ? visibleLabel : hiddenLabel;
      buttonEl.setAttribute("aria-label", nextLabel);
      buttonEl.setAttribute("title", nextLabel);
      if (icon) {
        icon.classList.toggle("fa-eye", !isHidden);
        icon.classList.toggle("fa-eye-slash", isHidden);
      }
    });
  };

  bindPasswordToggle(
    passwordInput,
    togglePasswordBtn,
    "Afficher le mot de passe",
    "Masquer le mot de passe"
  );
  bindPasswordToggle(
    passwordConfirmInput,
    togglePasswordConfirmBtn,
    "Afficher le mot de passe de confirmation",
    "Masquer le mot de passe de confirmation"
  );

  if (switchBtn) {
    switchBtn.addEventListener("click", () => {
      authMode = authMode === "signin" ? "signup" : "signin";
      renderPage1();
    });
  }

  const submitAuth = async () => {
    const identifier = (emailInput?.value || "").trim();
    const password = passwordInput?.value || "";
    const confirmPassword = passwordConfirmInput?.value || "";
    const promoCode = authMode === "signup" ? normalizeCode(promoCodeInput?.value || "") : "";
    const errorEl = document.getElementById("authError");
    const usernameCandidate = normalizeUsername(identifier);
    const signinByEmail = identifier.includes("@");
    pageAuthDebug("submitAuth:begin", {
      identifier,
      mode: authMode,
      promoCode,
      signinByEmail,
    });

    if (authMode === "signin") {
      if (signinByEmail) {
        if (!isValidEmail(identifier)) {
          if (errorEl) errorEl.textContent = "Email invalide.";
          return;
        }
      } else if (!isValidUsername(usernameCandidate)) {
        if (errorEl) errorEl.textContent = "Username invalide.";
        return;
      }
    } else if (!isValidEmail(identifier)) {
      if (errorEl) errorEl.textContent = "Email invalide.";
      return;
    }
    if (!isValidPassword(password)) {
      if (errorEl) errorEl.textContent = "Mot de passe invalide (minimum 6 caractères).";
      return;
    }
    if (authMode === "signup" && password !== confirmPassword) {
      if (errorEl) errorEl.textContent = "Le mot de passe de confirmation ne correspond pas.";
      return;
    }
    const signupConsent = authMode === "signup" ? getSignupConsentState() : null;
    if (authMode === "signup" && signupConsent?.ageAccepted !== true) {
      if (errorEl) errorEl.textContent = "Tu dois confirmer que tu as 18 ans ou plus.";
      return;
    }
    if (authMode === "signup" && signupConsent?.termsAccepted !== true) {
      if (errorEl) errorEl.textContent = "Tu dois accepter les conditions d'utilisation pour créer un compte.";
      return;
    }

    if (errorEl) errorEl.textContent = "";
    setForgotPasswordStatus("", "neutral");

    try {
      await withButtonLoading(submitBtn, async () => {
        authFlowBusy = true;
      if (authMode === "signin") {
        savePendingPromoCode("");
        if (signinByEmail) {
          await loginWithEmail(identifier, password);
        } else {
          await loginWithUsername(usernameCandidate, password);
        }
        pageAuthDebug("submitAuth:signinSuccess", {
          uid: String(auth.currentUser?.uid || ""),
          signinByEmail,
          username: usernameCandidate,
        });
        await handleAuthenticatedUser(auth.currentUser);
      } else {
        savePendingPromoCode(promoCode);
        await signupWithEmail(identifier, password);
        pageAuthDebug("submitAuth:signupSuccess", {
          uid: String(auth.currentUser?.uid || ""),
        });
        await handleAuthenticatedUser(auth.currentUser, promoCode);
      }
      }, { loadingLabel: authMode === "signin" ? "Connexion..." : "Création..." });
    } catch (err) {
      console.error("Auth error:", err);
      pageAuthDebug("submitAuth:error", {
        error: String(err?.message || err),
        code: String(err?.code || ""),
      });
      if (errorEl) errorEl.textContent = formatAuthError(err, "Erreur d'authentification");
    } finally {
      authFlowBusy = false;
      pageAuthDebug("submitAuth:finally");
    }
  };

  if (submitBtn) submitBtn.addEventListener("click", submitAuth);
  if (form) {
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      submitAuth();
    });
  }

  if (oneClickAuthBtn && oneClickAuthBtn.dataset.bound !== "1") {
    oneClickAuthBtn.dataset.bound = "1";
    oneClickAuthBtn.addEventListener("click", () => {
      const errorEl = document.getElementById("authError");
      if (errorEl) errorEl.textContent = "";
      openOneClickModal();
    });
  }

  const oneClickOverlay = ensureOneClickModal();
  const oneClickCancelBtn = document.getElementById("oneClickAuthCancelBtn");
  const oneClickCloseBtn = document.getElementById("oneClickAuthCloseBtn");
  const oneClickSubmitBtn = document.getElementById("oneClickAuthSubmitBtn");
  const oneClickErrorEl = document.getElementById("oneClickAuthError");
  const oneClickUsernameInput = document.getElementById("oneClickUsername");
  const oneClickPasswordInput = document.getElementById("oneClickPassword");
  const oneClickPasswordConfirmInput = document.getElementById("oneClickPasswordConfirm");
  const oneClickPromoInput = document.getElementById("oneClickPromoInput");
  const oneClickPasswordToggleBtn = document.getElementById("oneClickPasswordToggleBtn");
  const oneClickPasswordConfirmToggleBtn = document.getElementById("oneClickPasswordConfirmToggleBtn");
  const oneClickAgeCheckbox = document.getElementById("oneClickAgeCheckbox");
  const oneClickTermsCheckbox = document.getElementById("oneClickTermsCheckbox");
  const oneClickStepPrevBtn = document.getElementById("oneClickStepPrevBtn");
  const oneClickStepNextBtn = document.getElementById("oneClickStepNextBtn");

  const syncOneClickDataToSignup = () => {
    const signupAgeCheckbox = document.getElementById("signupAgeCheckbox");
    const signupTermsCheckbox = document.getElementById("signupTermsCheckbox");
    if (promoCodeInput && oneClickPromoInput) promoCodeInput.value = normalizeCode(oneClickPromoInput.value || "");
    if (signupAgeCheckbox && oneClickAgeCheckbox) signupAgeCheckbox.checked = oneClickAgeCheckbox.checked === true;
    if (signupTermsCheckbox && oneClickTermsCheckbox) signupTermsCheckbox.checked = oneClickTermsCheckbox.checked === true;
  };

  const validateOneClickUsernameStep = () => {
    const usernameRaw = String(oneClickUsernameInput?.value || "").trim();
    const username = normalizeUsername(usernameRaw);

    if (!isValidOneClickUsername(username)) {
      if (oneClickErrorEl) oneClickErrorEl.textContent = "Nom du player invalide : au moins 4 lettres, 1 chiffre, et seulement lettres, chiffres, point, tiret ou underscore.";
      return false;
    }
    return true;
  };

  const validateOneClickPasswordStep = () => {
    const password = String(oneClickPasswordInput?.value || "");

    if (!isValidOneClickPassword(password)) {
      if (oneClickErrorEl) oneClickErrorEl.textContent = "Passcode invalide : minimum 6 caractères avec au moins 1 lettre et 1 chiffre.";
      return false;
    }
    return true;
  };

  const validateOneClickPasswordConfirmStep = () => {
    const password = String(oneClickPasswordInput?.value || "");
    const passwordConfirm = String(oneClickPasswordConfirmInput?.value || "");

    if (!passwordConfirm) {
      if (oneClickErrorEl) oneClickErrorEl.textContent = "Tu dois confirmer le passcode.";
      return false;
    }
    if (password !== passwordConfirm) {
      if (oneClickErrorEl) oneClickErrorEl.textContent = "La vérification du passcode ne correspond pas.";
      return false;
    }
    return true;
  };

  bindPasswordToggle(
    oneClickPasswordInput,
    oneClickPasswordToggleBtn,
    "Afficher le mot de passe",
    "Masquer le mot de passe"
  );
  bindPasswordToggle(
    oneClickPasswordConfirmInput,
    oneClickPasswordConfirmToggleBtn,
    "Afficher le mot de passe de confirmation",
    "Masquer le mot de passe de confirmation"
  );

  if (oneClickCancelBtn && oneClickCancelBtn.dataset.bound !== "1") {
    oneClickCancelBtn.dataset.bound = "1";
    oneClickCancelBtn.addEventListener("click", () => {
      closeOneClickModal();
    });
  }

  if (oneClickCloseBtn && oneClickCloseBtn.dataset.bound !== "1") {
    oneClickCloseBtn.dataset.bound = "1";
    oneClickCloseBtn.addEventListener("click", () => {
      closeOneClickModal();
    });
  }

  if (oneClickOverlay && oneClickOverlay.dataset.bound !== "1") {
    oneClickOverlay.dataset.bound = "1";
    oneClickOverlay.addEventListener("click", (ev) => {
      if (ev.target === oneClickOverlay) closeOneClickModal();
    });
  }

  if (oneClickStepPrevBtn && oneClickStepPrevBtn.dataset.bound !== "1") {
    oneClickStepPrevBtn.dataset.bound = "1";
    oneClickStepPrevBtn.addEventListener("click", () => {
      if (oneClickErrorEl) oneClickErrorEl.textContent = "";
      const currentStep = Number(oneClickOverlay?.dataset.step || 0);
      syncOneClickModalStep(currentStep - 1);
    });
  }

  if (oneClickStepNextBtn && oneClickStepNextBtn.dataset.bound !== "1") {
    oneClickStepNextBtn.dataset.bound = "1";
    oneClickStepNextBtn.addEventListener("click", () => {
      if (oneClickErrorEl) oneClickErrorEl.textContent = "";
      const currentStep = Number(oneClickOverlay?.dataset.step || 0);
      if (currentStep === 0 && !validateOneClickUsernameStep()) return;
      if (currentStep === 1 && !validateOneClickPasswordStep()) return;
      if (currentStep === 2 && !validateOneClickPasswordConfirmStep()) return;
      if (currentStep === 3) {
        syncOneClickDataToSignup();
      }
      syncOneClickModalStep(currentStep + 1);
    });
  }

  if (oneClickSubmitBtn && oneClickSubmitBtn.dataset.bound !== "1") {
    oneClickSubmitBtn.dataset.bound = "1";
    oneClickSubmitBtn.addEventListener("click", async () => {
      const usernameRaw = String(oneClickUsernameInput?.value || "").trim();
      const username = normalizeUsername(usernameRaw);
      const password = String(oneClickPasswordInput?.value || "");
      const passwordConfirm = String(oneClickPasswordConfirmInput?.value || "");
      const oneClickId = createOneClickAccountId();
      const promoCode = normalizeCode(oneClickPromoInput?.value || "");

      if (oneClickErrorEl) oneClickErrorEl.textContent = "";
      const ageAccepted = oneClickAgeCheckbox?.checked === true;
      const termsAccepted = oneClickTermsCheckbox?.checked === true;
      if (ageAccepted !== true) {
        if (oneClickErrorEl) oneClickErrorEl.textContent = "Tu dois confirmer que tu as 18 ans ou plus.";
        return;
      }
      if (termsAccepted !== true) {
        if (oneClickErrorEl) oneClickErrorEl.textContent = "Tu dois accepter les conditions d'utilisation pour créer ton compte.";
        return;
      }
      if (!validateOneClickUsernameStep()) return;
      if (!validateOneClickPasswordStep()) return;
      if (!validateOneClickPasswordConfirmStep()) return;

      try {
        await withButtonLoading(oneClickSubmitBtn, async () => {
          pageAuthDebug("oneClickSignup:start", { username, oneClickId });
          syncOneClickDataToSignup();
          savePendingUsername(username);
          savePendingOneClickId(oneClickId);
          savePendingPromoCode(promoCode);
          await signupWithUsername(username, password);
          pageAuthDebug("oneClickSignup:success", { uid: String(auth.currentUser?.uid || ""), username, oneClickId });
          closeOneClickModal();
          await handleAuthenticatedUser(auth.currentUser);
        }, { loadingLabel: "Création..." });
      } catch (err) {
        console.error("One click auth error:", err);
        pageAuthDebug("oneClickSignup:error", {
          code: String(err?.code || ""),
          message: String(err?.message || err),
        });
        if (oneClickErrorEl) oneClickErrorEl.textContent = formatAuthError(err, "Impossible de créer ce compte.");
      }
    });
  }

  if (forgotPasswordBtn && forgotPasswordBtn.dataset.bound !== "1") {
    forgotPasswordBtn.dataset.bound = "1";
    forgotPasswordBtn.addEventListener("click", async () => {
      const email = (emailInput?.value || "").trim();
      const errorEl = document.getElementById("authError");
      if (errorEl) errorEl.textContent = "";

      if (!isValidEmail(email)) {
        setForgotPasswordStatus("Entre l'email du compte pour réinitialiser le mot de passe.", "error");
        return;
      }

      try {
        await withButtonLoading(
          forgotPasswordBtn,
          async () => {
            await sendPasswordReset(email);
            setForgotPasswordStatus("Email de réinitialisation envoyé. Vérifie aussi le dossier Spam/Indésirable.", "success");
          },
          { loadingLabel: "Envoi..." }
        );
      } catch (err) {
        console.error("Password reset error:", err);
        setForgotPasswordStatus(formatAuthError(err, "Impossible d'envoyer l'email de réinitialisation."), "error");
      }
    });
  }

  if (discussionFabBtn && discussionFabBtn.dataset.bound !== "1") {
    discussionFabBtn.dataset.bound = "1";
    discussionFabBtn.addEventListener("click", () => {
      window.location.href = "./discussion.html";
    });
  }
}

renderAuthLoading();
showGlobalLoading("Préparation de la connexion...");
pageAuthDebug("bootstrap:renderAuthLoadingDone");
authBootstrapReady = true;
pageAuthDebug("bootstrap:noGoogle:ready");
if (auth.currentUser) {
  handleAuthenticatedUser(auth.currentUser).catch((err) => {
    pageAuthDebug("bootstrap:noGoogle:currentUser:catch", {
      error: String(err?.message || err),
      code: String(err?.code || ""),
    });
  });
} else {
  hideGlobalLoading();
  renderPage1();
}

async function animatePage1() {
  let anime = null;
  try {
    anime = await ensureAnimeRuntime();
  } catch (error) {
    console.warn("[PAGE1] animation runtime unavailable", error);
    return;
  }
  if (!anime) return;

  anime({
    targets: "#appRoot",
    opacity: [0, 1],
    duration: 650,
    easing: "easeOutQuad",
  });

  const animatedInputs = ["#emailInput", "#passwordInput"];
  if (authMode === "signup") {
    animatedInputs.push("#promoCodeInput");
    animatedInputs.push("#passwordConfirmInput");
  }

  anime({
    targets: animatedInputs,
    translateY: [22, 0],
    opacity: [0, 1],
    delay: anime.stagger(120, { start: 200 }),
    duration: 600,
    easing: "easeOutCubic",
  });

  anime({
    targets: "#rightLogo",
    translateY: [-8, 8],
    direction: "alternate",
    loop: true,
    duration: 2200,
    easing: "easeInOutSine",
  });

  const signInBtn = document.getElementById("authSubmitBtn");
  if (signInBtn) {
    signInBtn.addEventListener("mouseenter", () => {
      anime({ targets: signInBtn, scale: 1.025, duration: 180, easing: "easeOutQuad" });
    });
    signInBtn.addEventListener("mouseleave", () => {
      anime({ targets: signInBtn, scale: 1, duration: 180, easing: "easeOutQuad" });
    });
  }
}

watchAuthState((user) => {
  pageAuthDebug("watchAuthState:callback", {
    hasUser: Boolean(user),
    uid: String(user?.uid || ""),
    email: String(user?.email || ""),
    emailVerified: user?.emailVerified === true,
    currentUid: String(auth.currentUser?.uid || ""),
  });
  authStateResolved = true;
  latestObservedUser = user || null;
  if (user) {
    setAuthBootstrapMessage("", "info");
    clearAuthFallbackRenderTimer();
    handleAuthenticatedUser(user).catch((err) => {
      console.error("Auth state redirect error:", err);
      pageAuthDebug("watchAuthState:handleAuthenticatedUser:catch", {
        error: String(err?.message || err),
        code: String(err?.code || ""),
      });
      if (userRequiresEmailVerification(user)) {
        showEmailVerificationModal(user).catch((modalErr) => {
          console.error("Email verification modal error:", modalErr);
          pageAuthDebug("watchAuthState:showEmailVerificationModal:catch", {
            error: String(modalErr?.message || modalErr),
          });
        });
        return;
      }
      redirectToHomeApp(user);
    });
    return;
  }
  redirectingToApp = false;
  pageAuthDebug("watchAuthState:noUser");
  hideGlobalLoading();
  if (authBootstrapReady !== true) return;
  scheduleAuthFallbackRender();
});
