const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const crypto = require("node:crypto");

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({
  region: "us-central1",
  maxInstances: 10,
});

const ROOMS_COLLECTION = "rooms";
const GAME_STATES_COLLECTION = "gameStates";
const CLIENTS_COLLECTION = "clients";
const AMBASSADORS_COLLECTION = "ambassadors";
const AMBASSADOR_EVENTS_COLLECTION = "ambassadorGameEvents";
const AMBASSADOR_PRIVATE_SUBCOLLECTION = "private";
const AMBASSADOR_SECRETS_DOC = "credentials";
const CHAT_COLLECTION = "globalChannelMessages";
const SUPPORT_THREADS_COLLECTION = "supportThreads";
const SUPPORT_MESSAGES_SUBCOLLECTION = "messages";

const RATE_HTG_TO_DOES = 20;
const DEFAULT_STAKE_REWARD_MULTIPLIER = 3;
const USER_REFERRAL_DEPOSIT_REWARD = 100;
const FINANCE_ADMIN_EMAIL = "leovitch2004@gmail.com";
const MIN_ORDER_HTG = 25;
const MIN_WITHDRAWAL_HTG = 50;
const MAX_WITHDRAWAL_HTG = 500000;
const MAX_PUBLIC_TEXT_LENGTH = 500;
const USER_REFERRAL_PREFIX = "USR";
const AMBASSADOR_LOSS_BONUS = 50;
const AMBASSADOR_WIN_PENALTY = 75;
const AMBASSADOR_PROMO_PREFIX = "AMB";
const AMBASSADOR_LINK_PREFIX = "AML";
const AMBASSADOR_SYSTEM_ENABLED = false;
const AUTH_HASH_ALGO = "scrypt_v1";
const AUTH_HASH_SALT_BYTES = 16;
const AUTH_HASH_KEYLEN = 64;
const AMBASSADOR_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DISCUSSION_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DISCUSSION_PURGE_BATCH_SIZE = 200;
const DISCUSSION_MESSAGES_FETCH_LIMIT = 250;
const DEFAULT_PUBLIC_SETTINGS = Object.freeze({
  verificationHours: 12,
  expiredMessage: "Le délai de vérification est dépassé. Contactez le support.",
});
const DPAYMENT_ADMIN_BOOTSTRAP_DOC = "dpayment_admin_bootstrap";
const APP_PUBLIC_SETTINGS_DOC = "public_app_settings";
const DEFAULT_GAME_STAKE_OPTIONS = Object.freeze([
  Object.freeze({ stakeDoes: 100, enabled: true, sortOrder: 10 }),
  Object.freeze({ stakeDoes: 500, enabled: false, sortOrder: 20 }),
  Object.freeze({ stakeDoes: 1000, enabled: false, sortOrder: 30 }),
  Object.freeze({ stakeDoes: 5000, enabled: false, sortOrder: 40 }),
]);
const DEFAULT_BOT_DIFFICULTY = "expert";
const BOT_DIFFICULTY_LEVELS = new Set(["amateur", "expert", "ultra"]);
const BOT_DIFFICULTY_LOOKAHEAD = Object.freeze({
  amateur: 0,
  expert: 3,
  ultra: 5,
});
const TILE_VALUES = Object.freeze([
  [0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6],
  [1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6],
  [2, 2], [2, 3], [2, 4], [2, 5], [2, 6],
  [3, 3], [3, 4], [3, 5], [3, 6],
  [4, 4], [4, 5], [4, 6],
  [5, 5], [5, 6],
  [6, 6],
]);

function isEmulator() {
  return process.env.FUNCTIONS_EMULATOR === "true";
}

function shouldEnforceAppCheck() {
  return process.env.ENFORCE_APP_CHECK === "true";
}

function logSecurityRejection(callable, request, code, extra = {}) {
  const payload = {
    code: String(code || "unknown"),
    callable: String(callable || "unknown"),
    uid: String(request?.auth?.uid || ""),
    hasAuth: !!request?.auth?.uid,
    hasAppCheck: !!request?.app,
    ...extra,
  };
  console.warn("[SECURITY_REJECT]", JSON.stringify(payload));
}

function assertAppCheck(request, callable) {
  if (!shouldEnforceAppCheck()) return;
  if (isEmulator()) return;
  if (request?.app) return;
  logSecurityRejection(callable, request, "app-check-required");
  throw new HttpsError("failed-precondition", "App Check requis.", {
    code: "app-check-required",
  });
}

function publicOnCall(callableName, handler) {
  return onCall(async (request) => {
    assertAppCheck(request, callableName);
    return handler(request);
  });
}

function safeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function safeSignedInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function sanitizeText(value, maxLength = 160) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeUsername(value, maxLength = 24) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, maxLength);
}

function sanitizeEmail(value, maxLength = 160) {
  const out = sanitizeText(value, maxLength).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out) ? out : "";
}

function sanitizePhone(value, maxLength = 40) {
  const out = sanitizeText(value, maxLength);
  return out.replace(/[^\d+\-\s().]/g, "");
}

function sanitizePublicAsset(value, maxLength = 400) {
  const out = sanitizeText(value, maxLength);
  if (!out) return "";
  if (/^(https:\/\/|\.\/|\/)/i.test(out)) return out;
  return "";
}

function sanitizePaymentMethodAsset(value, maxLength = 180) {
  const out = sanitizeText(value, maxLength);
  if (!out) return "";

  const baseValue = out.replace(/\\/g, "/").split(/[?#]/)[0];
  const fileName = baseValue.split("/").pop() || "";
  if (!/^[a-zA-Z0-9._-]+\.(png|jpe?g|gif|webp|svg)$/i.test(fileName)) {
    return "";
  }
  return fileName;
}

function sanitizeStorageAssetUrl(value, maxLength = 2000) {
  const out = sanitizePublicAsset(value, maxLength);
  if (!out) return "";
  if (
    /^https:\/\/firebasestorage\.googleapis\.com\//i.test(out)
    || /^https:\/\/storage\.googleapis\.com\//i.test(out)
  ) {
    return out;
  }
  return "";
}

function sanitizePlayerLabel(email, fallbackSeat = 0) {
  const local = String(email || "").split("@")[0] || "";
  const cleaned = local.replace(/[^a-z0-9 _.-]/gi, "").trim().slice(0, 24);
  return cleaned || `Joueur ${fallbackSeat + 1}`;
}

function botSeatLabel(seat = 0) {
  return `Bot ${Number(seat) + 1}`;
}

function toMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (value instanceof admin.firestore.Timestamp) return value.toMillis();
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  if (typeof value?.seconds === "number") return value.seconds * 1000;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractClientIp(request) {
  const forwarded = String(
    request?.rawRequest?.headers?.["x-forwarded-for"] ||
    request?.rawRequest?.headers?.["fastly-client-ip"] ||
    request?.rawRequest?.headers?.["cf-connecting-ip"] ||
    request?.rawRequest?.ip ||
    ""
  ).trim();
  if (!forwarded) return "";
  return forwarded.split(",")[0].trim();
}

function hashIpAddress(rawIp = "") {
  const safeIp = String(rawIp || "").trim();
  if (!safeIp) return "";
  return crypto.createHash("sha256").update(`domino-ip:${safeIp}`).digest("hex").slice(0, 32);
}

function sanitizeAnalyticsContext(payload = {}, request = null) {
  const data = payload && typeof payload === "object" ? payload : {};
  return {
    deviceId: sanitizeText(data.deviceId || "", 120),
    appVersion: sanitizeText(data.appVersion || "", 48),
    country: sanitizeText(data.country || "", 48).toUpperCase(),
    browser: sanitizeText(data.browser || "", 120),
    landingPage: sanitizeText(data.landingPage || "", 240),
    utmSource: sanitizeText(data.utmSource || data.utm_source || "", 80),
    utmCampaign: sanitizeText(data.utmCampaign || data.utm_campaign || "", 120),
    creativeId: sanitizeText(data.creativeId || data.creative_id || "", 120),
    ipHash: hashIpAddress(extractClientIp(request)),
  };
}

function toSerializableValue(value) {
  if (value == null) return value;
  if (value instanceof Date) return value.getTime();
  if (value instanceof admin.firestore.Timestamp) return value.toMillis();
  if (Array.isArray(value)) return value.map((item) => toSerializableValue(item));
  if (typeof value === "object") {
    if (typeof value.path === "string" && typeof value.id === "string" && typeof value.parent === "object") {
      return value.path;
    }
    const out = {};
    Object.keys(value).forEach((key) => {
      out[key] = toSerializableValue(value[key]);
    });
    return out;
  }
  return value;
}

function snapshotRecordForCallable(docSnap) {
  return {
    id: docSnap.id,
    path: docSnap.ref.path,
    ...toSerializableValue(docSnap.data() || {}),
  };
}

function subcollectionRecordForCallable(docSnap) {
  const base = snapshotRecordForCallable(docSnap);
  const ownerDoc = docSnap.ref.parent?.parent || null;
  return {
    ...base,
    clientId: String(base.clientId || base.uid || ownerDoc?.id || "").trim(),
  };
}

function referralRecordForCallable(docSnap) {
  const base = snapshotRecordForCallable(docSnap);
  const ownerDoc = docSnap.ref.parent?.parent || null;
  const ownerCollection = String(ownerDoc?.parent?.id || "").trim();
  return {
    ...base,
    ownerId: String(ownerDoc?.id || "").trim(),
    ownerCollection,
  };
}

function supportMessageRecordForCallable(docSnap) {
  const base = snapshotRecordForCallable(docSnap);
  return {
    ...base,
    threadId: String(docSnap.ref.parent?.parent?.id || base.threadId || "").trim(),
  };
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
}

function randomCode(size = 6) {
  let out = "";
  for (let i = 0; i < size; i += 1) {
    out += AMBASSADOR_CODE_CHARS[Math.floor(Math.random() * AMBASSADOR_CODE_CHARS.length)];
  }
  return out;
}

function buildAmbassadorReferralLink(linkCode) {
  const normalized = normalizeCode(linkCode);
  if (!normalized) return "";
  return `./inedex.html?amb=${encodeURIComponent(normalized)}`;
}

function buildUserReferralLink(referralCode) {
  const normalized = normalizeCode(referralCode);
  if (!normalized) return "";
  return `./inedex.html?ref=${encodeURIComponent(normalized)}`;
}

function safeCompareText(a, b) {
  const aBuf = Buffer.from(String(a || ""), "utf8");
  const bBuf = Buffer.from(String(b || ""), "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function hashAuthCode(authCode, saltHex = "") {
  const saltBuffer = saltHex ? Buffer.from(String(saltHex), "hex") : crypto.randomBytes(AUTH_HASH_SALT_BYTES);
  const hashBuffer = crypto.scryptSync(String(authCode || ""), saltBuffer, AUTH_HASH_KEYLEN);
  return {
    algo: AUTH_HASH_ALGO,
    saltHex: saltBuffer.toString("hex"),
    hashHex: hashBuffer.toString("hex"),
  };
}

function verifyAuthCode(authCode, hashHex, saltHex, algo = AUTH_HASH_ALGO) {
  if (String(algo || "") !== AUTH_HASH_ALGO) return false;
  try {
    const calc = crypto.scryptSync(String(authCode || ""), Buffer.from(String(saltHex || ""), "hex"), AUTH_HASH_KEYLEN);
    const expected = Buffer.from(String(hashHex || ""), "hex");
    if (calc.length !== expected.length) return false;
    return crypto.timingSafeEqual(calc, expected);
  } catch (_) {
    return false;
  }
}

function ambassadorSecretsRef(ambassadorRef) {
  return ambassadorRef.collection(AMBASSADOR_PRIVATE_SUBCOLLECTION).doc(AMBASSADOR_SECRETS_DOC);
}

async function readAmbassadorSecrets(ambassadorDoc) {
  const publicData = ambassadorDoc?.data() || {};
  const secretsSnap = await ambassadorSecretsRef(ambassadorDoc.ref).get();
  const secretData = secretsSnap.exists ? (secretsSnap.data() || {}) : {};
  return {
    hasPrivate: secretsSnap.exists,
    hashHex: String(secretData.authCodeHash || publicData.authCodeHash || ""),
    saltHex: String(secretData.authCodeSalt || publicData.authCodeSalt || ""),
    algo: String(secretData.authCodeAlgo || publicData.authCodeAlgo || AUTH_HASH_ALGO),
    legacyPlain: String(publicData.authCode || "").trim(),
    hasPublicSecrets:
      !!String(publicData.authCode || "").trim()
      || (!!String(publicData.authCodeHash || "").trim() && !!String(publicData.authCodeSalt || "").trim()),
  };
}

async function ambassadorCodeExists(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  const [promoSnap, linkSnap] = await Promise.all([
    db.collection(AMBASSADORS_COLLECTION).where("promoCode", "==", normalized).limit(1).get(),
    db.collection(AMBASSADORS_COLLECTION).where("linkCode", "==", normalized).limit(1).get(),
  ]);
  return !promoSnap.empty || !linkSnap.empty;
}

async function clientReferralCodeExists(code, currentUid = "") {
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  const snap = await db.collection(CLIENTS_COLLECTION)
    .where("referralCode", "==", normalized)
    .limit(1)
    .get();
  if (snap.empty) return false;
  const found = snap.docs[0];
  return !found || found.id !== String(currentUid || "");
}

async function generateUniqueClientReferralCode(currentUid = "") {
  for (let i = 0; i < 40; i += 1) {
    const candidate = `${USER_REFERRAL_PREFIX}${randomCode(6)}`;
    if (!(await clientReferralCodeExists(candidate, currentUid))) return candidate;
  }
  throw new HttpsError("aborted", "Impossible de générer un code de parrainage unique.");
}

async function findClientByReferralCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const snap = await db.collection(CLIENTS_COLLECTION)
    .where("referralCode", "==", normalized)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0];
}

async function findAmbassadorByCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const [promoSnap, linkSnap] = await Promise.all([
    db.collection(AMBASSADORS_COLLECTION).where("promoCode", "==", normalized).limit(1).get(),
    db.collection(AMBASSADORS_COLLECTION).where("linkCode", "==", normalized).limit(1).get(),
  ]);
  if (!promoSnap.empty) return promoSnap.docs[0];
  if (!linkSnap.empty) return linkSnap.docs[0];
  return null;
}

function deriveRootAmbassadorContext(sourceData = {}, directAmbassadorId = "") {
  const rootAmbassadorId = String(
    directAmbassadorId ||
    sourceData.rootAmbassadorId ||
    sourceData.referredByAmbassadorId ||
    ""
  ).trim();
  if (!rootAmbassadorId) return null;

  let depth = safeInt(sourceData.ambassadorDepthFromRoot);
  if (!depth && directAmbassadorId) depth = 1;
  if (!depth && String(sourceData.referredByType || "") === "ambassador") depth = 1;
  if (!depth && String(sourceData.referredByAmbassadorId || "").trim() === rootAmbassadorId) depth = 1;
  return {
    rootAmbassadorId,
    depth: Math.max(1, depth || 1),
  };
}

