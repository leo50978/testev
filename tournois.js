import {
  auth,
  functions as firebaseFunctions,
  httpsCallable,
} from "./firebase-init.js";

const POLL_MS = 10 * 1000;

const dom = {
  refreshBtn: document.getElementById("refreshBtn"),
  pageMessage: document.getElementById("pageMessage"),
  signedOutPanel: document.getElementById("signedOutPanel"),
  dashboard: document.getElementById("dashboard"),
  sessionsGrid: document.getElementById("sessionsGrid"),
  sessionLabel: document.getElementById("sessionLabel"),
  timerText: document.getElementById("timerText"),
  sessionStatusWrap: document.getElementById("sessionStatusWrap"),
  sessionStatusText: document.getElementById("sessionStatusText"),
  userWinsHero: document.getElementById("userWinsHero"),
  leaderboardMeta: document.getElementById("leaderboardMeta"),
  leaderboardState: document.getElementById("leaderboardState"),
  leaderTable: document.getElementById("leaderTable"),
  winnerBanner: document.getElementById("winnerBanner"),
  winnerText: document.getElementById("winnerText"),
  replayBtn: document.getElementById("replayBtn"),
  userBadge: document.getElementById("userBadge"),
  userWinsValue: document.getElementById("userWinsValue"),
  userRankValue: document.getElementById("userRankValue"),
  userStatus: document.getElementById("userStatus"),
};

const ensureSessionsFn = httpsCallable(firebaseFunctions, "ensureUserTournamentSessions");
const selectSessionFn = httpsCallable(firebaseFunctions, "selectUserTournament");
const stateFn = httpsCallable(firebaseFunctions, "getUserTournamentState");

let currentUser = null;
let sessions = [];
let currentSessionId = "";
let pollHandle = null;
let refreshBusy = false;

function hashId(uid = "") {
  let hash = 0;
  for (let i = 0; i < uid.length; i += 1) {
    hash = ((hash << 5) - hash) + uid.charCodeAt(i);
    hash |= 0;
  }
  return `ID-${Math.abs(hash).toString(36).slice(0, 6).toUpperCase()}`;
}

function formatTimer(ms) {
  const totalSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSec / 60).toString().padStart(2, "0");
  const seconds = (totalSec % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatDateTime(ms) {
  const value = Number(ms || 0);
  if (!Number.isFinite(value) || value <= 0) return "--";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function safeSessionStatus(session) {
  if (!session) return "active";
  if (String(session.status || "").toLowerCase() === "ended") return "ended";
  if (Number(session.endMs || 0) > 0 && Number(session.endMs) <= Date.now()) return "ended";
  return "active";
}

function setPageMessage(text = "", type = "info") {
  if (!dom.pageMessage) return;
  const content = String(text || "").trim();
  if (!content) {
    dom.pageMessage.hidden = true;
    dom.pageMessage.textContent = "";
    dom.pageMessage.classList.remove("error");
    return;
  }
  dom.pageMessage.hidden = false;
  dom.pageMessage.textContent = content;
  dom.pageMessage.classList.toggle("error", type === "error");
}

function setRefreshBusy(isBusy) {
  refreshBusy = isBusy === true;
  if (!dom.refreshBtn) return;
  dom.refreshBtn.disabled = refreshBusy;
  dom.refreshBtn.textContent = refreshBusy ? "Chargement..." : "Actualiser";
}

function stopPolling() {
  if (pollHandle) {
    window.clearInterval(pollHandle);
    pollHandle = null;
  }
}

function startPolling() {
  stopPolling();
  pollHandle = window.setInterval(() => {
    void loadState({ silent: true });
  }, POLL_MS);
}

function showSignedOutState() {
  stopPolling();
  sessions = [];
  currentSessionId = "";
  if (dom.signedOutPanel) dom.signedOutPanel.hidden = false;
  if (dom.dashboard) dom.dashboard.hidden = true;
  if (dom.sessionLabel) dom.sessionLabel.textContent = "Connexion requise";
  if (dom.timerText) dom.timerText.textContent = "--:--";
  renderStatusPill("Invite", "ended");
  if (dom.userWinsHero) dom.userWinsHero.textContent = "0";
  renderEmptyLeaderboard("Connectez-vous pour charger vos slots de tournoi.");
  updateUserPanel(null, 0, null);
  setPageMessage("");
}

function showDashboardState() {
  if (dom.signedOutPanel) dom.signedOutPanel.hidden = true;
  if (dom.dashboard) dom.dashboard.hidden = false;
}

function normalizeSessions(rawSessions) {
  return (Array.isArray(rawSessions) ? rawSessions : [])
    .map((session) => ({
      sessionId: String(session?.sessionId || "").trim(),
      slotNumber: Number(session?.slotNumber || 0),
      startMs: Number(session?.startMs || 0),
      endMs: Number(session?.endMs || 0),
      status: String(session?.status || "active"),
    }))
    .filter((session) => session.sessionId)
    .sort((left, right) => left.slotNumber - right.slotNumber);
}

function mergeSessionState(sessionState) {
  if (!sessionState?.sessionId) return;
  const sessionId = String(sessionState.sessionId);
  const normalized = {
    sessionId,
    slotNumber: Number(sessionState.slotNumber || 0),
    startMs: Number(sessionState.startMs || 0),
    endMs: Number(sessionState.endMs || 0),
    status: String(sessionState.status || "active"),
  };
  const idx = sessions.findIndex((entry) => entry.sessionId === sessionId);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], ...normalized };
  } else {
    sessions = [...sessions, normalized].sort((left, right) => left.slotNumber - right.slotNumber);
  }
}

