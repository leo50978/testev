import { functions as firebaseFunctions, httpsCallable } from "./firebase-init.js";

const CALLABLE_CACHE = new Map();

function getCallable(name) {
  const key = String(name || "").trim();
  if (!key) throw new Error("Callable name is required");
  if (!CALLABLE_CACHE.has(key)) {
    CALLABLE_CACHE.set(key, httpsCallable(firebaseFunctions, key));
  }
  return CALLABLE_CACHE.get(key);
}

function normalizeCallableError(err, fallback = "Erreur serveur") {
  const codeRaw = String(err?.code || "");
  const firebaseCode = codeRaw.startsWith("functions/") ? codeRaw.slice("functions/".length) : codeRaw;
  const details = err?.details && typeof err.details === "object" ? err.details : {};

  const normalized = new Error(String(err?.message || fallback));
  normalized.code = String(details.code || firebaseCode || "unknown");

  Object.keys(details).forEach((k) => {
    normalized[k] = details[k];
  });

  return normalized;
}

async function invokeCallable(name, payload = {}, fallbackError = "Erreur serveur") {
  try {
    const callable = getCallable(name);
    const res = await callable(payload);
    return res?.data || null;
  } catch (err) {
    throw normalizeCallableError(err, fallbackError);
  }
}

export async function walletMutateSecure(payload = {}) {
  return invokeCallable("walletMutate", payload, "Impossible de mettre à jour le wallet.");
}

export async function joinMatchmakingSecure(payload = {}) {
  return invokeCallable("joinMatchmaking", payload, "Impossible de rejoindre une partie.");
}

export async function ensureRoomReadySecure(payload = {}) {
  return invokeCallable("ensureRoomReady", payload, "Impossible de demarrer la partie.");
}

export async function ackRoomStartSeenSecure(payload = {}) {
  return invokeCallable("ackRoomStartSeen", payload, "Impossible de synchroniser le démarrage de la partie.");
}

export async function leaveRoomSecure(payload = {}) {
  return invokeCallable("leaveRoom", payload, "Impossible de quitter la salle.");
}

export async function finalizeGameSecure(payload = {}) {
  return invokeCallable("finalizeGame", payload, "Impossible de finaliser la partie.");
}

export async function confirmGameEndSecure(payload = {}) {
  return invokeCallable("confirmGameEnd", payload, "Impossible de valider la fin de partie.");
}

export async function claimWinRewardSecure(payload = {}) {
  return invokeCallable("claimWinReward", payload, "Impossible de valider le gain.");
}

export async function recordAmbassadorOutcomeSecure(payload = {}) {
  return invokeCallable("recordAmbassadorOutcome", payload, "Impossible de traiter le résultat ambassadeur.");
}

export async function submitActionSecure(payload = {}) {
  return invokeCallable("submitAction", payload, "Impossible d'envoyer l'action.");
}

export async function updateClientProfileSecure(payload = {}) {
  return invokeCallable("updateClientProfileSecure", payload, "Impossible de mettre à jour le profil.");
}

export async function createOrderSecure(payload = {}) {
  return invokeCallable("createOrderSecure", payload, "Impossible de créer la commande.");
}

export async function createWithdrawalSecure(payload = {}) {
  return invokeCallable("createWithdrawalSecure", payload, "Impossible de créer le retrait.");
}

export async function orderClientActionSecure(payload = {}) {
  return invokeCallable("orderClientActionSecure", payload, "Impossible de mettre à jour la demande.");
}

export async function getPublicPaymentOptionsSecure(payload = {}) {
  return invokeCallable("getPublicPaymentOptionsSecure", payload, "Impossible de charger les options de paiement.");
}

export async function getPublicGameStakeOptionsSecure(payload = {}) {
  return invokeCallable("getPublicGameStakeOptionsSecure", payload, "Impossible de charger les mises de partie.");
}

export async function getGlobalAnalyticsSnapshotSecure(payload = {}) {
  return invokeCallable("getGlobalAnalyticsSnapshot", payload, "Impossible de charger les analytics globaux.");
}

export async function markChatSeenSecure(payload = {}) {
  return invokeCallable("markChatSeenSecure", payload, "Impossible de marquer la discussion comme lue.");
}

export async function ensureSupportThreadSecure(payload = {}) {
  return invokeCallable("ensureSupportThreadSecure", payload, "Impossible d'ouvrir le fil de support.");
}

export async function getSupportMessagesSecure(payload = {}) {
  return invokeCallable("getSupportMessagesSecure", payload, "Impossible de charger les messages du support.");
}

export async function createSupportMessageSecure(payload = {}) {
  return invokeCallable("createSupportMessageSecure", payload, "Impossible d'envoyer le message au support.");
}

export async function markSupportThreadSeenSecure(payload = {}) {
  return invokeCallable("markSupportThreadSeenSecure", payload, "Impossible de marquer le support comme lu.");
}

export async function createAmbassadorSecure(payload = {}) {
  return invokeCallable("createAmbassadorSecure", payload, "Impossible de créer le compte ambassadeur.");
}

export async function ambassadorLoginSecure(payload = {}) {
  return invokeCallable("ambassadorLoginSecure", payload, "Impossible de connecter l'ambassadeur.");
}

export async function adminCheckSecure(payload = {}) {
  return invokeCallable("adminCheck", payload, "Accès administrateur refusé.");
}

export async function setBotDifficultySecure(payload = {}) {
  return invokeCallable("setBotDifficulty", payload, "Impossible de changer le niveau des bots.");
}
