import {
  db,
  doc,
  getDoc,
  setDoc,
  runTransaction,
  serverTimestamp,
  collection,
  query,
  where,
  limit,
  getDocs,
} from "./firebase-init.js";
import {
  recordAmbassadorOutcomeSecure,
  createAmbassadorSecure,
  ambassadorLoginSecure,
} from "./secure-functions.js";

const CLIENTS_COLLECTION = "clients";
const AMBASSADORS_COLLECTION = "ambassadors";
const AMBASSADOR_EVENTS_COLLECTION = "ambassadorGameEvents";

const USER_REFERRAL_PREFIX = "USR";
const AMBASSADOR_PROMO_PREFIX = "AMB";
const AMBASSADOR_LINK_PREFIX = "AML";
const AMBASSADOR_FEATURE_ENABLED = false;

export const USER_REFERRAL_DEPOSIT_REWARD = 100;
export const AMBASSADOR_LOSS_BONUS = 50;
export const AMBASSADOR_WIN_PENALTY = 75;

function safeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function safeSignedInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function randomCode(size = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < size; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
}

function isServerTimestampLike(value) {
  return !!value && typeof value === "object" && (typeof value.seconds === "number" || typeof value.toDate === "function");
}

function tsToMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sanitizeAmbassadorRecord(data = {}) {
  const safe = { ...(data || {}) };
  delete safe.authCode;
  delete safe.authCodeHash;
  delete safe.authCodeSalt;
  delete safe.authCodeAlgo;
  return safe;
}