function participantLabel(entry, currentUid = currentUser?.uid || "") {
  if (!entry) return "Participant inconnu";
  const rawId = String(entry.id || "").trim();
  if (entry.isUser || rawId === currentUid) {
    const email = currentUser?.email || rawId || "Vous";
    return `Vous • ${email} (${hashId(currentUid || rawId)})`;
  }
  if (entry.isBot) {
    return `${rawId || "BOT"} • bot du tournoi`;
  }
  return rawId || hashId(rawId);
}

function renderStatusPill(label, status = "active") {
  if (!dom.sessionStatusWrap) return;
  dom.sessionStatusWrap.innerHTML = "";
  const pill = document.createElement("span");
  pill.className = `status-pill ${status === "ended" ? "ended" : "active"}`;
  pill.textContent = label;
  dom.sessionStatusWrap.appendChild(pill);
  dom.sessionStatusText = pill;
}

function renderSessions() {
  if (!dom.sessionsGrid) return;
  dom.sessionsGrid.innerHTML = "";

  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Aucun slot actif n'a ete trouve pour ce compte.";
    dom.sessionsGrid.appendChild(empty);
    return;
  }

  sessions.forEach((session) => {
    const isSelected = session.sessionId === currentSessionId;
    const status = safeSessionStatus(session);
    const card = document.createElement("button");
    card.type = "button";
    card.className = `slot-card${isSelected ? " selected" : ""}${status === "ended" ? " ended" : ""}`;

    const top = document.createElement("div");
    top.className = "slot-top";

    const title = document.createElement("div");
    title.className = "slot-title";
    title.textContent = `Slot ${session.slotNumber || "?"}`;

    const badge = document.createElement("span");
    badge.className = `status-pill ${status === "ended" ? "ended" : "active"}`;
    badge.textContent = status === "ended" ? "Termine" : "Actif";

    top.appendChild(title);
    top.appendChild(badge);

    const meta = document.createElement("div");
    meta.className = "slot-meta";
    meta.textContent = status === "ended"
      ? `Termine le ${formatDateTime(session.endMs)}`
      : `Fin prevue le ${formatDateTime(session.endMs)} • ${formatTimer(Math.max(0, session.endMs - Date.now()))}`;

    card.appendChild(top);
    card.appendChild(meta);
    card.addEventListener("click", () => {
      void chooseSession(session.sessionId);
    });
    dom.sessionsGrid.appendChild(card);
  });
}

