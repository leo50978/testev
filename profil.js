import { auth, logoutCurrentUser, watchAuthState } from "./auth.js";
import { mountXchangeModal, getXchangeState } from "./xchange.js";
import { mountRetraitModal } from "./retrait.js";
import { db, doc, onSnapshot } from "./firebase-init.js";
const BALANCE_DEBUG = true;
let referralLoadToken = 0;
let referralHintFreezeUntil = 0;
let referralHintRestoreTimer = null;
let profileClientUnsub = null;
let profileRealtimeUid = "";
let profileRealtimeRefreshTimer = null;
let latestProfileClientData = null;

function safeCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function normalizeReferralCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
}

function buildProfileReferralLink(code) {
  const normalized = normalizeReferralCode(code);
  if (!normalized) return "";
  const url = new URL("./inedex.html", window.location.href);
  url.hash = "";
  url.searchParams.set("ref", normalized);
  return url.toString();
}

function getBalanceBaseForUi() {
  const base = window.__userBaseBalance;
  const fallback = window.__userBalance;
  if (base === null || typeof(base) === "undefined" || Number.isNaN(Number(base))) {
    return Number(fallback || 0);
  }
  return Number(base);
}

function getDisplayName(user) {
  if (!user) return "Guest";
  if (user.displayName) return user.displayName;
  if (user.email) return user.email.split("@")[0];
  return "Player";
}

function formatAmount(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat("fr-HT", {
    style: "currency",
    currency: "HTG",
    maximumFractionDigits: 0,
  }).format(amount);
}

function bindHideOnErrorImages(root) {
  if (!root) return;
  root.querySelectorAll('img[data-hide-on-error="1"]').forEach((img) => {
    if (img.dataset.errorBound === "1") return;
    img.dataset.errorBound = "1";
    img.addEventListener("error", () => {
      img.style.display = "none";
    });
  });
}

function clearProfileRealtimeWatchers() {
  if (profileClientUnsub) {
    profileClientUnsub();
    profileClientUnsub = null;
  }
  profileRealtimeUid = "";
  latestProfileClientData = null;
}

function scheduleProfileRealtimeRefresh(user) {
  if (profileRealtimeRefreshTimer) {
    clearTimeout(profileRealtimeRefreshTimer);
    profileRealtimeRefreshTimer = null;
  }
  profileRealtimeRefreshTimer = setTimeout(() => {
    profileRealtimeRefreshTimer = null;
    updateProfileData(user || auth.currentUser || null);
  }, 120);
}

function ensureProfileRealtimeWatchers(user) {
  const uid = String(user?.uid || "");
  if (!uid) {
    clearProfileRealtimeWatchers();
    return;
  }
  if (profileRealtimeUid === uid && profileClientUnsub) {
    return;
  }

  clearProfileRealtimeWatchers();
  profileRealtimeUid = uid;

  profileClientUnsub = onSnapshot(
    doc(db, "clients", uid),
    (snap) => {
      latestProfileClientData = snap.exists() ? (snap.data() || {}) : null;
      scheduleProfileRealtimeRefresh(user || auth.currentUser || null);
    },
    (err) => {
      console.error("Erreur listener profil client:", err);
    }
  );
}