function buildAmbassadorReferralWrite(options = {}) {
  const currentData = options.currentData || {};
  const hasApprovedDeposit = options.hasApprovedDeposit === true;
  const totalGamesTracked = safeInt(currentData.totalGamesTracked || currentData.totalGames);
  const winsTracked = safeInt(currentData.winsTracked || currentData.winCount);
  const lossesTracked = safeInt(currentData.lossesTracked || currentData.lossCount);
  const depositCount = hasApprovedDeposit
    ? Math.max(1, safeInt(currentData.depositCount || 1))
    : safeInt(currentData.depositCount);

  return {
    userId: String(options.userId || "").trim(),
    clientUid: String(options.userId || "").trim(),
    email: sanitizeEmail(options.email || currentData.email || "", 160),
    displayName: sanitizeText(options.displayName || currentData.displayName || options.userId || "Utilisateur", 80),
    code: normalizeCode(options.code || currentData.code || ""),
    via: sanitizeText(options.via || currentData.via || "", 32),
    depth: Math.max(1, safeInt(options.depth || currentData.depth || 1)),
    parentClientUid: String(options.parentClientUid || currentData.parentClientUid || "").trim(),
    rootAmbassadorId: String(options.rootAmbassadorId || currentData.rootAmbassadorId || "").trim(),
    isCommissionEligible: options.isCommissionEligible === true,
    hasApprovedDeposit,
    depositCount,
    totalGamesTracked,
    totalGames: totalGamesTracked,
    winsTracked,
    winCount: winsTracked,
    lossesTracked,
    lossCount: lossesTracked,
    ambassadorDoesDelta: safeSignedInt(currentData.ambassadorDoesDelta),
    lastGameAt: currentData.lastGameAt || null,
    createdAt: currentData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

async function applyUserReferralAttribution(options = {}) {
  const uid = String(options.uid || "").trim();
  const email = sanitizeEmail(options.email || "", 160);
  const promoCode = normalizeCode(options.promoCode || "");
  const via = String(options.via || "").toLowerCase() === "link" ? "link" : "promo";

  if (!uid || !promoCode) {
    return { applied: false, reason: "no_candidate" };
  }

  const referrerSnap = await findClientByReferralCode(promoCode);
  if (!referrerSnap || referrerSnap.id === uid) {
    return { applied: false, reason: "invalid_or_self" };
  }

  const clientRef = walletRef(uid);
  const referrerRef = walletRef(referrerSnap.id);
  const referralRef = referrerRef.collection("referrals").doc(uid);

  return db.runTransaction(async (tx) => {
    const clientSnap = await tx.get(clientRef);
    if (!clientSnap.exists) {
      return { applied: false, reason: "client_not_found" };
    }

    const clientData = clientSnap.data() || {};
    if (clientData.referredByType || clientData.referredByUserId || clientData.referredByAmbassadorId) {
      return { applied: false, reason: "already_set" };
    }
    if (normalizeCode(clientData.referralCode || "") === promoCode) {
      return { applied: false, reason: "invalid_or_self" };
    }

    const latestReferrerSnap = await tx.get(referrerRef);
    if (!latestReferrerSnap.exists || latestReferrerSnap.id === uid) {
      return { applied: false, reason: "invalid_or_self" };
    }

    const referralSnap = await tx.get(referralRef);
    const referrerData = latestReferrerSnap.data() || {};
    const referralData = referralSnap.exists ? (referralSnap.data() || {}) : {};
    const ambassadorContext = AMBASSADOR_SYSTEM_ENABLED ? deriveRootAmbassadorContext(referrerData) : null;
    let ambassadorSnap = null;
    let ambassadorReferralSnap = null;
    let ambassadorRef = null;
    let ambassadorReferralRef = null;
    let ambassadorDepth = 0;
    let ambassadorEligible = false;
    let ambassadorData = {};
    let ambassadorReferralData = {};

    if (ambassadorContext?.rootAmbassadorId) {
      ambassadorDepth = Math.max(1, safeInt(ambassadorContext.depth) + 1);
      ambassadorEligible = ambassadorDepth <= 3;
      ambassadorRef = db.collection(AMBASSADORS_COLLECTION).doc(ambassadorContext.rootAmbassadorId);
      ambassadorReferralRef = ambassadorRef.collection("referrals").doc(uid);
      ambassadorSnap = await tx.get(ambassadorRef);
      ambassadorData = ambassadorSnap.exists ? (ambassadorSnap.data() || {}) : {};
      if (ambassadorEligible && ambassadorSnap.exists) {
        ambassadorReferralSnap = await tx.get(ambassadorReferralRef);
        ambassadorReferralData = ambassadorReferralSnap.exists ? (ambassadorReferralSnap.data() || {}) : {};
      }
    }

    const clientPatch = {
      referredByType: "user",
      referredByUserId: latestReferrerSnap.id,
      referredByCode: promoCode,
      referredVia: via,
      referredAt: admin.firestore.FieldValue.serverTimestamp(),
      invitedByType: "user",
      invitedByUserId: latestReferrerSnap.id,
      hasApprovedDeposit: clientData.hasApprovedDeposit === true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (ambassadorContext?.rootAmbassadorId && ambassadorSnap?.exists) {
      clientPatch.rootAmbassadorId = ambassadorContext.rootAmbassadorId;
      clientPatch.ambassadorDepthFromRoot = ambassadorDepth;
      clientPatch.ambassadorCommissionEligible = ambassadorEligible;
    }

    tx.set(clientRef, clientPatch, { merge: true });

    tx.set(referrerRef, {
      referralSignupsTotal: safeInt(referrerData.referralSignupsTotal) + 1,
      referralSignupsViaLink: safeInt(referrerData.referralSignupsViaLink) + (via === "link" ? 1 : 0),
      referralSignupsViaCode: safeInt(referrerData.referralSignupsViaCode) + (via === "link" ? 0 : 1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    tx.set(referralRef, {
      userId: uid,
      email: email || sanitizeEmail(referralData.email || "", 160),
      displayName: sanitizeText(clientData.name || String(email || "").split("@")[0] || referralData.displayName || "Utilisateur", 80),
      code: promoCode,
      via,
      hasApprovedDeposit: clientData.hasApprovedDeposit === true,
      depositCount: safeInt(clientData.hasApprovedDeposit === true ? 1 : referralData.depositCount),
      createdAt: referralData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    if (ambassadorContext?.rootAmbassadorId && ambassadorEligible && ambassadorSnap?.exists) {
      tx.set(ambassadorRef, {
        totalSignups: safeInt(ambassadorData.totalSignups) + 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      tx.set(ambassadorReferralRef, buildAmbassadorReferralWrite({
        userId: uid,
        email,
        displayName: clientData.name || String(email || "").split("@")[0] || "Utilisateur",
        code: promoCode,
        via,
        depth: ambassadorDepth,
        parentClientUid: latestReferrerSnap.id,
        rootAmbassadorId: ambassadorContext.rootAmbassadorId,
        isCommissionEligible: true,
        hasApprovedDeposit: clientData.hasApprovedDeposit === true,
        currentData: ambassadorReferralData,
      }), { merge: true });
    }

    return {
      applied: true,
      targetType: "user",
      targetId: latestReferrerSnap.id,
      code: promoCode,
      via,
    };
  });
}

async function applyAmbassadorReferralAttribution(options = {}) {
  if (!AMBASSADOR_SYSTEM_ENABLED) {
    return { applied: false, reason: "ambassador_disabled" };
  }
  const uid = String(options.uid || "").trim();
  const email = sanitizeEmail(options.email || "", 160);
  const promoCode = normalizeCode(options.promoCode || "");
  const via = String(options.via || "").toLowerCase() === "link" ? "link" : "promo";

  if (!uid || !promoCode) {
    return { applied: false, reason: "no_candidate" };
  }

  const ambassadorSnap = await findAmbassadorByCode(promoCode);
  if (!ambassadorSnap) {
    return { applied: false, reason: "invalid_or_self" };
  }

  const clientRef = walletRef(uid);
  const ambassadorRef = db.collection(AMBASSADORS_COLLECTION).doc(ambassadorSnap.id);
  const ambassadorReferralRef = ambassadorRef.collection("referrals").doc(uid);

  return db.runTransaction(async (tx) => {
    const clientSnap = await tx.get(clientRef);
    if (!clientSnap.exists) {
      return { applied: false, reason: "client_not_found" };
    }

    const clientData = clientSnap.data() || {};
    if (clientData.referredByType || clientData.referredByUserId || clientData.referredByAmbassadorId) {
      return { applied: false, reason: "already_set" };
    }

    const latestAmbassadorSnap = await tx.get(ambassadorRef);
    if (!latestAmbassadorSnap.exists) {
      return { applied: false, reason: "invalid_or_self" };
    }

    const ambassadorData = latestAmbassadorSnap.data() || {};
    const ambassadorReferralSnap = await tx.get(ambassadorReferralRef);
    const ambassadorReferralData = ambassadorReferralSnap.exists ? (ambassadorReferralSnap.data() || {}) : {};

    tx.set(clientRef, {
      referredByType: "ambassador",
      referredByAmbassadorId: latestAmbassadorSnap.id,
      referredByCode: promoCode,
      referredVia: via,
      referredAt: admin.firestore.FieldValue.serverTimestamp(),
      invitedByType: "ambassador",
      invitedByUserId: "",
      rootAmbassadorId: latestAmbassadorSnap.id,
      ambassadorDepthFromRoot: 1,
      ambassadorCommissionEligible: true,
      hasApprovedDeposit: clientData.hasApprovedDeposit === true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    tx.set(ambassadorRef, {
      totalSignups: safeInt(ambassadorData.totalSignups) + 1,
      totalSignupsViaLink: safeInt(ambassadorData.totalSignupsViaLink) + (via === "link" ? 1 : 0),
      totalSignupsViaCode: safeInt(ambassadorData.totalSignupsViaCode) + (via === "link" ? 0 : 1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    tx.set(ambassadorReferralRef, buildAmbassadorReferralWrite({
      userId: uid,
      email,
      displayName: clientData.name || String(email || "").split("@")[0] || "Utilisateur",
      code: promoCode,
      via,
      depth: 1,
      parentClientUid: "",
      rootAmbassadorId: latestAmbassadorSnap.id,
      isCommissionEligible: true,
      hasApprovedDeposit: clientData.hasApprovedDeposit === true,
      currentData: ambassadorReferralData,
    }), { merge: true });

    return {
      applied: true,
      targetType: "ambassador",
      targetId: latestAmbassadorSnap.id,
      code: promoCode,
      via,
    };
  });
}

async function applyPromoAttribution(options = {}) {
  const promoCode = normalizeCode(options.promoCode || "");
  if (!promoCode) {
    return { applied: false, reason: "no_candidate" };
  }

  if (promoCode.startsWith(USER_REFERRAL_PREFIX)) {
    return applyUserReferralAttribution(options);
  }
  if (promoCode.startsWith(AMBASSADOR_PROMO_PREFIX) || promoCode.startsWith(AMBASSADOR_LINK_PREFIX)) {
    if (!AMBASSADOR_SYSTEM_ENABLED) {
      return { applied: false, reason: "ambassador_disabled" };
    }
    return applyAmbassadorReferralAttribution(options);
  }

  const userAttempt = await applyUserReferralAttribution(options);
  if (userAttempt.applied) return userAttempt;

  if (!AMBASSADOR_SYSTEM_ENABLED) {
    return userAttempt;
  }

  const ambassadorAttempt = await applyAmbassadorReferralAttribution(options);
  if (ambassadorAttempt.applied) return ambassadorAttempt;

  return userAttempt.reason === "already_set" ? userAttempt : ambassadorAttempt;
}

async function generateUniqueAmbassadorCode(prefix, size) {
  for (let i = 0; i < 40; i += 1) {
    const candidate = `${prefix}${randomCode(size)}`;
    if (!(await ambassadorCodeExists(candidate))) return candidate;
  }
  throw new HttpsError("aborted", "Impossible de générer un code unique.");
}

function assertAuth(request) {
  const uid = String(request.auth?.uid || "").trim();
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentification requise.");
  }
  const email = String(request.auth?.token?.email || "").trim();
  return { uid, email };
}

function hasFinanceAdminClaim(request) {
  return request?.auth?.token?.admin === true
    || request?.auth?.token?.financeAdmin === true;
}

function hasFinanceAdminEmail(request) {
  const email = String(request?.auth?.token?.email || "").trim().toLowerCase();
  return !!email && email === FINANCE_ADMIN_EMAIL;
}

function assertFinanceAdmin(request) {
  const authData = assertAuth(request);
  if (!hasFinanceAdminClaim(request) && !hasFinanceAdminEmail(request)) {
    throw new HttpsError("permission-denied", "Accès administrateur requis.");
  }
  return authData;
}

function normalizeBotDifficulty(value) {
  const level = sanitizeText(value || "", 20).toLowerCase();
  return BOT_DIFFICULTY_LEVELS.has(level) ? level : DEFAULT_BOT_DIFFICULTY;
}

function assertAdmin(request) {
  const authData = assertAuth(request);
  if (request.auth?.token?.admin !== true) {
    throw new HttpsError("permission-denied", "Accès administrateur requis.");
  }
  return authData;
}

function walletRef(uid) {
  return db.collection(CLIENTS_COLLECTION).doc(uid);
}

function walletHistoryRef(uid) {
  return db.collection(CLIENTS_COLLECTION).doc(uid).collection("xchanges");
}

function adminBootstrapRef() {
  return db.collection("settings").doc(DPAYMENT_ADMIN_BOOTSTRAP_DOC);
}

function appPublicSettingsRef() {
  return db.collection("settings").doc(APP_PUBLIC_SETTINGS_DOC);
}

function buildStakeRewardDoes(stakeDoes) {
  return safeInt(stakeDoes) * DEFAULT_STAKE_REWARD_MULTIPLIER;
}

function buildStakeOptionId(stakeDoes) {
  return `stake_${safeInt(stakeDoes)}`;
}

function normalizeGameStakeOptions(rawOptions) {
  const source = Array.isArray(rawOptions) && rawOptions.length ? rawOptions : DEFAULT_GAME_STAKE_OPTIONS;
  const byStake = new Map();

  source.forEach((raw, index) => {
    const stakeDoes = safeInt(raw?.stakeDoes);
    if (stakeDoes <= 0) return;
    if (byStake.has(stakeDoes)) return;

    const sortOrderRaw = Number(raw?.sortOrder);
    const sortOrder = Number.isFinite(sortOrderRaw) ? Math.trunc(sortOrderRaw) : ((index + 1) * 10);

    byStake.set(stakeDoes, {
      id: buildStakeOptionId(stakeDoes),
      stakeDoes,
      rewardDoes: buildStakeRewardDoes(stakeDoes),
      enabled: raw?.enabled !== false,
      sortOrder,
    });
  });

  const normalized = Array.from(byStake.values())
    .sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
      return left.stakeDoes - right.stakeDoes;
    });

  if (normalized.length) return normalized;
  return DEFAULT_GAME_STAKE_OPTIONS.map((item) => ({
    id: buildStakeOptionId(item.stakeDoes),
    stakeDoes: item.stakeDoes,
    rewardDoes: buildStakeRewardDoes(item.stakeDoes),
    enabled: item.enabled !== false,
    sortOrder: item.sortOrder,
  }));
}

function findStakeConfigByAmount(stakeDoes, gameStakeOptions, requireEnabled = false) {
  const normalizedStake = safeInt(stakeDoes);
  if (normalizedStake <= 0) return null;
  const options = Array.isArray(gameStakeOptions) ? gameStakeOptions : normalizeGameStakeOptions();
  const found = options.find((item) => safeInt(item?.stakeDoes) === normalizedStake) || null;
  if (!found) return null;
  if (requireEnabled && found.enabled !== true) return null;
  return found;
}

function resolveRoomRewardDoes(room = {}) {
  const explicit = safeInt(room.rewardAmountDoes);
  if (explicit > 0) return explicit;
  return buildStakeRewardDoes(room.entryCostDoes || room.stakeDoes || 0);
}

function normalizePublicAppSettings(rawData = {}) {
  return {
    verificationHours: Math.max(1, Math.min(72, safeInt(rawData.verificationHours || DEFAULT_PUBLIC_SETTINGS.verificationHours))),
    expiredMessage: sanitizeText(rawData.expiredMessage || DEFAULT_PUBLIC_SETTINGS.expiredMessage, MAX_PUBLIC_TEXT_LENGTH),
    gameStakeOptions: normalizeGameStakeOptions(rawData.gameStakeOptions),
    appCheckSiteKey: sanitizeText(rawData.appCheckSiteKey || "", 256),
  };
}

async function readRawPublicAppSettings() {
  const directSnap = await appPublicSettingsRef().get();
  if (directSnap.exists) {
    return directSnap.data() || {};
  }

  const fallbackSnap = await db.collection("settings").get();
  if (fallbackSnap.empty) return {};

  const legacy = fallbackSnap.docs.find((docSnap) => {
    return docSnap.id !== DPAYMENT_ADMIN_BOOTSTRAP_DOC && docSnap.id !== APP_PUBLIC_SETTINGS_DOC;
  });

  return legacy ? (legacy.data() || {}) : {};
}

async function getConfiguredBotDifficulty() {
  try {
    const snap = await adminBootstrapRef().get();
    if (!snap.exists) return DEFAULT_BOT_DIFFICULTY;
    return normalizeBotDifficulty(snap.data()?.botDifficulty);
  } catch (_) {
    return DEFAULT_BOT_DIFFICULTY;
  }
}

function makeDeckOrder() {
  const arr = Array.from({ length: 28 }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

function normalizePrivateDeckOrder(raw) {
  if (!Array.isArray(raw) || raw.length !== 28) return [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const tileId = Number(raw[i]);
    if (!Number.isFinite(tileId) || tileId < 0 || tileId >= 28 || seen.has(tileId)) {
      return [];
    }
    seen.add(tileId);
    out.push(Math.trunc(tileId));
  }
  return out;
}

async function readPrivateDeckOrderForRoom(roomId) {
  const safeRoomId = String(roomId || "").trim();
  if (!safeRoomId) return [];
  const snap = await gameStateRef(safeRoomId).get();
  if (!snap.exists) return [];
  return normalizePrivateDeckOrder(snap.data()?.deckOrder);
}

function starterSeatFromDeckOrder(deckOrder) {
  if (!Array.isArray(deckOrder) || deckOrder.length !== 28) {
    return Math.floor(Math.random() * 4);
  }
  const tile = Number(deckOrder[0]);
  if (!Number.isFinite(tile)) return Math.floor(Math.random() * 4);
  return Math.abs(tile) % 4;
}

function buildPlayRequiredError(payload = {}) {
  return new HttpsError(
    "failed-precondition",
    "Tu dois jouer les Does avant de les reconvertir en HTG.",
    {
      code: "play-required-before-sell",
      pendingPlayFromXchangeDoes: safeInt(payload.pendingPlayFromXchangeDoes),
      pendingPlayFromReferralDoes: safeInt(payload.pendingPlayFromReferralDoes),
      pendingPlayTotalDoes: safeInt(payload.pendingPlayTotalDoes),
    }
  );
}

function roomRef(roomId) {
  return db.collection(ROOMS_COLLECTION).doc(String(roomId || "").trim());
}

function gameStateRef(roomId) {
  return db.collection(GAME_STATES_COLLECTION).doc(String(roomId || "").trim());
}

function getTileValues(tileId) {
  const idx = safeInt(tileId);
  const values = TILE_VALUES[idx];
  return Array.isArray(values) ? values : null;
}

function buildSeatHands(deckOrder) {
  if (!Array.isArray(deckOrder) || deckOrder.length !== 28) return null;
  const seatHands = [];
  for (let seat = 0; seat < 4; seat += 1) {
    const hand = [];
    for (let slot = 0; slot < 7; slot += 1) {
      const tileId = Number(deckOrder[(seat * 7) + slot]);
      if (!Number.isFinite(tileId) || !TILE_VALUES[tileId]) return null;
      hand.push(tileId);
    }
    seatHands.push(hand);
  }
  return seatHands;
}

function cloneSeatHands(seatHands) {
  return Array.isArray(seatHands)
    ? seatHands.map((hand) => (Array.isArray(hand) ? hand.slice(0, 7) : Array(7).fill(null)))
    : Array.from({ length: 4 }, () => Array(7).fill(null));
}

function serializeSeatHands(seatHands) {
  const normalized = cloneSeatHands(seatHands);
  const out = {};
  for (let seat = 0; seat < 4; seat += 1) {
    out[String(seat)] = Array.isArray(normalized[seat]) ? normalized[seat].slice(0, 7) : Array(7).fill(null);
  }
  return out;
}

function normalizeSeatHands(raw, fallbackDeckOrder = []) {
  const fallback = buildSeatHands(fallbackDeckOrder) || Array.from({ length: 4 }, () => Array(7).fill(null));
  let source = null;

  if (Array.isArray(raw) && raw.length === 4) {
    source = raw;
  } else if (raw && typeof raw === "object") {
    source = Array.from({ length: 4 }, (_, seat) => raw[String(seat)] ?? raw[seat] ?? null);
  }

  if (!Array.isArray(source) || source.length !== 4) return fallback;

  return source.map((hand, seat) => {
    const base = Array.isArray(fallback[seat]) ? fallback[seat] : Array(7).fill(null);
    if (!Array.isArray(hand) || hand.length !== 7) return base.slice();
    return hand.map((tileId, slot) => {
      if (tileId === null) return null;
      const parsed = Number(tileId);
      return Number.isFinite(parsed) && TILE_VALUES[parsed] ? parsed : base[slot];
    });
  });
}

function getHumanSeatSet(room = {}) {
  return new Set(
    Object.values(getRoomSeats(room))
      .map((seat) => Number(seat))
      .filter((seat) => Number.isFinite(seat) && seat >= 0 && seat < 4)
  );
}

function getBlockedRejoinSet(room = {}) {
  return new Set(
    Array.isArray(room.blockedRejoinUids)
      ? room.blockedRejoinUids.map((uid) => String(uid || "").trim()).filter(Boolean)
      : []
  );
}

function isSeatHuman(room = {}, seat) {
  return getHumanSeatSet(room).has(Number(seat));
}

function findSeatWithTile(seatHands, tileId) {
  for (let seat = 0; seat < 4; seat += 1) {
    const hand = Array.isArray(seatHands?.[seat]) ? seatHands[seat] : [];
    for (let slot = 0; slot < 7; slot += 1) {
      if (hand[slot] === tileId) return seat;
    }
  }
  return -1;
}

function findSeatSlotByTileId(seatHands, seat, tileId) {
  const hand = Array.isArray(seatHands?.[seat]) ? seatHands[seat] : [];
  for (let slot = 0; slot < hand.length; slot += 1) {
    if (hand[slot] === tileId) return slot;
  }
  return -1;
}

function countRemainingTilesForSeat(seatHands, seat) {
  const hand = Array.isArray(seatHands?.[seat]) ? seatHands[seat] : [];
  return hand.reduce((count, tileId) => count + (tileId === null ? 0 : 1), 0);
}

function sumSeatPips(seatHands, seat) {
  const hand = Array.isArray(seatHands?.[seat]) ? seatHands[seat] : [];
  return hand.reduce((sum, tileId) => {
    if (tileId === null) return sum;
    const values = getTileValues(tileId);
    return values ? sum + values[0] + values[1] : sum;
  }, 0);
}

function computeBlockedWinnerSeat(seatHands) {
  let bestSeat = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let seat = 0; seat < 4; seat += 1) {
    const score = sumSeatPips(seatHands, seat);
    if (score < bestScore) {
      bestScore = score;
      bestSeat = seat;
    }
  }
  return bestSeat;
}

function getWinnerUidForSeat(room, winnerSeat) {
  if (typeof winnerSeat !== "number" || winnerSeat < 0) return "";
  const seats = getRoomSeats(room);
  for (const [uid, seat] of Object.entries(seats)) {
    if (seat === winnerSeat) return uid;
  }
  return "";
}

function normalizeLegacyBranch(value, isOpeningMove = false) {
  const raw = String(value || "").trim().toLowerCase();
  if (isOpeningMove) return "centro";
  if (raw === "izquierda" || raw === "left") return "izquierda";
  if (raw === "derecha" || raw === "right") return "derecha";
  return "";
}

function normalizeRequestedSide(value, branch, isOpeningMove = false) {
  if (isOpeningMove) return "center";
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "left" || raw === "izquierda") return "left";
  if (raw === "right" || raw === "derecha") return "right";
  const legacy = normalizeLegacyBranch(branch, false);
  if (legacy === "izquierda") return "left";
  if (legacy === "derecha") return "right";
  return "";
}

function getLegalMovesForSeat(state, seat) {
  const moves = [];
  const hand = Array.isArray(state?.seatHands?.[seat]) ? state.seatHands[seat] : [];
  const openingMove = safeSignedInt(state?.appliedActionSeq) < 0;

  for (let slot = 0; slot < hand.length; slot += 1) {
    const tileId = hand[slot];
    if (tileId === null) continue;
    const values = getTileValues(tileId);
    if (!values) continue;

    if (openingMove) {
      if (tileId === 27) {
        moves.push({
          tileId,
          slot,
          side: "center",
          branch: "centro",
          tileLeft: values[0],
          tileRight: values[1],
        });
      }
      continue;
    }

    if (values[0] === state.leftEnd || values[1] === state.leftEnd) {
      moves.push({
        tileId,
        slot,
        side: "left",
        branch: "izquierda",
        tileLeft: values[0],
        tileRight: values[1],
      });
    }
    if (values[0] === state.rightEnd || values[1] === state.rightEnd) {
      moves.push({
        tileId,
        slot,
        side: "right",
        branch: "derecha",
        tileLeft: values[0],
        tileRight: values[1],
      });
    }
  }

  moves.sort((a, b) => {
    const aValues = getTileValues(a.tileId) || [0, 0];
    const bValues = getTileValues(b.tileId) || [0, 0];
    return (bValues[0] + bValues[1]) - (aValues[0] + aValues[1]);
  });
  return moves;
}

function normalizeGameState(raw = {}, room = {}) {
  const deckOrder = Array.isArray(raw.deckOrder) && raw.deckOrder.length === 28
    ? raw.deckOrder.slice(0, 28)
    : (Array.isArray(room.deckOrder) ? room.deckOrder.slice(0, 28) : makeDeckOrder());
  const seatHands = normalizeSeatHands(raw.seatHands, deckOrder);
  const appliedActionSeq = Number.isFinite(Number(raw.appliedActionSeq)) ? Math.trunc(Number(raw.appliedActionSeq)) : -1;
  const winnerSeat = Number.isFinite(Number(raw.winnerSeat)) ? Math.trunc(Number(raw.winnerSeat)) : -1;
  const currentPlayer = Number.isFinite(Number(raw.currentPlayer))
    ? Math.trunc(Number(raw.currentPlayer))
    : Math.max(0, findSeatWithTile(seatHands, 27));

  return {
    deckOrder,
    seatHands,
    leftEnd: Number.isFinite(Number(raw.leftEnd)) ? Math.trunc(Number(raw.leftEnd)) : null,
    rightEnd: Number.isFinite(Number(raw.rightEnd)) ? Math.trunc(Number(raw.rightEnd)) : null,
    passesInRow: safeInt(raw.passesInRow),
    appliedActionSeq,
    currentPlayer,
    winnerSeat,
    winnerUid: String(raw.winnerUid || "").trim(),
    endedReason: sanitizeText(raw.endedReason || "", 40),
    idempotencyKeys: raw.idempotencyKeys && typeof raw.idempotencyKeys === "object" ? { ...raw.idempotencyKeys } : {},
  };
}

function trimIdempotencyKeys(keys = {}, maxEntries = 200) {
  const entries = Object.entries(keys).slice(-maxEntries);
  return Object.fromEntries(entries);
}

function createInitialGameState(room = {}, deckOrder = []) {
  const cleanDeckOrder = Array.isArray(deckOrder) && deckOrder.length === 28 ? deckOrder.slice(0, 28) : makeDeckOrder();
  const seatHands = buildSeatHands(cleanDeckOrder) || Array.from({ length: 4 }, () => Array(7).fill(null));
  const currentPlayer = Math.max(0, findSeatWithTile(seatHands, 27));
  return {
    deckOrder: cleanDeckOrder,
    seatHands,
    leftEnd: null,
    rightEnd: null,
    passesInRow: 0,
    appliedActionSeq: -1,
    currentPlayer,
    winnerSeat: -1,
    winnerUid: "",
    endedReason: "",
    idempotencyKeys: {},
  };
}

function sanitizePublicStep(step = {}) {
  const safeFields = Array.isArray(step.fields)
    ? step.fields.slice(0, 8).map((field) => ({
        type: sanitizeText(field?.type || "text", 20),
        name: sanitizeText(field?.name || "", 40),
        label: sanitizeText(field?.label || "", 80),
        required: field?.required === true,
        options: Array.isArray(field?.options)
          ? field.options.slice(0, 12).map((opt) => sanitizeText(opt, 80)).filter(Boolean)
          : [],
      }))
    : [];

  return {
    type: sanitizeText(step.type || "custom", 20),
    title: sanitizeText(step.title || "", 120),
    content: sanitizeText(step.content || "", MAX_PUBLIC_TEXT_LENGTH),
    buttonText: sanitizeText(step.buttonText || "", 40),
    description: sanitizeText(step.description || "", MAX_PUBLIC_TEXT_LENGTH),
    instruction: sanitizeText(step.instruction || "", MAX_PUBLIC_TEXT_LENGTH),
    message: sanitizeText(step.message || "", MAX_PUBLIC_TEXT_LENGTH),
    fields: safeFields,
  };
}

function sanitizePublicMethod(docSnap) {
  const data = docSnap.data() || {};
  if (data.isActive === false) return null;
  return {
    id: docSnap.id,
    name: sanitizeText(data.name || "Methode", 80),
    instructions: sanitizeText(data.instructions || "", MAX_PUBLIC_TEXT_LENGTH),
    image: sanitizePaymentMethodAsset(data.image || ""),
    qrCode: sanitizePaymentMethodAsset(data.qrCode || ""),
    accountName: sanitizeText(data.accountName || "", 120),
    phoneNumber: sanitizePhone(data.phoneNumber || ""),
    isActive: true,
    steps: Array.isArray(data.steps) ? data.steps.slice(0, 8).map((step) => sanitizePublicStep(step)) : [],
  };
}

function resolveRequestedMove(state, seat, rawAction = {}) {
  const type = String(rawAction?.type || "").trim();
  if (type !== "play" && type !== "pass") {
    throw new HttpsError("invalid-argument", "Type d'action invalide.");
  }

  if (type === "pass") {
    const legalMoves = getLegalMovesForSeat(state, seat);
    if (legalMoves.length > 0) {
      throw new HttpsError("failed-precondition", "Pass interdit tant qu'un coup légal existe.");
    }
    return {
      type: "pass",
      player: seat,
      tileId: null,
      tilePos: null,
      tileLeft: null,
      tileRight: null,
      side: null,
      branch: "",
      slot: -1,
    };
  }

  const hand = Array.isArray(state?.seatHands?.[seat]) ? state.seatHands[seat] : [];
  const legalMoves = getLegalMovesForSeat(state, seat);
  let tileId = Number(rawAction?.tileId);
  let slot = Number.isFinite(tileId) ? findSeatSlotByTileId(state.seatHands, seat, Math.trunc(tileId)) : -1;
  tileId = Number.isFinite(tileId) ? Math.trunc(tileId) : -1;

  const tilePosRaw = Number(rawAction?.tilePos);
  if ((slot < 0 || !TILE_VALUES[tileId]) && Number.isFinite(tilePosRaw)) {
    const tilePos = Math.trunc(tilePosRaw);
    const seatFromPos = Math.floor(tilePos / 7);
    const slotFromPos = tilePos % 7;
    if (seatFromPos !== seat || slotFromPos < 0 || slotFromPos > 6) {
      throw new HttpsError("permission-denied", "Tuile invalide pour ce joueur.");
    }
    const tileAtSlot = hand[slotFromPos];
    if (tileAtSlot === null || !TILE_VALUES[tileAtSlot]) {
      throw new HttpsError("failed-precondition", "Cette tuile n'est plus dans ta main.");
    }
    tileId = tileAtSlot;
    slot = slotFromPos;
  }

  if (slot < 0 || !TILE_VALUES[tileId]) {
    throw new HttpsError("failed-precondition", "Tuile introuvable dans la main du joueur.");
  }

  const matchingMoves = legalMoves.filter((move) => move.tileId === tileId && move.slot === slot);
  if (matchingMoves.length === 0) {
    throw new HttpsError("failed-precondition", "Coup illégal pour cette tuile.");
  }

  const openingMove = safeSignedInt(state?.appliedActionSeq) < 0;
  const requestedSide = normalizeRequestedSide(rawAction?.side, rawAction?.branch, openingMove);
  let selectedMove = null;

  if (requestedSide && requestedSide !== "center") {
    selectedMove = matchingMoves.find((move) => move.side === requestedSide) || null;
  } else if (matchingMoves.length === 1) {
    selectedMove = matchingMoves[0];
  } else if (openingMove) {
    selectedMove = matchingMoves[0];
  }

  if (!selectedMove) {
    throw new HttpsError("failed-precondition", "Précise un côté valide pour jouer cette tuile.");
  }

  return {
    type: "play",
    player: seat,
    tileId,
    tilePos: (seat * 7) + slot,
    tileLeft: selectedMove.tileLeft,
    tileRight: selectedMove.tileRight,
    side: selectedMove.side,
    branch: selectedMove.branch,
    slot,
  };
}

function applyResolvedMove(state, room, move, actorUid) {
  const nextState = normalizeGameState(state, room);
  const seq = safeInt(nextState.appliedActionSeq + 1);
  const record = {
    seq,
    type: move.type,
    player: move.player,
    tileId: move.type === "play" ? move.tileId : null,
    tilePos: move.type === "play" ? move.tilePos : null,
    tileLeft: move.type === "play" ? move.tileLeft : null,
    tileRight: move.type === "play" ? move.tileRight : null,
    side: move.type === "play" ? move.side : null,
    branch: move.type === "play" ? move.branch : "",
    resolvedPlacement: move.type === "play" ? move.branch : "pass",
    by: String(actorUid || ""),
  };

  if (move.type === "play") {
    const values = getTileValues(move.tileId);
    if (!values) {
      throw new HttpsError("failed-precondition", "Tuile inconnue.");
    }
    if (!Array.isArray(nextState.seatHands[move.player]) || nextState.seatHands[move.player][move.slot] !== move.tileId) {
      throw new HttpsError("failed-precondition", "La tuile a déjà été consommée.");
    }
    nextState.seatHands[move.player][move.slot] = null;

    if (safeSignedInt(nextState.appliedActionSeq) < 0) {
      if (move.tileId !== 27) {
        throw new HttpsError("failed-precondition", "La partie doit commencer par le double six.");
      }
      nextState.leftEnd = values[0];
      nextState.rightEnd = values[1];
    } else if (move.side === "left") {
      if (values[0] !== nextState.leftEnd && values[1] !== nextState.leftEnd) {
        throw new HttpsError("failed-precondition", "Placement incompatible à gauche.");
      }
      nextState.leftEnd = values[0] === nextState.leftEnd ? values[1] : values[0];
    } else if (move.side === "right") {
      if (values[0] !== nextState.rightEnd && values[1] !== nextState.rightEnd) {
        throw new HttpsError("failed-precondition", "Placement incompatible à droite.");
      }
      nextState.rightEnd = values[0] === nextState.rightEnd ? values[1] : values[0];
    } else {
      throw new HttpsError("failed-precondition", "Côté de pose invalide.");
    }

    nextState.passesInRow = 0;
    if (countRemainingTilesForSeat(nextState.seatHands, move.player) === 0) {
      nextState.winnerSeat = move.player;
      nextState.winnerUid = getWinnerUidForSeat(room, move.player);
      nextState.endedReason = "out";
    }
  } else {
    const legalMoves = getLegalMovesForSeat(nextState, move.player);
    if (legalMoves.length > 0) {
      throw new HttpsError("failed-precondition", "Pass interdit tant qu'un coup légal existe.");
    }
    nextState.passesInRow = safeInt(nextState.passesInRow) + 1;
    if (nextState.passesInRow >= 4) {
      nextState.winnerSeat = computeBlockedWinnerSeat(nextState.seatHands);
      nextState.winnerUid = getWinnerUidForSeat(room, nextState.winnerSeat);
      nextState.endedReason = "block";
    }
  }

  nextState.appliedActionSeq = seq;
  if (nextState.winnerSeat < 0) {
    nextState.currentPlayer = (move.player + 1) % 4;
  }

  return {
    state: nextState,
    record,
    ended: nextState.winnerSeat >= 0,
  };
}

function buildPassMoveForSeat(seat) {
  return {
    type: "pass",
    player: seat,
    tileId: null,
    tilePos: null,
    tileLeft: null,
    tileRight: null,
    side: null,
    branch: "",
    slot: -1,
  };
}

function buildPlayMoveFromLegal(seat, move) {
  return {
    type: "play",
    player: seat,
    tileId: move.tileId,
    tilePos: (seat * 7) + move.slot,
    tileLeft: move.tileLeft,
    tileRight: move.tileRight,
    side: move.side,
    branch: move.branch,
    slot: move.slot,
  };
}

function getOtherSeats(seat) {
  const seats = [];
  for (let i = 0; i < 4; i += 1) {
    if (i !== seat) seats.push(i);
  }
  return seats;
}

function countValueMatchesInSeatHand(state, seat, value) {
  if (!Number.isFinite(value)) return 0;
  const hand = Array.isArray(state?.seatHands?.[seat]) ? state.seatHands[seat] : [];
  let count = 0;
  for (let i = 0; i < hand.length; i += 1) {
    const tileId = hand[i];
    if (tileId === null) continue;
    const values = getTileValues(tileId);
    if (!values) continue;
    if (values[0] === value) count += 1;
    if (values[1] === value) count += 1;
  }
  return count;
}

function countValueMatchesForSeats(state, seats, value) {
  return seats.reduce((sum, seat) => sum + countValueMatchesInSeatHand(state, seat, value), 0);
}

function countImmediateWinThreat(state, seat) {
  const remaining = countRemainingTilesForSeat(state.seatHands, seat);
  if (remaining <= 0) return 0;
  const legal = getLegalMovesForSeat(state, seat).length;
  if (legal <= 0) return 0;
  if (remaining === 1) return 1;
  if (remaining === 2) return 0.45;
  return 0;
}

function sleepMs(delayMs = 0) {
  const wait = Math.max(0, safeInt(delayMs));
  if (!wait) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, wait);
  });
}

function scoreStateForSeat(room, state, perspectiveSeat) {
  const winnerSeat = Number.isFinite(Number(state?.winnerSeat))
    ? Math.trunc(Number(state.winnerSeat))
    : -1;
  const perspectiveIsHuman = isSeatHuman(room, perspectiveSeat);
  const otherSeats = getOtherSeats(perspectiveSeat);
  const humanOpponents = otherSeats.filter((seat) => isSeatHuman(room, seat));
  const robotPeers = otherSeats.filter((seat) => !isSeatHuman(room, seat));

  if (winnerSeat >= 0) {
    if (winnerSeat === perspectiveSeat) return 1_000_000;
    if (perspectiveIsHuman) return -1_000_000;
    return isSeatHuman(room, winnerSeat) ? -900_000 : -220_000;
  }

  const selfTiles = countRemainingTilesForSeat(state.seatHands, perspectiveSeat);
  const selfPips = sumSeatPips(state.seatHands, perspectiveSeat);
  const selfLegal = getLegalMovesForSeat(state, perspectiveSeat).length;
  const leftEnd = Number(state?.leftEnd);
  const rightEnd = Number(state?.rightEnd);

  const selfLeftControl = countValueMatchesInSeatHand(state, perspectiveSeat, leftEnd);
  const selfRightControl = countValueMatchesInSeatHand(state, perspectiveSeat, rightEnd);
  const selfControl = selfLeftControl + selfRightControl;

  const humanLegalTotal = humanOpponents.reduce((sum, seat) => sum + getLegalMovesForSeat(state, seat).length, 0);
  const humanThreat = humanOpponents.reduce((sum, seat) => sum + countImmediateWinThreat(state, seat), 0);
  const humanPipsTotal = humanOpponents.reduce((sum, seat) => sum + sumSeatPips(state.seatHands, seat), 0);
  const humanReach = countValueMatchesForSeats(state, humanOpponents, leftEnd) + countValueMatchesForSeats(state, humanOpponents, rightEnd);

  const robotLegalTotal = robotPeers.reduce((sum, seat) => sum + getLegalMovesForSeat(state, seat).length, 0);
  const robotThreat = robotPeers.reduce((sum, seat) => sum + countImmediateWinThreat(state, seat), 0);
  const robotReach = countValueMatchesForSeats(state, robotPeers, leftEnd) + countValueMatchesForSeats(state, robotPeers, rightEnd);

  let score = 0;
  score += (7 - selfTiles) * 260;
  score -= selfPips * (safeInt(state?.passesInRow) >= 2 ? 28 : 14);
  score += selfLegal * 22;
  score += selfControl * 34;

  if (Number.isFinite(leftEnd) && Number.isFinite(rightEnd) && leftEnd !== rightEnd) {
    score += Math.abs(selfLeftControl - selfRightControl) <= 1 ? 10 : 0;
  }

  if (perspectiveIsHuman) {
    const opponentLegalTotal = otherSeats.reduce((sum, seat) => sum + getLegalMovesForSeat(state, seat).length, 0);
    const opponentThreat = otherSeats.reduce((sum, seat) => sum + countImmediateWinThreat(state, seat), 0);
    const opponentReach = countValueMatchesForSeats(state, otherSeats, leftEnd) + countValueMatchesForSeats(state, otherSeats, rightEnd);
    score -= opponentLegalTotal * 18;
    score -= opponentThreat * 420;
    score -= opponentReach * 8;
  } else {
    score -= humanLegalTotal * 24;
    score -= humanThreat * 620;
    score += humanPipsTotal * 1.35;
    score -= humanReach * 12;

    // Les robots cherchent leur victoire, mais n'essaient pas de fermer le jeu aux autres robots.
    score += robotLegalTotal * 7;
    score += robotReach * 4;
    score -= robotThreat * 45;
  }

  const nextSeat = safeSignedInt(state?.currentPlayer);
  if (nextSeat >= 0 && nextSeat < 4 && nextSeat !== perspectiveSeat) {
    const nextIsHuman = isSeatHuman(room, nextSeat);
    const nextLegal = getLegalMovesForSeat(state, nextSeat).length;
    const nextRemaining = countRemainingTilesForSeat(state.seatHands, nextSeat);
    if (nextIsHuman) {
      if (nextLegal === 0) score += 140;
      if (nextRemaining === 1 && nextLegal > 0) score -= 380;
    } else if (!perspectiveIsHuman) {
      if (nextLegal === 0) score += 18;
      if (nextRemaining === 1 && nextLegal > 0) score -= 28;
    } else if (nextRemaining === 1 && nextLegal > 0) {
      score -= 180;
    }
  }

  return score;
}

function chooseStrategicMove(room, state, seat, options = {}) {
  const legalMoves = getLegalMovesForSeat(state, seat);
  const lookahead = Math.max(0, safeInt(options.lookaheadPlies));
  if (legalMoves.length === 0) return buildPassMoveForSeat(seat);

  let bestMove = buildPlayMoveFromLegal(seat, legalMoves[0]);
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < legalMoves.length; i += 1) {
    const legalMove = legalMoves[i];
    const candidate = buildPlayMoveFromLegal(seat, legalMove);
    let simulated = null;

    try {
      simulated = applyResolvedMove(state, room, candidate, `server:bot:eval:${seat}`);
    } catch (_) {
      continue;
    }

    const tileValues = getTileValues(candidate.tileId) || [0, 0];
    let score = scoreStateForSeat(room, simulated.state, seat);
    score += (tileValues[0] + tileValues[1]) * 6;

    if (lookahead > 0 && simulated.state.winnerSeat < 0) {
      let lookState = simulated.state;
      let weight = 0.62;
      for (let ply = 0; ply < lookahead && lookState.winnerSeat < 0; ply += 1) {
        const actor = safeSignedInt(lookState.currentPlayer);
        if (actor < 0 || actor > 3) break;
        const predicted = chooseStrategicMove(room, lookState, actor, { lookaheadPlies: 0 });
        const predictedResult = applyResolvedMove(lookState, room, predicted, `server:bot:sim:${actor}`);
        lookState = predictedResult.state;
        score += weight * scoreStateForSeat(room, lookState, seat);
        weight *= 0.62;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMove = candidate;
      continue;
    }

    if (score === bestScore) {
      const bestValues = getTileValues(bestMove.tileId) || [0, 0];
      const bestPips = bestValues[0] + bestValues[1];
      const candidatePips = tileValues[0] + tileValues[1];
      if (candidatePips > bestPips) {
        bestMove = candidate;
      }
    }
  }

  return bestMove;
}

function chooseBotMove(room, state, seat) {
  const difficulty = normalizeBotDifficulty(room?.botDifficulty);
  return chooseStrategicMove(room, state, seat, {
    lookaheadPlies: safeInt(BOT_DIFFICULTY_LOOKAHEAD[difficulty]),
  });
}

function buildOpeningMoveForState(state) {
  const liveState = normalizeGameState(state);
  const openingSeat = findSeatWithTile(liveState.seatHands, 27);
  if (openingSeat < 0 || openingSeat > 3) {
    throw new HttpsError("failed-precondition", "Impossible de trouver le double six pour demarrer.");
  }

  const legalMoves = getLegalMovesForSeat(liveState, openingSeat);
  const openingMove = legalMoves.find((move) => move.tileId === 27) || null;
  if (!openingMove) {
    throw new HttpsError("failed-precondition", "Le double six ne peut pas ouvrir la partie.");
  }

  return {
    type: "play",
    player: openingSeat,
    tileId: openingMove.tileId,
    tilePos: (openingSeat * 7) + openingMove.slot,
    tileLeft: openingMove.tileLeft,
    tileRight: openingMove.tileRight,
    side: openingMove.side,
    branch: openingMove.branch,
    slot: openingMove.slot,
  };
}

function advanceBotsAndCollect(room, state, roomId, firstMove = null, actorUid = "", allowBotAdvance = true) {
  let liveState = normalizeGameState(state, room);
  const records = [];
  let autoBotMoves = 0;

  if (firstMove) {
    const result = applyResolvedMove(liveState, room, firstMove, actorUid);
    liveState = result.state;
    records.push({
      ...result.record,
      roomId,
    });
  }

  while (allowBotAdvance === true && liveState.winnerSeat < 0 && autoBotMoves < 12) {
    const botSeat = safeSignedInt(liveState.currentPlayer);
    if (botSeat < 0 || botSeat > 3 || isSeatHuman(room, botSeat)) {
      break;
    }

    const botMove = chooseBotMove(room, liveState, botSeat);
    const result = applyResolvedMove(liveState, room, botMove, "server:bot");
    liveState = result.state;
    records.push({
      ...result.record,
      roomId,
    });
    autoBotMoves += 1;
  }

  return {
    state: liveState,
    records,
  };
}

function applyActionBatchInTransaction(tx, roomRefDoc, room, state, roomId, firstMove = null, actorUid = "", options = {}) {
  const batchResult = advanceBotsAndCollect(
    room,
    state,
    roomId,
    firstMove,
    actorUid,
    options?.allowBotAdvance !== false
  );
  batchResult.records.forEach((record) => {
    const actionRef = roomRefDoc.collection("actions").doc(String(record.seq));
    tx.set(actionRef, {
      ...record,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  return batchResult;
}

function buildRoomUpdateFromGameState(room, nextState, records = []) {
  const lastRecord = records.length > 0 ? records[records.length - 1] : null;
  const playedCountDelta = records.reduce((count, item) => count + (item.type === "play" ? 1 : 0), 0);
  const nextActionSeq = safeInt(nextState.appliedActionSeq + 1);
  const update = {
    nextActionSeq,
    lastActionSeq: nextState.appliedActionSeq,
    currentPlayer: nextState.currentPlayer,
    turnActual: nextActionSeq,
    turnStartedAt: admin.firestore.FieldValue.serverTimestamp(),
    playedCount: safeInt(room.playedCount) + playedCountDelta,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    turnLockedUntilMs: 0,
    deckOrder: admin.firestore.FieldValue.delete(),
  };

  if (lastRecord) {
    update.lastMove = {
      seq: lastRecord.seq,
      type: lastRecord.type,
      player: lastRecord.player,
      tileId: lastRecord.tileId,
      tilePos: lastRecord.tilePos,
      tileLeft: lastRecord.tileLeft,
      tileRight: lastRecord.tileRight,
      side: lastRecord.side,
      branch: lastRecord.branch,
    };
  }

  if (nextState.winnerSeat >= 0) {
    update.status = "ended";
    update.winnerSeat = nextState.winnerSeat;
    update.winnerUid = nextState.winnerUid;
    update.endedReason = nextState.endedReason || "out";
    update.endedAt = admin.firestore.FieldValue.serverTimestamp();
    update.endedAtMs = Date.now();
    update.endClicks = {};
  }

  return update;
}

async function processPendingBotTurns(roomId) {
  const safeRoomId = String(roomId || "").trim();
  if (!safeRoomId) return;

  const roomRef = db.collection(ROOMS_COLLECTION).doc(safeRoomId);
  const stateRef = gameStateRef(safeRoomId);

  while (true) {
    const roomSnap = await roomRef.get();
    if (!roomSnap.exists) return;
    const room = roomSnap.data() || {};

    if (String(room.status || "") !== "playing") return;
    if (room.startRevealPending === true) return;
    const roomWinnerSeat = Number.isFinite(Number(room.winnerSeat))
      ? Math.trunc(Number(room.winnerSeat))
      : -1;
    if (roomWinnerSeat >= 0) return;

    const botSeat = safeSignedInt(room.currentPlayer);
    if (botSeat < 0 || botSeat > 3 || isSeatHuman(room, botSeat)) {
      return;
    }

    const outcome = await db.runTransaction(async (tx) => {
      const [liveRoomSnap, stateSnap] = await Promise.all([
        tx.get(roomRef),
        tx.get(stateRef),
      ]);

      if (!liveRoomSnap.exists) {
        return { processed: false, stop: true };
      }

      const liveRoom = liveRoomSnap.data() || {};
      if (String(liveRoom.status || "") !== "playing") {
        return { processed: false, stop: true };
      }
      if (liveRoom.startRevealPending === true) {
        return { processed: false, stop: true };
      }
      const liveWinnerSeat = Number.isFinite(Number(liveRoom.winnerSeat))
        ? Math.trunc(Number(liveRoom.winnerSeat))
        : -1;
      if (liveWinnerSeat >= 0) {
        return { processed: false, stop: true };
      }

      const liveBotSeat = safeSignedInt(liveRoom.currentPlayer);
      if (liveBotSeat < 0 || liveBotSeat > 3 || isSeatHuman(liveRoom, liveBotSeat)) {
        return { processed: false, stop: true };
      }

      const currentState = stateSnap.exists
        ? normalizeGameState(
            stateSnap.data(),
            liveRoom
          )
        : createInitialGameState(
            liveRoom,
            Array.isArray(liveRoom.deckOrder) && liveRoom.deckOrder.length === 28 ? liveRoom.deckOrder : makeDeckOrder()
          );

      if (currentState.winnerSeat >= 0) {
        return { processed: false, stop: true };
      }

      const botMove = chooseBotMove(liveRoom, currentState, liveBotSeat);
      const batchResult = applyActionBatchInTransaction(
        tx,
        roomRef,
        liveRoom,
        currentState,
        safeRoomId,
        botMove,
        "server:bot"
      );
      const nextState = batchResult.state;
      tx.set(stateRef, buildGameStateWrite(nextState), { merge: true });
      tx.update(roomRef, buildRoomUpdateFromGameState(liveRoom, nextState, batchResult.records));

      return {
        processed: true,
        stop: nextState.winnerSeat >= 0 || isSeatHuman(liveRoom, nextState.currentPlayer),
      };
    });

    if (!outcome) return;
    if (!outcome.processed || outcome.stop) {
      return;
    }
  }
}

function buildGameStateWrite(nextState) {
  return {
    deckOrder: nextState.deckOrder,
    seatHands: serializeSeatHands(nextState.seatHands),
    leftEnd: nextState.leftEnd,
    rightEnd: nextState.rightEnd,
    passesInRow: nextState.passesInRow,
    appliedActionSeq: nextState.appliedActionSeq,
    currentPlayer: nextState.currentPlayer,
    winnerSeat: nextState.winnerSeat,
    winnerUid: nextState.winnerUid,
    endedReason: nextState.endedReason,
    idempotencyKeys: trimIdempotencyKeys(nextState.idempotencyKeys),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

async function applyWalletMutationTx(tx, options) {
  const uid = String(options.uid || "").trim();
  const email = String(options.email || "").trim();
  const type = String(options.type || "mutation").trim();
  const note = String(options.note || "");
  const deltaDoes = safeSignedInt(options.deltaDoes);
  const deltaExchangedGourdes = safeSignedInt(options.deltaExchangedGourdes);
  const amountGourdes = safeInt(options.amountGourdes);
  const amountDoes = safeInt(options.amountDoes);

  const ref = walletRef(uid);
  const snap = await tx.get(ref);
  const data = snap.exists ? (snap.data() || {}) : {};

  const beforeDoes = safeInt(data.doesBalance);
  const beforeExchanged = safeSignedInt(data.exchangedGourdes);
  const beforePendingFromXchange = safeInt(data.pendingPlayFromXchangeDoes);
  const beforePendingFromReferral = safeInt(data.pendingPlayFromReferralDoes);
  const beforeTotalExchangedEver = safeInt(data.totalExchangedHtgEver);

  const nextDoesRaw = beforeDoes + deltaDoes;
  if (nextDoesRaw < 0) {
    throw new HttpsError("failed-precondition", "Solde Does insuffisant.");
  }

  const nextExchangedRaw = beforeExchanged + deltaExchangedGourdes;
  const afterDoes = safeInt(nextDoesRaw);
  const afterExchanged = safeSignedInt(nextExchangedRaw);

  let afterPendingFromXchange = beforePendingFromXchange;
  let afterPendingFromReferral = beforePendingFromReferral;
  let afterTotalExchangedEver = beforeTotalExchangedEver;

  if (type === "xchange_buy") {
    const [ordersSnap, withdrawalsSnap] = await Promise.all([
      tx.get(
        db.collection(CLIENTS_COLLECTION)
          .doc(uid)
          .collection("orders")
          .where("status", "==", "approved")
      ),
      tx.get(
        db.collection(CLIENTS_COLLECTION)
          .doc(uid)
          .collection("withdrawals")
      ),
    ]);

    const approvedDeposits = ordersSnap.docs.reduce(
      (sum, item) => sum + safeInt(item.data()?.amount),
      0
    );
    const reservedWithdrawals = withdrawalsSnap.docs.reduce((sum, item) => {
      const withdrawal = item.data() || {};
      if (withdrawal.status === "rejected") return sum;
      return sum + safeInt(withdrawal.requestedAmount ?? withdrawal.amount);
    }, 0);
    const baseBalanceHtg = Math.max(0, approvedDeposits - reservedWithdrawals);
    const availableToConvertHtg = Math.max(0, baseBalanceHtg - beforeExchanged);

    if (amountGourdes <= 0 || amountGourdes > availableToConvertHtg) {
      throw new HttpsError("failed-precondition", "Montant supérieur au solde HTG disponible.");
    }

    afterTotalExchangedEver = beforeTotalExchangedEver + amountGourdes;
    afterPendingFromXchange = beforePendingFromXchange + amountDoes;
  }

  if (type === "game_entry") {
    let playedDoes = amountDoes;
    if (playedDoes > 0 && afterPendingFromXchange > 0) {
      const consumeXchange = Math.min(playedDoes, afterPendingFromXchange);
      afterPendingFromXchange -= consumeXchange;
      playedDoes -= consumeXchange;
    }
    if (playedDoes > 0 && afterPendingFromReferral > 0) {
      const consumeReferral = Math.min(playedDoes, afterPendingFromReferral);
      afterPendingFromReferral -= consumeReferral;
      playedDoes -= consumeReferral;
    }
  }

  if (type === "xchange_sell") {
    const pendingTotal = afterPendingFromXchange + afterPendingFromReferral;
    if (pendingTotal > 0) {
      throw buildPlayRequiredError({
        pendingPlayFromXchangeDoes: afterPendingFromXchange,
        pendingPlayFromReferralDoes: afterPendingFromReferral,
        pendingPlayTotalDoes: pendingTotal,
      });
    }
  }

  const nextWallet = {
    uid,
    email: email || String(data.email || ""),
    doesBalance: afterDoes,
    exchangedGourdes: afterExchanged,
    pendingPlayFromXchangeDoes: afterPendingFromXchange,
    pendingPlayFromReferralDoes: afterPendingFromReferral,
    totalExchangedHtgEver: afterTotalExchangedEver,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (!snap.exists) {
    nextWallet.createdAt = admin.firestore.FieldValue.serverTimestamp();
  }

  tx.set(ref, nextWallet, { merge: true });

  const historyDoc = walletHistoryRef(uid).doc();
  tx.set(historyDoc, {
    uid,
    email: email || String(data.email || ""),
    type,
    note,
    amountGourdes,
    amountDoes,
    deltaDoes,
    deltaExchangedGourdes,
    beforeDoes,
    afterDoes,
    beforeExchangedGourdes: beforeExchanged,
    afterExchangedGourdes: afterExchanged,
    beforePendingPlayFromXchangeDoes: beforePendingFromXchange,
    afterPendingPlayFromXchangeDoes: afterPendingFromXchange,
    beforePendingPlayFromReferralDoes: beforePendingFromReferral,
    afterPendingPlayFromReferralDoes: afterPendingFromReferral,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    beforeDoes,
    afterDoes,
    beforeExchanged,
    afterExchanged,
    afterPendingFromXchange,
    afterPendingFromReferral,
    afterTotalExchangedEver,
  };
}

function timestampToMillis(value) {
  if (value && typeof value.toMillis === "function") {
    return value.toMillis();
  }
  const raw = Number(value);
  return Number.isFinite(raw) ? raw : 0;
}

async function findActiveRoomForUser(uid) {
  const rooms = db.collection(ROOMS_COLLECTION);
  const membershipSnap = await rooms
    .where("playerUids", "array-contains", uid)
    .limit(12)
    .get();

  if (membershipSnap.empty) return null;

  let playingCandidate = null;
  let waitingCandidate = null;

  membershipSnap.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const status = String(data.status || "");
    if (status === "playing" && !playingCandidate) {
      playingCandidate = docSnap;
      return;
    }
    if (status === "waiting" && !waitingCandidate) {
      waitingCandidate = docSnap;
    }
  });

  const candidate = playingCandidate || waitingCandidate;

  if (!candidate) return null;

  const data = candidate.data() || {};
  const seats = data.seats && typeof data.seats === "object" ? data.seats : {};
  const seatIndex = typeof seats[uid] === "number" ? seats[uid] : -1;

  return {
    roomId: candidate.id,
    status: String(data.status || ""),
    seatIndex,
  };
}

function getRoomSeats(room) {
  return room?.seats && typeof room.seats === "object" ? room.seats : {};
}

function getSeatForUser(room, uid) {
  const seats = getRoomSeats(room);
  return typeof seats[uid] === "number" ? seats[uid] : -1;
}

async function deleteCollectionInChunks(collectionRef, batchSize = 400) {
  while (true) {
    const snap = await collectionRef.limit(batchSize).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((item) => batch.delete(item.ref));
    await batch.commit();
  }
}

async function cleanupRoom(roomRef) {
  await deleteCollectionInChunks(roomRef.collection("actions"));
  await deleteCollectionInChunks(roomRef.collection("settlements"));
  await gameStateRef(roomRef.id).delete().catch(() => null);
  await roomRef.delete();
}

async function ensureRoomGameStartedTx(tx, roomRefDoc, room = {}) {
  const stateRef = gameStateRef(roomRefDoc.id);
  const stateSnap = await tx.get(stateRef);

  let state = stateSnap.exists
    ? normalizeGameState(stateSnap.data(), room)
    : createInitialGameState(room, Array.isArray(room.deckOrder) && room.deckOrder.length === 28 ? room.deckOrder : makeDeckOrder());

  const batchResult = applyActionBatchInTransaction(tx, roomRefDoc, room, state, roomRefDoc.id);
  state = batchResult.state;

  tx.set(stateRef, buildGameStateWrite(state), { merge: true });
  return {
    state,
    records: batchResult.records,
  };
}

exports.walletMutate = publicOnCall("walletMutate", async (request) => {
  const { uid, email } = assertAuth(request);
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const op = String(payload.op || "").trim();

  let mutation = null;
  if (op === "xchange_buy") {
    const amountGourdes = safeInt(payload.amountGourdes);
    if (amountGourdes <= 0) {
      throw new HttpsError("invalid-argument", "Montant invalide.");
    }
    mutation = {
      uid,
      email,
      type: "xchange_buy",
      note: "Conversion HTG vers Does",
      amountGourdes,
      amountDoes: amountGourdes * RATE_HTG_TO_DOES,
      deltaDoes: amountGourdes * RATE_HTG_TO_DOES,
      deltaExchangedGourdes: amountGourdes,
    };
  } else if (op === "xchange_sell") {
    const amountDoes = safeInt(payload.amountDoes);
    if (amountDoes <= 0 || amountDoes % RATE_HTG_TO_DOES !== 0) {
      throw new HttpsError("invalid-argument", `Le montant Does doit être multiple de ${RATE_HTG_TO_DOES}.`);
    }
    const amountGourdes = Math.floor(amountDoes / RATE_HTG_TO_DOES);
    mutation = {
      uid,
      email,
      type: "xchange_sell",
      note: "Conversion Does vers HTG",
      amountGourdes,
      amountDoes,
      deltaDoes: -amountDoes,
      deltaExchangedGourdes: -amountGourdes,
    };
  } else if (op === "game_entry") {
    const amountDoes = safeInt(payload.amountDoes);
    const settingsSnapshot = await getSettingsSnapshotData();
    if (!findStakeConfigByAmount(amountDoes, settingsSnapshot.gameStakeOptions, true)) {
      throw new HttpsError("invalid-argument", "Mise non autorisée.");
    }
    mutation = {
      uid,
      email,
      type: "game_entry",
      note: "Participation partie",
      amountGourdes: 0,
      amountDoes,
      deltaDoes: -amountDoes,
      deltaExchangedGourdes: 0,
    };
  } else {
    throw new HttpsError("invalid-argument", "Opération non supportée.");
  }

  const result = await db.runTransaction((tx) => applyWalletMutationTx(tx, mutation));
  return {
    ok: true,
    does: result.afterDoes,
    exchangedGourdes: result.afterExchanged,
    pendingPlayFromXchangeDoes: result.afterPendingFromXchange,
    pendingPlayFromReferralDoes: result.afterPendingFromReferral,
    totalExchangedHtgEver: result.afterTotalExchangedEver,
  };
});

exports.joinMatchmaking = publicOnCall("joinMatchmaking", async (request) => {
  const { uid, email } = assertAuth(request);
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const stakeDoes = safeInt(payload.stakeDoes);
  const [configuredBotDifficulty, settingsSnapshot] = await Promise.all([
    getConfiguredBotDifficulty(),
    getSettingsSnapshotData(),
  ]);
  const selectedStakeConfig = findStakeConfigByAmount(stakeDoes, settingsSnapshot.gameStakeOptions, true);

  if (!selectedStakeConfig) {
    throw new HttpsError("invalid-argument", "Mise non autorisée.");
  }

  const rewardAmountDoes = selectedStakeConfig.rewardDoes;

  const active = await findActiveRoomForUser(uid);
  if (active && active.seatIndex >= 0) {
    const privateDeckOrder = active.status === "playing"
      ? await readPrivateDeckOrderForRoom(active.roomId)
      : [];
    return {
      ok: true,
      resumed: true,
      charged: false,
      roomId: active.roomId,
      seatIndex: active.seatIndex,
      status: active.status,
      privateDeckOrder,
    };
  }

  const waitingCandidates = await db
    .collection(ROOMS_COLLECTION)
    .where("status", "==", "waiting")
    .limit(64)
    .get();

  const waitingDocs = waitingCandidates.docs
    .slice()
    .sort((a, b) => {
      const left = timestampToMillis(a.get("createdAt"));
      const right = timestampToMillis(b.get("createdAt"));
      return left - right;
    });

  for (const candidate of waitingDocs) {
    const roomRef = candidate.ref;
    try {
      const joined = await db.runTransaction(async (tx) => {
        const [roomSnap, walletSnap] = await Promise.all([
          tx.get(roomRef),
          tx.get(walletRef(uid)),
        ]);
        if (!roomSnap.exists) {
          throw new HttpsError("aborted", "Salle introuvable.");
        }
        const room = roomSnap.data() || {};
        if (room.status !== "waiting") {
          throw new HttpsError("aborted", "Salle non disponible.");
        }
        if (getBlockedRejoinSet(room).has(uid)) {
          throw new HttpsError("aborted", "Salle non disponible.");
        }

        const roomEntryCostDoes = safeInt(room.entryCostDoes || room.stakeDoes);
        const roomRewardAmountDoes = resolveRoomRewardDoes(room);
        if (roomEntryCostDoes !== stakeDoes || roomRewardAmountDoes !== rewardAmountDoes) {
          throw new HttpsError("aborted", "Salle non compatible.");
        }

        const currentSeats = room.seats && typeof room.seats === "object" ? room.seats : {};
        const playerUids = Array.from({ length: 4 }, (_, idx) => String((room.playerUids || [])[idx] || ""));
        if (playerUids.includes(uid)) {
          const seats = currentSeats;
          const seatIndex = typeof seats[uid] === "number" ? seats[uid] : 0;
          const privateDeckOrder = room.status === "playing"
            ? await readPrivateDeckOrderForRoom(roomRef.id)
            : [];
          return {
            ok: true,
            resumed: true,
            charged: false,
            roomId: roomRef.id,
            seatIndex,
            status: room.status,
            privateDeckOrder,
          };
        }

        const humans = playerUids.filter(Boolean).length;
        if (humans >= 4) {
          throw new HttpsError("aborted", "Salle complète.");
        }

        const walletData = walletSnap.exists ? (walletSnap.data() || {}) : {};
        const beforeDoes = safeInt(walletData.doesBalance);
        if (beforeDoes < stakeDoes) {
          throw new HttpsError("failed-precondition", "Solde Does insuffisant.");
        }

        const walletMutation = await applyWalletMutationTx(tx, {
          uid,
          email,
          type: "game_entry",
          note: "Participation partie",
          amountDoes: stakeDoes,
          amountGourdes: 0,
          deltaDoes: -stakeDoes,
          deltaExchangedGourdes: 0,
        });

        const usedSeats = new Set(
          Object.values(currentSeats)
            .map((seat) => Number(seat))
            .filter((seat) => Number.isFinite(seat) && seat >= 0 && seat < 4)
        );
        const seatIndex = [0, 1, 2, 3].find((seat) => !usedSeats.has(seat));
        if (typeof seatIndex !== "number") {
          throw new HttpsError("aborted", "Salle complète.");
        }

        const nextPlayerUids = playerUids.slice();
        nextPlayerUids[seatIndex] = uid;
        const currentNames = Array.from({ length: 4 }, (_, idx) => String((room.playerNames || [])[idx] || ""));
        const nextPlayerNames = currentNames.slice();
        nextPlayerNames[seatIndex] = sanitizePlayerLabel(email || uid, seatIndex);
        const nextSeats = {
          ...currentSeats,
          [uid]: seatIndex,
        };
        const nextHumans = nextPlayerUids.filter(Boolean).length;

        const updates = {
          playerUids: nextPlayerUids,
          playerNames: nextPlayerNames,
          playerEmails: admin.firestore.FieldValue.delete(),
          seats: nextSeats,
          humanCount: nextHumans,
          botCount: Math.max(0, 4 - nextHumans),
          botDifficulty: configuredBotDifficulty,
          stakeDoes,
          entryCostDoes: stakeDoes,
          rewardAmountDoes,
          stakeConfigId: selectedStakeConfig.id,
          turnLockedUntilMs: 0,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        if (nextHumans >= 4) {
          const deckOrder = makeDeckOrder();
          const roomAtStart = {
            ...room,
            playerUids: nextPlayerUids,
            playerNames: nextPlayerNames,
            seats: nextSeats,
            humanCount: nextHumans,
            botCount: 0,
            deckOrder,
            playedCount: 0,
          };
          const gameState = createInitialGameState(roomAtStart, deckOrder);
          const openingMove = buildOpeningMoveForState(gameState);
          const batchResult = applyActionBatchInTransaction(
            tx,
            roomRef,
            roomAtStart,
            gameState,
            roomRef.id,
            openingMove,
            "server:opening",
            { allowBotAdvance: false }
          );
          const finalState = batchResult.state;

          tx.set(gameStateRef(roomRef.id), buildGameStateWrite(finalState), { merge: true });

          updates.status = finalState.winnerSeat >= 0 ? "ended" : "playing";
          updates.startRevealPending = finalState.winnerSeat < 0;
          updates.startRevealAckUids = [];
          updates.startedAt = admin.firestore.FieldValue.serverTimestamp();
          updates.startedAtMs = Date.now();
          updates.deckOrder = admin.firestore.FieldValue.delete();
          updates.endClicks = {};
          Object.assign(updates, buildRoomUpdateFromGameState(roomAtStart, finalState, batchResult.records));
          if (finalState.winnerSeat < 0) {
            updates.winnerSeat = admin.firestore.FieldValue.delete();
            updates.winnerUid = admin.firestore.FieldValue.delete();
            updates.endedReason = admin.firestore.FieldValue.delete();
            updates.endedAt = admin.firestore.FieldValue.delete();
            updates.endedAtMs = admin.firestore.FieldValue.delete();
          }
        }

        tx.update(roomRef, updates);

        return {
          ok: true,
          resumed: false,
          charged: true,
          roomId: roomRef.id,
          seatIndex,
          status: String(updates.status || "waiting"),
          startRevealPending: updates.startRevealPending === true,
          does: walletMutation.afterDoes,
          privateDeckOrder: updates.status === "playing" ? finalState.deckOrder.slice(0, 28) : [],
        };
      });

      if (joined?.status === "playing") {
        if (joined?.startRevealPending !== true) {
          await processPendingBotTurns(String(joined.roomId || ""));
        }
      }
      return joined;
    } catch (err) {
      if (err instanceof HttpsError && err.code === "failed-precondition") {
        throw err;
      }
      continue;
    }
  }

  const newRoomRef = db.collection(ROOMS_COLLECTION).doc();
  const created = await db.runTransaction(async (tx) => {
    const walletMutation = await applyWalletMutationTx(tx, {
      uid,
      email,
      type: "game_entry",
      note: "Participation partie",
      amountDoes: stakeDoes,
      amountGourdes: 0,
      deltaDoes: -stakeDoes,
      deltaExchangedGourdes: 0,
    });

    tx.set(newRoomRef, {
      status: "waiting",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ownerUid: uid,
      playerUids: [uid, "", "", ""],
      playerNames: [sanitizePlayerLabel(email || uid, 0), "", "", ""],
      blockedRejoinUids: [],
      humanCount: 1,
      seats: { [uid]: 0 },
      botCount: 3,
      botDifficulty: configuredBotDifficulty,
      startRevealPending: false,
      startRevealAckUids: [],
      startedAt: null,
      startedAtMs: 0,
      endedAtMs: 0,
      turnLockedUntilMs: 0,
      nextActionSeq: 0,
      gameMode: "domino-ffa",
      engineVersion: 2,
      stakeDoes,
      entryCostDoes: stakeDoes,
      rewardAmountDoes,
      stakeConfigId: selectedStakeConfig.id,
    });

    return {
      ok: true,
      resumed: false,
      charged: true,
      roomId: newRoomRef.id,
      seatIndex: 0,
      status: "waiting",
      does: walletMutation.afterDoes,
    };
  });

  return created;
});

exports.ensureRoomReady = publicOnCall("ensureRoomReady", async (request) => {
  const { uid } = assertAuth(request);
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const roomId = String(payload.roomId || "").trim();
  const configuredBotDifficulty = await getConfiguredBotDifficulty();

  if (!roomId) {
    throw new HttpsError("invalid-argument", "roomId requis.");
  }

  const roomRef = db.collection(ROOMS_COLLECTION).doc(roomId);
  const stateRef = gameStateRef(roomId);
  const startResult = await db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists) {
      throw new HttpsError("not-found", "Salle introuvable.");
    }

    const room = roomSnap.data() || {};
    const seatIndex = getSeatForUser(room, uid);
    if (seatIndex < 0) {
      throw new HttpsError("permission-denied", "Tu ne fais pas partie de cette salle.");
    }

    const status = String(room.status || "");
    if (status !== "waiting") {
      const stateSnap = status === "playing" ? await tx.get(stateRef) : null;
      return {
        ok: true,
        started: false,
        status,
        startRevealPending: room.startRevealPending === true,
        privateDeckOrder: status === "playing"
          ? normalizePrivateDeckOrder(stateSnap?.data()?.deckOrder)
          : [],
      };
    }

    const humans = Array.isArray(room.playerUids) ? room.playerUids.filter(Boolean).length : safeInt(room.humanCount);
    const deckOrder = Array.isArray(room.deckOrder) && room.deckOrder.length === 28 ? room.deckOrder.slice(0, 28) : makeDeckOrder();
    const roomAtStart = {
      ...room,
      botDifficulty: configuredBotDifficulty,
      deckOrder,
      humanCount: humans,
      botCount: Math.max(0, 4 - humans),
      playedCount: 0,
    };
    const initialState = createInitialGameState(roomAtStart, deckOrder);
    const openingMove = buildOpeningMoveForState(initialState);
    const batchResult = applyActionBatchInTransaction(
      tx,
      roomRef,
      roomAtStart,
      initialState,
      roomId,
      openingMove,
      "server:opening",
      { allowBotAdvance: false }
    );
    const finalState = batchResult.state;

    tx.set(gameStateRef(roomId), buildGameStateWrite(finalState), { merge: true });

    const updates = {
      status: finalState.winnerSeat >= 0 ? "ended" : "playing",
      startRevealPending: finalState.winnerSeat < 0,
      startRevealAckUids: [],
      botCount: Math.max(0, 4 - humans),
      botDifficulty: configuredBotDifficulty,
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      startedAtMs: Date.now(),
      deckOrder: admin.firestore.FieldValue.delete(),
      turnLockedUntilMs: 0,
      endClicks: {},
      playerEmails: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    Object.assign(updates, buildRoomUpdateFromGameState(roomAtStart, finalState, batchResult.records));
    if (finalState.winnerSeat < 0) {
      updates.winnerSeat = admin.firestore.FieldValue.delete();
      updates.winnerUid = admin.firestore.FieldValue.delete();
      updates.endedReason = admin.firestore.FieldValue.delete();
      updates.endedAt = admin.firestore.FieldValue.delete();
      updates.endedAtMs = admin.firestore.FieldValue.delete();
    }

    tx.update(roomRef, updates);

    return {
      ok: true,
      started: true,
      status: String(updates.status || "playing"),
      startRevealPending: updates.startRevealPending === true,
      privateDeckOrder: String(updates.status || "playing") === "playing" ? finalState.deckOrder.slice(0, 28) : [],
    };
  });

  if (startResult?.status === "playing") {
    if (!Array.isArray(startResult.privateDeckOrder) || startResult.privateDeckOrder.length !== 28) {
      startResult.privateDeckOrder = await readPrivateDeckOrderForRoom(roomId);
    }
    if (startResult.startRevealPending !== true) {
      await processPendingBotTurns(roomId);
    }
  }

  return startResult;
});

exports.ackRoomStartSeen = publicOnCall("ackRoomStartSeen", async (request) => {
  const { uid } = assertAuth(request);
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const roomId = String(payload.roomId || "").trim();

  if (!roomId) {
    throw new HttpsError("invalid-argument", "roomId requis.");
  }

  const roomRef = db.collection(ROOMS_COLLECTION).doc(roomId);
  const ackResult = await db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists) {
      throw new HttpsError("not-found", "Salle introuvable.");
    }

    const room = roomSnap.data() || {};
    const humanUids = Array.isArray(room.playerUids)
      ? room.playerUids.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const ackUids = Array.isArray(room.startRevealAckUids)
      ? room.startRevealAckUids.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const ackSet = new Set(ackUids);

    if (String(room.status || "") !== "playing") {
      return {
        ok: true,
        pending: false,
        released: false,
        humanCount: humanUids.length,
        ackCount: ackSet.size,
      };
    }

    const seatIndex = getSeatForUser(room, uid);
    if (seatIndex < 0) {
      throw new HttpsError("permission-denied", "Tu ne fais pas partie de cette salle.");
    }

    ackSet.add(uid);
    if (room.startRevealPending !== true) {
      return {
        ok: true,
        pending: false,
        released: false,
        humanCount: humanUids.length,
        ackCount: ackSet.size,
      };
    }

    const nextAckUids = Array.from(ackSet);
    const ready = humanUids.length > 0 && humanUids.every((humanUid) => ackSet.has(humanUid));

    tx.update(roomRef, {
      startRevealAckUids: nextAckUids,
      startRevealPending: ready ? false : true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      pending: !ready,
      released: ready,
      humanCount: humanUids.length,
      ackCount: nextAckUids.length,
    };
  });

  if (ackResult?.released === true) {
    await processPendingBotTurns(roomId);
  }

  return ackResult;
});

exports.leaveRoom = publicOnCall("leaveRoom", async (request) => {
  const { uid } = assertAuth(request);
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const roomId = String(payload.roomId || "").trim();

  if (!roomId) {
    throw new HttpsError("invalid-argument", "roomId requis.");
  }

  const roomRef = db.collection(ROOMS_COLLECTION).doc(roomId);
  let shouldCleanup = false;
  let shouldNudgeBots = false;

  const result = await db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists) {
      return {
        ok: true,
        deleted: true,
        status: "missing",
      };
    }

    const room = roomSnap.data() || {};
    const currentUids = Array.from({ length: 4 }, (_, idx) => String((room.playerUids || [])[idx] || ""));
    if (!currentUids.includes(uid)) {
      return {
        ok: true,
        deleted: false,
        status: String(room.status || ""),
      };
    }

    const status = String(room.status || "");
    const seatIndex = currentUids.findIndex((candidate) => candidate === uid);
    const nextPlayerUids = currentUids.slice();
    if (seatIndex >= 0) nextPlayerUids[seatIndex] = "";
    const currentNames = Array.from({ length: 4 }, (_, idx) => String((room.playerNames || [])[idx] || ""));
    const nextPlayerNames = currentNames.slice();
    if (seatIndex >= 0) {
      nextPlayerNames[seatIndex] = status === "playing" ? botSeatLabel(seatIndex) : "";
    }

    const nextSeats = { ...getRoomSeats(room) };
    delete nextSeats[uid];
    const blockedRejoinUids = Array.from(getBlockedRejoinSet(room));
    if (!blockedRejoinUids.includes(uid)) {
      blockedRejoinUids.push(uid);
    }

    const humans = nextPlayerUids.filter(Boolean).length;
    if (humans <= 0) {
      shouldCleanup = true;
      tx.set(roomRef, {
        status: "closing",
        playerUids: ["", "", "", ""],
        playerNames: ["", "", "", ""],
        blockedRejoinUids,
        playerEmails: admin.firestore.FieldValue.delete(),
        seats: {},
        humanCount: 0,
        botCount: 4,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      return {
        ok: true,
        deleted: true,
        status: "closing",
      };
    }

    const nextAckUids = Array.isArray(room.startRevealAckUids)
      ? room.startRevealAckUids.map((item) => String(item || "").trim()).filter(Boolean).filter((item) => item !== uid)
      : [];
    const revealPending = room.startRevealPending === true;
    const revealReady = revealPending === true
      && nextPlayerUids.filter(Boolean).every((playerUid) => nextAckUids.includes(playerUid));
    const nextBotCount = Math.max(0, 4 - humans);

    tx.update(roomRef, {
      playerUids: nextPlayerUids,
      playerNames: nextPlayerNames,
      blockedRejoinUids,
      playerEmails: admin.firestore.FieldValue.delete(),
      seats: nextSeats,
      humanCount: humans,
      botCount: nextBotCount,
      startRevealAckUids: nextAckUids,
      startRevealPending: revealPending === true ? !revealReady : false,
      ownerUid: room.ownerUid === uid
        ? String(nextPlayerUids.find(Boolean) || "")
        : String(room.ownerUid || ""),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (status === "playing") {
      shouldNudgeBots = true;
    }

    return {
      ok: true,
      deleted: false,
      status: String(room.status || ""),
      humanCount: humans,
      botCount: nextBotCount,
      revealPending: revealPending === true ? !revealReady : false,
    };
  });

  if (shouldNudgeBots) {
    await processPendingBotTurns(roomId);
  }

  if (!shouldCleanup) {
    return result;
  }

  await cleanupRoom(roomRef);
  return {
    ok: true,
    deleted: true,
    status: "deleted",
  };
});

exports.finalizeGame = publicOnCall("finalizeGame", async (request) => {
  const { uid } = assertAuth(request);
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const roomId = String(payload.roomId || "").trim();

  if (!roomId) {
    throw new HttpsError("invalid-argument", "roomId requis.");
  }

  const roomRef = db.collection(ROOMS_COLLECTION).doc(roomId);
  return db.runTransaction(async (tx) => {
    const [roomSnap, stateSnap] = await Promise.all([
      tx.get(roomRef),
      tx.get(gameStateRef(roomId)),
    ]);
    if (!roomSnap.exists) {
      throw new HttpsError("not-found", "Salle introuvable.");
    }

    const room = roomSnap.data() || {};
    if (getSeatForUser(room, uid) < 0) {
      throw new HttpsError("permission-denied", "Tu ne fais pas partie de cette salle.");
    }

    const status = String(room.status || "");
    if (status === "ended" || status === "closing" || status === "closed") {
      return {
        ok: true,
        alreadyFinalized: true,
        status,
        winnerSeat: typeof room.winnerSeat === "number" ? room.winnerSeat : -1,
        winnerUid: String(room.winnerUid || ""),
      };
    }
    if (status !== "playing") {
      throw new HttpsError("failed-precondition", "La partie n'est pas en cours.");
    }

    const state = stateSnap.exists ? normalizeGameState(stateSnap.data(), room) : normalizeGameState({}, room);
    let winnerSeat = state.winnerSeat;
    let endedReason = state.endedReason || "";

    if (winnerSeat < 0) {
      for (let seat = 0; seat < 4; seat += 1) {
        if (countRemainingTilesForSeat(state.seatHands, seat) === 0) {
          winnerSeat = seat;
          endedReason = "out";
          break;
        }
      }
    }
    if (winnerSeat < 0 && safeInt(state.passesInRow) >= 4) {
      winnerSeat = computeBlockedWinnerSeat(state.seatHands);
      endedReason = "block";
    }
    if (winnerSeat < 0 || winnerSeat > 3) {
      throw new HttpsError("failed-precondition", "Aucun gagnant serveur disponible.");
    }

    const winnerUid = getWinnerUidForSeat(room, winnerSeat);
    tx.update(roomRef, {
      status: "ended",
      endedAt: admin.firestore.FieldValue.serverTimestamp(),
      endedAtMs: Date.now(),
      winnerSeat,
      winnerUid,
      endedReason: endedReason || "out",
      endClicks: {},
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(gameStateRef(roomId), {
      winnerSeat,
      winnerUid,
      endedReason: endedReason || "out",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return {
      ok: true,
      alreadyFinalized: false,
      status: "ended",
      winnerSeat,
      winnerUid,
      endedReason: endedReason || "out",
    };
  });
});

exports.confirmGameEnd = publicOnCall("confirmGameEnd", async (request) => {
  const { uid } = assertAuth(request);
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const roomId = String(payload.roomId || "").trim();

  if (!roomId) {
    throw new HttpsError("invalid-argument", "roomId requis.");
  }

  const roomRef = db.collection(ROOMS_COLLECTION).doc(roomId);
  let shouldCleanup = false;

  const result = await db.runTransaction(async (tx) => {
    const roomSnap = await tx.get(roomRef);
    if (!roomSnap.exists) {
      return {
        ok: true,
        state: "missing",
      };
    }

    const room = roomSnap.data() || {};
    if (getSeatForUser(room, uid) < 0) {
      throw new HttpsError("permission-denied", "Tu ne fais pas partie de cette salle.");
    }

    const status = String(room.status || "");
    if (status === "closed") {
      return {
        ok: true,
        state: "deleted",
      };
    }
    if (status === "closing") {
      shouldCleanup = true;
      return {
        ok: true,
        state: "pending",
      };
    }
    if (status !== "ended") {
      return {
        ok: true,
        state: "no_room",
      };
    }

    const playerUids = Array.isArray(room.playerUids) ? room.playerUids.filter(Boolean) : [];
    const currentEndClicks = room.endClicks && typeof room.endClicks === "object" ? room.endClicks : {};
    const nextEndClicks = {
      ...currentEndClicks,
      [uid]: true,
    };

    const allClicked = playerUids.length > 0 && playerUids.every((playerUid) => nextEndClicks[playerUid] === true);
    if (!allClicked) {
      tx.update(roomRef, {
        endClicks: nextEndClicks,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return {
        ok: true,
        state: "pending",
      };
    }

    shouldCleanup = true;
    tx.update(roomRef, {
      status: "closing",
      endClicks: nextEndClicks,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return {
      ok: true,
      state: "deleted",
    };
  });

  if (!shouldCleanup) {
    return result;
  }

  await cleanupRoom(roomRef);
  return {
    ok: true,
    state: "deleted",
  };
});

exports.submitAction = publicOnCall("submitAction", async (request) => {
  const { uid } = assertAuth(request);
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const roomId = String(payload.roomId || "").trim();
  const clientActionId = sanitizeText(payload.clientActionId || "", 80);
  const action = payload.action && typeof payload.action === "object" ? payload.action : null;

  if (!roomId || !action) {
    throw new HttpsError("invalid-argument", "roomId et action sont requis.");
  }
  if (!clientActionId) {
    throw new HttpsError("invalid-argument", "clientActionId requis.");
  }

  const type = String(action.type || "").trim();
  if (type !== "play" && type !== "pass") {
    throw new HttpsError("invalid-argument", "Type d'action invalide.");
  }

  const roomRef = db.collection(ROOMS_COLLECTION).doc(roomId);
  const result = await db.runTransaction(async (tx) => {
    const [roomSnap, stateSnap] = await Promise.all([
      tx.get(roomRef),
      tx.get(gameStateRef(roomId)),
    ]);
    if (!roomSnap.exists) {
      throw new HttpsError("not-found", "Salle introuvable.");
    }

    const room = roomSnap.data() || {};
    if (room.status !== "playing") {
      throw new HttpsError("failed-precondition", "La partie n'est pas en cours.");
    }
    if (room.startRevealPending === true) {
      throw new HttpsError("failed-precondition", "La partie se synchronise encore.");
    }
    const localSeat = getSeatForUser(room, uid);
    if (localSeat < 0) {
      throw new HttpsError("permission-denied", "Tu ne fais pas partie de cette salle.");
    }

    if (typeof room.currentPlayer === "number" && room.currentPlayer !== localSeat) {
      throw new HttpsError("failed-precondition", `Hors tour. Joueur attendu: ${room.currentPlayer + 1}`);
    }

    const currentState = stateSnap.exists
      ? normalizeGameState(stateSnap.data(), room)
      : createInitialGameState(room, Array.isArray(room.deckOrder) && room.deckOrder.length === 28 ? room.deckOrder : makeDeckOrder());

    if (currentState.winnerSeat >= 0) {
      throw new HttpsError("failed-precondition", "La partie est déjà terminée.");
    }
    if (typeof currentState.currentPlayer === "number" && currentState.currentPlayer !== localSeat) {
      throw new HttpsError("failed-precondition", `Hors tour. Joueur attendu: ${currentState.currentPlayer + 1}`);
    }

    if (currentState.idempotencyKeys[clientActionId] === true) {
      return {
        ok: true,
        duplicate: true,
        seq: safeSignedInt(currentState.appliedActionSeq),
        nextPlayer: currentState.currentPlayer,
        status: room.status,
      };
    }

    const resolvedMove = resolveRequestedMove(currentState, localSeat, action);
    const batchResult = applyActionBatchInTransaction(tx, roomRef, room, currentState, roomId, resolvedMove, uid);
    const nextState = batchResult.state;
    nextState.idempotencyKeys[clientActionId] = true;

    tx.set(gameStateRef(roomId), buildGameStateWrite(nextState), { merge: true });

    const roomUpdate = buildRoomUpdateFromGameState(room, nextState, batchResult.records);
    tx.update(roomRef, roomUpdate);

    const lastRecord = batchResult.records.length > 0 ? batchResult.records[batchResult.records.length - 1] : null;
    return {
      ok: true,
      duplicate: false,
      seq: lastRecord ? lastRecord.seq : safeSignedInt(nextState.appliedActionSeq),
      nextPlayer: nextState.currentPlayer,
      status: nextState.winnerSeat >= 0 ? "ended" : "playing",
      winnerSeat: nextState.winnerSeat,
      winnerUid: nextState.winnerUid,
      endedReason: nextState.endedReason,
    };
  });

  if (result?.status === "playing" && typeof result.nextPlayer === "number") {
    await processPendingBotTurns(roomId);
  }

  return result;
});

exports.claimWinReward = publicOnCall("claimWinReward", async (request) => {
  const { uid, email } = assertAuth(request);
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const roomId = String(payload.roomId || "").trim();

  if (!roomId) {
    throw new HttpsError("invalid-argument", "roomId requis.");
  }

  const roomRef = db.collection(ROOMS_COLLECTION).doc(roomId);
  const settlementRef = roomRef.collection("settlements").doc(uid);

  const result = await db.runTransaction(async (tx) => {
    const [roomSnap, settlementSnap, stateSnap] = await Promise.all([
      tx.get(roomRef),
      tx.get(settlementRef),
      tx.get(gameStateRef(roomId)),
    ]);

    if (!roomSnap.exists) {
      throw new HttpsError("not-found", "Salle introuvable.");
    }

    const room = roomSnap.data() || {};
    const seat = getSeatForUser(room, uid);
    const state = stateSnap.exists ? normalizeGameState(stateSnap.data(), room) : null;
    const winnerSeat = typeof room.winnerSeat === "number"
      ? room.winnerSeat
      : (state && typeof state.winnerSeat === "number" ? state.winnerSeat : -1);
    const winnerUid = String(room.winnerUid || state?.winnerUid || "").trim();

    if (winnerUid) {
      if (winnerUid !== uid) {
        throw new HttpsError("permission-denied", "Ce compte n'est pas gagnant de cette partie.");
      }
    } else if (seat < 0) {
      throw new HttpsError("permission-denied", "Ce compte ne fait pas partie de cette partie.");
    } else if (winnerSeat < 0 || seat !== winnerSeat) {
      throw new HttpsError("permission-denied", "Ce compte n'est pas gagnant de cette partie.");
    }

    const settlementData = settlementSnap.exists ? (settlementSnap.data() || {}) : {};
    if (settlementData.rewardPaid === true) {
      return {
        ok: true,
        rewardGranted: false,
        reason: "already_paid",
        rewardAmountDoes: safeInt(settlementData.rewardAmountDoes) || resolveRoomRewardDoes(room),
      };
    }

    const rewardAmountDoes = resolveRoomRewardDoes(room);
    if (rewardAmountDoes <= 0) {
      throw new HttpsError("failed-precondition", "Gain invalide pour cette salle.");
    }

    const walletMutation = await applyWalletMutationTx(tx, {
      uid,
      email,
      type: "game_reward",
      note: `Gain de partie (${roomId})`,
      amountDoes: rewardAmountDoes,
      amountGourdes: 0,
      deltaDoes: rewardAmountDoes,
      deltaExchangedGourdes: 0,
    });

    tx.set(settlementRef, {
      uid,
      roomId,
      rewardPaid: true,
      rewardAmountDoes,
      claimedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return {
      ok: true,
      rewardGranted: true,
      rewardAmountDoes,
      does: walletMutation.afterDoes,
    };
  });

  return result;
});

exports.recordAmbassadorOutcome = publicOnCall("recordAmbassadorOutcome", async (request) => {
  const { uid } = assertAuth(request);
  if (!AMBASSADOR_SYSTEM_ENABLED) {
    return {
      applied: false,
      changed: 0,
      skipped: 0,
      reason: "ambassador_disabled",
      results: [],
    };
  }
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const roomId = String(payload.roomId || "").trim();

  if (!roomId) {
    throw new HttpsError("invalid-argument", "roomId requis.");
  }

  const roomSnap = await db.collection(ROOMS_COLLECTION).doc(roomId).get();
  if (!roomSnap.exists) {
    throw new HttpsError("not-found", "Salle introuvable.");
  }

  const room = roomSnap.data() || {};
  const participants = Array.isArray(room.playerUids)
    ? [...new Set(room.playerUids.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
  if (!participants.includes(uid)) {
    throw new HttpsError("permission-denied", "Tu ne fais pas partie de cette salle.");
  }

  let winnerUid = String(room.winnerUid || "").trim();
  const winnerSeat = typeof room.winnerSeat === "number" ? Math.trunc(room.winnerSeat) : -1;
  if (!winnerUid && Array.isArray(room.playerUids) && winnerSeat >= 0 && winnerSeat < room.playerUids.length) {
    winnerUid = String(room.playerUids[winnerSeat] || "").trim();
  }

  if (!winnerUid) {
    throw new HttpsError("failed-precondition", "Le gagnant de la partie n'est pas encore connu.");
  }

  const results = [];
  let changed = 0;

  for (const playerUid of participants) {
    const result = await db.runTransaction(async (tx) => {
      const playerRef = walletRef(playerUid);
      const eventRef = db.collection(AMBASSADOR_EVENTS_COLLECTION).doc(`${roomId}_${playerUid}`);
      const [playerSnap, eventSnap] = await Promise.all([
        tx.get(playerRef),
        tx.get(eventRef),
      ]);

      if (eventSnap.exists) {
        return { playerUid, applied: false, reason: "already_recorded" };
      }
      if (!playerSnap.exists) {
        return { playerUid, applied: false, reason: "client_not_found" };
      }

      const playerData = playerSnap.data() || {};
      const ambassadorContext = deriveRootAmbassadorContext(playerData);
      const depth = Math.max(1, safeInt(playerData.ambassadorDepthFromRoot || ambassadorContext?.depth || 0));
      const isEligible = playerData.ambassadorCommissionEligible !== false && depth <= 3;
      if (!ambassadorContext?.rootAmbassadorId || !isEligible) {
        return { playerUid, applied: false, reason: "no_eligible_ambassador" };
      }

      const ambassadorRef = db.collection(AMBASSADORS_COLLECTION).doc(ambassadorContext.rootAmbassadorId);
      const ambassadorReferralRef = ambassadorRef.collection("referrals").doc(playerUid);
      const [ambassadorSnap, ambassadorReferralSnap] = await Promise.all([
        tx.get(ambassadorRef),
        tx.get(ambassadorReferralRef),
      ]);

      if (!ambassadorSnap.exists) {
        return { playerUid, applied: false, reason: "ambassador_not_found" };
      }

      const ambassadorData = ambassadorSnap.data() || {};
      const referralData = ambassadorReferralSnap.exists ? (ambassadorReferralSnap.data() || {}) : {};
      const delta = playerUid === winnerUid ? -AMBASSADOR_WIN_PENALTY : AMBASSADOR_LOSS_BONUS;
      const totalGamesTracked = safeInt(referralData.totalGamesTracked || referralData.totalGames) + 1;
      const winsTracked = safeInt(referralData.winsTracked || referralData.winCount) + (delta < 0 ? 1 : 0);
      const lossesTracked = safeInt(referralData.lossesTracked || referralData.lossCount) + (delta > 0 ? 1 : 0);

      tx.set(ambassadorRef, {
        doesBalance: safeSignedInt(ambassadorData.doesBalance) + delta,
        totalGames: safeInt(ambassadorData.totalGames) + 1,
        totalInvitedWins: safeInt(ambassadorData.totalInvitedWins) + (delta < 0 ? 1 : 0),
        totalInvitedLosses: safeInt(ambassadorData.totalInvitedLosses) + (delta > 0 ? 1 : 0),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      tx.set(ambassadorReferralRef, {
        userId: playerUid,
        clientUid: playerUid,
        email: sanitizeEmail(playerData.email || referralData.email || "", 160),
        displayName: sanitizeText(playerData.name || playerData.email || referralData.displayName || playerUid, 80),
        depth,
        parentClientUid: String(referralData.parentClientUid || "").trim(),
        rootAmbassadorId: ambassadorContext.rootAmbassadorId,
        isCommissionEligible: true,
        hasApprovedDeposit: playerData.hasApprovedDeposit === true,
        depositCount: playerData.hasApprovedDeposit === true
          ? Math.max(1, safeInt(referralData.depositCount || 1))
          : safeInt(referralData.depositCount),
        totalGamesTracked,
        totalGames: totalGamesTracked,
        winsTracked,
        winCount: winsTracked,
        lossesTracked,
        lossCount: lossesTracked,
        ambassadorDoesDelta: safeSignedInt(referralData.ambassadorDoesDelta) + delta,
        lastGameAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: referralData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      tx.set(eventRef, {
        roomId,
        playerUid,
        ambassadorId: ambassadorContext.rootAmbassadorId,
        depth,
        delta,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      tx.set(playerRef, {
        lastGameAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      return {
        playerUid,
        ambassadorId: ambassadorContext.rootAmbassadorId,
        delta,
        applied: true,
      };
    });

    results.push(result);
    if (result.applied) changed += 1;
  }

  return {
    applied: changed > 0,
    roomId,
    changed,
    skipped: results.length - changed,
    results,
  };
});

function messagePreviewFromRecord(data = {}) {
  const text = sanitizeText(data.text || "", 120);
  if (text) return text;
  if (String(data.mediaType || "") === "video") return "Video";
  if (String(data.mediaType || "") === "image") return "Image";
  return "Message";
}

function sanitizeGuestThreadId(value = "") {
  const safe = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 160);
  return safe.startsWith("guest_") ? safe : "";
}

function defaultGuestDisplayName(guestId = "") {
  const suffix = String(guestId || "").slice(-4).toUpperCase();
  return suffix ? `Anonyme ${suffix}` : "Anonyme";
}

function randomGuestAccessToken() {
  return crypto.randomBytes(24).toString("hex");
}

function supportThreadRecordForCallable(docSnap) {
  const base = snapshotRecordForCallable(docSnap);
  delete base.guestAccessToken;
  return base;
}

function sanitizeSupportMediaPayload(raw = {}) {
  const mediaType = sanitizeText(raw?.mediaType || "", 16).toLowerCase();
  if (mediaType !== "image" && mediaType !== "video") {
    return {
      mediaType: "",
      mediaUrl: "",
      mediaPath: "",
      fileName: "",
    };
  }

  const mediaUrl = sanitizeStorageAssetUrl(raw?.mediaUrl || "", 2000);
  const mediaPath = sanitizeText(raw?.mediaPath || "", 600);
  if (!mediaUrl || !mediaPath.startsWith("chat-media/")) {
    return {
      mediaType: "",
      mediaUrl: "",
      mediaPath: "",
      fileName: "",
    };
  }

  return {
    mediaType,
    mediaUrl,
    mediaPath,
    fileName: sanitizeText(raw?.fileName || "", 120),
  };
}

function supportMediaMatchesThread(mediaPath = "", threadId = "") {
  const safePath = String(mediaPath || "").trim();
  const safeThreadId = String(threadId || "").trim();
  if (!safePath || !safeThreadId) return false;
  return safePath.startsWith(`chat-media/support/${safeThreadId}/`);
}

function buildSupportMessageRecord(actor = {}, text = "", media = null, extras = {}) {
  const createdAtMs = Date.now();
  const expiresAtMs = createdAtMs + DISCUSSION_MESSAGE_RETENTION_MS;
  const safeMedia = sanitizeSupportMediaPayload(media);

  return {
    text: sanitizeText(text || "", MAX_PUBLIC_TEXT_LENGTH),
    mediaType: safeMedia.mediaType,
    mediaUrl: safeMedia.mediaUrl,
    mediaPath: safeMedia.mediaPath,
    fileName: safeMedia.fileName,
    senderRole: sanitizeText(actor.senderRole || "user", 20),
    senderType: sanitizeText(actor.senderType || "user", 20),
    senderKey: sanitizeText(actor.senderKey || "", 160),
    uid: sanitizeText(actor.uid || "", 160),
    guestId: sanitizeText(actor.guestId || "", 160),
    email: sanitizeEmail(actor.email || "", 160),
    displayName: sanitizeText(actor.displayName || "Utilisateur", 80) || "Utilisateur",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAtMs,
    expiresAtMs,
    expiresAt: admin.firestore.Timestamp.fromMillis(expiresAtMs),
    editedAtMs: 0,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...extras,
  };
}

async function resolveSupportThreadContext(request, payload = {}, options = {}) {
  const allowCreate = options.allowCreate !== false;

  if (request.auth?.uid) {
    const { uid, email } = assertAuth(request);
    const threadId = `user_${uid}`;
    const threadRef = db.collection(SUPPORT_THREADS_COLLECTION).doc(threadId);
    const [threadSnap, clientSnap] = await Promise.all([
      threadRef.get(),
      walletRef(uid).get(),
    ]);
    const clientData = clientSnap.exists ? (clientSnap.data() || {}) : {};
    const displayName = sanitizeText(
      clientData.name || clientData.displayName || String(email || "").split("@")[0] || "Utilisateur",
      80
    ) || "Utilisateur";

    if (!threadSnap.exists && !allowCreate) {
      throw new HttpsError("not-found", "Fil support introuvable.");
    }

    const patch = {
      threadId,
      participantType: "user",
      participantId: uid,
      participantUid: uid,
      guestId: "",
      participantName: displayName,
      participantEmail: sanitizeEmail(email || "", 160),
      status: threadSnap.exists ? sanitizeText(threadSnap.data()?.status || "open", 16) || "open" : "open",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!threadSnap.exists) {
      patch.createdAt = admin.firestore.FieldValue.serverTimestamp();
      patch.createdAtMs = Date.now();
      patch.lastMessageText = "Aucun message";
      patch.lastMessageAt = null;
      patch.lastMessageAtMs = 0;
      patch.lastSenderRole = "";
      patch.unreadForAgent = false;
      patch.unreadForUser = false;
      patch.firstAgentReplyAt = null;
      patch.firstAgentReplyAtMs = 0;
      patch.resolvedAt = null;
      patch.resolvedAtMs = 0;
      patch.resolutionTag = "";
    }

    await threadRef.set(patch, { merge: true });
    const freshSnap = await threadRef.get();

    return {
      threadId,
      threadRef,
      threadSnap: freshSnap,
      guestToken: "",
      actor: {
        senderRole: "user",
        senderType: "user",
        senderKey: uid,
        uid,
        guestId: "",
        email: sanitizeEmail(email || "", 160),
        displayName,
      },
    };
  }

  const guestId = sanitizeGuestThreadId(payload.guestId || "");
  if (!guestId) {
    throw new HttpsError("invalid-argument", "Identifiant invité invalide.");
  }

  const threadId = guestId;
  const threadRef = db.collection(SUPPORT_THREADS_COLLECTION).doc(threadId);
  const requestedToken = sanitizeText(payload.guestToken || "", 128);
  const requestedName = sanitizeText(payload.displayName || "", 80);
  const displayName = requestedName || defaultGuestDisplayName(guestId);
  const threadSnap = await threadRef.get();

  if (!threadSnap.exists && !allowCreate) {
    throw new HttpsError("not-found", "Fil support introuvable.");
  }

  let issuedToken = "";
  if (!threadSnap.exists) {
    issuedToken = randomGuestAccessToken();
    await threadRef.set({
      threadId,
      participantType: "guest",
      participantId: guestId,
      participantUid: "",
      guestId,
      participantName: displayName,
      participantEmail: "",
      guestAccessToken: issuedToken,
      status: "open",
      unreadForAgent: false,
      unreadForUser: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
      lastMessageText: "Aucun message",
      lastMessageAt: null,
      lastMessageAtMs: 0,
      lastSenderRole: "",
      firstAgentReplyAt: null,
      firstAgentReplyAtMs: 0,
      resolvedAt: null,
      resolvedAtMs: 0,
      resolutionTag: "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } else {
    const existingData = threadSnap.data() || {};
    issuedToken = sanitizeText(existingData.guestAccessToken || "", 128);
    if (!issuedToken) {
      issuedToken = randomGuestAccessToken();
    } else if (!requestedToken || requestedToken !== issuedToken) {
      throw new HttpsError("permission-denied", "Accès invité refusé.");
    }

    await threadRef.set({
      participantName: displayName,
      guestAccessToken: issuedToken,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  const freshSnap = await threadRef.get();
  return {
    threadId,
    threadRef,
    threadSnap: freshSnap,
    guestToken: issuedToken,
    actor: {
      senderRole: "guest",
      senderType: "guest",
      senderKey: guestId,
      uid: "",
      guestId,
      email: "",
      displayName,
    },
  };
}

async function refreshSupportThreadSummaryAdmin(threadId = "") {
  const safeThreadId = String(threadId || "").trim();
  if (!safeThreadId) return;

  const latestSnap = await db.collection(SUPPORT_THREADS_COLLECTION)
    .doc(safeThreadId)
    .collection(SUPPORT_MESSAGES_SUBCOLLECTION)
    .orderBy("createdAtMs", "desc")
    .limit(1)
    .get();

  if (latestSnap.empty) {
    await db.collection(SUPPORT_THREADS_COLLECTION).doc(safeThreadId).set({
      lastMessageText: "Aucun message",
      lastMessageAt: null,
      lastMessageAtMs: 0,
      lastSenderRole: "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return;
  }

  const latest = latestSnap.docs[0].data() || {};
  const patch = {
    lastMessageText: messagePreviewFromRecord(latest),
    lastMessageAtMs: safeInt(latest.createdAtMs),
    lastSenderRole: sanitizeText(latest.senderRole || "", 20),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (latest.createdAt) {
    patch.lastMessageAt = latest.createdAt;
  }
  await db.collection(SUPPORT_THREADS_COLLECTION).doc(safeThreadId).set(patch, { merge: true });
}

function collectUniqueDocsFromSnapshots(...snapshots) {
  const seen = new Set();
  const out = [];
  for (const snap of snapshots) {
    for (const docSnap of snap?.docs || []) {
      const path = String(docSnap?.ref?.path || "");
      if (!path || seen.has(path)) continue;
      seen.add(path);
      out.push(docSnap);
    }
  }
  return out;
}

async function deleteDiscussionMediaIfNeeded(data = {}) {
  const mediaPath = String(data.mediaPath || "").trim();
  if (!mediaPath) return;
  try {
    await admin.storage().bucket().file(mediaPath).delete();
  } catch (error) {
    const code = Number(error?.code || 0);
    const notFound = code === 404 || String(error?.message || "").toLowerCase().includes("no such object");
    if (!notFound) {
      throw error;
    }
  }
}

exports.purgeExpiredDiscussionMessages = onSchedule("every 60 minutes", async () => {
  const nowMs = Date.now();
  const legacyCutoffMs = nowMs - DISCUSSION_MESSAGE_RETENTION_MS;

  const [
    channelByExpirySnap,
    channelLegacySnap,
    supportByExpirySnap,
    supportLegacySnap,
  ] = await Promise.all([
    db.collection(CHAT_COLLECTION)
      .where("expiresAtMs", "<=", nowMs)
      .limit(DISCUSSION_PURGE_BATCH_SIZE)
      .get(),
    db.collection(CHAT_COLLECTION)
      .where("createdAtMs", "<=", legacyCutoffMs)
      .limit(DISCUSSION_PURGE_BATCH_SIZE)
      .get(),
    db.collectionGroup(SUPPORT_MESSAGES_SUBCOLLECTION)
      .where("expiresAtMs", "<=", nowMs)
      .limit(DISCUSSION_PURGE_BATCH_SIZE)
      .get(),
    db.collectionGroup(SUPPORT_MESSAGES_SUBCOLLECTION)
      .where("createdAtMs", "<=", legacyCutoffMs)
      .limit(DISCUSSION_PURGE_BATCH_SIZE)
      .get(),
  ]);

  const expiredChannelDocs = collectUniqueDocsFromSnapshots(channelByExpirySnap, channelLegacySnap);
  const expiredSupportDocs = collectUniqueDocsFromSnapshots(supportByExpirySnap, supportLegacySnap);
  const touchedThreads = new Set();
  let channelDeleted = 0;
  let supportDeleted = 0;
  let mediaErrors = 0;

  for (const docSnap of expiredChannelDocs) {
    const data = docSnap.data() || {};
    const expiresAtMs = safeSignedInt(data.expiresAtMs) || (safeSignedInt(data.createdAtMs) + DISCUSSION_MESSAGE_RETENTION_MS);
    if (expiresAtMs > nowMs) continue;
    try {
      await deleteDiscussionMediaIfNeeded(data);
      await docSnap.ref.delete();
      channelDeleted += 1;
    } catch (error) {
      mediaErrors += 1;
      console.warn("[DISCUSSION_PURGE][CHANNEL]", docSnap.ref.path, error?.message || error);
    }
  }

  for (const docSnap of expiredSupportDocs) {
    const data = docSnap.data() || {};
    const threadId = String(docSnap.ref.parent?.parent?.id || "").trim();
    const expiresAtMs = safeSignedInt(data.expiresAtMs) || (safeSignedInt(data.createdAtMs) + DISCUSSION_MESSAGE_RETENTION_MS);
    if (expiresAtMs > nowMs) continue;
    try {
      await deleteDiscussionMediaIfNeeded(data);
      await docSnap.ref.delete();
      if (threadId) touchedThreads.add(threadId);
      supportDeleted += 1;
    } catch (error) {
      mediaErrors += 1;
      console.warn("[DISCUSSION_PURGE][SUPPORT]", docSnap.ref.path, error?.message || error);
    }
  }

  for (const threadId of touchedThreads) {
    try {
      await refreshSupportThreadSummaryAdmin(threadId);
    } catch (error) {
      console.warn("[DISCUSSION_PURGE][THREAD_SUMMARY]", threadId, error?.message || error);
    }
  }

  console.info("[DISCUSSION_PURGE]", JSON.stringify({
    channelDeleted,
    supportDeleted,
    touchedThreads: touchedThreads.size,
    mediaErrors,
  }));
});

async function getSettingsSnapshotData() {
  const data = await readRawPublicAppSettings();
  return normalizePublicAppSettings(data);
}

async function getPublicPaymentConfig() {
  const [settings, methodsSnap] = await Promise.all([
    getSettingsSnapshotData(),
    db.collection("paymentMethods").get(),
  ]);
  const methods = methodsSnap.docs
    .map((item) => sanitizePublicMethod(item))
    .filter(Boolean);
  return { settings, methods };
}

exports.getPublicPaymentOptionsSecure = publicOnCall("getPublicPaymentOptionsSecure", async () => {
  const data = await getPublicPaymentConfig();
  return {
    methods: data.methods,
    settings: data.settings,
  };
});

exports.getPublicGameStakeOptionsSecure = publicOnCall("getPublicGameStakeOptionsSecure", async () => {
  const settings = await getSettingsSnapshotData();
  return {
    options: settings.gameStakeOptions.map((item) => ({
      id: item.id,
      stakeDoes: item.stakeDoes,
      rewardDoes: item.rewardDoes,
      enabled: item.enabled === true,
      sortOrder: item.sortOrder,
    })),
  };
});

exports.getPublicRuntimeConfigSecure = publicOnCall("getPublicRuntimeConfigSecure", async () => {
  const settings = await getSettingsSnapshotData();
  return {
    appCheckSiteKey: String(settings.appCheckSiteKey || ""),
    appCheckConfigured: !!String(settings.appCheckSiteKey || "").trim(),
  };
});

exports.getDpaymentBootstrapConfig = publicOnCall("getDpaymentBootstrapConfig", async () => {
  const snap = await adminBootstrapRef().get();
  if (!snap.exists) {
    return {
      ok: true,
      bootstrapped: false,
      email: "",
    };
  }

  const data = snap.data() || {};
  const email = String(data.email || "").trim().toLowerCase();
  return {
    ok: true,
    bootstrapped: email === FINANCE_ADMIN_EMAIL,
    email: email === FINANCE_ADMIN_EMAIL ? email : "",
  };
});

exports.getGlobalAnalyticsSnapshot = publicOnCall("getGlobalAnalyticsSnapshot", async (request) => {
  assertFinanceAdmin(request);
  const botDifficulty = await getConfiguredBotDifficulty();
  const [
    clientsSnap,
    ambassadorsSnap,
    roomsSnap,
    ordersSnap,
    withdrawalsSnap,
    xchangesSnap,
    referralRewardsSnap,
    referralsSnap,
    channelSnap,
    threadsSnap,
    supportMessagesSnap,
  ] = await Promise.all([
    db.collection(CLIENTS_COLLECTION).get(),
    db.collection(AMBASSADORS_COLLECTION).get(),
    db.collection(ROOMS_COLLECTION).get(),
    db.collectionGroup("orders").get(),
    db.collectionGroup("withdrawals").get(),
    db.collectionGroup("xchanges").get(),
    db.collectionGroup("referralRewards").get(),
    db.collectionGroup("referrals").get(),
    db.collection(CHAT_COLLECTION).get(),
    db.collection(SUPPORT_THREADS_COLLECTION).get(),
    db.collectionGroup(SUPPORT_MESSAGES_SUBCOLLECTION).get(),
  ]);

  const referrals = referralsSnap.docs.map(referralRecordForCallable);

  return {
    generatedAtMs: Date.now(),
    botDifficulty,
    clients: clientsSnap.docs.map(snapshotRecordForCallable),
    ambassadors: ambassadorsSnap.docs.map(snapshotRecordForCallable),
    rooms: roomsSnap.docs.map(snapshotRecordForCallable),
    orders: ordersSnap.docs.map(subcollectionRecordForCallable),
    withdrawals: withdrawalsSnap.docs.map(subcollectionRecordForCallable),
    xchanges: xchangesSnap.docs.map(subcollectionRecordForCallable),
    referralRewards: referralRewardsSnap.docs.map(subcollectionRecordForCallable),
    clientReferrals: referrals.filter((item) => item.ownerCollection === CLIENTS_COLLECTION),
    ambassadorReferrals: referrals.filter((item) => item.ownerCollection === AMBASSADORS_COLLECTION),
    channelMessages: channelSnap.docs.map(snapshotRecordForCallable),
    supportThreads: threadsSnap.docs.map(snapshotRecordForCallable),
    supportMessages: supportMessagesSnap.docs.map(supportMessageRecordForCallable),
  };
});

exports.updateClientProfileSecure = publicOnCall("updateClientProfileSecure", async (request) => {
  const { uid, email } = assertAuth(request);
  const payload = request.data && typeof request.data === "object" ? request.data : {};

  const name = sanitizeText(payload.name || "", 80);
  const phone = sanitizePhone(payload.phone || "", 40);
  const photoURL = sanitizePublicAsset(payload.photoURL || "", 400);
  const usernameInput = sanitizeUsername(payload.username || "", 24);
  const oneClickIdInput = sanitizeText(payload.oneClickId || "", 64).toUpperCase();
  const promoCode = normalizeCode(payload.promoCode || "");
  const referralSource = String(payload.referralSource || "").toLowerCase() === "link" ? "link" : "promo";
  const context = sanitizeAnalyticsContext(payload, request);
  const ref = walletRef(uid);
  const snap = await ref.get();
  const current = snap.exists ? (snap.data() || {}) : {};
  const isNewProfile = !snap.exists;
  let referralCode = normalizeCode(current.referralCode || "");

  if (!referralCode) {
    referralCode = await generateUniqueClientReferralCode(uid);
  }

  const profile = {
    uid,
    email: email || String(current.email || ""),
    name: name || sanitizeText(current.name || String(email || "").split("@")[0] || "Player", 80),
    phone: phone || sanitizePhone(current.phone || ""),
    photoURL: photoURL || sanitizePublicAsset(current.photoURL || ""),
    username: usernameInput || sanitizeUsername(current.username || "", 24),
    oneClickId: oneClickIdInput || sanitizeText(current.oneClickId || "", 64).toUpperCase(),
    referralCode,
    deviceId: context.deviceId || String(current.deviceId || ""),
    appVersion: context.appVersion || String(current.appVersion || ""),
    country: context.country || String(current.country || ""),
    browser: context.browser || String(current.browser || ""),
    ipHash: context.ipHash || String(current.ipHash || ""),
    utmSource: String(current.utmSource || "") || context.utmSource || "",
    utmCampaign: String(current.utmCampaign || "") || context.utmCampaign || "",
    landingPage: String(current.landingPage || "") || context.landingPage || "",
    creativeId: String(current.creativeId || "") || context.creativeId || "",
    lastLandingPage: context.landingPage || String(current.lastLandingPage || current.landingPage || ""),
    lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSeenAtMs: Date.now(),
    lastAuthAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (isNewProfile) {
    profile.createdAt = admin.firestore.FieldValue.serverTimestamp();
    profile.createdAtMs = Date.now();
    profile.doesBalance = safeInt(current.doesBalance);
    profile.exchangedGourdes = safeSignedInt(current.exchangedGourdes);
    profile.pendingPlayFromXchangeDoes = safeInt(current.pendingPlayFromXchangeDoes);
    profile.pendingPlayFromReferralDoes = safeInt(current.pendingPlayFromReferralDoes);
    profile.totalExchangedHtgEver = safeInt(current.totalExchangedHtgEver);
    profile.referralSignupsTotal = safeInt(current.referralSignupsTotal);
    profile.referralSignupsViaLink = safeInt(current.referralSignupsViaLink);
    profile.referralSignupsViaCode = safeInt(current.referralSignupsViaCode);
    profile.referralDepositsTotal = safeInt(current.referralDepositsTotal);
  } else {
    if (typeof current.referralSignupsTotal !== "number") profile.referralSignupsTotal = safeInt(current.referralSignupsTotal);
    if (typeof current.referralSignupsViaLink !== "number") profile.referralSignupsViaLink = safeInt(current.referralSignupsViaLink);
    if (typeof current.referralSignupsViaCode !== "number") profile.referralSignupsViaCode = safeInt(current.referralSignupsViaCode);
    if (typeof current.referralDepositsTotal !== "number") profile.referralDepositsTotal = safeInt(current.referralDepositsTotal);
  }

  await ref.set(profile, { merge: true });

  let referralBootstrap = { applied: false, reason: "no_candidate" };
  if (isNewProfile && promoCode) {
    referralBootstrap = await applyPromoAttribution({
      uid,
      email,
      promoCode,
      via: referralSource,
    });
  }

  const finalSnap = await ref.get();
  const finalProfile = finalSnap.exists ? (finalSnap.data() || {}) : {};
  const finalReferralCode = normalizeCode(finalProfile.referralCode || referralCode);

  return {
    ok: true,
    profile: {
      name: String(finalProfile.name || profile.name || ""),
      phone: sanitizePhone(finalProfile.phone || profile.phone || ""),
      photoURL: sanitizePublicAsset(finalProfile.photoURL || profile.photoURL || ""),
      username: sanitizeUsername(finalProfile.username || profile.username || "", 24),
      oneClickId: sanitizeText(finalProfile.oneClickId || profile.oneClickId || "", 64).toUpperCase(),
      referralCode: finalReferralCode,
      referralLink: buildUserReferralLink(finalReferralCode),
      referralSignupsTotal: safeInt(finalProfile.referralSignupsTotal),
      referralDepositsTotal: safeInt(finalProfile.referralDepositsTotal),
      referredByType: sanitizeText(finalProfile.referredByType || "", 20),
      referredByCode: normalizeCode(finalProfile.referredByCode || ""),
      updatedAt: new Date().toISOString(),
    },
    referralApplied: referralBootstrap.applied === true,
    referralReason: String(referralBootstrap.reason || ""),
  };
});

exports.createOrderSecure = publicOnCall("createOrderSecure", async (request) => {
  const { uid, email } = assertAuth(request);
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const methodId = sanitizeText(payload.methodId || "", 120);
  const amountHtg = safeInt(payload.amountHtg);
  const customerName = sanitizeText(payload.customerName || "", 120);
  const customerEmail = sanitizeEmail(payload.customerEmail || email || "", 160) || sanitizeEmail(email || "", 160);
  const customerPhone = sanitizePhone(payload.customerPhone || "", 40);
  const proofRef = sanitizeText(payload.proofRef || "", 180);

  if (!methodId || amountHtg < MIN_ORDER_HTG || !customerName || !proofRef) {
    throw new HttpsError("invalid-argument", "Commande invalide.");
  }

  const methodSnap = await db.collection("paymentMethods").doc(methodId).get();
  if (!methodSnap.exists) {
    throw new HttpsError("not-found", "Méthode introuvable.");
  }
  const publicMethod = sanitizePublicMethod(methodSnap);
  if (!publicMethod) {
    throw new HttpsError("failed-precondition", "Méthode indisponible.");
  }

  const settings = await getSettingsSnapshotData();
  const orderRef = db.collection(CLIENTS_COLLECTION).doc(uid).collection("orders").doc();
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const clientRef = walletRef(uid);
  const clientSnap = await clientRef.get();
  const clientData = clientSnap.exists ? (clientSnap.data() || {}) : {};
  const orderData = {
    uid,
    clientId: uid,
    clientUid: uid,
    amount: amountHtg,
    methodId,
    methodName: publicMethod.name,
    methodDetails: {
      name: publicMethod.name,
      accountName: publicMethod.accountName,
      phoneNumber: publicMethod.phoneNumber,
    },
    status: "pending",
    uniqueCode: `VLX-${crypto.randomBytes(4).toString("hex").toUpperCase()}-${Date.now().toString(36).toUpperCase()}`,
    proofRef,
    customerName,
    customerEmail,
    customerPhone,
    extractedText: sanitizeText(payload.extractedText || "", MAX_PUBLIC_TEXT_LENGTH),
    extractedTextStatus: ["pending", "success", "empty", "failed"].includes(String(payload.extractedTextStatus || ""))
      ? String(payload.extractedTextStatus)
      : "pending",
    createdAtMs: nowMs,
    createdAt: nowIso,
    expiresAt: new Date(Date.now() + (settings.verificationHours * 60 * 60 * 1000)).toISOString(),
    updatedAt: nowIso,
    deviceId: sanitizeText(clientData.deviceId || "", 120),
    appVersion: sanitizeText(clientData.appVersion || "", 48),
    country: sanitizeText(clientData.country || "", 48),
    browser: sanitizeText(clientData.browser || "", 120),
    ipHash: sanitizeText(clientData.ipHash || "", 64),
    utmSource: sanitizeText(clientData.utmSource || "", 80),
    utmCampaign: sanitizeText(clientData.utmCampaign || "", 120),
    landingPage: sanitizeText(clientData.landingPage || "", 240),
    creativeId: sanitizeText(clientData.creativeId || "", 120),
  };
  await clientRef.set({
    uid,
    email,
    name: customerName || sanitizeText(clientData.name || "", 80) || sanitizeText(String(email || "").split("@")[0], 80) || "Player",
    phone: customerPhone || sanitizePhone(clientData.phone || ""),
    lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSeenAtMs: nowMs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(clientSnap.exists ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
  }, { merge: true });
  await orderRef.set(orderData, { merge: true });

  return {
    ok: true,
    orderId: orderRef.id,
    status: orderData.status,
  };
});

exports.createWithdrawalSecure = publicOnCall("createWithdrawalSecure", async (request) => {
  const { uid, email } = assertAuth(request);
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const requestedAmount = safeInt(payload.requestedAmount ?? payload.amountHtg ?? payload.amountDoes);
  const destinationType = sanitizeText(payload.destinationType || payload.methodId || "", 80);
  const destinationValue = sanitizeText(payload.destinationValue || payload.phone || "", 160);
  const customerName = sanitizeText(payload.customerName || "", 120);
  const customerPhone = sanitizePhone(payload.customerPhone || payload.phone || "", 40);

  if (!destinationType || !destinationValue || requestedAmount < MIN_WITHDRAWAL_HTG || requestedAmount > MAX_WITHDRAWAL_HTG) {
    throw new HttpsError("invalid-argument", "Retrait invalide.");
  }

  const [ordersSnap, withdrawalsSnap] = await Promise.all([
    db.collection(CLIENTS_COLLECTION).doc(uid).collection("orders").where("status", "==", "approved").get(),
    db.collection(CLIENTS_COLLECTION).doc(uid).collection("withdrawals").get(),
  ]);

  const approvedDeposits = ordersSnap.docs.reduce((sum, item) => sum + safeInt(item.data()?.amount), 0);
  const reservedWithdrawals = withdrawalsSnap.docs.reduce((sum, item) => {
    const data = item.data() || {};
    if (data.status === "rejected") return sum;
    return sum + safeInt(data.requestedAmount ?? data.amount);
  }, 0);
  const available = Math.max(0, approvedDeposits - reservedWithdrawals);

  if (requestedAmount > available) {
    throw new HttpsError("failed-precondition", "Montant supérieur au solde disponible.");
  }

  const ref = db.collection(CLIENTS_COLLECTION).doc(uid).collection("withdrawals").doc();
  const nowIso = new Date().toISOString();
  await ref.set({
    uid,
    clientId: uid,
    clientUid: uid,
    status: "pending",
    requestedAmount,
    amount: requestedAmount,
    methodId: destinationType,
    methodName: destinationType,
    destinationType,
    destinationValue,
    customerName,
    customerEmail: sanitizeEmail(email || "", 160),
    customerPhone,
    createdAt: nowIso,
    updatedAt: nowIso,
  }, { merge: true });

  await walletRef(uid).set({
    uid,
    email,
    name: customerName || sanitizeText(String(email || "").split("@")[0], 80) || "Player",
    phone: customerPhone,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return {
    ok: true,
    withdrawalId: ref.id,
    status: "pending",
  };
});

exports.orderClientActionSecure = publicOnCall("orderClientActionSecure", async (request) => {
  const { uid } = assertAuth(request);
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const kind = String(payload.kind || "").trim();
  const id = sanitizeText(payload.id || "", 160);
  const action = String(payload.action || "").trim();

  if (!id || (kind !== "order" && kind !== "withdrawal") || (action !== "hide" && action !== "review")) {
    throw new HttpsError("invalid-argument", "Action client invalide.");
  }

  const subcollection = kind === "withdrawal" ? "withdrawals" : "orders";
  const ref = db.collection(CLIENTS_COLLECTION).doc(uid).collection(subcollection).doc(id);
  const updates = {
    updatedAt: new Date().toISOString(),
  };

  if (action === "hide") {
    updates.userHiddenByClient = true;
    updates.userHiddenAt = new Date().toISOString();
  } else {
    updates.status = "review";
    updates.reviewRequestedByClient = true;
    updates.reviewRequestedAt = new Date().toISOString();
    updates.userHiddenByClient = false;
  }

  await ref.set(updates, { merge: true });
  return { ok: true };
});

exports.markChatSeenSecure = publicOnCall("markChatSeenSecure", async (request) => {
  const { uid, email } = assertAuth(request);
  await walletRef(uid).set({
    uid,
    email,
    chatLastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSeenAtMs: Date.now(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true };
});

exports.ensureSupportThreadSecure = publicOnCall("ensureSupportThreadSecure", async (request) => {
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const context = await resolveSupportThreadContext(request, payload, { allowCreate: true });
  return {
    ok: true,
    threadId: context.threadId,
    guestToken: context.guestToken || "",
    thread: supportThreadRecordForCallable(context.threadSnap),
  };
});

exports.getSupportMessagesSecure = publicOnCall("getSupportMessagesSecure", async (request) => {
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const context = await resolveSupportThreadContext(request, payload, { allowCreate: true });
  const limitValue = Math.max(
    1,
    Math.min(
      DISCUSSION_MESSAGES_FETCH_LIMIT,
      safeInt(payload.limit || DISCUSSION_MESSAGES_FETCH_LIMIT) || DISCUSSION_MESSAGES_FETCH_LIMIT
    )
  );
  const messagesSnap = await context.threadRef
    .collection(SUPPORT_MESSAGES_SUBCOLLECTION)
    .orderBy("createdAtMs", "desc")
    .limit(limitValue)
    .get();

  const messages = messagesSnap.docs
    .map((item) => supportMessageRecordForCallable(item))
    .reverse();

  return {
    ok: true,
    threadId: context.threadId,
    guestToken: context.guestToken || "",
    thread: supportThreadRecordForCallable(context.threadSnap),
    messages,
  };
});

exports.createSupportMessageSecure = publicOnCall("createSupportMessageSecure", async (request) => {
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const context = await resolveSupportThreadContext(request, payload, { allowCreate: true });
  const text = sanitizeText(payload.text || "", MAX_PUBLIC_TEXT_LENGTH);
  const media = sanitizeSupportMediaPayload(payload.media || {});
  if (media.mediaPath && !supportMediaMatchesThread(media.mediaPath, context.threadId)) {
    throw new HttpsError("invalid-argument", "Le média ne correspond pas à ce fil.");
  }
  if (!text && !media.mediaUrl) {
    throw new HttpsError("invalid-argument", "Le message est vide.");
  }

  const record = buildSupportMessageRecord(context.actor, text, media, {
    scope: "support",
    threadId: context.threadId,
  });

  const ref = await context.threadRef
    .collection(SUPPORT_MESSAGES_SUBCOLLECTION)
    .add(record);

  const threadData = context.threadSnap.exists ? (context.threadSnap.data() || {}) : {};
  await context.threadRef.set({
    lastMessageText: messagePreviewFromRecord(record),
    lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
    lastMessageAtMs: record.createdAtMs,
    lastSenderRole: record.senderRole,
    status: "open",
    unreadForAgent: true,
    unreadForUser: false,
    resolvedAt: null,
    resolvedAtMs: 0,
    resolutionTag: "",
    participantName: record.displayName,
    participantEmail: record.email,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    firstAgentReplyAt: threadData.firstAgentReplyAt || null,
    firstAgentReplyAtMs: safeInt(threadData.firstAgentReplyAtMs),
  }, { merge: true });

  return {
    ok: true,
    threadId: context.threadId,
    guestToken: context.guestToken || "",
    message: {
      id: ref.id,
      threadId: context.threadId,
      text: record.text,
      mediaType: record.mediaType,
      mediaUrl: record.mediaUrl,
      mediaPath: record.mediaPath,
      fileName: record.fileName,
      senderRole: record.senderRole,
      senderType: record.senderType,
      senderKey: record.senderKey,
      uid: record.uid,
      guestId: record.guestId,
      email: record.email,
      displayName: record.displayName,
      createdAtMs: record.createdAtMs,
      expiresAtMs: record.expiresAtMs,
    },
  };
});

exports.markSupportThreadSeenSecure = publicOnCall("markSupportThreadSeenSecure", async (request) => {
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const context = await resolveSupportThreadContext(request, payload, { allowCreate: true });
  await context.threadRef.set({
    unreadForUser: false,
    participantSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    participantSeenAtMs: Date.now(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return {
    ok: true,
    threadId: context.threadId,
    guestToken: context.guestToken || "",
  };
});

exports.adminCheck = publicOnCall("adminCheck", async (request) => {
  const { uid, email } = assertFinanceAdmin(request);
  return {
    ok: true,
    uid,
    email,
    botDifficulty: await getConfiguredBotDifficulty(),
  };
});

exports.setBotDifficulty = publicOnCall("setBotDifficulty", async (request) => {
  assertFinanceAdmin(request);
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const botDifficulty = normalizeBotDifficulty(payload.botDifficulty);

  await adminBootstrapRef().set({
    email: FINANCE_ADMIN_EMAIL,
    botDifficulty,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return {
    ok: true,
    botDifficulty,
  };
});

exports.createAmbassadorSecure = publicOnCall("createAmbassadorSecure", async (request) => {
  if (!AMBASSADOR_SYSTEM_ENABLED) {
    throw new HttpsError("failed-precondition", "Système ambassadeur désactivé.");
  }
  const { uid, email } = assertFinanceAdmin(request);
  const payload = request.data && typeof request.data === "object" ? request.data : {};

  const name = String(payload.name || "").trim();
  const authCode = String(payload.authCode || "").trim();
  if (!name) {
    throw new HttpsError("invalid-argument", "Nom ambassadeur requis.");
  }
  if (authCode.length < 4 || authCode.length > 128) {
    throw new HttpsError("invalid-argument", "Code d'auth invalide.");
  }

  let promoCode = normalizeCode(payload.promoCode || "");
  if (!promoCode) {
    promoCode = await generateUniqueAmbassadorCode(AMBASSADOR_PROMO_PREFIX, 6);
  } else if (await ambassadorCodeExists(promoCode)) {
    throw new HttpsError("already-exists", "Ce code promo existe déjà.");
  }

  let linkCode = normalizeCode(payload.linkCode || "");
  if (!linkCode) {
    linkCode = await generateUniqueAmbassadorCode(AMBASSADOR_LINK_PREFIX, 6);
  } else if (await ambassadorCodeExists(linkCode)) {
    throw new HttpsError("already-exists", "Ce code lien existe déjà.");
  }

  const hashed = hashAuthCode(authCode);
  const ref = db.collection(AMBASSADORS_COLLECTION).doc();
  const batch = db.batch();
  batch.set(ref, {
    name,
    promoCode,
    linkCode,
    doesBalance: 0,
    totalSignups: 0,
    totalSignupsViaLink: 0,
    totalSignupsViaCode: 0,
    totalDeposits: 0,
    totalGames: 0,
    totalInvitedWins: 0,
    totalInvitedLosses: 0,
    createdByUid: uid,
    createdByEmail: email,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  batch.set(ambassadorSecretsRef(ref), {
    authCodeHash: hashed.hashHex,
    authCodeSalt: hashed.saltHex,
    authCodeAlgo: hashed.algo,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  await batch.commit();

  return {
    ok: true,
    account: {
      id: ref.id,
      name,
      promoCode,
      linkCode,
      doesBalance: 0,
      totalSignups: 0,
      totalDeposits: 0,
      totalGames: 0,
      totalInvitedWins: 0,
      totalInvitedLosses: 0,
      createdByUid: uid,
      createdByEmail: email,
      referralLink: buildAmbassadorReferralLink(linkCode || promoCode),
    },
  };
});

exports.ambassadorLoginSecure = publicOnCall("ambassadorLoginSecure", async (request) => {
  if (!AMBASSADOR_SYSTEM_ENABLED) {
    return { ok: false, reason: "disabled" };
  }
  const payload = request.data && typeof request.data === "object" ? request.data : {};
  const code = normalizeCode(payload.promoCode || payload.code || "");
  const authCode = String(payload.authCode || "").trim();
  if (!code || !authCode) {
    return { ok: false, reason: "missing" };
  }

  const [promoSnap, linkSnap] = await Promise.all([
    db.collection(AMBASSADORS_COLLECTION).where("promoCode", "==", code).limit(1).get(),
    db.collection(AMBASSADORS_COLLECTION).where("linkCode", "==", code).limit(1).get(),
  ]);
  const candidateDoc = !promoSnap.empty ? promoSnap.docs[0] : (!linkSnap.empty ? linkSnap.docs[0] : null);
  if (!candidateDoc) {
    return { ok: false, reason: "invalid" };
  }

  const candidate = candidateDoc.data() || {};
  const secrets = await readAmbassadorSecrets(candidateDoc);
  const hashHex = secrets.hashHex;
  const saltHex = secrets.saltHex;
  const algo = secrets.algo;
  const legacyPlain = secrets.legacyPlain;

  let valid = false;
  if (hashHex && saltHex) {
    valid = verifyAuthCode(authCode, hashHex, saltHex, algo);
  } else if (legacyPlain) {
    valid = safeCompareText(legacyPlain.trim(), authCode);
  }

  if (!valid) {
    return { ok: false, reason: "invalid" };
  }

  if (!secrets.hasPrivate || secrets.hasPublicSecrets) {
    await ambassadorSecretsRef(candidateDoc.ref).set({
      authCodeHash: hashHex,
      authCodeSalt: saltHex,
      authCodeAlgo: algo,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await candidateDoc.ref.set({
      authCode: admin.firestore.FieldValue.delete(),
      authCodeHash: admin.firestore.FieldValue.delete(),
      authCodeSalt: admin.firestore.FieldValue.delete(),
      authCodeAlgo: admin.firestore.FieldValue.delete(),
      authCodeMigratedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  return {
    ok: true,
    ambassador: {
      id: candidateDoc.id,
      name: String(candidate.name || ""),
      promoCode: normalizeCode(candidate.promoCode || ""),
      linkCode: normalizeCode(candidate.linkCode || ""),
      doesBalance: safeSignedInt(candidate.doesBalance),
      totalSignups: safeInt(candidate.totalSignups),
      totalDeposits: safeInt(candidate.totalDeposits),
      totalGames: safeInt(candidate.totalGames),
      totalInvitedWins: safeInt(candidate.totalInvitedWins),
      totalInvitedLosses: safeInt(candidate.totalInvitedLosses),
      referralLink: buildAmbassadorReferralLink(candidate.linkCode || candidate.promoCode || ""),
    },
  };
});

exports.migrateAmbassadorSecrets = publicOnCall("migrateAmbassadorSecrets", async (request) => {
  assertFinanceAdmin(request);
  const snap = await db.collection(AMBASSADORS_COLLECTION).get();

  let migrated = 0;
  let skipped = 0;
  let pendingOps = 0;
  let batch = db.batch();

  for (const item of snap.docs) {
    const secrets = await readAmbassadorSecrets(item);
    let nextHash = "";
    let nextSalt = "";
    let nextAlgo = AUTH_HASH_ALGO;

    if (secrets.hasPrivate && secrets.hashHex && secrets.saltHex) {
      nextHash = secrets.hashHex;
      nextSalt = secrets.saltHex;
      nextAlgo = secrets.algo;
    } else if (secrets.hashHex && secrets.saltHex) {
      nextHash = secrets.hashHex;
      nextSalt = secrets.saltHex;
      nextAlgo = secrets.algo;
    } else if (secrets.legacyPlain) {
      const next = hashAuthCode(secrets.legacyPlain);
      nextHash = next.hashHex;
      nextSalt = next.saltHex;
      nextAlgo = next.algo;
    }

    if (!nextHash || !nextSalt) {
      skipped += 1;
      continue;
    }

    batch.set(ambassadorSecretsRef(item.ref), {
      authCodeHash: nextHash,
      authCodeSalt: nextSalt,
      authCodeAlgo: nextAlgo,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    batch.set(item.ref, {
      authCode: admin.firestore.FieldValue.delete(),
      authCodeHash: admin.firestore.FieldValue.delete(),
      authCodeSalt: admin.firestore.FieldValue.delete(),
      authCodeAlgo: admin.firestore.FieldValue.delete(),
      authCodeMigratedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    pendingOps += 2;
    migrated += 1;

    if (pendingOps >= 350) {
      await batch.commit();
      batch = db.batch();
      pendingOps = 0;
    }
  }

  if (pendingOps > 0) {
    await batch.commit();
  }

  return {
    ok: true,
    total: snap.size,
    migrated,
    skipped,
  };
});
