const PWA_PROMPT_NEVER_KEY = "domino_pwa_prompt_never_v1";
const PWA_PROMPT_INSTALLED_KEY = "domino_pwa_prompt_installed_v1";
const PWA_PROMPT_NOT_NOW_SESSION_KEY = "domino_pwa_prompt_not_now_v1";
const PWA_SW_URL = "./sw.js";

let pwaSupportRegistered = false;
let deferredInstallPrompt = null;
let promptEnabledOnHome = false;
let modalNode = null;

function pwaDebug(event, data = {}) {
  try {
    console.log(`[PWA_DEBUG] ${event}`, {
      ts: new Date().toISOString(),
      href: String(window.location?.href || ""),
      ...data,
    });
  } catch (_) {}
}

function isStandaloneMode() {
  return (
    window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
    window.navigator?.standalone === true
  );
}

function isIosBrowser() {
  const ua = String(window.navigator?.userAgent || "");
  return /iPhone|iPad|iPod/i.test(ua);
}

function isIosManualInstallAvailable() {
  return isIosBrowser() && !isStandaloneMode();
}

function getPromptMode() {
  if (deferredInstallPrompt) return "native";
  if (isIosManualInstallAvailable()) return "ios-guide";
  return "hidden";
}

function shouldSuppressPrompt() {
  if (!promptEnabledOnHome) return true;
  if (isStandaloneMode()) return true;

  try {
    if (localStorage.getItem(PWA_PROMPT_NEVER_KEY) === "1") return true;
    if (localStorage.getItem(PWA_PROMPT_INSTALLED_KEY) === "1") return true;
  } catch (_) {}

  try {
    if (sessionStorage.getItem(PWA_PROMPT_NOT_NOW_SESSION_KEY) === "1") return true;
  } catch (_) {}

  return false;
}

