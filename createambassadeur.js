import "./firebase-init.js";
import { auth, watchAuthState } from "./auth.js";
import { ensureFinanceDashboardSession } from "./dashboard-admin-auth.js";
import { withButtonLoading } from "./loading-ui.js";
import { createAmbassadorAccount, normalizeCode } from "./referral.js";

const OWNER_EMAIL_ALLOWLIST = ["leovitch2004@gmail.com"];
const DISABLE_DASHBOARD_OWNER_GUARD = false;
const AMBASSADOR_UI_ENABLED = false;

const elements = {
  ownerAuthStatus: document.getElementById("ownerAuthStatus"),
  form: document.getElementById("createAmbassadorForm"),
  nameInput: document.getElementById("ambNameInput"),
  authCodeInput: document.getElementById("ambAuthCodeCreateInput"),
  promoInput: document.getElementById("ambPromoCodeCreateInput"),
  linkInput: document.getElementById("ambLinkCodeCreateInput"),
  submitBtn: document.getElementById("createAmbassadorBtn"),
  error: document.getElementById("createAmbassadorError"),

  resultPanel: document.getElementById("createAmbassadorResult"),
  resultName: document.getElementById("resultAmbName"),
  resultPromo: document.getElementById("resultAmbPromo"),
  resultLinkCode: document.getElementById("resultAmbLinkCode"),
  resultLinkInput: document.getElementById("resultAmbLink"),
  copyResultLinkBtn: document.getElementById("copyResultLinkBtn"),
};

let currentUser = null;

function setError(message) {
  if (elements.error) {
    elements.error.textContent = message || "";
  }
}

function renderOwnerStatus(user) {
  if (!elements.ownerAuthStatus) return;

  if (!user) {
    elements.ownerAuthStatus.textContent = "Non connecté";
    elements.ownerAuthStatus.className = "rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700";
    return;
  }

  if (!DISABLE_DASHBOARD_OWNER_GUARD && !canUseOwnerEmail(user)) {
    elements.ownerAuthStatus.textContent = `Connecté (non autorisé): ${user.email || user.uid}`;
    elements.ownerAuthStatus.className = "rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700";
    return;
  }

  elements.ownerAuthStatus.textContent = DISABLE_DASHBOARD_OWNER_GUARD
    ? `Connecté: ${user.email || user.uid} (garde owner désactivée)`
    : `Connecté: ${user.email || user.uid} (validation admin serveur requise)`;
  elements.ownerAuthStatus.className = "rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700";
}

function canUseOwnerEmail(user) {
  if (!user?.email) return OWNER_EMAIL_ALLOWLIST.length === 0;
  if (OWNER_EMAIL_ALLOWLIST.length === 0) return true;
  const email = String(user.email || "").trim().toLowerCase();
  return OWNER_EMAIL_ALLOWLIST.map((v) => String(v || "").trim().toLowerCase()).includes(email);
}

async function copyToClipboard(text) {
  const value = String(text || "").trim();
  if (!value) return;

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch (_) {}

  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    document.body.removeChild(area);
  } catch (_) {}
}

function showResult(account) {
  if (!elements.resultPanel || !account) return;
  elements.resultPanel.classList.remove("hidden");
  if (elements.resultName) elements.resultName.textContent = account.name || "-";
  if (elements.resultPromo) elements.resultPromo.textContent = account.promoCode || "-";
  if (elements.resultLinkCode) elements.resultLinkCode.textContent = account.linkCode || "-";
  if (elements.resultLinkInput) elements.resultLinkInput.value = account.referralLink || "";
}

async function submitCreateAmbassador(event) {
  event.preventDefault();
  setError("");

  const name = String(elements.nameInput?.value || "").trim();
  const authCode = String(elements.authCodeInput?.value || "").trim();
  const promoCode = normalizeCode(elements.promoInput?.value || "");
  const linkCode = normalizeCode(elements.linkInput?.value || "");

  if (!currentUser) {
    setError("Connecte-toi d'abord avec ton compte owner.");
    return;
  }
  if (!DISABLE_DASHBOARD_OWNER_GUARD && !canUseOwnerEmail(currentUser)) {
    setError("Email non autorisé pour cette page owner.");
    return;
  }
  if (!name) {
    setError("Nom ambassadeur requis.");
    return;
  }
  if (authCode.length < 4) {
    setError("Code d'auth ambassadeur: minimum 4 caractères.");
    return;
  }

  try {
    await withButtonLoading(
      elements.submitBtn,
      async () => {
        const account = await createAmbassadorAccount({
          name,
          authCode,
          promoCode,
          linkCode,
          createdByUid: currentUser.uid,
          createdByEmail: currentUser.email || "",
        });
        showResult(account);
      },
      { loadingLabel: "Création..." }
    );
  } catch (err) {
    const code = String(err?.code || "");
    if (code === "permission-denied") {
      setError("Accès refusé: connecte-toi avec l'email admin autorisé.");
      return;
    }
    setError(err?.message || "Erreur de création.");
  }
}

function forceUppercaseInput(input) {
  if (!input) return;
  input.addEventListener("input", () => {
    const next = String(input.value || "").toUpperCase();
    if (next !== input.value) {
      input.value = next;
    }
  });
}

function bindEvents() {
  elements.form?.addEventListener("submit", submitCreateAmbassador);
  elements.copyResultLinkBtn?.addEventListener("click", async () => {
    await copyToClipboard(elements.resultLinkInput?.value || "");
  });
  forceUppercaseInput(elements.promoInput);
  forceUppercaseInput(elements.linkInput);
}

function initAuthWatcher() {
  watchAuthState((user) => {
    currentUser = user || null;
    renderOwnerStatus(currentUser);
  });
}

async function init() {
  if (!AMBASSADOR_UI_ENABLED) {
    document.body.innerHTML = `
      <main style="min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#0f172a;font-family:Poppins,sans-serif;padding:24px;">
        <section style="width:min(92vw,640px);border:1px solid rgba(148,163,184,.5);border-radius:20px;background:#ffffff;padding:24px;box-shadow:0 20px 50px rgba(15,23,42,.12);">
          <h1 style="margin:0 0 10px;font-size:1.3rem;font-weight:800;">Création ambassadeur désactivée</h1>
          <p style="margin:0;color:#475569;line-height:1.5;">
            Cette page a été désactivée car le système ambassadeur n'est plus utilisé dans l'application.
          </p>
        </section>
      </main>
    `;
    return;
  }
  bindEvents();
  initAuthWatcher();
  renderOwnerStatus(auth.currentUser || null);
  try {
    await ensureFinanceDashboardSession({
      title: "Créer un ambassadeur",
      description: "Connecte-toi avec le compte admin pour créer un nouvel ambassadeur.",
    });
  } catch (error) {
    setError(error?.message || "Authentification administrateur requise.");
  }
}

init();
