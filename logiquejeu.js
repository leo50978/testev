import {
  auth,
  db,
  collection,
  doc,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  onSnapshot,
  onAuthStateChanged,
} from "./firebase-init.js";
import { getXchangeState, ensureXchangeState } from "./xchange.js";
import {
  joinMatchmakingSecure,
  ensureRoomReadySecure,
  leaveRoomSecure,
  finalizeGameSecure,
  claimWinRewardSecure,
  submitActionSecure,
} from "./secure-functions.js";

const ROOMS = "rooms";
const WAIT_MS = 15 * 1000;
const TURN_LIMIT_MS = 30 * 1000;
const ACTION_CACHE_PREFIX = "domino_actions_";
const ROOM_SETTLEMENT_PREFIX = "domino_settle_";
const HOW_TO_PLAY_STORAGE_KEY = "domino_how_to_play_seen_v1";
const DEFAULT_ENTRY_COST_DOES = 100;
const DEFAULT_STAKE_REWARD_MULTIPLIER = 3;
const ONLINE_USERS_MIN = 30000;
const ONLINE_USERS_MAX = 100000;
const URL_PARAMS = new URLSearchParams(window.location.search);
const SHOULD_AUTOSTART = URL_PARAMS.get("autostart") === "1";

function resolveEntryCostDoes(searchParams) {
  const rawStake = searchParams.get("stake");
  if (!rawStake) return DEFAULT_ENTRY_COST_DOES;
  const parsed = Number.parseInt(rawStake, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ENTRY_COST_DOES;
  return Math.floor(parsed);
}

function resolveRewardDoesFromEntry(entryCostDoes) {
  const parsed = Number.parseInt(String(entryCostDoes || 0), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_ENTRY_COST_DOES * DEFAULT_STAKE_REWARD_MULTIPLIER;
  }
  return Math.floor(parsed) * DEFAULT_STAKE_REWARD_MULTIPLIER;
}

function resolveRoomRewardDoes(roomData = {}) {
  const explicit = Number.parseInt(String(roomData?.rewardAmountDoes || 0), 10);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  return resolveRewardDoesFromEntry(roomData?.entryCostDoes || roomData?.stakeDoes || DEFAULT_ENTRY_COST_DOES);
}

function getSessionRewardDoes() {
  return resolveRoomRewardDoes(window.GameSession || {});
}

function getSessionEntryCostDoes() {
  return Number.parseInt(String(window.GameSession?.entryCostDoes || ENTRY_COST_DOES_RESOLVED), 10) || DEFAULT_ENTRY_COST_DOES;
}

function getCurrentRoomRewardDoes(roomData = null) {
  if (roomData) return resolveRoomRewardDoes(roomData);
  return getSessionRewardDoes();
}

function getCurrentRoomEntryCostDoes(roomData = null) {
  if (roomData) {
    const explicit = Number.parseInt(String(roomData?.entryCostDoes || roomData?.stakeDoes || 0), 10);
    if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  }
  return getSessionEntryCostDoes();
}

const ENTRY_COST_DOES_RESOLVED = resolveEntryCostDoes(URL_PARAMS);

function buildAutostartUrl() {
  return `./jeu.html?autostart=1&stake=${ENTRY_COST_DOES_RESOLVED}`;
}

let roomUnsub = null;
let actionsUnsub = null;
let roomId = null;
let seatIndex = -1;
let startTimer = null;
let turnTimer = null;
let turnTimerKey = "";
let turnTick = null;
let botTurnTimer = null;
let gameLaunched = false;
let matchmakingBusy = false;
let resumePromise = null;
let autostartTried = false;
let resumeDeclined = false;
let pendingStartAfterRotate = false;
let onlineUsersValue = ONLINE_USERS_MIN;
let onlineUsersTick = null;
let fullscreenHintTimer = null;
let howToPlayPromptPromise = null;

function makeClientActionId() {
  return `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function setMatchLoading(visible, text) {
  const overlay = document.getElementById("MatchLoadingOverlay");
  const txt = document.getElementById("MatchLoadingText");
  if (txt && typeof text === "string" && text.length > 0) txt.textContent = text;
  if (!overlay) return;
  if (visible) {
    overlay.classList.remove("hidden");
    overlay.classList.add("flex");
  } else {
    overlay.classList.add("hidden");
    overlay.classList.remove("flex");
  }
}

function hasSeenHowToPlayPrompt() {
  try {
    return window.localStorage?.getItem(HOW_TO_PLAY_STORAGE_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function markHowToPlayPromptSeen() {
  try {
    window.localStorage?.setItem(HOW_TO_PLAY_STORAGE_KEY, "1");
  } catch (_) {
    // Ignore storage failures; the tutorial may reappear next time.
  }
}

function ensureHowToPlayModal() {
  let overlay = document.getElementById("HowToPlayOverlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "HowToPlayOverlay";
  overlay.className = "fixed inset-0 z-[2600] hidden items-center justify-center bg-black/70 p-4 backdrop-blur-md";
  overlay.innerHTML = `
    <div class="w-[min(94vw,34rem)] rounded-3xl border border-white/20 bg-[#24304a]/90 p-5 text-white shadow-[14px_14px_34px_rgba(8,14,28,0.48),-10px_-10px_24px_rgba(67,93,142,0.18)] backdrop-blur-xl sm:p-6">
      <div class="text-xs font-semibold uppercase tracking-[0.22em] text-[#8ed8ff]">Comment jouer</div>
      <h2 class="mt-2 text-xl font-bold sm:text-2xl">Ton premier match</h2>
      <div class="mt-4 space-y-3 text-sm text-white/85 sm:text-[15px]">
        <p>Pour jouer un domino, clique simplement sur le domino que tu veux poser.</p>
        <p>Si le domino peut se jouer par les deux cotes, clique sur le cote que tu choisis.</p>
        <p class="rounded-2xl border border-white/15 bg-white/8 px-4 py-3 text-white/90">
          Exemple: avec <span class="font-semibold text-[#ffd8b5]">6-3</span>, si tu peux jouer soit par le <span class="font-semibold">6</span> soit par le <span class="font-semibold">3</span>, clique directement sur le <span class="font-semibold">6</span> ou sur le <span class="font-semibold">3</span>.
        </p>
      </div>
      <button id="HowToPlayContinueBtn" type="button" class="mt-5 h-11 w-full rounded-2xl border border-[#58c4ff]/45 bg-[#1293d8] text-sm font-semibold text-white shadow-[8px_8px_18px_rgba(10,49,82,0.45),-6px_-6px_14px_rgba(88,196,255,0.18)] transition hover:-translate-y-0.5">
        J'ai compris
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function ensureHowToPlayPromptAccepted() {
  if (hasSeenHowToPlayPrompt()) return Promise.resolve();
  if (howToPlayPromptPromise) return howToPlayPromptPromise;

  const overlay = ensureHowToPlayModal();
  const continueBtn = document.getElementById("HowToPlayContinueBtn");
  if (!overlay || !continueBtn) {
    markHowToPlayPromptSeen();
    return Promise.resolve();
  }

  overlay.classList.remove("hidden");
  overlay.classList.add("flex");

  howToPlayPromptPromise = new Promise((resolve) => {
    const accept = () => {
      continueBtn.removeEventListener("click", accept);
      markHowToPlayPromptSeen();
      overlay.classList.add("hidden");
      overlay.classList.remove("flex");
      howToPlayPromptPromise = null;
      resolve();
    };
    continueBtn.addEventListener("click", accept);
  });

  return howToPlayPromptPromise;
}

function askResumeRoomDecision() {
  const overlay = document.getElementById("ResumeRoomOverlay");
  const joinBtn = document.getElementById("ResumeRoomJoinBtn");
  const leaveBtn = document.getElementById("ResumeRoomLeaveBtn");

  if (!overlay || !joinBtn || !leaveBtn) {
    return Promise.resolve(
      window.confirm("Une partie en cours a été trouvée.\nOK = Rentrer dans la salle\nAnnuler = Quitter la salle")
    );
  }

  return new Promise((resolve) => {
    const cleanup = () => {
      joinBtn.removeEventListener("click", onJoin);
      leaveBtn.removeEventListener("click", onLeave);
      overlay.classList.add("hidden");
      overlay.classList.remove("flex");
    };
    const onJoin = () => {
      cleanup();
      resolve(true);
    };
    const onLeave = () => {
      cleanup();
      resolve(false);
    };

    joinBtn.addEventListener("click", onJoin);
    leaveBtn.addEventListener("click", onLeave);
    overlay.classList.remove("hidden");
    overlay.classList.add("flex");
  });
}

function extractUrl(text) {
  if (!text) return null;
  const m = String(text).match(/https?:\/\/[^\s)"]+/);
  return m ? m[0] : null;
}

function logFirestoreError(context, err) {
  const code = err && err.code ? err.code : "unknown";
  const message = err && err.message ? err.message : String(err);
  const link = extractUrl(message);
  console.error(`[Firestore][${context}] code=${code}`, err);
  if (link) {
    console.log(`[Firestore][${context}] index/create link: ${link}`);
    setStatus(`Erreur Firestore (${code}). Ouvre la console: lien d'index détecté.`);
  } else {
    setStatus(`Erreur Firestore (${code}). Voir console.`);
  }
}

function requireUser() {
  const user = auth.currentUser;
  if (!user) throw new Error("Tu dois être connecté pour jouer en multijoueur.");
  return user;
}

function setStatus(msg) {
  if (window.AuthState && typeof window.AuthState.setStatus === "function") {
    window.AuthState.setStatus(msg);
  }
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function randomIntInclusive(min, max) {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function formatOnlineUsers(value) {
  return Number(value || 0).toLocaleString("fr-FR").replace(/\u202f/g, " ");
}

function setOnlineUsersHud(value) {
  const hud = document.getElementById("OnlineUsersHud");
  if (!hud) return;
  hud.textContent = `Utilisateurs en ligne: ${formatOnlineUsers(value)}`;
}

function startOnlineUsersTicker() {
  const hud = document.getElementById("OnlineUsersHud");
  if (!hud) return;

  if (onlineUsersTick) {
    clearInterval(onlineUsersTick);
    onlineUsersTick = null;
  }

  onlineUsersValue = randomIntInclusive(ONLINE_USERS_MIN, ONLINE_USERS_MAX);
  setOnlineUsersHud(onlineUsersValue);

  onlineUsersTick = setInterval(() => {
    const amplitude = Math.max(15, Math.floor(onlineUsersValue * 0.0015));
    let delta = randomIntInclusive(-amplitude, amplitude);
    if (delta === 0) delta = Math.random() < 0.5 ? -1 : 1;
    onlineUsersValue = clampNumber(onlineUsersValue + delta, ONLINE_USERS_MIN, ONLINE_USERS_MAX);
    setOnlineUsersHud(onlineUsersValue);
  }, 1100);
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || null;
}

function requestFullscreenCompat(target) {
  if (!target) return null;
  if (typeof target.requestFullscreen === "function") return target.requestFullscreen();
  if (typeof target.webkitRequestFullscreen === "function") return target.webkitRequestFullscreen();
  if (typeof target.msRequestFullscreen === "function") return target.msRequestFullscreen();
  return null;
}

function exitFullscreenCompat() {
  if (typeof document.exitFullscreen === "function") return document.exitFullscreen();
  if (typeof document.webkitExitFullscreen === "function") return document.webkitExitFullscreen();
  if (typeof document.msExitFullscreen === "function") return document.msExitFullscreen();
  return null;
}

function isFullscreenSupported() {
  const root = document.documentElement;
  return Boolean(
    (root && (
      typeof root.requestFullscreen === "function" ||
      typeof root.webkitRequestFullscreen === "function" ||
      typeof root.msRequestFullscreen === "function"
    )) ||
    typeof document.exitFullscreen === "function" ||
    typeof document.webkitExitFullscreen === "function" ||
    typeof document.msExitFullscreen === "function"
  );
}

function setFullscreenHint(text) {
  const hint = document.getElementById("FullscreenHint");
  if (!hint) return;
  hint.textContent = text || "Plein ecran non supporte sur cet appareil.";
  hint.classList.remove("hidden");
  if (fullscreenHintTimer) clearTimeout(fullscreenHintTimer);
  fullscreenHintTimer = setTimeout(() => {
    const liveHint = document.getElementById("FullscreenHint");
    if (!liveHint) return;
    liveHint.classList.add("hidden");
  }, 2600);
}

function setFullscreenIcon(isActive) {
  const icon = document.getElementById("FullscreenToggleIcon");
  if (!icon) return;
  if (isActive) {
    icon.innerHTML = `
      <path d="M9 9H5V5"></path>
      <path d="M15 9h4V5"></path>
      <path d="M9 15H5v4"></path>
      <path d="M15 15h4v4"></path>
    `;
    return;
  }
  icon.innerHTML = `
    <path d="M8 3H5a2 2 0 0 0-2 2v3"></path>
    <path d="M16 3h3a2 2 0 0 1 2 2v3"></path>
    <path d="M8 21H5a2 2 0 0 1-2-2v-3"></path>
    <path d="M16 21h3a2 2 0 0 0 2-2v-3"></path>
  `;
}

function syncFullscreenButtonState() {
  const btn = document.getElementById("FullscreenToggleBtn");
  if (!btn) return;
  const active = !!fullscreenElement();
  btn.setAttribute("aria-label", active ? "Quitter le plein ecran" : "Passer en plein ecran");
  btn.setAttribute("title", active ? "Quitter le plein ecran" : "Passer en plein ecran");
  setFullscreenIcon(active);
}

async function toggleFullscreen() {
  if (!isFullscreenSupported()) {
    setFullscreenHint("Plein ecran non supporte sur cet appareil.");
    return;
  }
  try {
    if (fullscreenElement()) {
      await exitFullscreenCompat();
    } else {
      const result = requestFullscreenCompat(document.documentElement);
      if (result === null) {
        setFullscreenHint("Plein ecran non supporte sur cet appareil.");
        return;
      }
      if (result && typeof result.then === "function") await result;
    }
  } catch (err) {
    console.warn("[FULLSCREEN] toggle failed", err);
    setFullscreenHint("Impossible d'activer le plein ecran.");
  } finally {
    syncFullscreenButtonState();
  }
}

function bindFullscreenToggle() {
  const btn = document.getElementById("FullscreenToggleBtn");
  if (!btn || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", () => {
    toggleFullscreen();
  });
  document.addEventListener("fullscreenchange", syncFullscreenButtonState);
  document.addEventListener("webkitfullscreenchange", syncFullscreenButtonState);
  document.addEventListener("msfullscreenchange", syncFullscreenButtonState);
  document.addEventListener("MSFullscreenChange", syncFullscreenButtonState);
  syncFullscreenButtonState();
}

function isLikelyMobileDevice() {
  const touch = ("ontouchstart" in window) || ((navigator && navigator.maxTouchPoints) || 0) > 0;
  const smallViewport = window.matchMedia && window.matchMedia("(max-width: 1024px)").matches;
  return touch && smallViewport;
}

function isPortraitNow() {
  if (window.matchMedia) return window.matchMedia("(orientation: portrait)").matches;
  return window.innerHeight >= window.innerWidth;
}

function isLandscapeRequiredAndMissing() {
  return isLikelyMobileDevice() && isPortraitNow();
}

function updateOrientationGuard() {
  const overlay = document.getElementById("OrientationGuardOverlay");
  const title = document.getElementById("OrientationGuardTitle");
  const risk = document.getElementById("OrientationGuardRisk");
  if (!overlay) return true;

  const blocked = isLandscapeRequiredAndMissing();
  const isPlaying = !!(window.GameSession && window.GameSession.status === "playing");

  if (!blocked) {
    overlay.classList.add("hidden");
    overlay.classList.remove("flex");
    return true;
  }

  if (title) {
    title.textContent = isPlaying
      ? "Remets le telephone en mode horizontal maintenant"
      : "Tourne ton telephone pour jouer";
  }
  if (risk) risk.classList.toggle("hidden", !isPlaying);
  overlay.classList.remove("hidden");
  overlay.classList.add("flex");
  return false;
}

function ensureLandscapeReadyBeforeStart() {
  if (updateOrientationGuard() === true) return true;
  pendingStartAfterRotate = true;
  setStatus("Tourne le telephone a l'horizontale pour lancer la partie.");
  setMatchLoading(false);
  return false;
}

function onOrientationMaybeChanged() {
  const ready = updateOrientationGuard();
  if (!ready) {
    if (window.GameSession && window.GameSession.status === "playing") {
      setStatus("Mode horizontal requis: remets vite le telephone a l'horizontale.");
    }
    return;
  }
  if (pendingStartAfterRotate && auth.currentUser) {
    pendingStartAfterRotate = false;
    startGameFlow().catch((err) => {
      setStatus(err && err.message ? err.message : "Erreur matchmaking");
    });
  }
}

function refreshDoesHud() {
  const el = document.getElementById("LocalDoesValue");
  if (!el) return;
  try {
    const uid = auth.currentUser?.uid || "guest";
    const xState = getXchangeState(window.__userBaseBalance || window.__userBalance || 0, uid);
    el.textContent = String(xState?.does || 0);
  } catch (_) {
    el.textContent = "0";
  }
}

function settlementKey(id, uid) {
  return `${ROOM_SETTLEMENT_PREFIX}${id || "none"}_${uid || "guest"}`;
}

function readSettlement(id, uid) {
  try {
    const raw = localStorage.getItem(settlementKey(id, uid));
    if (!raw) return { entryPaid: false, rewardPaid: false };
    const parsed = JSON.parse(raw);
    return {
      entryPaid: parsed && parsed.entryPaid === true,
      rewardPaid: parsed && parsed.rewardPaid === true,
    };
  } catch (_) {
    return { entryPaid: false, rewardPaid: false };
  }
}

function writeSettlement(id, uid, patch) {
  const prev = readSettlement(id, uid);
  const next = {
    entryPaid: patch && typeof patch.entryPaid === "boolean" ? patch.entryPaid : prev.entryPaid,
    rewardPaid: patch && typeof patch.rewardPaid === "boolean" ? patch.rewardPaid : prev.rewardPaid,
  };
  try {
    localStorage.setItem(settlementKey(id, uid), JSON.stringify(next));
  } catch (_) {}
}

function ensureEndActionsButtonsBound() {
  const replayBtn = document.getElementById("GameEndReplayBtn");
  const backBtn = document.getElementById("GameEndBackBtn");
  if (replayBtn && replayBtn.dataset.bound !== "1") {
    replayBtn.dataset.bound = "1";
    replayBtn.onclick = function() {
      window.location.href = buildAutostartUrl();
    };
  }
  if (backBtn && backBtn.dataset.bound !== "1") {
    backBtn.dataset.bound = "1";
    backBtn.onclick = function() {
      window.location.href = "./inedex.html";
    };
  }
}

function showReplayReturnOverlay(message) {
  const overlay = document.getElementById("GameEndOverlay");
  const winnerEl = document.getElementById("GameEndWinnerText");
  const infoEl = document.getElementById("GameEndInfoText");
  const trophy = document.getElementById("GameEndTrophy");
  const viewWrap = document.getElementById("GameEndViewWrap");
  const actionsWrap = document.getElementById("GameEndActionsWrap");
  const goBtn = document.getElementById("GameEndGoBtn");

  ensureEndActionsButtonsBound();
  if (!overlay || !actionsWrap) return;
  if (winnerEl) winnerEl.textContent = "Salle quittée";
  if (infoEl) infoEl.textContent = message || "Tu peux rejouer ou retourner à l'accueil.";
  if (trophy) trophy.classList.add("hidden");
  if (viewWrap) {
    viewWrap.classList.add("hidden");
    viewWrap.classList.remove("block");
  }
  if (goBtn) {
    goBtn.classList.add("hidden");
    goBtn.classList.remove("block");
  }
  actionsWrap.classList.remove("hidden");
  actionsWrap.classList.add("grid");
  overlay.classList.remove("hidden");
  overlay.classList.add("flex");
}

function clearTimer() {
  if (startTimer) {
    clearTimeout(startTimer);
    startTimer = null;
  }
}

function clearTurnTimer() {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
  if (botTurnTimer) {
    clearTimeout(botTurnTimer);
    botTurnTimer = null;
  }
  if (turnTick) {
    clearInterval(turnTick);
    turnTick = null;
  }
  turnTimerKey = "";
  const el = document.getElementById("TurnTimer");
  if (el) {
    el.textContent = "--";
    el.setAttribute("Urgent", "false");
  }
}

function setTurnTimerUI(remainingSec, currentPlayer) {
  const S = window.GameSession || null;
  const localSeat = (S && typeof S.seatIndex === "number") ? S.seatIndex : -1;
  const isLocalTurn = (typeof currentPlayer === "number" && localSeat === currentPlayer);

  const legacy = document.getElementById("TurnTimer");
  if (legacy) {
    const safeLegacy = Math.max(0, Math.ceil(remainingSec));
    legacy.textContent = String(safeLegacy);
    legacy.setAttribute("Urgent", safeLegacy <= 5 ? "true" : "false");
  }

  const labelEl = document.getElementById("LocalTurnLabel");
  const valueEl = document.getElementById("LocalTurnValue");
  const barEl = document.getElementById("LocalTurnBar");
  if (!labelEl || !valueEl || !barEl) return;

  if (!isLocalTurn) {
    labelEl.textContent = "En attente";
    valueEl.textContent = "--";
    barEl.style.width = "100%";
    barEl.style.opacity = "0.35";
    return;
  }

  const safe = Math.max(0, Math.ceil(remainingSec));
  const pct = Math.max(0, Math.min(100, Math.floor((safe / (TURN_LIMIT_MS / 1000)) * 100)));
  labelEl.textContent = "Ton tour";
  valueEl.textContent = String(safe);
  barEl.style.width = `${pct}%`;
  barEl.style.opacity = "1";
  barEl.classList.toggle("from-red-500", safe <= 5);
  barEl.classList.toggle("to-rose-300", safe <= 5);
  barEl.classList.toggle("from-orange-500", safe > 5);
  barEl.classList.toggle("to-amber-300", safe > 5);
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  return 0;
}

function clearSubs() {
  if (roomUnsub) roomUnsub();
  if (actionsUnsub) actionsUnsub();
  roomUnsub = null;
  actionsUnsub = null;
  clearTurnTimer();
  gameLaunched = false;
}

function actionCacheKey(id) {
  return `${ACTION_CACHE_PREFIX}${id}`;
}

function clearActionCache(id) {
  if (!id) return;
  try {
    localStorage.removeItem(actionCacheKey(id));
  } catch (e) {
    console.warn("[CACHE] clearActionCache error", e);
  }
}

function readActionCache(id) {
  if (!id) return [];
  try {
    const raw = localStorage.getItem(actionCacheKey(id));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    arr.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    return arr;
  } catch (e) {
    console.warn("[CACHE] readActionCache error", e);
    return [];
  }
}

function saveActionToCache(id, action) {
  if (!id || !action || typeof action.seq !== "number") return;
  try {
    const arr = readActionCache(id);
    const last = arr.length > 0 ? arr[arr.length - 1] : null;
    if (last && typeof last.seq === "number" && action.seq <= last.seq) {
      if (action.seq === last.seq) return;
      // si l'ordre n'est pas strictement croissant, on déduplique par seq
      const map = {};
      for (let i = 0; i < arr.length; i++) map[arr[i].seq] = arr[i];
      map[action.seq] = action;
      const next = Object.keys(map).map((k) => map[k]).sort((a, b) => a.seq - b.seq);
      localStorage.setItem(actionCacheKey(id), JSON.stringify(next.slice(-200)));
      return;
    }
    arr.push(action);
    localStorage.setItem(actionCacheKey(id), JSON.stringify(arr.slice(-200)));
  } catch (e) {
    console.warn("[CACHE] saveActionToCache error", e);
  }
}

function applyCachedActionsInstant(id) {
  const actions = readActionCache(id);
  if (!actions.length) return;
  // Le cache doit être strictement continu depuis seq=0, sinon on l'ignore.
  if (typeof actions[0].seq !== "number" || actions[0].seq !== 0) {
    clearActionCache(id);
    return;
  }
  for (let i = 1; i < actions.length; i++) {
    if (typeof actions[i].seq !== "number" || actions[i].seq !== actions[i - 1].seq + 1) {
      clearActionCache(id);
      return;
    }
  }
  if (!window.Domino || !window.Domino.Partida) return;
  if (typeof window.Domino.Partida.AplicarAccionMultijugador !== "function") return;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (typeof action.seq !== "number") continue;
    window.Domino.Partida.AplicarAccionMultijugador(action);
  }
}

function resetSessionState() {
  clearTimer();
  clearSubs();
  setMatchLoading(false);
  roomId = null;
  seatIndex = -1;
  matchmakingBusy = false;
  window.GameSession = null;
  setLeaveRoomButtonVisible(false);
  updateOrientationGuard();
}

function parseSeatsMap(seats) {
  const humanSeats = [];
  if (!seats || typeof seats !== "object") return humanSeats;
  Object.keys(seats).forEach((uid) => {
    const s = seats[uid];
    if (typeof s === "number" && s >= 0 && s < 4) humanSeats.push(s);
  });
  humanSeats.sort((a, b) => a - b);
  return humanSeats;
}

async function findWaitingRoom() {
  // Evite une dépendance à un index composite Firestore sur les nouveaux projets.
  const q = query(
    collection(db, ROOMS),
    where("status", "==", "waiting"),
    limit(25)
  );
  try {
    const snap = await getDocs(q);
    if (snap.empty) return null;

    function tsValue(t) {
      if (!t) return 0;
      if (typeof t.toMillis === "function") return t.toMillis();
      if (typeof t.seconds === "number") return t.seconds * 1000;
      return 0;
    }

    const candidates = [];
    for (let i = 0; i < snap.docs.length; i++) {
      const d = snap.docs[i];
      const data = d.data() || {};
      const humans = Number.isFinite(Number(data.humanCount)) ? Number(data.humanCount) : 1;
      if (humans >= 4) continue;
      candidates.push({
        id: d.id,
        humans,
        createdAtMs: tsValue(data.createdAt),
      });
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      if (b.humans !== a.humans) return b.humans - a.humans; // priorise les salles presque pleines
      return a.createdAtMs - b.createdAtMs; // puis la plus ancienne
    });
    return candidates[0].id;
  } catch (err) {
    logFirestoreError("findWaitingRoom", err);
    throw err;
  }
}

async function findActiveRoomForUser(uid) {
  const q = query(
    collection(db, ROOMS),
    where("playerUids", "array-contains", uid),
    limit(10)
  );
  try {
    const snap = await getDocs(q);
    if (snap.empty) return null;

    function tsValue(t) {
      if (!t) return 0;
      if (typeof t.toMillis === "function") return t.toMillis();
      if (typeof t.seconds === "number") return t.seconds * 1000;
      return 0;
    }

    let waiting = null;
    let waitingTs = 0;
    let playing = null;
    let playingTs = 0;

    for (let i = 0; i < snap.docs.length; i++) {
      const d = snap.docs[i];
      const data = d.data();
      if (!data || !data.status) continue;

      if (data.status === "playing") {
        const t = tsValue(data.startedAt) || tsValue(data.createdAt);
        if (playing === null || t > playingTs) {
          playing = { id: d.id, data };
          playingTs = t;
        }
      } else if (data.status === "waiting") {
        const t = tsValue(data.createdAt);
        if (waiting === null || t > waitingTs) {
          waiting = { id: d.id, data };
          waitingTs = t;
        }
      }
    }
    return playing || waiting;
  } catch (err) {
    logFirestoreError("findActiveRoomForUser", err);
    throw err;
  }
}

async function startRoomIfNeeded(id) {
  try {
    await ensureRoomReadySecure({ roomId: id });
  } catch (err) {
    logFirestoreError("startRoomIfNeeded", err);
    throw err;
  }
}

async function endGameClick() {
  const user = auth.currentUser;
  if (!user || !roomId) {
    setStatus("Aucune salle active.");
    return "no_room";
  }
  await leaveRoom();
  return "left";
}

async function handleEndedRoom(roomData) {
  const user = auth.currentUser;
  if (!user || !roomId || !roomData) return;

  const winnerSeat = typeof roomData.winnerSeat === "number" ? roomData.winnerSeat : -1;
  const winnerUid = String(roomData.winnerUid || "").trim();
  const hasWinner = winnerUid.length > 0 || winnerSeat >= 0;
  if (!hasWinner) return;

  const didWin = winnerUid ? winnerUid === user.uid : seatIndex === winnerSeat;

  if (!didWin) return;

  const settle = readSettlement(roomId, user.uid);
  if (settle.rewardPaid === true) return;

  try {
    const rewardRes = await claimWinRewardSecure({ roomId });
    const rewardAmountDoes = Number.parseInt(
      String(rewardRes?.rewardAmountDoes || getCurrentRoomRewardDoes(roomData)),
      10
    ) || getCurrentRoomRewardDoes(roomData);
    if (rewardRes?.rewardGranted === true) {
      writeSettlement(roomId, user.uid, { entryPaid: true, rewardPaid: true });
      setStatus(`Victoire: +${rewardAmountDoes} Does.`);
      refreshDoesHud();
    } else {
      writeSettlement(roomId, user.uid, { entryPaid: true, rewardPaid: true });
      setStatus("Gain déjà validé.");
      refreshDoesHud();
    }
  } catch (err) {
    console.error("[REWARD] claimWinReward error", err);
    setStatus("Impossible de valider le gain pour le moment.");
  }
}

async function onGameEnded(winnerSeat) {
  if (!roomId) return;
  const currentRoomId = roomId;
  const isHost = !!(window.GameSession && window.GameSession.isHost === true);
  if (!isHost) return;

  try {
    await finalizeGameSecure({
      roomId: currentRoomId,
    });
    setStatus("Partie terminée. Clique sur Aller pour continuer.");
  } catch (err) {
    logFirestoreError("onGameEnded", err);
  }
}

async function pushAction(action) {
  if (!roomId) throw new Error("Aucune salle active.");
  try {
    await submitActionSecure({
      roomId,
      clientActionId: makeClientActionId(),
      action,
    });
  } catch (err) {
    console.error("[MATCH] submitAction error", err);
    throw err;
  }
}

function scheduleTurnTimeout(id, roomData) {
  clearTurnTimer();
  if (!roomData || roomData.status !== "playing") return;
  if (typeof roomData.currentPlayer !== "number" || typeof roomData.turnActual !== "number") return;

  const turnStartedMs = tsToMs(roomData.turnStartedAt);
  const elapsedMs = turnStartedMs > 0 ? Math.max(0, Date.now() - turnStartedMs) : 0;
  const remainingMs = Math.max(0, TURN_LIMIT_MS - elapsedMs);
  const baseStartMs = Date.now() - elapsedMs;
  setTurnTimerUI(remainingMs / 1000, roomData.currentPlayer);
  turnTick = setInterval(() => {
    const liveLeft = Math.max(0, TURN_LIMIT_MS - (Date.now() - baseStartMs));
    setTurnTimerUI(liveLeft / 1000, roomData.currentPlayer);
  }, 250);

  const key = `${id}:${roomData.turnActual}:${roomData.currentPlayer}`;
  turnTimerKey = key;

  turnTimer = setTimeout(async () => {
    if (turnTimerKey !== key) return;
    setTurnTimerUI(0, roomData.currentPlayer);
  }, remainingMs);
}

function watchActions(id) {
  if (actionsUnsub) actionsUnsub();
  const q = query(collection(db, ROOMS, id, "actions"), orderBy("seq", "asc"));
  let firstSnapshot = true;

  function maybeFinishRehydration() {
    const partida = window.Domino && window.Domino.Partida ? window.Domino.Partida : null;
    const session = window.GameSession || null;
    if (!partida || partida.ModoRehidratacion !== true) return;
    if (typeof partida.FinalizarRehidratacion !== "function") return;

    const expectedTurn = Number.isFinite(Number(session?.turnActual)) ? Math.trunc(Number(session.turnActual)) : 0;
    const expectedPlayer = Number.isFinite(Number(session?.currentPlayer)) ? Math.trunc(Number(session.currentPlayer)) : -1;

    if (partida.TurnoActual !== expectedTurn) return;
    if (expectedPlayer >= 0 && partida.JugadorActual !== expectedPlayer) return;

    partida.FinalizarRehidratacion();
  }

  actionsUnsub = onSnapshot(
    q,
    (snap) => {
      if (
        firstSnapshot &&
        window.Domino &&
        window.Domino.Partida &&
        typeof window.Domino.Partida.AplicarAccionMultijugador === "function"
      ) {
        firstSnapshot = false;

        if (typeof window.Domino.Partida.IniciarRehidratacion === "function") {
          window.Domino.Partida.IniciarRehidratacion();
        }
        try {
          // Rebuild autoritaire depuis Firestore pour éviter toute dérive du cache local.
          if (typeof window.Domino.Partida.Empezar === "function") {
            window.Domino.Partida.Empezar();
          }
          if (snap.empty) {
            maybeFinishRehydration();
            return;
          }
          snap.docs.forEach((d) => {
            const action = d.data();
            if (typeof action.seq !== "number") return;
            saveActionToCache(id, action);
            window.Domino.Partida.AplicarAccionMultijugador(action);
          });
        } finally {
          maybeFinishRehydration();
        }
        return;
      }

      firstSnapshot = false;
      snap.docChanges().forEach((change) => {
        if (change.type !== "added") return;
        const action = change.doc.data();
        if (typeof action.seq !== "number") return;
        saveActionToCache(id, action);

        if (window.Domino && window.Domino.Partida && typeof window.Domino.Partida.AplicarAccionMultijugador === "function") {
          window.Domino.Partida.AplicarAccionMultijugador(action);
        }
      });
      maybeFinishRehydration();
    },
    (err) => {
      logFirestoreError("watchActions", err);
    });
}

function launchLocalGame(roomData) {
  const seats = roomData.seats || {};
  const humanSeats = parseSeatsMap(seats);
  const hostSeat = seats[roomData.ownerUid] !== undefined ? seats[roomData.ownerUid] : 0;

  window.GameSession = {
    roomId,
    seatIndex,
    hostSeat,
    isHost: seatIndex === hostSeat,
    playerUids: roomData.playerUids || [],
    playerNames: roomData.playerNames || roomData.playerEmails || [],
    humanSeats,
    humans: roomData.humanCount || humanSeats.length || 1,
    bots: roomData.botCount || 0,
    status: roomData.status,
    currentPlayer: typeof roomData.currentPlayer === "number" ? roomData.currentPlayer : 0,
    turnActual: typeof roomData.turnActual === "number" ? roomData.turnActual : 0,
    lastActionSeq: typeof roomData.lastActionSeq === "number" ? roomData.lastActionSeq : -1,
    entryCostDoes: getCurrentRoomEntryCostDoes(roomData),
    rewardAmountDoes: getCurrentRoomRewardDoes(roomData),
    deckOrder: Array.isArray(roomData.deckOrder) ? roomData.deckOrder : [],
  };
  if (gameLaunched) return;
  gameLaunched = true;
  setLeaveRoomButtonVisible(true);
  updateOrientationGuard();

  setStatus(
    `Salle ${roomId} | Mise ${window.GameSession.entryCostDoes} Does | Gain ${window.GameSession.rewardAmountDoes} Does | Seat ${seatIndex + 1} | Humains ${window.GameSession.humans} | Bots ${window.GameSession.bots}`
  );

  if (window.Domino && window.Domino.Partida) {
    // Empêche toute action locale prématurée pendant la reconstruction d'état.
    if (typeof window.Domino.Partida.IniciarRehidratacion === "function") {
      window.Domino.Partida.IniciarRehidratacion();
    }
    window.Domino.Partida.Empezar();
    applyCachedActionsInstant(roomId);
  }
  watchActions(roomId);
}

function watchRoom(id) {
  if (roomUnsub) roomUnsub();
  const roomRef = doc(db, ROOMS, id);

  roomUnsub = onSnapshot(
    roomRef,
    (snap) => {
      if (!snap.exists()) {
        if (id === roomId) {
          resetSessionState();
          clearActionCache(id);
          setMatchLoading(false);
          if (window.UI && typeof window.UI.NotifierSalleSupprimee === "function") {
            window.UI.NotifierSalleSupprimee();
          }
          if (window.UI) window.UI.MostrarEmpezar();
          setStatus("Salle fermée et supprimée.");
        }
        return;
      }
      const data = snap.data();

      if (data.status === "waiting") {
        clearTurnTimer();
        setMatchLoading(true, "Connexion des joueurs en cours.");
        const humans = data.humanCount || 1;
        setStatus(`Salle en attente (${humans}/4). La partie démarre automatiquement dans 15s, puis les bots complètent la table si besoin.`);
        if (humans >= 4) startRoomIfNeeded(id).catch((err) => setStatus(err.message || "Erreur start"));
        return;
      }

      if (data.status === "ended") {
        clearTurnTimer();
        clearTimer();
        setMatchLoading(false);
        setStatus("Partie terminée. Clique sur Aller pour continuer.");
        handleEndedRoom(data).catch((err) => {
          console.error("[ROOM] ended handling error", err);
        });
        return;
      }

      if (data.status === "playing") {
        clearTimer();
        setMatchLoading(false);
        launchLocalGame(data);
        updateOrientationGuard();
        scheduleTurnTimeout(id, data);
        matchmakingBusy = false;
        return;
      }

      if (data.status === "closing") {
        clearTurnTimer();
        clearTimer();
        setMatchLoading(true, "Finalisation de la salle...");
        setStatus("Salle en fermeture...");
        return;
      }

      if (data.status === "closed") {
        clearTurnTimer();
        clearTimer();
        setMatchLoading(false);
        resetSessionState();
        clearActionCache(id);
        if (window.UI) window.UI.MostrarEmpezar();
        setStatus("Salle fermée.");
      }
    },
    (err) => {
      logFirestoreError("watchRoom", err);
    }
  );
}

async function startMatchmaking() {
  if (matchmakingBusy) return;
  if (!ensureLandscapeReadyBeforeStart()) return;
  matchmakingBusy = true;
  setMatchLoading(true, "Recherche de joueurs...");
  try {
    const resumed = await resumeSession();
    if (resumed) {
      matchmakingBusy = false;
      return;
    }
    if (resumeDeclined) {
      resumeDeclined = false;
      matchmakingBusy = false;
      setMatchLoading(false);
      return;
    }

    const user = requireUser();
    await ensureXchangeState(user.uid);
    const matchRes = await joinMatchmakingSecure({ stakeDoes: ENTRY_COST_DOES_RESOLVED });
    if (!matchRes || matchRes.ok !== true || !matchRes.roomId) {
      throw new Error("Impossible de rejoindre une partie.");
    }
    refreshDoesHud();
    clearSubs();

    roomId = String(matchRes.roomId || "");
    seatIndex = Number(matchRes.seatIndex || 0);
    if (matchRes.charged === true) {
      writeSettlement(roomId, user.uid, { entryPaid: true, rewardPaid: false });
    }

    if (matchRes.resumed === true) {
      setStatus(`Reconnexion salle (${roomId}). Position ${seatIndex + 1}/4`);
    } else if (matchRes.status === "waiting") {
      setStatus(`Salle rejointe (${roomId}). Position ${seatIndex + 1}/4. Le lancement est automatique dans 15s.`);
    } else {
      setStatus(`Salle prête (${roomId}). Position ${seatIndex + 1}/4`);
    }
    setLeaveRoomButtonVisible(true);

    watchRoom(roomId);
    if (matchRes.status === "waiting") {
      clearTimer();
      startTimer = setTimeout(() => {
        startRoomIfNeeded(roomId).catch((err) => setStatus(err.message || "Erreur démarrage"));
      }, WAIT_MS);
    }
  } catch (err) {
    matchmakingBusy = false;
    setMatchLoading(false);
    throw err;
  }
}

async function maybeAutoStart() {
  if (!SHOULD_AUTOSTART || autostartTried) return;
  if (!auth.currentUser) return;
  autostartTried = true;
  try {
    await startGameFlow();
  } catch (err) {
    autostartTried = false;
    setStatus(err.message || "Erreur démarrage auto");
  }
}

async function resumeSession() {
  // Reprise migrée côté serveur: joinMatchmaking renvoie déjà la salle active si elle existe.
  // On évite ici une lecture directe de collection `rooms` qui peut être refusée
  // par les règles strictes avant que la session soit ré-attachée.
  resumePromise = Promise.resolve(false).finally(() => {
    resumePromise = null;
  });
  return resumePromise;
}

async function leaveRoomById(targetRoomId, user) {
  await leaveRoomSecure({ roomId: targetRoomId });
  clearActionCache(targetRoomId);
}

async function leaveRoom() {
  const user = auth.currentUser;
  if (!user || !roomId) {
    resetSessionState();
    setStatus("Aucune salle active.");
    if (window.UI) window.UI.MostrarEmpezar();
    return;
  }

  const leavingRoomId = roomId;

  try {
    await leaveRoomById(leavingRoomId, user);
  } catch (err) {
    logFirestoreError("leaveRoom", err);
  } finally {
    clearActionCache(leavingRoomId);
    resetSessionState();
    setMatchLoading(false);
    if (window.UI) window.UI.MostrarEmpezar();
    setStatus("Salle quittée.");
  }
}

async function startGameFlow() {
  if (!ensureLandscapeReadyBeforeStart()) return;
  if (!auth.currentUser) {
    await startMatchmaking();
    return;
  }
  await ensureHowToPlayPromptAccepted();
  await startMatchmaking();
}

function setLeaveRoomButtonVisible(visible) {
  const btn = document.getElementById("LeaveRoomTopBtn");
  if (!btn) return;
  if (visible) {
    btn.classList.remove("hidden");
    btn.classList.add("inline-flex");
  } else {
    btn.classList.add("hidden");
    btn.classList.remove("inline-flex");
  }
}

function bindLeaveRoomTopButton() {
  const btn = document.getElementById("LeaveRoomTopBtn");
  if (!btn || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await leaveRoom();
      showReplayReturnOverlay(`Tu as quitté la salle. Ta mise de ${ENTRY_COST_DOES_RESOLVED} Does est perdue.`);
    } finally {
      btn.disabled = false;
    }
  });
}