function renderSummary(session, userWins = 0) {
  const slotNumber = Number(session?.slotNumber || 0);
  const status = safeSessionStatus(session);
  if (dom.sessionLabel) {
    dom.sessionLabel.textContent = slotNumber > 0 ? `Slot ${slotNumber}` : "Session en attente";
  }
  if (dom.timerText) {
    dom.timerText.textContent = status === "ended"
      ? "Termine"
      : formatTimer(Math.max(0, Number(session?.endMs || 0) - Date.now()));
  }
  renderStatusPill(status === "ended" ? "Tournoi termine" : "Tournoi actif", status);
  if (dom.userWinsHero) {
    dom.userWinsHero.textContent = String(userWins);
  }
}

function renderWinner(winnerId = "", leaderboard = []) {
  if (!dom.winnerBanner || !dom.winnerText) return;
  const winner = leaderboard.find((entry) => String(entry.id || "") === String(winnerId || "").trim());
  const winnerLabel = winner ? participantLabel(winner) : (winnerId || "");
  if (!winnerLabel) {
    dom.winnerBanner.hidden = true;
    dom.winnerText.textContent = "";
    return;
  }
  dom.winnerBanner.hidden = false;
  dom.winnerText.textContent = winnerLabel;
}

function renderEmptyLeaderboard(text) {
  if (dom.leaderboardState) {
    dom.leaderboardState.hidden = false;
    dom.leaderboardState.textContent = text;
  }
  if (dom.leaderTable) {
    dom.leaderTable.hidden = true;
    dom.leaderTable.innerHTML = "";
  }
  if (dom.winnerBanner) dom.winnerBanner.hidden = true;
}

function updateUserPanel(rank, userWins, session) {
  const currentUid = currentUser?.uid || "";
  if (dom.userBadge) {
    if (currentUid) {
      dom.userBadge.hidden = false;
      dom.userBadge.textContent = `${currentUser?.email || "Compte"} • ${hashId(currentUid)}`;
    } else {
      dom.userBadge.hidden = true;
      dom.userBadge.textContent = "";
    }
  }

  if (dom.userWinsValue) dom.userWinsValue.textContent = String(userWins || 0);
  if (dom.userRankValue) dom.userRankValue.textContent = rank ? `#${rank}` : "--";

  if (!dom.userStatus) return;
  if (!currentUid) {
    dom.userStatus.textContent = "Connectez-vous puis choisissez un slot pour suivre votre progression.";
    dom.userStatus.classList.remove("error");
    return;
  }

  const status = safeSessionStatus(session);
  if (rank) {
    dom.userStatus.textContent = status === "ended"
      ? `Session terminee. Vous avez fini #${rank} avec ${userWins} victoire(s).`
      : `Vous etes actuellement #${rank} avec ${userWins} victoire(s) sur ce slot.`;
  } else {
    dom.userStatus.textContent = status === "ended"
      ? `Session terminee avec ${userWins} victoire(s).`
      : `Vous avez ${userWins} victoire(s). Continuez a jouer pour grimper dans le classement.`;
  }
}

function renderLeaderboard(entries, userWins, session) {
  const rows = Array.isArray(entries) ? entries : [];
  const sessionStatus = safeSessionStatus(session);

  if (!rows.length) {
    renderEmptyLeaderboard("Le classement de ce slot est vide pour le moment.");
    updateUserPanel(null, userWins, session);
    return;
  }

  if (dom.leaderboardState) dom.leaderboardState.hidden = true;
  if (dom.leaderTable) {
    dom.leaderTable.hidden = false;
    dom.leaderTable.innerHTML = "";
  }

  let myRank = null;
  rows.forEach((entry, index) => {
    const row = document.createElement("article");
    const isMe = entry.isUser || String(entry.id || "") === String(currentUser?.uid || "");
    row.className = `leader-row${isMe ? " me" : ""}${entry.isChampion ? " champion" : ""}`;
    if (isMe) myRank = index + 1;

    const rank = document.createElement("div");
    rank.className = "rank-chip";
    rank.textContent = `#${index + 1}`;

    const name = document.createElement("div");
    name.className = "leader-name";
    const strong = document.createElement("strong");
    strong.textContent = participantLabel(entry);
    const detail = document.createElement("span");
    detail.textContent = entry.isChampion
      ? "Champion favori du slot"
      : (entry.isBot ? "Bot du classement" : "Votre score reel");
    name.appendChild(strong);
    name.appendChild(detail);

    const score = document.createElement("div");
    score.className = "leader-score";
    score.textContent = `${Number(entry.wins || 0)} victoire(s)`;

    row.appendChild(rank);
    row.appendChild(name);
    row.appendChild(score);
    dom.leaderTable?.appendChild(row);
  });

  if (dom.leaderboardMeta) {
    dom.leaderboardMeta.textContent = sessionStatus === "ended"
      ? "Session terminee. Le classement final reste visible ci-dessous."
      : "Le classement se met a jour automatiquement toutes les 10 secondes pendant la session.";
  }

  updateUserPanel(myRank, userWins, session);
}