function ensureProfileModal() {
  const existing = document.getElementById("profileModalOverlay");
  if (existing) return existing;

  const overlay = document.createElement("div");
  overlay.id = "profileModalOverlay";
  overlay.className = "fixed inset-0 z-[3000] hidden items-center justify-center bg-black/45 p-3 backdrop-blur-sm lg:items-stretch lg:justify-end lg:p-0";

  overlay.innerHTML = `
    <aside id="profileModalPanel" class="relative h-[88vh] w-[92vw] overflow-y-auto overscroll-contain rounded-3xl border border-white/20 bg-[#3F4766]/45 shadow-[14px_14px_34px_rgba(12,16,28,0.45),-10px_-10px_24px_rgba(98,113,151,0.18)] backdrop-blur-xl lg:h-screen lg:w-[50vw] lg:rounded-none lg:rounded-l-3xl" style="-webkit-overflow-scrolling: touch;">
      <div class="absolute inset-0 bg-gradient-to-b from-white/10 to-transparent"></div>
      <div class="relative flex h-full flex-col p-4 sm:p-6 lg:p-8">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-xs uppercase tracking-[0.16em] text-white/70">Profile</p>
            <h2 class="mt-1 text-2xl font-bold text-white sm:text-3xl">Mon compte</h2>
          </div>
          <button id="profileModalClose" type="button" class="grid h-11 w-11 place-items-center rounded-full border border-white/20 bg-white/10 text-white shadow-[7px_7px_16px_rgba(18,24,39,0.35),-5px_-5px_12px_rgba(124,138,176,0.2)] transition hover:bg-white/15" aria-label="Close profile">
            <i class="fa-solid fa-xmark text-lg"></i>
          </button>
        </div>

        <div class="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="rounded-2xl border border-white/20 bg-white/10 p-4 shadow-[8px_8px_18px_rgba(19,25,40,0.34),-6px_-6px_14px_rgba(111,126,164,0.2)]">
            <p class="text-[11px] uppercase tracking-[0.14em] text-white/65">Solde disponible</p>
            <p id="profileBalance" class="mt-2 text-sm text-white">-</p>
          </div>
          <div class="rounded-2xl border border-white/20 bg-white/10 p-4 shadow-[8px_8px_18px_rgba(19,25,40,0.34),-6px_-6px_14px_rgba(111,126,164,0.2)]">
            <button id="profileDepositBtn" type="button" class="inline-flex w-full items-center justify-between rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm font-semibold text-white shadow-[8px_8px_18px_rgba(19,25,40,0.34),-6px_-6px_14px_rgba(111,126,164,0.2)]">
              <span class="inline-flex items-center gap-2">
                <i class="fa-solid fa-plus text-[11px]"></i>
                Faire un dépôt
              </span>
              <i class="fa-solid fa-wallet text-xs text-white/80"></i>
            </button>
            <button id="profileXchangeBtn" type="button" class="mt-2 inline-flex w-full items-center justify-between rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm font-semibold text-white shadow-[8px_8px_18px_rgba(19,25,40,0.34),-6px_-6px_14px_rgba(111,126,164,0.2)]">
              <span class="inline-flex items-center gap-2">
                <img src="./does.png" alt="Does" class="h-4 w-4 rounded-full object-cover" data-hide-on-error="1" />
                Xchange en crypto
              </span>
              <i class="fa-solid fa-coins text-xs text-white/80"></i>
            </button>
            <button id="profileWithdrawBtn" type="button" class="mt-2 inline-flex w-full items-center justify-between rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm font-semibold text-white shadow-[8px_8px_18px_rgba(19,25,40,0.34),-6px_-6px_14px_rgba(111,126,164,0.2)]">
              <span class="inline-flex items-center gap-2">
                <i class="fa-solid fa-arrow-up-right-from-square text-[11px]"></i>
                Faire un retrait
              </span>
              <i class="fa-solid fa-money-bill-transfer text-xs text-white/80"></i>
            </button>
          </div>
        </div>

        <div class="mt-4 rounded-2xl border border-white/20 bg-white/10 p-4 shadow-[inset_6px_6px_14px_rgba(18,24,38,0.34),inset_-6px_-6px_14px_rgba(110,124,163,0.18)] backdrop-blur-md sm:p-5">
          <div class="flex min-w-0 items-center gap-3 sm:gap-4">
            <div class="grid h-16 w-16 shrink-0 place-items-center rounded-2xl border border-white/20 bg-white/10 text-white shadow-[8px_8px_18px_rgba(20,27,44,0.38),-6px_-6px_14px_rgba(120,133,172,0.2)]">
              <i class="fa-regular fa-circle-user text-3xl"></i>
            </div>
            <div class="min-w-0 flex-1">
              <p id="profileName" class="truncate text-lg font-semibold text-white">Player</p>
              <p id="profileEmail" class="mt-0.5 truncate text-sm text-white/75">-</p>
            </div>
          </div>
        </div>

        <div class="mt-4 rounded-2xl border border-white/20 bg-white/10 p-4 shadow-[8px_8px_18px_rgba(19,25,40,0.34),-6px_-6px_14px_rgba(111,126,164,0.2)]">
          <div class="flex items-center justify-between gap-3">
            <p class="text-[11px] uppercase tracking-[0.14em] text-white/65">Parrainage</p>
            <button id="profileCopyReferralCode" type="button" class="rounded-xl border border-white/20 bg-white/10 px-3 py-1.5 text-[11px] font-semibold text-white/90">
              Copier code
            </button>
          </div>

          <div class="mt-2 flex items-center justify-between gap-2 rounded-xl border border-white/15 bg-white/10 px-3 py-2">
            <p class="text-sm text-white/85">Code: <span id="profileReferralCode" class="font-semibold text-white">-</span></p>
            <button id="profileCopyReferralLink" type="button" class="rounded-lg border border-white/20 bg-white/10 px-2.5 py-1.5 text-[11px] font-semibold text-white/90">
              Copier lien
            </button>
          </div>

          <p id="profileReferralHint" class="mt-2 text-xs text-white/70">Partage ton code ou ton lien pour parrainer.</p>

          <div class="mt-3 grid grid-cols-2 gap-2">
            <div class="rounded-xl border border-white/15 bg-white/10 p-3">
              <p class="text-[11px] uppercase tracking-[0.12em] text-white/60">Inscriptions</p>
              <p id="profileReferralSignups" class="mt-1 text-lg font-semibold text-white">0</p>
            </div>
            <div class="rounded-xl border border-white/15 bg-white/10 p-3">
              <p class="text-[11px] uppercase tracking-[0.12em] text-white/60">Dépôts</p>
              <p id="profileReferralDeposits" class="mt-1 text-lg font-semibold text-white">0</p>
            </div>
          </div>
          <button id="profileReferralRulesBtn" type="button" class="mt-3 w-full rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-xs font-semibold tracking-wide text-white/90 transition hover:bg-white/15">
            Règles parrainage
          </button>
        </div>

        <div class="mt-4 rounded-2xl border border-white/20 bg-white/10 p-4 shadow-[8px_8px_18px_rgba(19,25,40,0.34),-6px_-6px_14px_rgba(111,126,164,0.2)]">
          <p class="text-[11px] uppercase tracking-[0.14em] text-white/65">Xchange prioritaire</p>
          <div class="mt-2 flex items-center gap-2">
            <img src="./does.png" alt="Does" class="h-6 w-6 rounded-full object-cover" data-hide-on-error="1" />
            <p class="text-sm font-semibold text-white"><span id="profileDoesTotal">0</span> Does</p>
          </div>
          <p id="profileExchanged" class="mt-1 text-xs text-white/70">Échangé: 0 HTG</p>
        </div>

        <div class="mt-auto pt-6">
          <button id="profileLogoutBtn" type="button" class="h-12 w-full rounded-2xl border border-[#ffb26e] bg-[#F57C00] text-sm font-semibold tracking-wide text-white shadow-[8px_8px_18px_rgba(163,82,27,0.45),-6px_-6px_14px_rgba(255,175,102,0.22)] transition hover:-translate-y-0.5">
            Déconnexion
          </button>
        </div>
      </div>
    </aside>

    <div id="profileReferralRulesOverlay" class="fixed inset-0 z-[3050] hidden items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
      <div id="profileReferralRulesPanel" class="w-full max-w-lg rounded-3xl border border-white/20 bg-[#3F4766]/80 p-5 text-white shadow-[14px_14px_34px_rgba(16,23,40,0.5),-10px_-10px_24px_rgba(112,126,165,0.2)] backdrop-blur-xl sm:p-6">
        <div class="flex items-center justify-between">
          <h3 class="text-lg font-bold">Règles parrainage</h3>
          <button id="profileReferralRulesClose" type="button" class="grid h-9 w-9 place-items-center rounded-full border border-white/20 bg-white/10 text-white">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="mt-4 space-y-2 text-sm text-white/90">
          <p>1. Partage ton lien ou ton code promo avec tes amis.</p>
          <p>2. Ton ami crée son compte avec ton lien ou ton code.</p>
          <p>3. Tu reçois un bonus uniquement sur son premier dépôt approuvé.</p>
          <p>4. Bonus: <span class="font-semibold text-white">4 Does par 1 HTG déposé</span>.</p>
          <p>Exemples: 25 HTG = 100 Does, 50 HTG = 200 Does, 100 HTG = 400 Does.</p>
          <p>Le bonus n'est versé qu'une seule fois par filleul (premier dépôt seulement).</p>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  bindHideOnErrorImages(overlay);

  const closeBtn = overlay.querySelector("#profileModalClose");
  const panel = overlay.querySelector("#profileModalPanel");
  const logoutBtn = overlay.querySelector("#profileLogoutBtn");
  const rulesBtn = overlay.querySelector("#profileReferralRulesBtn");
  const rulesOverlay = overlay.querySelector("#profileReferralRulesOverlay");
  const rulesPanel = overlay.querySelector("#profileReferralRulesPanel");
  const rulesClose = overlay.querySelector("#profileReferralRulesClose");

  const closeRulesModal = () => {
    if (!rulesOverlay) return;
    rulesOverlay.classList.add("hidden");
    rulesOverlay.classList.remove("flex");
  };

  const openRulesModal = () => {
    if (!rulesOverlay) return;
    rulesOverlay.classList.remove("hidden");
    rulesOverlay.classList.add("flex");
  };

  const closeModal = () => {
    closeRulesModal();
    overlay.classList.add("hidden");
    overlay.classList.remove("flex");
  };

  const openModal = () => {
    overlay.classList.remove("hidden");
    overlay.classList.add("flex");
    if (panel) panel.scrollTop = 0;
  };

  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) closeModal();
  });

  if (panel) {
    panel.addEventListener("click", (ev) => ev.stopPropagation());
  }

  if (rulesPanel) {
    rulesPanel.addEventListener("click", (ev) => ev.stopPropagation());
  }

  if (rulesOverlay) {
    rulesOverlay.addEventListener("click", (ev) => {
      if (ev.target === rulesOverlay) closeRulesModal();
    });
  }

  if (rulesClose) {
    rulesClose.addEventListener("click", closeRulesModal);
  }

  if (rulesBtn && rulesBtn.dataset.bound !== "1") {
    rulesBtn.dataset.bound = "1";
    rulesBtn.addEventListener("click", openRulesModal);
  }

  if (closeBtn) closeBtn.addEventListener("click", closeModal);

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await logoutCurrentUser();
        closeModal();
      } catch (err) {
        console.error("Logout error:", err);
      }
    });
  }

  const copyReferralCodeBtn = overlay.querySelector("#profileCopyReferralCode");
  const copyReferralLinkBtn = overlay.querySelector("#profileCopyReferralLink");

  const copyToClipboard = async (text) => {
    const value = String(text || "").trim();
    if (!value || value === "-") return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
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
      return true;
    } catch (_) {
      return false;
    }
  };

  if (copyReferralCodeBtn && copyReferralCodeBtn.dataset.bound !== "1") {
    copyReferralCodeBtn.dataset.bound = "1";
    copyReferralCodeBtn.addEventListener("click", async () => {
      const code = document.getElementById("profileReferralCode")?.textContent || "";
      const ok = await copyToClipboard(code);
      showReferralCopyFeedback(ok ? "Code copié avec succès." : "Impossible de copier le code.", ok);
    });
  }

  if (copyReferralLinkBtn && copyReferralLinkBtn.dataset.bound !== "1") {
    copyReferralLinkBtn.dataset.bound = "1";
    copyReferralLinkBtn.addEventListener("click", async () => {
      const link = copyReferralLinkBtn.getAttribute("data-link") || "";
      const ok = await copyToClipboard(link);
      showReferralCopyFeedback(ok ? "Lien copié avec succès." : "Impossible de copier le lien.", ok);
    });
  }

  overlay.__openModal = openModal;
  overlay.__closeModal = closeModal;

  return overlay;
}

function showReferralCopyFeedback(message, success = true) {
  const hintEl = document.getElementById("profileReferralHint");
  if (!hintEl) return;

  referralHintFreezeUntil = Date.now() + 1800;
  hintEl.textContent = String(message || "");
  hintEl.style.color = success ? "#86efac" : "#fecaca";

  if (referralHintRestoreTimer) {
    clearTimeout(referralHintRestoreTimer);
    referralHintRestoreTimer = null;
  }

  referralHintRestoreTimer = setTimeout(() => {
    referralHintRestoreTimer = null;
    if (Date.now() < referralHintFreezeUntil) return;
    hintEl.style.color = "";
    updateReferralData(auth.currentUser);
  }, 1900);
}

function updateProfileData(user) {
  const nameEl = document.getElementById("profileName");
  const emailEl = document.getElementById("profileEmail");
  const balanceEl = document.getElementById("profileBalance");
  const doesEl = document.getElementById("profileDoesTotal");
  const exchangedEl = document.getElementById("profileExchanged");
  const baseForUi = getBalanceBaseForUi();
  const xState = getXchangeState(baseForUi, user?.uid || auth.currentUser?.uid);

  if (BALANCE_DEBUG) {
    console.log("[BALANCE_DEBUG][PROFILE] updateProfileData", {
      uid: user?.uid || auth.currentUser?.uid || null,
      baseForUi,
      __userBaseBalance: window.__userBaseBalance,
      __userBalance: window.__userBalance,
      availableFromXchange: xState.availableGourdes,
      exchanged: xState.exchangedGourdes,
      does: xState.does,
    });
  }

  if (nameEl) {
    const displayName = getDisplayName(user);
    nameEl.textContent = displayName;
    nameEl.title = displayName || "";
  }
  if (emailEl) {
    const email = user?.email || "-";
    emailEl.textContent = email;
    emailEl.title = email;
  }
  if (balanceEl) balanceEl.textContent = formatAmount(xState.availableGourdes);
  if (doesEl) doesEl.textContent = String(xState.does || 0);
  if (exchangedEl) exchangedEl.textContent = `Échangé: ${xState.exchangedGourdes} HTG`;
  updateReferralData(user);
}

function updateReferralData(user) {
  const codeEl = document.getElementById("profileReferralCode");
  const signupsEl = document.getElementById("profileReferralSignups");
  const depositsEl = document.getElementById("profileReferralDeposits");
  const hintEl = document.getElementById("profileReferralHint");
  const copyLinkBtn = document.getElementById("profileCopyReferralLink");

  const token = ++referralLoadToken;
  const hintLocked = Date.now() < referralHintFreezeUntil;

  if (!user?.uid) {
    if (codeEl) codeEl.textContent = "-";
    if (signupsEl) signupsEl.textContent = "0";
    if (depositsEl) depositsEl.textContent = "0";
    if (hintEl && !hintLocked) {
      hintEl.textContent = "Parrainage désactivé sur les pages publiques.";
      hintEl.style.color = "";
    }
    if (copyLinkBtn) copyLinkBtn.setAttribute("data-link", "");
    return;
  }

  if (token !== referralLoadToken) return;
  const clientData = latestProfileClientData || {};
  const referralCode = normalizeReferralCode(clientData.referralCode || "");
  const referralLink = referralCode ? buildProfileReferralLink(referralCode) : "";
  const signupsTotal = safeCount(clientData.referralSignupsTotal);
  const depositsTotal = safeCount(clientData.referralDepositsTotal);

  if (codeEl) codeEl.textContent = referralCode || "Génération...";
  if (signupsEl) signupsEl.textContent = String(signupsTotal);
  if (depositsEl) depositsEl.textContent = String(depositsTotal);
  if (copyLinkBtn) copyLinkBtn.setAttribute("data-link", referralLink);

  if (hintEl) {
    if (hintLocked) return;
    hintEl.style.color = "";
    hintEl.textContent = referralCode
      ? "Ton code et ton lien de parrainage sont prêts."
      : "Génération du code de parrainage...";
  }
}

export function mountProfileModal(options = {}) {
  const { triggerSelector = "#p2Profile" } = options;
  const overlay = ensureProfileModal();
  const openModal = overlay.__openModal;
  const closeModal = overlay.__closeModal;

  const trigger = document.querySelector(triggerSelector);
  if (trigger && openModal) {
    trigger.addEventListener("click", () => {
      updateProfileData(auth.currentUser);
      openModal();

      const depositBtn = document.getElementById("profileDepositBtn");
      const withdrawBtn = document.getElementById("profileWithdrawBtn");
      if (depositBtn && !depositBtn.dataset.bound) {
        depositBtn.dataset.bound = "1";
        depositBtn.addEventListener("click", () => {
          closeModal();
          const soldBadge = document.getElementById("soldBadge");
          if (soldBadge) {
            soldBadge.click();
          }
        });
      }
      if (withdrawBtn && !withdrawBtn.dataset.bound) {
        withdrawBtn.dataset.bound = "1";
        withdrawBtn.addEventListener("click", () => {
          closeModal();
          if (typeof window.openRetraitDirectly === "function") {
            window.openRetraitDirectly();
          }
        });
      }
    });
  }

  watchAuthState((user) => {
    const activeUser = user || auth.currentUser || null;
    ensureProfileRealtimeWatchers(activeUser);
    updateProfileData(activeUser);
  });

  window.addEventListener("userBalanceUpdated", () => {
    updateProfileData(auth.currentUser);
  });
  window.addEventListener("xchangeUpdated", () => {
    updateProfileData(auth.currentUser);
  });

  mountXchangeModal({ triggerSelector: "#profileXchangeBtn" });
  mountRetraitModal({ triggerSelector: "#profileWithdrawBtn" });

  ensureProfileRealtimeWatchers(auth.currentUser);
  updateProfileData(auth.currentUser);
}