function dedupeCandidates(entries) {
  const seen = new Set();
  const out = [];
  for (const item of entries) {
    const key = `${item?.code || ""}|${item?.hintType || ""}|${item?.via || ""}`;
    if (!item?.code || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function buildHomeBaseUrl() {
  const url = new URL("./inedex.html", window.location.href);
  url.hash = "";
  return url;
}

export function buildUserReferralLink(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return "";
  const url = buildHomeBaseUrl();
  url.searchParams.set("ref", normalized);
  return url.toString();
}

export function buildAmbassadorReferralLink(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return "";
  const url = buildHomeBaseUrl();
  url.searchParams.set("amb", normalized);
  return url.toString();
}

export function getReferralContextFromUrl(search = window.location.search) {
  const params = new URLSearchParams(search || "");
  return {
    userCodeFromLink: normalizeCode(params.get("ref") || params.get("referral") || ""),
    ambassadorCodeFromLink: AMBASSADOR_FEATURE_ENABLED
      ? normalizeCode(params.get("amb") || params.get("ambassador") || "")
      : "",
    promoCodeFromQuery: normalizeCode(params.get("promo") || params.get("code") || ""),
  };
}

async function generateUniqueCode(collectionName, fieldName, prefix, size, currentId = "") {
  for (let i = 0; i < 30; i++) {
    const candidate = `${prefix}${randomCode(size)}`;
    const q = query(collection(db, collectionName), where(fieldName, "==", candidate), limit(1));
    const snap = await getDocs(q);
    if (snap.empty) return candidate;
    const first = snap.docs[0];
    if (first && first.id === currentId) return candidate;
  }
  throw new Error(`Impossible de générer un code unique (${collectionName}.${fieldName}).`);
}

async function findClientByReferralCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const q = query(collection(db, CLIENTS_COLLECTION), where("referralCode", "==", normalized), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const found = snap.docs[0];
  return { id: found.id, ...found.data() };
}

async function findAmbassadorByCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;

  const promoQuery = query(collection(db, AMBASSADORS_COLLECTION), where("promoCode", "==", normalized), limit(1));
  const promoSnap = await getDocs(promoQuery);
  if (!promoSnap.empty) {
    const found = promoSnap.docs[0];
    return { id: found.id, ...sanitizeAmbassadorRecord(found.data() || {}) };
  }

  const linkQuery = query(collection(db, AMBASSADORS_COLLECTION), where("linkCode", "==", normalized), limit(1));
  const linkSnap = await getDocs(linkQuery);
  if (!linkSnap.empty) {
    const found = linkSnap.docs[0];
    return { id: found.id, ...sanitizeAmbassadorRecord(found.data() || {}) };
  }

  return null;
}

async function resolveReferralTarget(candidate, uid, ownReferralCode) {
  if (!candidate?.code) return null;
  const normalized = normalizeCode(candidate.code);
  if (!normalized) return null;
  if (ownReferralCode && normalizeCode(ownReferralCode) === normalized) return null;

  const preferAmbassador = candidate.hintType === "ambassador" || normalized.startsWith(AMBASSADOR_PROMO_PREFIX) || normalized.startsWith(AMBASSADOR_LINK_PREFIX);
  const preferUser = candidate.hintType === "user" || normalized.startsWith(USER_REFERRAL_PREFIX);

  if (preferUser) {
    const user = await findClientByReferralCode(normalized);
    if (user && user.id !== uid) {
      return {
        type: "user",
        id: user.id,
        code: normalized,
        via: candidate.via,
      };
    }
    return null;
  }

  if (preferAmbassador) {
    if (!AMBASSADOR_FEATURE_ENABLED) return null;
    const amb = await findAmbassadorByCode(normalized);
    if (amb) {
      return {
        type: "ambassador",
        id: amb.id,
        code: normalized,
        via: candidate.via,
      };
    }
    return null;
  }

  const fromUser = await findClientByReferralCode(normalized);
  if (fromUser && fromUser.id !== uid) {
    return {
      type: "user",
      id: fromUser.id,
      code: normalized,
      via: candidate.via,
    };
  }

  if (AMBASSADOR_FEATURE_ENABLED) {
    const fromAmb = await findAmbassadorByCode(normalized);
    if (fromAmb) {
      return {
        type: "ambassador",
        id: fromAmb.id,
        code: normalized,
        via: candidate.via,
      };
    }
  }

  return null;
}

export async function ensureClientProfile(user) {
  if (!user?.uid) return null;

  const uid = user.uid;
  const ref = doc(db, CLIENTS_COLLECTION, uid);
  const snap = await getDoc(ref);
  const current = snap.exists() ? (snap.data() || {}) : {};

  const patch = {
    uid,
    email: user.email || current.email || "",
    name: user.displayName || current.name || (user.email ? user.email.split("@")[0] : "Player"),
    updatedAt: serverTimestamp(),
  };

  if (!snap.exists()) {
    patch.createdAt = serverTimestamp();
    patch.doesBalance = safeInt(current.doesBalance);
    patch.exchangedGourdes = safeSignedInt(current.exchangedGourdes);
    patch.referralSignupsTotal = 0;
    patch.referralSignupsViaLink = 0;
    patch.referralSignupsViaCode = 0;
    patch.referralDepositsTotal = 0;
  } else {
    if (typeof current.referralSignupsTotal !== "number") patch.referralSignupsTotal = safeInt(current.referralSignupsTotal);
    if (typeof current.referralSignupsViaLink !== "number") patch.referralSignupsViaLink = safeInt(current.referralSignupsViaLink);
    if (typeof current.referralSignupsViaCode !== "number") patch.referralSignupsViaCode = safeInt(current.referralSignupsViaCode);
    if (typeof current.referralDepositsTotal !== "number") patch.referralDepositsTotal = safeInt(current.referralDepositsTotal);
  }

  let referralCode = normalizeCode(current.referralCode);
  if (!referralCode) {
    referralCode = await generateUniqueCode(CLIENTS_COLLECTION, "referralCode", USER_REFERRAL_PREFIX, 6, uid);
    patch.referralCode = referralCode;
  }

  await setDoc(ref, patch, { merge: true });
  return {
    id: uid,
    ...current,
    ...patch,
    referralCode: patch.referralCode || referralCode,
  };
}

async function applyUserReferralTarget({ uid, target, email }) {
  const clientRef = doc(db, CLIENTS_COLLECTION, uid);
  const referrerRef = doc(db, CLIENTS_COLLECTION, target.id);
  const referrerUserRef = doc(db, CLIENTS_COLLECTION, target.id, "referrals", uid);

  let applied = false;

  await runTransaction(db, async (tx) => {
    const clientSnap = await tx.get(clientRef);
    if (!clientSnap.exists()) return;

    const clientData = clientSnap.data() || {};
    if (clientData.referredByType || clientData.referredByUserId || clientData.referredByAmbassadorId) return;
    if (target.id === uid) return;
    if (normalizeCode(clientData.referralCode) === normalizeCode(target.code)) return;

    const referrerSnap = await tx.get(referrerRef);
    const referrerData = referrerSnap.exists() ? (referrerSnap.data() || {}) : {};

    const viaIsLink = target.via === "link";
    tx.set(clientRef, {
      referredByType: "user",
      referredByUserId: target.id,
      referredByCode: target.code,
      referredVia: viaIsLink ? "link" : "promo",
      referredAt: serverTimestamp(),
      hasApprovedDeposit: clientData.hasApprovedDeposit === true,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    tx.set(referrerRef, {
      referralSignupsTotal: safeInt(referrerData.referralSignupsTotal) + 1,
      referralSignupsViaLink: safeInt(referrerData.referralSignupsViaLink) + (viaIsLink ? 1 : 0),
      referralSignupsViaCode: safeInt(referrerData.referralSignupsViaCode) + (viaIsLink ? 0 : 1),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    tx.set(referrerUserRef, {
      userId: uid,
      email: email || "",
      code: target.code,
      via: viaIsLink ? "link" : "promo",
      hasApprovedDeposit: clientData.hasApprovedDeposit === true,
      depositCount: safeInt(clientData.hasApprovedDeposit === true ? 1 : 0),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    applied = true;
  });

  return applied;
}

async function applyAmbassadorReferralTarget({ uid, target, email }) {
  if (!AMBASSADOR_FEATURE_ENABLED) return false;
  const clientRef = doc(db, CLIENTS_COLLECTION, uid);
  const ambassadorRef = doc(db, AMBASSADORS_COLLECTION, target.id);
  const ambassadorUserRef = doc(db, AMBASSADORS_COLLECTION, target.id, "referrals", uid);

  let applied = false;

  await runTransaction(db, async (tx) => {
    const clientSnap = await tx.get(clientRef);
    if (!clientSnap.exists()) return;

    const clientData = clientSnap.data() || {};
    if (clientData.referredByType || clientData.referredByUserId || clientData.referredByAmbassadorId) return;

    const ambassadorSnap = await tx.get(ambassadorRef);
    if (!ambassadorSnap.exists()) return;
    const ambassadorData = ambassadorSnap.data() || {};

    const viaIsLink = target.via === "link";
    tx.set(clientRef, {
      referredByType: "ambassador",
      referredByAmbassadorId: target.id,
      referredByCode: target.code,
      referredVia: viaIsLink ? "link" : "promo",
      referredAt: serverTimestamp(),
      hasApprovedDeposit: clientData.hasApprovedDeposit === true,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    tx.set(ambassadorRef, {
      totalSignups: safeInt(ambassadorData.totalSignups) + 1,
      totalSignupsViaLink: safeInt(ambassadorData.totalSignupsViaLink) + (viaIsLink ? 1 : 0),
      totalSignupsViaCode: safeInt(ambassadorData.totalSignupsViaCode) + (viaIsLink ? 0 : 1),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    tx.set(ambassadorUserRef, {
      userId: uid,
      email: email || "",
      code: target.code,
      via: viaIsLink ? "link" : "promo",
      hasApprovedDeposit: clientData.hasApprovedDeposit === true,
      depositCount: safeInt(clientData.hasApprovedDeposit === true ? 1 : 0),
      totalGames: 0,
      winCount: 0,
      lossCount: 0,
      ambassadorDoesDelta: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    applied = true;
  });

  return applied;
}

export async function maybeApplyReferralAttribution(user, options = {}) {
  if (!user?.uid) return { applied: false, reason: "no_user" };

  const profile = await ensureClientProfile(user);
  const uid = user.uid;
  const clientRef = doc(db, CLIENTS_COLLECTION, uid);
  const snap = await getDoc(clientRef);
  const current = snap.exists() ? (snap.data() || {}) : {};

  if (current.referredByType || current.referredByUserId || current.referredByAmbassadorId) {
    return { applied: false, reason: "already_set" };
  }

  // The referral should be attached only during account creation.
  const allowExistingAccountAttribution = options.allowExistingAccountAttribution === true;
  if (!allowExistingAccountAttribution) {
    const createdAtMs = user?.metadata?.creationTime ? Date.parse(user.metadata.creationTime) : 0;
    const accountAgeMs = createdAtMs ? (Date.now() - createdAtMs) : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(accountAgeMs) || accountAgeMs > 15 * 60 * 1000) {
      return { applied: false, reason: "account_not_recent", profile };
    }
  }

  const urlCtx = getReferralContextFromUrl(options.locationSearch || window.location.search);
  const promoFromInput = normalizeCode(options.promoCode || "");
  const candidates = dedupeCandidates([
    promoFromInput ? { code: promoFromInput, via: "promo", hintType: null } : null,
    urlCtx.promoCodeFromQuery ? { code: urlCtx.promoCodeFromQuery, via: "promo", hintType: null } : null,
    urlCtx.userCodeFromLink ? { code: urlCtx.userCodeFromLink, via: "link", hintType: "user" } : null,
    (AMBASSADOR_FEATURE_ENABLED && urlCtx.ambassadorCodeFromLink)
      ? { code: urlCtx.ambassadorCodeFromLink, via: "link", hintType: "ambassador" }
      : null,
  ].filter(Boolean));

  if (!candidates.length) {
    return { applied: false, reason: "no_candidate", profile };
  }

  for (const candidate of candidates) {
    const target = await resolveReferralTarget(candidate, uid, profile?.referralCode || current.referralCode || "");
    if (!target) continue;

    if (target.type === "user") {
      const applied = await applyUserReferralTarget({ uid, target, email: user.email || "" });
      if (applied) {
        return {
          applied: true,
          targetType: "user",
          targetId: target.id,
          code: target.code,
          via: target.via,
        };
      }
      continue;
    }

    if (target.type === "ambassador") {
      const applied = await applyAmbassadorReferralTarget({ uid, target, email: user.email || "" });
      if (applied) {
        return {
          applied: true,
          targetType: "ambassador",
          targetId: target.id,
          code: target.code,
          via: target.via,
        };
      }
      continue;
    }
  }

  return { applied: false, reason: "invalid_or_self", profile };
}

export async function bootstrapReferralForAuthUser(user, options = {}) {
  if (!user?.uid) return null;
  await ensureClientProfile(user);
  await maybeApplyReferralAttribution(user, options);
  return getUserReferralSummary(user.uid);
}

export async function getUserReferralSummary(uid) {
  if (!uid) return null;
  const ref = doc(db, CLIENTS_COLLECTION, uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;

  const data = snap.data() || {};
  const referralCode = normalizeCode(data.referralCode || "");
  const referralsSnap = await getDocs(collection(db, CLIENTS_COLLECTION, uid, "referrals"));
  const referrals = referralsSnap.docs.map((d) => d.data() || {});
  const derivedSignupsTotal = referrals.length;
  const derivedDepositsTotal = referrals.reduce((count, item) => {
    const hasDeposit = item?.hasApprovedDeposit === true || safeInt(item?.depositCount) > 0;
    return count + (hasDeposit ? 1 : 0);
  }, 0);

  let referredByLabel = "";
  if (data.referredByType === "user" && data.referredByUserId) {
    try {
      const srcSnap = await getDoc(doc(db, CLIENTS_COLLECTION, data.referredByUserId));
      if (srcSnap.exists()) {
        const srcData = srcSnap.data() || {};
        referredByLabel = srcData.name || srcData.email || data.referredByCode || data.referredByUserId;
      } else {
        referredByLabel = data.referredByCode || data.referredByUserId;
      }
    } catch (_) {
      referredByLabel = data.referredByCode || data.referredByUserId;
    }
  } else if (data.referredByType === "ambassador" && data.referredByAmbassadorId) {
    const ambSnap = await getDoc(doc(db, AMBASSADORS_COLLECTION, data.referredByAmbassadorId));
    if (ambSnap.exists()) {
      const ambData = ambSnap.data() || {};
      referredByLabel = ambData.name || ambData.promoCode || data.referredByAmbassadorId;
    } else {
      referredByLabel = data.referredByCode || data.referredByAmbassadorId;
    }
  }

  return {
    uid,
    referralCode,
    referralLink: buildUserReferralLink(referralCode),
    signupsTotal: Math.max(safeInt(data.referralSignupsTotal), derivedSignupsTotal),
    signupsViaLink: safeInt(data.referralSignupsViaLink),
    signupsViaCode: safeInt(data.referralSignupsViaCode),
    depositsTotal: Math.max(safeInt(data.referralDepositsTotal), derivedDepositsTotal),
    referredByType: data.referredByType || "",
    referredByCode: normalizeCode(data.referredByCode || ""),
    referredVia: data.referredVia || "",
    referredByLabel,
  };
}

export async function createAmbassadorAccount(options = {}) {
  if (!AMBASSADOR_FEATURE_ENABLED) {
    throw new Error("Système ambassadeur désactivé.");
  }
  const name = String(options.name || "").trim();
  const authCode = String(options.authCode || "").trim();
  if (!name) throw new Error("Nom ambassadeur requis.");
  if (authCode.length < 4) throw new Error("Code d'auth au moins 4 caractères.");

  try {
    const response = await createAmbassadorSecure({
      name,
      authCode,
      promoCode: normalizeCode(options.promoCode || ""),
      linkCode: normalizeCode(options.linkCode || ""),
    });
    if (!response?.ok || !response?.account) {
      throw new Error("Réponse serveur invalide.");
    }
    const account = response.account;
    return {
      ...account,
      promoCode: normalizeCode(account.promoCode || ""),
      linkCode: normalizeCode(account.linkCode || ""),
      referralLink: buildAmbassadorReferralLink(account.linkCode || account.promoCode || ""),
    };
  } catch (err) {
    const code = String(err?.code || "");
    if (code === "already-exists") {
      throw new Error("Ce code promo/lien ambassadeur existe déjà.");
    }
    if (code === "permission-denied") {
      throw new Error("Accès admin refusé pour créer cet ambassadeur.");
    }
    if (code === "invalid-argument") {
      throw new Error(err?.message || "Données invalide pour la création ambassadeur.");
    }
    throw err;
  }
}

export async function authenticateAmbassador(options = {}) {
  if (!AMBASSADOR_FEATURE_ENABLED) return { ok: false, reason: "disabled" };
  const code = normalizeCode(options.promoCode || options.code || "");
  const authCode = String(options.authCode || "").trim();
  if (!code || !authCode) return { ok: false, reason: "missing" };

  try {
    const response = await ambassadorLoginSecure({ code, authCode });
    if (!response?.ok || !response?.ambassador?.id) {
      return { ok: false, reason: response?.reason || "invalid_auth" };
    }
    const candidate = response.ambassador;
    return {
      ok: true,
      ambassador: {
        id: candidate.id,
        ...candidate,
        promoCode: normalizeCode(candidate.promoCode || ""),
        linkCode: normalizeCode(candidate.linkCode || ""),
        referralLink: buildAmbassadorReferralLink(candidate.linkCode || candidate.promoCode || ""),
      },
    };
  } catch (err) {
    console.error("[AMBASSADOR] secure login error", err);
    return { ok: false, reason: "server_error" };
  }
}

export async function getAmbassadorDashboardData(ambassadorId) {
  if (!AMBASSADOR_FEATURE_ENABLED) return null;
  if (!ambassadorId) return null;

  const ambRef = doc(db, AMBASSADORS_COLLECTION, ambassadorId);
  const ambSnap = await getDoc(ambRef);
  if (!ambSnap.exists()) return null;
  const ambassador = {
    id: ambSnap.id,
    ...sanitizeAmbassadorRecord(ambSnap.data() || {}),
  };

  const referralsSnap = await getDocs(collection(db, AMBASSADORS_COLLECTION, ambassadorId, "referrals"));
  const referrals = referralsSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .map((item) => {
      const depth = Math.max(1, safeInt(item.depth || 1));
      const totalGamesTracked = safeInt(item.totalGamesTracked || item.totalGames);
      const winsTracked = safeInt(item.winsTracked || item.winCount);
      const lossesTracked = safeInt(item.lossesTracked || item.lossCount);
      return {
        ...item,
        depth,
        totalGamesTracked,
        totalGames: totalGamesTracked,
        winsTracked,
        winCount: winsTracked,
        lossesTracked,
        lossCount: lossesTracked,
        isCommissionEligible: item.isCommissionEligible !== false && depth <= 3,
      };
    })
    .filter((item) => item.depth <= 3)
    .sort((a, b) => {
      const depthDelta = safeInt(a.depth || 1) - safeInt(b.depth || 1);
      if (depthDelta !== 0) return depthDelta;
      return tsToMs(b.createdAt) - tsToMs(a.createdAt);
    });

  return {
    ambassador: {
      ...ambassador,
      referralLink: buildAmbassadorReferralLink(ambassador.linkCode || ambassador.promoCode || ""),
      promoCode: normalizeCode(ambassador.promoCode || ""),
      linkCode: normalizeCode(ambassador.linkCode || ""),
      doesBalance: safeSignedInt(ambassador.doesBalance),
      totalSignups: Math.max(safeInt(ambassador.totalSignups), referrals.length),
      totalDeposits: safeInt(ambassador.totalDeposits),
      totalGames: safeInt(ambassador.totalGames),
      totalInvitedWins: safeInt(ambassador.totalInvitedWins),
      totalInvitedLosses: safeInt(ambassador.totalInvitedLosses),
    },
    referrals: referrals.map((item) => ({
      ...item,
      totalGamesTracked: safeInt(item.totalGamesTracked || item.totalGames),
      totalGames: safeInt(item.totalGamesTracked || item.totalGames),
      winsTracked: safeInt(item.winsTracked || item.winCount),
      winCount: safeInt(item.winsTracked || item.winCount),
      lossesTracked: safeInt(item.lossesTracked || item.lossCount),
      lossCount: safeInt(item.lossesTracked || item.lossCount),
      ambassadorDoesDelta: safeSignedInt(item.ambassadorDoesDelta),
      hasApprovedDeposit: item.hasApprovedDeposit === true,
      depositCount: safeInt(item.depositCount),
    })),
  };
}

export async function applyAmbassadorGameOutcome(options = {}) {
  if (!AMBASSADOR_FEATURE_ENABLED) return { applied: false, reason: "disabled" };
  const uid = options.uid || "";
  const roomId = String(options.roomId || "").trim();
  if (!uid || !roomId) return { applied: false, reason: "missing" };

  try {
    const response = await recordAmbassadorOutcomeSecure({ roomId });
    if (!response || typeof response !== "object") {
      return { applied: false, reason: "no_response" };
    }
    return response;
  } catch (err) {
    console.error("[AMBASSADOR] secure outcome error", err);
    return {
      applied: false,
      reason: err?.code || "server_error",
      error: err?.message || "Erreur Firebase Function",
    };
  }
}

export async function getAmbassadorById(ambassadorId) {
  if (!AMBASSADOR_FEATURE_ENABLED) return null;
  if (!ambassadorId) return null;
  const snap = await getDoc(doc(db, AMBASSADORS_COLLECTION, ambassadorId));
  if (!snap.exists()) return null;
  const data = snap.data() || {};
  return {
    id: snap.id,
    ...sanitizeAmbassadorRecord(data),
    promoCode: normalizeCode(data.promoCode || ""),
    linkCode: normalizeCode(data.linkCode || ""),
    referralLink: buildAmbassadorReferralLink(data.linkCode || data.promoCode || ""),
  };
}

export function formatDateTime(value) {
  const ms = tsToMs(value);
  if (!ms) return "-";
  return new Date(ms).toLocaleString("fr-FR");
}

export function isLikelyNewUser(user) {
  const created = user?.metadata?.creationTime ? Date.parse(user.metadata.creationTime) : 0;
  const last = user?.metadata?.lastSignInTime ? Date.parse(user.metadata.lastSignInTime) : 0;
  if (!created || !last) return false;
  return Math.abs(last - created) < 2000;
}

export function serializeAmbassadorSession(ambassador) {
  if (!ambassador?.id) return "";
  return JSON.stringify({
    id: ambassador.id,
    promoCode: normalizeCode(ambassador.promoCode || ""),
    savedAt: Date.now(),
  });
}

export function parseAmbassadorSession(raw) {
  try {
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.id) return null;
    return {
      id: String(parsed.id),
      promoCode: normalizeCode(parsed.promoCode || ""),
      savedAt: Number(parsed.savedAt || 0),
    };
  } catch (_) {
    return null;
  }
}

export function formatSignedDoes(value) {
  const n = safeSignedInt(value);
  if (n > 0) return `+${n}`;
  return String(n);
}

export function hasApprovedDepositFlag(value) {
  return value === true;
}

export function isTimestampValue(value) {
  return isServerTimestampLike(value);
}