function ensureModalNode() {
  if (modalNode && document.body.contains(modalNode)) return modalNode;

  const node = document.createElement("div");
  node.id = "pwaInstallPromptOverlay";
  node.className = "fixed inset-0 z-[4900] hidden items-end justify-center bg-[radial-gradient(circle_at_top,rgba(63,71,102,0.18),rgba(6,10,20,0.76))] p-4 backdrop-blur-sm sm:items-center";
  node.innerHTML = `
    <div class="w-full max-w-xl overflow-hidden rounded-[28px] border border-white/15 bg-[linear-gradient(145deg,rgba(63,71,102,0.95),rgba(22,30,48,0.92))] text-white shadow-[18px_18px_44px_rgba(8,12,24,0.52),-12px_-12px_28px_rgba(118,131,172,0.12)]">
      <div class="relative px-5 pt-5 pb-4 sm:px-7 sm:pt-7">
        <div class="absolute inset-x-0 top-0 h-24 bg-[radial-gradient(circle_at_top,rgba(245,124,0,0.26),transparent_72%)]"></div>
        <div class="relative flex items-start gap-4">
          <div class="grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-white/15 bg-white/10 shadow-[inset_4px_4px_10px_rgba(15,20,34,0.45),inset_-4px_-4px_10px_rgba(121,134,175,0.12)]">
            <i class="fa-solid fa-download text-xl text-[#ffb26e]"></i>
          </div>
          <div class="min-w-0">
            <p class="text-[11px] font-semibold uppercase tracking-[0.35em] text-[#ffcf9f]">Application Web</p>
            <h3 class="mt-2 text-2xl font-extrabold leading-tight text-white sm:text-[30px]">Installer Dominoes Lakay</h3>
            <p id="pwaInstallPromptText" class="mt-3 text-sm leading-6 text-white/82 sm:text-[15px]">
              Ajoute l'application a ton ecran d'accueil pour profiter d'un acces plus rapide, d'un affichage optimise et des dernieres mises a jour de la plateforme.
            </p>
          </div>
        </div>
        <div id="pwaInstallHelperBox" class="relative mt-4 hidden rounded-2xl border border-white/12 bg-black/18 px-4 py-4 text-sm text-white/82"></div>
        <div id="pwaInstallStatusNote" class="relative mt-3 text-xs text-white/55"></div>
        <div class="relative mt-4 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.24em] text-white/45">
          <span class="rounded-full border border-white/12 bg-white/6 px-3 py-2">Plein ecran</span>
          <span class="rounded-full border border-white/12 bg-white/6 px-3 py-2">Acces rapide</span>
          <span class="rounded-full border border-white/12 bg-white/6 px-3 py-2">Mises a jour</span>
        </div>
      </div>
      <div class="flex flex-col gap-3 border-t border-white/10 bg-black/12 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
        <button id="pwaInstallActionBtn" type="button" class="inline-flex h-12 items-center justify-center gap-2 rounded-2xl border border-[#ffb26e] bg-[#F57C00] px-5 text-sm font-semibold text-white shadow-[10px_10px_22px_rgba(163,82,27,0.42),-8px_-8px_18px_rgba(255,175,102,0.16)] transition hover:-translate-y-0.5">
          <i class="fa-solid fa-download"></i>
          <span id="pwaInstallActionLabel">Telecharger l'app</span>
        </button>
        <div class="flex flex-col gap-2 sm:flex-row">
          <button id="pwaInstallLaterBtn" type="button" class="h-11 rounded-2xl border border-white/18 bg-white/8 px-5 text-sm font-semibold text-white/86 transition hover:bg-white/12">
            Pas maintenant
          </button>
          <button id="pwaInstallNeverBtn" type="button" class="h-11 rounded-2xl border border-transparent bg-transparent px-2 text-sm font-semibold text-white/60 transition hover:text-white/86">
            Ne plus afficher
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(node);
  modalNode = node;

  const laterBtn = node.querySelector("#pwaInstallLaterBtn");
  const neverBtn = node.querySelector("#pwaInstallNeverBtn");
  const actionBtn = node.querySelector("#pwaInstallActionBtn");

  laterBtn?.addEventListener("click", () => {
    try {
      sessionStorage.setItem(PWA_PROMPT_NOT_NOW_SESSION_KEY, "1");
    } catch (_) {}
    pwaDebug("prompt:later");
    hidePwaInstallPrompt();
  });

  neverBtn?.addEventListener("click", () => {
    try {
      localStorage.setItem(PWA_PROMPT_NEVER_KEY, "1");
    } catch (_) {}
    pwaDebug("prompt:never");
    hidePwaInstallPrompt();
  });

  actionBtn?.addEventListener("click", async () => {
    const helperBox = node.querySelector("#pwaInstallHelperBox");
    const mode = getPromptMode();

    if (mode === "ios-guide") {
      if (helperBox) {
        helperBox.innerHTML = `
          <p class="font-semibold text-white">Installation sur iPhone / iPad</p>
          <p class="mt-2">1. Appuie sur l'icone <span class="font-semibold text-[#ffcf9f]">Partager</span> de Safari.</p>
          <p class="mt-1">2. Choisis <span class="font-semibold text-[#ffcf9f]">Sur l'ecran d'accueil</span>.</p>
          <p class="mt-1">3. Confirme pour ajouter Dominoes Lakay.</p>
        `;
        helperBox.classList.remove("hidden");
      }
      actionBtn.blur();
      pwaDebug("prompt:iosGuideShown");
      return;
    }

    if (mode === "hidden" || !deferredInstallPrompt) {
      pwaDebug("prompt:hiddenNoNativePrompt");
      return;
    }

    const installPrompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    actionBtn.setAttribute("disabled", "disabled");
    actionBtn.classList.add("opacity-70", "cursor-not-allowed");
    pwaDebug("prompt:installRequested");

    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      pwaDebug("prompt:userChoice", { outcome: String(choice?.outcome || "") });
      if (choice?.outcome === "accepted") {
        markPromptInstalled();
      } else {
        try {
          sessionStorage.setItem(PWA_PROMPT_NOT_NOW_SESSION_KEY, "1");
        } catch (_) {}
        hidePwaInstallPrompt();
      }
    } catch (error) {
      pwaDebug("prompt:error", {
        message: String(error?.message || error),
      });
      hidePwaInstallPrompt();
    } finally {
      actionBtn.removeAttribute("disabled");
      actionBtn.classList.remove("opacity-70", "cursor-not-allowed");
      syncPwaInstallPrompt();
    }
  });

  return node;
}

function updateModalCopy() {
  const node = ensureModalNode();
  const textNode = node.querySelector("#pwaInstallPromptText");
  const actionLabelNode = node.querySelector("#pwaInstallActionLabel");
  const helperBox = node.querySelector("#pwaInstallHelperBox");
  const statusNoteNode = node.querySelector("#pwaInstallStatusNote");
  if (!textNode || !actionLabelNode || !helperBox || !statusNoteNode) return;

  const mode = getPromptMode();

  helperBox.classList.add("hidden");

  if (mode === "ios-guide") {
    textNode.textContent = "Ajoute Dominoes Lakay sur ton ecran d'accueil pour l'ouvrir comme une vraie application et profiter d'une navigation plus directe.";
    actionLabelNode.textContent = "Voir comment l'installer";
    statusNoteNode.textContent = "Safari ne propose pas de fenetre d'installation native. Les etapes seront affichees ici.";
    return;
  }

  if (mode === "native") {
    textNode.textContent = "Ajoute l'application a ton ecran d'accueil pour profiter d'un acces plus rapide, d'un affichage optimise et des dernieres mises a jour de la plateforme.";
    actionLabelNode.textContent = "Telecharger l'app";
    statusNoteNode.textContent = "La fenetre native de ton navigateur est prete.";
    return;
  }

  textNode.textContent = "Ajoute Dominoes Lakay sur ton ecran d'accueil pour retrouver l'application plus vite depuis ton telephone.";
  actionLabelNode.textContent = "Telecharger l'app";
  statusNoteNode.textContent = "";
}

function showPwaInstallPrompt() {
  const node = ensureModalNode();
  updateModalCopy();
  node.classList.remove("hidden");
  node.classList.add("flex");
}

function hidePwaInstallPrompt() {
  const node = ensureModalNode();
  node.classList.add("hidden");
  node.classList.remove("flex");
}

function markPromptInstalled() {
  try {
    localStorage.setItem(PWA_PROMPT_INSTALLED_KEY, "1");
    localStorage.setItem(PWA_PROMPT_NEVER_KEY, "1");
  } catch (_) {}
  pwaDebug("prompt:installed");
  hidePwaInstallPrompt();
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    pwaDebug("sw:unsupported");
    return;
  }
  if (!(window.isSecureContext || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
    pwaDebug("sw:insecureContext");
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register(PWA_SW_URL, { scope: "./" });
    pwaDebug("sw:registered", {
      scope: String(registration?.scope || ""),
    });
  } catch (error) {
    pwaDebug("sw:registerError", {
      message: String(error?.message || error),
    });
  }
}

export function registerPwaSupport() {
  if (pwaSupportRegistered) return;
  pwaSupportRegistered = true;

  if (document.readyState === "complete") {
    void registerServiceWorker();
  } else {
    window.addEventListener("load", () => {
      void registerServiceWorker();
    }, { once: true });
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    pwaDebug("prompt:available");
    syncPwaInstallPrompt();
  });

  window.addEventListener("appinstalled", () => {
    pwaDebug("prompt:appinstalled");
    markPromptInstalled();
  });
}

export function syncPwaInstallPrompt(options = {}) {
  if (typeof options.enabled === "boolean") {
    promptEnabledOnHome = options.enabled;
  }

  if (!promptEnabledOnHome) {
    hidePwaInstallPrompt();
    return;
  }

  if (shouldSuppressPrompt()) {
    hidePwaInstallPrompt();
    return;
  }

  if (getPromptMode() === "hidden") {
    hidePwaInstallPrompt();
    return;
  }

  showPwaInstallPrompt();
}