async function ensureSessions() {
  const response = await ensureSessionsFn({});
  const data = response?.data || {};
  sessions = normalizeSessions(data.sessions);
  currentSessionId = String(data.currentSessionId || currentSessionId || sessions[0]?.sessionId || "").trim();
  renderSessions();
  return currentSessionId;
}

async function chooseSession(sessionId) {
  const nextSessionId = String(sessionId || "").trim();
  if (!nextSessionId) return;
  try {
    await selectSessionFn({ sessionId: nextSessionId });
    currentSessionId = nextSessionId;
    renderSessions();
    await loadState();
    startPolling();
  } catch (error) {
    console.error("[TOURNOIS] select session error", error);
    setPageMessage("Impossible de charger ce slot maintenant. Reessayez.", "error");
  }
}

async function loadState({ silent = false } = {}) {
  if (!currentUser) {
    showSignedOutState();
    return;
  }
  if (!currentSessionId) {
    renderEmptyLeaderboard("Selectionnez un slot pour afficher son classement.");
    renderSummary(null, 0);
    updateUserPanel(null, 0, null);
    return;
  }

  try {
    const response = await stateFn({ sessionId: currentSessionId });
    const data = response?.data || {};
    const session = data.session || {};
    const leaderboard = Array.isArray(data.leaderboard) ? data.leaderboard : [];
    const userWins = Number(data.userWins || 0);

    mergeSessionState(session);
    renderSessions();
    renderSummary(session, userWins);
    renderLeaderboard(leaderboard, userWins, session);
    renderWinner(safeSessionStatus(session) === "ended" ? session.winnerId || leaderboard[0]?.id || "" : "", leaderboard);
    setPageMessage("");
  } catch (error) {
    console.error("[TOURNOIS] load state error", error);
    if (!silent) {
      renderEmptyLeaderboard("Le classement n'a pas pu etre charge pour le moment.");
      setPageMessage("Impossible de recuperer l'etat du tournoi. Verifiez votre connexion puis reessayez.", "error");
    }
  }
}

async function refreshPage() {
  if (refreshBusy) return;
  setRefreshBusy(true);
  try {
    showDashboardState();
    await ensureSessions();
    if (currentSessionId) {
      await loadState();
      startPolling();
    } else {
      renderEmptyLeaderboard("Aucun slot disponible pour le moment.");
      renderSummary(null, 0);
      updateUserPanel(null, 0, null);
    }
  } catch (error) {
    console.error("[TOURNOIS] refresh error", error);
    renderEmptyLeaderboard("Les slots de tournoi n'ont pas pu etre recuperes.");
    setPageMessage("Impossible de charger vos tournois maintenant. Reessayez dans un instant.", "error");
  } finally {
    setRefreshBusy(false);
  }
}

function bindUi() {
  dom.refreshBtn?.addEventListener("click", () => {
    void refreshPage();
  });

  dom.replayBtn?.addEventListener("click", () => {
    void refreshPage();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

function initAuth() {
  auth.onAuthStateChanged((user) => {
    currentUser = user;
    if (!user) {
      showSignedOutState();
      return;
    }
    showDashboardState();
    void refreshPage();
  });
}

function init() {
  bindUi();
  showSignedOutState();
  initAuth();
}

init();
