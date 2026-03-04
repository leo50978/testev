import "./firebase-init.js";
import {
  auth,
  formatAuthError,
  isValidEmail,
  isValidPassword,
  loginWithEmail,
  loginWithGoogle,
  completeGoogleRedirectIfAny,
  hasPendingGoogleRedirect,
  clearPendingGoogleRedirect,
  signupWithEmail,
  sendPasswordReset,
  sendSignupVerificationEmail,
  refreshCurrentUser,
  isEmailPasswordUser,
  logoutCurrentUser,
  watchAuthState,
} from "./auth.js";
import { renderPage2 } from "./page2.js";
import { withButtonLoading } from "./loading-ui.js";
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
const PENDING_PROMO_STORAGE_KEY = "domino_pending_promo_code";
const CLIENT_DEVICE_STORAGE_KEY = "domino_device_id_v1";
const verificationEmailSentByUid = new Set();
const APP_HOME_ROUTE = "./index.html";
const TERMS_ROUTE = "./conditions-utilisation.html";
const PRIVACY_ROUTE = "./politique-confidentialite.html";
const LEGAL_ROUTE = "./mentions-legales.html";
let signupConsentResolver = null;

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

function randomToken(size = 10) {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < size; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
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

function scheduleAuthFallbackRender(delayMs = 1200) {
  clearAuthFallbackRenderTimer();
  authFallbackRenderTimer = window.setTimeout(() => {
    authFallbackRenderTimer = null;
    if (redirectingToApp) return;
    if (auth.currentUser) return;
    if (latestObservedUser !== null) return;
    if (authBootstrapReady !== true || authStateResolved !== true) return;
    renderPage1();
  }, Math.max(250, Number(delayMs) || 1200));
}

function userRequiresEmailVerification(user) {
  return Boolean(user && isEmailPasswordUser(user) && user.emailVerified !== true);
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
}

function resolveSignupConsent(value) {
  if (!signupConsentResolver) return;
  const resolver = signupConsentResolver;
  signupConsentResolver = null;
  resolver(Boolean(value));
}

function closeSignupConsentModal(accepted = false) {
  const overlay = document.getElementById("signupConsentOverlay");
  if (!overlay) {
    resolveSignupConsent(accepted);
    return;
  }
  overlay.classList.add("hidden");
  overlay.classList.remove("flex");
  document.body.classList.remove("overflow-hidden");
  resolveSignupConsent(accepted);
}

function ensureSignupConsentModal() {
  let overlay = document.getElementById("signupConsentOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "signupConsentOverlay";
    overlay.className = "fixed inset-0 z-[5300] hidden items-center justify-center bg-black/65 p-4 backdrop-blur-md";
    overlay.innerHTML = `
      <div class="w-[min(94vw,34rem)] rounded-3xl border border-white/20 bg-[#3F4766]/88 p-5 text-white shadow-[14px_14px_34px_rgba(16,23,40,0.5),-10px_-10px_24px_rgba(112,126,165,0.2)] backdrop-blur-xl sm:p-6">
        <h2 class="text-xl font-bold tracking-wide sm:text-2xl">Avant de continuer</h2>
        <p class="mt-2 text-sm text-white/80">
          Pour créer un compte, tu dois confirmer ton âge et accepter les règles d'utilisation de Dominoes Lakay.
        </p>

        <div class="mt-5 space-y-3">
          <label class="flex items-start gap-3 rounded-2xl border border-white/15 bg-white/8 px-4 py-3">
            <input id="signupConsentAge" type="checkbox" class="mt-1 h-4 w-4 rounded border-white/30 bg-white/10 text-[#f48f45]" />
            <span class="text-sm text-white/90">J'ai 18 ans ou plus.</span>
          </label>

          <label class="flex items-start gap-3 rounded-2xl border border-white/15 bg-white/8 px-4 py-3">
            <input id="signupConsentTerms" type="checkbox" class="mt-1 h-4 w-4 rounded border-white/30 bg-white/10 text-[#f48f45]" />
            <span class="text-sm text-white/90">
              J'accepte les <a href="${TERMS_ROUTE}" target="_blank" rel="noopener noreferrer" class="font-semibold text-[#ffd8b5] underline underline-offset-2">conditions d'utilisation</a>.
            </span>
          </label>
        </div>

        <div class="mt-4 rounded-2xl border border-amber-300/35 bg-amber-500/12 px-4 py-3 text-xs text-amber-100 sm:text-sm">
          Important: en créant un compte, tu confirmes utiliser des informations exactes, respecter les règles du jeu et accepter les politiques du service.
        </div>

        <div id="signupConsentError" class="mt-3 min-h-5 text-sm text-[#ffb0b0]"></div>

        <div class="mt-4 flex flex-col gap-3 sm:flex-row">
          <button id="signupConsentCancelBtn" type="button" class="h-11 flex-1 rounded-2xl border border-white/15 bg-white/8 text-sm font-semibold text-white/85 transition hover:bg-white/12">
            Annuler
          </button>
          <button id="signupConsentConfirmBtn" type="button" class="h-11 flex-1 rounded-2xl border border-[#ffb26e] bg-[#F57C00] text-sm font-semibold text-white shadow-[8px_8px_18px_rgba(163,82,27,0.45),-6px_-6px_14px_rgba(255,175,102,0.22)] transition hover:-translate-y-0.5">
            Continuer
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  const cancelBtn = document.getElementById("signupConsentCancelBtn");
  const confirmBtn = document.getElementById("signupConsentConfirmBtn");

  if (cancelBtn && !cancelBtn.dataset.bound) {
    cancelBtn.dataset.bound = "1";
    cancelBtn.addEventListener("click", () => {
      closeSignupConsentModal(false);
    });
  }

  if (confirmBtn && !confirmBtn.dataset.bound) {
    confirmBtn.dataset.bound = "1";
    confirmBtn.addEventListener("click", () => {
      const ageCheckbox = document.getElementById("signupConsentAge");
      const termsCheckbox = document.getElementById("signupConsentTerms");
      const errorEl = document.getElementById("signupConsentError");
      const hasAgeConsent = ageCheckbox?.checked === true;
      const hasTermsConsent = termsCheckbox?.checked === true;

      if (!hasAgeConsent || !hasTermsConsent) {
        if (errorEl) errorEl.textContent = "Tu dois cocher les deux cases pour créer un compte.";
        return;
      }

      if (errorEl) errorEl.textContent = "";
      closeSignupConsentModal(true);
    });
  }

  return overlay;
}

function requestSignupConsentForGoogle() {
  if (signupConsentResolver) {
    resolveSignupConsent(false);
  }

  const overlay = ensureSignupConsentModal();
  const ageCheckbox = document.getElementById("signupConsentAge");
  const termsCheckbox = document.getElementById("signupConsentTerms");
  const errorEl = document.getElementById("signupConsentError");

  if (ageCheckbox) ageCheckbox.checked = false;
  if (termsCheckbox) termsCheckbox.checked = false;
  if (errorEl) errorEl.textContent = "";

  overlay.classList.remove("hidden");
  overlay.classList.add("flex");
  document.body.classList.add("overflow-hidden");

  return new Promise((resolve) => {
    signupConsentResolver = resolve;
  });
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
  const overlay = ensureEmailVerificationModal();
  const emailTarget = document.getElementById("emailVerifyTarget");
  if (emailTarget) emailTarget.textContent = user?.email || "ton adresse email";
  overlay.classList.remove("hidden");
  overlay.classList.add("flex");

  setVerificationStatus("Confirme ton email puis reviens ici et clique sur le bouton ci-dessous.", "info");
  await sendVerificationEmailIfNeeded(user);
}

async function checkEmailVerificationAndContinue(explicitPromoCode = "", options = {}) {
  const refreshedUser = await refreshCurrentUser(auth.currentUser);
  if (!refreshedUser) {
    closeEmailVerificationModal();
    return false;
  }
  if (userRequiresEmailVerification(refreshedUser)) {
    if (options.showWaitingMessage) {
      setVerificationStatus("Toujours en attente de vérification. Ouvre le mail reçu et clique le lien de confirmation.", "warning");
    }
    return false;
  }
  closeEmailVerificationModal();
  await bootstrapReferralBeforeRedirect(refreshedUser, explicitPromoCode);
  redirectToHomeApp(refreshedUser);
  return true;
}

function redirectToHomeApp(user) {
  if (redirectingToApp) return;
  redirectingToApp = true;
  const currentPath = String(window.location.pathname || "");
  const onHomePage =
    currentPath.endsWith("/inedex.html") ||
    currentPath.endsWith("inedex.html") ||
    currentPath.endsWith("/index.html") ||
    currentPath.endsWith("index.html") ||
    currentPath === "/" ||
    currentPath === "";
  if (onHomePage) {
    renderPage2(user || auth.currentUser);
    return;
  }
  window.location.replace(APP_HOME_ROUTE);
}

async function bootstrapReferralBeforeRedirect(user, explicitPromoCode = "") {
  if (!user) return;
  const urlCtx = getReferralContextFromUrl(window.location.search);
  const typedPromoCode = normalizeCode(explicitPromoCode || "");
  const pendingPromoCode = consumePendingPromoCode();
  const queryPromoCode = normalizeCode(urlCtx.promoCodeFromQuery || "");
  const linkReferralCode = normalizeCode(urlCtx.userCodeFromLink || urlCtx.ambassadorCodeFromLink || "");

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
    referralBootstrapPromise = updateClientProfileSecure({
      ...collectAnalyticsContext(),
      ...referralPayload,
    })
      .catch((err) => {
        console.error("Secure profile bootstrap error:", err);
      })
      .finally(() => {
        referralBootstrapPromise = null;
      });
  }

  await referralBootstrapPromise;
}

async function handleAuthenticatedUser(user, explicitPromoCode = "") {
  if (!user) return;
  clearAuthFallbackRenderTimer();
  if (userRequiresEmailVerification(user)) {
    await showEmailVerificationModal(user);
    return;
  }
  closeEmailVerificationModal();
  await bootstrapReferralBeforeRedirect(user, explicitPromoCode);
  redirectToHomeApp(user);
}

function renderAuthLoading() {
  document.body.innerHTML = `
    <div class="min-h-screen grid place-items-center bg-[#3f4766] text-white font-['Poppins']">
      <div class="rounded-3xl border border-white/15 bg-white/10 px-6 py-5 text-center shadow-[12px_12px_28px_rgba(25,30,44,0.42),-10px_-10px_24px_rgba(97,110,150,0.16)] backdrop-blur-md">
        <div class="text-base font-semibold tracking-wide">Connexion en cours...</div>
      </div>
    </div>
  `;
}

function renderPage1() {
  const modeTitle = authMode === "signin" ? "SE CONNECTER" : "S'INSCRIRE";
  const helperPrefix = authMode === "signin" ? "Pas encore de compte ?" : "Déjà un compte ?";
  const helperAction = authMode === "signin" ? "S'inscrire" : "Se connecter";
  const referralCtx = getReferralContextFromUrl(window.location.search);
  const hintCode = referralCtx.ambassadorCodeFromLink || referralCtx.userCodeFromLink;
  const promoPrefill = normalizeCode(
    referralCtx.promoCodeFromQuery ||
    referralCtx.userCodeFromLink ||
    referralCtx.ambassadorCodeFromLink ||
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
    ? `<div id="authInfo" class="mt-2 min-h-5 text-xs text-amber-200">${escapeAttr(authBootstrapMessage)}</div>`
    : `<div id="authInfo" class="mt-2 min-h-5 text-xs text-amber-200"></div>`;

  document.body.innerHTML = `
    <div id="appRoot" class="min-h-screen bg-[#3f4766] text-white font-['Poppins']">
      <div class="min-h-screen lg:grid lg:grid-cols-[1.05fr_0.95fr]">
        <section class="flex min-h-screen flex-col px-6 pb-6 pt-8 sm:px-10 lg:px-0 lg:pl-24 lg:pr-16 lg:pt-10">
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

            <form id="authForm" class="mt-7 space-y-4 sm:space-y-5">
              <input
                id="emailInput"
                type="email"
                placeholder="Email"
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
                    Utilisé lors de la création du compte, y compris avec Google.
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

            <div class="mt-7 flex items-center gap-4 text-white/65">
              <div class="h-px flex-1 bg-white/20"></div>
              <span class="text-sm">ou</span>
              <div class="h-px flex-1 bg-white/20"></div>
            </div>

            <button
              id="googleContinueBtn"
              type="button"
              class="mt-5 flex w-full items-center justify-center gap-3 rounded-full border border-white/35 bg-white/80 px-6 py-3.5 text-sm font-semibold text-[#1f2937] shadow-[8px_8px_18px_rgba(22,28,44,0.3),-6px_-6px_14px_rgba(255,255,255,0.28)] backdrop-blur-sm transition hover:-translate-y-0.5 sm:text-base"
            >
              <i class="fa-brands fa-google text-[#4285F4]"></i>
              Continuer avec Google
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

        <aside class="relative hidden min-h-screen items-center justify-center border-l border-white/10 bg-white/5 backdrop-blur-md lg:flex">
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
}

function bindPage1Events() {
  const switchBtn = document.getElementById("switchAuthMode");
  const submitBtn = document.getElementById("authSubmitBtn");
  const form = document.getElementById("authForm");
  const emailInput = document.getElementById("emailInput");
  const passwordInput = document.getElementById("passwordInput");
  const passwordConfirmInput = document.getElementById("passwordConfirmInput");
  const togglePasswordBtn = document.getElementById("togglePasswordBtn");
  const togglePasswordConfirmBtn = document.getElementById("togglePasswordConfirmBtn");
  const promoCodeInput = document.getElementById("promoCodeInput");
  const signupAgeCheckbox = document.getElementById("signupAgeCheckbox");
  const signupTermsCheckbox = document.getElementById("signupTermsCheckbox");
  const googleBtn = document.getElementById("googleContinueBtn");
  const forgotPasswordBtn = document.getElementById("forgotPasswordBtn");
  const forgotPasswordStatus = document.getElementById("forgotPasswordStatus");
  const discussionFabBtn = document.getElementById("loginDiscussionFabBtn");

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
    const email = (emailInput?.value || "").trim();
    const password = passwordInput?.value || "";
    const confirmPassword = passwordConfirmInput?.value || "";
    const promoCode = authMode === "signup" ? normalizeCode(promoCodeInput?.value || "") : "";
    const errorEl = document.getElementById("authError");

    if (!isValidEmail(email)) {
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
    if (authMode === "signup" && signupAgeCheckbox?.checked !== true) {
      if (errorEl) errorEl.textContent = "Tu dois confirmer que tu as 18 ans ou plus.";
      return;
    }
    if (authMode === "signup" && signupTermsCheckbox?.checked !== true) {
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
          await loginWithEmail(email, password);
          await handleAuthenticatedUser(auth.currentUser);
        } else {
          savePendingPromoCode(promoCode);
          await signupWithEmail(email, password);
          await handleAuthenticatedUser(auth.currentUser, promoCode);
        }
      }, { loadingLabel: authMode === "signin" ? "Connexion..." : "Création..." });
    } catch (err) {
      console.error("Auth error:", err);
      if (errorEl) errorEl.textContent = formatAuthError(err, "Erreur d'authentification");
    } finally {
      authFlowBusy = false;
    }
  };

  if (submitBtn) submitBtn.addEventListener("click", submitAuth);
  if (form) {
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      submitAuth();
    });
  }

  if (googleBtn) {
    googleBtn.addEventListener("click", async () => {
      const errorEl = document.getElementById("authError");
      const infoEl = document.getElementById("authInfo");
      if (errorEl) errorEl.textContent = "";
      authBootstrapMessage = "";
      if (infoEl) infoEl.textContent = "";
      setForgotPasswordStatus("", "neutral");
      try {
        await withButtonLoading(googleBtn, async () => {
          const promoCode = authMode === "signup" ? normalizeCode(promoCodeInput?.value || "") : "";
          if (authMode === "signup") {
            const consentOk = await requestSignupConsentForGoogle();
            if (!consentOk) return;
          }
          savePendingPromoCode(promoCode);
          authFlowBusy = true;
          const res = await loginWithGoogle();
          if (res?.mode === "redirect" && errorEl) {
            errorEl.textContent = "Redirection Google en cours...";
          }
          if (res?.mode === "popup") {
            await handleAuthenticatedUser(auth.currentUser, promoCode);
          }
        }, { loadingLabel: "Connexion Google..." });
      } catch (err) {
        console.error("Google auth error:", err);
        if (errorEl) errorEl.textContent = formatAuthError(err, "Erreur de connexion Google");
      } finally {
        authFlowBusy = false;
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
        setForgotPasswordStatus("Saisis ton email valide avant de demander la réinitialisation.", "error");
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

completeGoogleRedirectIfAny()
  .then((result) => {
    if (result?.user) {
      authBootstrapMessage = "";
      clearPendingGoogleRedirect();
      return handleAuthenticatedUser(result.user, consumePendingPromoCode());
    }
    if (hasPendingGoogleRedirect()) {
      clearPendingGoogleRedirect();
      authBootstrapMessage = "Connexion Google interrompue. Réessaie le bouton Google.";
    }
    return null;
  })
  .catch((err) => {
    console.error("Google redirect auth error:", err);
  })
  .finally(() => {
    authBootstrapReady = true;
    if (latestObservedUser === null && authStateResolved === true && redirectingToApp === false) {
      scheduleAuthFallbackRender();
    }
  });

function animatePage1() {
  if (!window.anime) return;

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
  authStateResolved = true;
  latestObservedUser = user || null;
  if (user) {
    authBootstrapMessage = "";
    clearPendingGoogleRedirect();
    clearAuthFallbackRenderTimer();
    handleAuthenticatedUser(user).catch((err) => {
      console.error("Auth state redirect error:", err);
      if (userRequiresEmailVerification(user)) {
        showEmailVerificationModal(user).catch((modalErr) => {
          console.error("Email verification modal error:", modalErr);
        });
        return;
      }
      redirectToHomeApp(user);
    });
    return;
  }
  redirectingToApp = false;
  if (authBootstrapReady !== true) return;
  scheduleAuthFallbackRender();
});