function bindStartButton() {
  const btn = document.getElementById("BotonEmpezar");
  if (!btn) return;

  const handler = async function (ev) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    try {
      await startGameFlow();
    } catch (err) {
      setStatus(err.message || "Erreur matchmaking");
    }
  };

  btn.onclick = handler;
  btn.addEventListener("click", handler, true);
}

window.LogiqueJeu = {
  startMatchmaking,
  resumeSession,
  pushAction,
  endGameClick,
  onGameEnded,
  leaveRoom,
  hasActiveRoom: () => !!roomId,
  getSession: () => window.GameSession || null,
};

bindStartButton();
bindLeaveRoomTopButton();
bindFullscreenToggle();
startOnlineUsersTicker();
window.addEventListener("resize", onOrientationMaybeChanged);
window.addEventListener("orientationchange", onOrientationMaybeChanged);
window.addEventListener("xchangeUpdated", refreshDoesHud);
window.addEventListener("userBalanceUpdated", refreshDoesHud);
window.addEventListener("storage", refreshDoesHud);
window.addEventListener("beforeunload", () => {
  if (onlineUsersTick) {
    clearInterval(onlineUsersTick);
    onlineUsersTick = null;
  }
  if (fullscreenHintTimer) {
    clearTimeout(fullscreenHintTimer);
    fullscreenHintTimer = null;
  }
});
refreshDoesHud();
updateOrientationGuard();

onAuthStateChanged(auth, (user) => {
  if (!user) {
    resetSessionState();
    resumeDeclined = false;
    pendingStartAfterRotate = false;
    refreshDoesHud();
    updateOrientationGuard();
    return;
  }
  refreshDoesHud();
  updateOrientationGuard();
  resumeSession().then(() => {
    if (resumeDeclined) return;
    maybeAutoStart();
  }).catch((err) => {
    logFirestoreError("onAuthStateChangedResume", err);
  });
});
