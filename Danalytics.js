import {
  db,
  collection,
  collectionGroup,
  doc,
  getDocs,
  getDoc,
} from "./firebase-init.js";
import { ensureFinanceDashboardSession } from "./dashboard-admin-auth.js";
import { getGlobalAnalyticsSnapshotSecure, setBotDifficultySecure } from "./secure-functions.js";

const CLIENTS_COLLECTION = "clients";
const AMBASSADORS_COLLECTION = "ambassadors";
const ROOMS_COLLECTION = "rooms";
const ORDERS_SUBCOLLECTION = "orders";
const WITHDRAWALS_SUBCOLLECTION = "withdrawals";
const XCHANGES_SUBCOLLECTION = "xchanges";
const REFERRAL_REWARDS_SUBCOLLECTION = "referralRewards";
const REFERRALS_SUBCOLLECTION = "referrals";
const CHANNEL_COLLECTION = "globalChannelMessages";
const SUPPORT_THREADS_COLLECTION = "supportThreads";
const SUPPORT_MESSAGES_SUBCOLLECTION = "messages";
const DPAYMENT_ADMIN_BOOTSTRAP_DOC = "dpayment_admin_bootstrap";
const DEFAULT_BOT_DIFFICULTY = "expert";

const RATE_HTG_TO_DOES = 20;
const DEFAULT_STAKE_REWARD_MULTIPLIER = 3;
const USER_REFERRAL_DEPOSIT_REWARD = 100;
const MAX_TREE_ROOTS = 6;
const MAX_TOP_ROWS = 8;

const chartState = {
  matches: null,
  finance: null,
  depth: null,
};

const state = {
  raw: null,
  computed: null,
  botDifficulty: DEFAULT_BOT_DIFFICULTY,
};

const dom = {
  status: document.getElementById("analyticsStatus"),
  refreshBtn: document.getElementById("analyticsRefreshBtn"),
  applyBtn: document.getElementById("analyticsApplyBtn"),
  dateFrom: document.getElementById("analyticsDateFrom"),
  dateTo: document.getElementById("analyticsDateTo"),
  treeDepth: document.getElementById("analyticsTreeDepth"),
  insights: document.getElementById("analyticsInsights"),
  topPlayers: document.getElementById("topPlayersList"),
  topReferrers: document.getElementById("topReferrersList"),
  topAmbassadors: document.getElementById("topAmbassadorsList"),
  referralRewards: document.getElementById("referralRewardsList"),
  gainLossRecords: document.getElementById("gainLossRecordsList"),
  financeRecords: document.getElementById("financeRecordsList"),
  treeWrap: document.getElementById("referralTreeWrap"),
  recommendedMetrics: document.getElementById("recommendedMetrics"),
  botDifficultyStatus: document.getElementById("botDifficultyStatus"),
  botDifficultyButtons: Array.from(document.querySelectorAll("[data-bot-level]")),
};

function setStatus(text, tone = "neutral") {
  if (!dom.status) return;
  dom.status.textContent = String(text || "");
  dom.status.style.color = tone === "error"
    ? "#ff9bab"
    : tone === "success"
      ? "#7ff1c7"
      : tone === "warn"
        ? "#ffc476"
        : "";
}

function botDifficultyLabel(level) {
  const normalized = normalizeBotDifficulty(level);
  if (normalized === "amateur") return "Amateur";
  if (normalized === "ultra") return "Ultra";
  return "Expert";
}

function renderBotDifficultyControls(level = DEFAULT_BOT_DIFFICULTY) {
  const normalized = normalizeBotDifficulty(level);
  state.botDifficulty = normalized;

  dom.botDifficultyButtons.forEach((button) => {
    const buttonLevel = normalizeBotDifficulty(button.dataset.botLevel);
    button.classList.toggle("active", buttonLevel === normalized);
    button.setAttribute("aria-pressed", buttonLevel === normalized ? "true" : "false");
  });

  if (dom.botDifficultyStatus) {
    dom.botDifficultyStatus.textContent = `Niveau actuel: ${botDifficultyLabel(normalized)}. Seul l'admin finance peut le modifier depuis ce dashboard.`;
  }
}

function safeInt(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
}

function resolveRoomRewardDoes(room = {}) {
  const explicit = safeInt(room.rewardAmountDoes);
  if (explicit > 0) return explicit;
  return safeInt(room.entryCostDoes || room.stakeDoes) * DEFAULT_STAKE_REWARD_MULTIPLIER;
}

function safeSignedInt(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}

function normalizeBotDifficulty(value) {
  const level = String(value || "").trim().toLowerCase();
  return level === "amateur" || level === "expert" || level === "ultra"
    ? level
    : DEFAULT_BOT_DIFFICULTY;
}

function safeFloat(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, safeFloat(value)));
}

function tsToMs(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function startOfDayMs(value) {
  const ms = tsToMs(value);
  if (!ms) return 0;
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function endOfDayMs(value) {
  const ms = tsToMs(value);
  if (!ms) return 0;
  const date = new Date(ms);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

function startOfWeekMs(value) {
  const ms = tsToMs(value);
  if (!ms) return 0;
  const date = new Date(ms);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfMonthMs(value) {
  const ms = tsToMs(value);
  if (!ms) return 0;
  const date = new Date(ms);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function parseDateInputMs(rawValue, endOfDay = false) {
  const raw = String(rawValue || "").trim();
  if (!raw) return 0;
  const parts = raw.split("-").map((item) => Number(item));
  if (parts.length !== 3 || parts.some((item) => !Number.isFinite(item))) return 0;
  const [year, month, day] = parts;
  if (endOfDay) return new Date(year, month - 1, day, 23, 59, 59, 999).getTime();
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

function formatInt(value) {
  return new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: 0,
  }).format(safeFloat(value));
}

function formatCurrencyHtg(value) {
  return `${formatInt(value)} HTG`;
}

function formatDoes(value) {
  return `${formatInt(value)} Does`;
}

function formatSignedDoes(value) {
  const num = safeSignedInt(value);
  return `${num > 0 ? "+" : ""}${formatInt(num)} Does`;
}

function formatPercent(value) {
  return `${clampPercent(value).toFixed(1)}%`;
}

function formatDateLabel(ms) {
  if (!ms) return "-";
  return new Date(ms).toLocaleDateString("fr-FR");
}

function formatDuration(ms) {
  const safeMs = safeSignedInt(ms);
  if (!safeMs) return "-";
  const minutes = safeMs / 60000;
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  const days = hours / 24;
  return `${days.toFixed(days < 10 ? 1 : 0)} j`;
}

function sourceLabel(rawSource) {
  const source = String(rawSource || "").toLowerCase();
  if (source === "game_reward") return "Gain de match";
  if (source === "game_entry" || source === "game_cost" || source === "entry") return "Mise de match";
  if (source === "xchange_buy" || source === "exchange_htg_to_does" || source === "buy") return "Achat Does";
  if (source === "xchange_sell" || source === "exchange_does_to_htg" || source === "sell") return "Vente Does";
  if (source === "referral_reward" || source.includes("referral")) return "Prime parrainage";
  if (source === "reward") return "Credit reward";
  return source ? source.replaceAll("_", " ") : "Operation";
}

function countValues(items, mapper) {
  const counts = new Map();
  (items || []).forEach((item) => {
    const key = String(mapper(item) || "").trim();
    if (!key) return;
    counts.set(key, safeInt(counts.get(key)) + 1);
  });
  return counts;
}

function topCountLabel(counts, fallback = "Aucune donnée") {
  if (!(counts instanceof Map) || counts.size === 0) return fallback;
  const top = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  return `${top[0]} (${formatInt(top[1])})`;
}

function formatPeriodLabel(ms, granularity = "day") {
  const safeMs = safeSignedInt(ms);
  if (!safeMs) return "-";
  const date = new Date(safeMs);
  if (granularity === "week") {
    const end = new Date(safeMs);
    end.setDate(end.getDate() + 6);
    return `${date.toLocaleDateString("fr-FR")} -> ${end.toLocaleDateString("fr-FR")}`;
  }
  if (granularity === "month") {
    return date.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  }
  return date.toLocaleDateString("fr-FR");
}

function getCreatedMs(item) {
  return tsToMs(item.createdAt) || safeSignedInt(item.createdAtMs) || tsToMs(item.updatedAt);
}

function getRoomPeriodMs(room) {
  if (String(room.status || "") === "ended") {
    return tsToMs(room.endedAt) || safeSignedInt(room.endedAtMs) || tsToMs(room.updatedAt) || tsToMs(room.createdAt);
  }
  return tsToMs(room.startedAt) || safeSignedInt(room.startedAtMs) || tsToMs(room.createdAt) || tsToMs(room.updatedAt);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function withinRange(ms, range) {
  if (!ms) return false;
  return ms >= range.fromMs && ms <= range.toMs;
}

function getDateInputValue(date) {
  return new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString().slice(0, 10);
}

function readDateRangeFromInputs() {
  const fromRaw = dom.dateFrom?.value || "";
  const toRaw = dom.dateTo?.value || "";
  const now = new Date();
  const fallbackFrom = new Date(now.getTime() - (29 * 24 * 60 * 60 * 1000));
  const fromMs = parseDateInputMs(fromRaw, false) || startOfDayMs(fallbackFrom);
  const toMs = parseDateInputMs(toRaw, true) || endOfDayMs(now);
  return {
    fromMs,
    toMs,
  };
}

function snapshotRecord(docSnap) {
  return {
    id: docSnap.id,
    path: docSnap.ref.path,
    ...docSnap.data(),
  };
}

function subcollectionRecord(docSnap) {
  const base = snapshotRecord(docSnap);
  const ownerDoc = docSnap.ref.parent?.parent || null;
  return {
    ...base,
    clientId: String(base.clientId || base.uid || ownerDoc?.id || "").trim(),
  };
}

function referralRecord(docSnap) {
  const base = snapshotRecord(docSnap);
  const ownerDoc = docSnap.ref.parent?.parent || null;
  const ownerCollection = String(ownerDoc?.parent?.id || "").trim();
  return {
    ...base,
    ownerId: String(ownerDoc?.id || "").trim(),
    ownerCollection,
  };
}

function supportMessageRecord(docSnap) {
  const base = snapshotRecord(docSnap);
  return {
    ...base,
    threadId: String(docSnap.ref.parent?.parent?.id || base.threadId || "").trim(),
  };
}

function getLedgerDeltaDoes(item) {
  const explicit = Number(item.deltaDoes);
  if (Number.isFinite(explicit) && explicit !== 0) return Math.trunc(explicit);

  const amountDoes = safeInt(item.amountDoes || item.rewardDoes || 0);
  const type = classifyXchange(item);
  if (type === "buy" || type === "reward" || type === "referral") return amountDoes;
  if (type === "sell" || type === "entry") return -amountDoes;
  return 0;
}

function getBucketStartMs(ms, granularity) {
  if (!ms) return 0;
  if (granularity === "week") return startOfWeekMs(ms);
  if (granularity === "month") return startOfMonthMs(ms);
  return startOfDayMs(ms);
}

function buildPeriodExtremes(entries, granularity) {
  const buckets = new Map();

  (entries || []).forEach((entry) => {
    const bucketMs = getBucketStartMs(entry.createdMs, granularity);
    if (!bucketMs) return;
    if (!buckets.has(bucketMs)) {
      buckets.set(bucketMs, {
        bucketMs,
        positiveDoes: 0,
        negativeDoes: 0,
        netDoes: 0,
        events: 0,
      });
    }
    const bucket = buckets.get(bucketMs);
    const delta = safeSignedInt(entry.deltaDoes);
    if (delta > 0) bucket.positiveDoes += delta;
    if (delta < 0) bucket.negativeDoes += Math.abs(delta);
    bucket.netDoes += delta;
    bucket.events += 1;
  });

  const all = [...buckets.values()];
  const bestGain = all
    .filter((item) => item.positiveDoes > 0)
    .sort((left, right) => right.positiveDoes - left.positiveDoes)[0] || null;
  const worstLoss = all
    .filter((item) => item.negativeDoes > 0)
    .sort((left, right) => right.negativeDoes - left.negativeDoes)[0] || null;

  return { bestGain, worstLoss };
}

async function fetchFallbackBotDifficulty() {
  try {
    const snap = await getDoc(doc(db, "settings", DPAYMENT_ADMIN_BOOTSTRAP_DOC));
    if (!snap.exists()) return DEFAULT_BOT_DIFFICULTY;
    return normalizeBotDifficulty(snap.data()?.botDifficulty);
  } catch (_) {
    return DEFAULT_BOT_DIFFICULTY;
  }
}

async function fetchAllAnalyticsData() {
  try {
    const raw = await getGlobalAnalyticsSnapshotSecure();
    return {
      botDifficulty: normalizeBotDifficulty(raw?.botDifficulty),
      clients: asArray(raw?.clients),
      ambassadors: asArray(raw?.ambassadors),
      rooms: asArray(raw?.rooms),
      orders: asArray(raw?.orders),
      withdrawals: asArray(raw?.withdrawals),
      xchanges: asArray(raw?.xchanges),
      referralRewards: asArray(raw?.referralRewards),
      clientReferrals: asArray(raw?.clientReferrals),
      ambassadorReferrals: asArray(raw?.ambassadorReferrals),
      channelMessages: asArray(raw?.channelMessages),
      supportThreads: asArray(raw?.supportThreads),
      supportMessages: asArray(raw?.supportMessages),
      generatedAtMs: safeSignedInt(raw?.generatedAtMs),
    };
  } catch (error) {
    console.warn("[ANALYTICS] callable unavailable, fallback to direct Firestore reads", error);
  }

  const settled = await Promise.allSettled([
    getDocs(collection(db, CLIENTS_COLLECTION)),
    getDocs(collection(db, AMBASSADORS_COLLECTION)),
    getDocs(collection(db, ROOMS_COLLECTION)),
    getDocs(collectionGroup(db, ORDERS_SUBCOLLECTION)),
    getDocs(collectionGroup(db, WITHDRAWALS_SUBCOLLECTION)),
    getDocs(collectionGroup(db, XCHANGES_SUBCOLLECTION)),
    getDocs(collectionGroup(db, REFERRAL_REWARDS_SUBCOLLECTION)),
    getDocs(collectionGroup(db, REFERRALS_SUBCOLLECTION)),
    getDocs(collection(db, CHANNEL_COLLECTION)),
    getDocs(collection(db, SUPPORT_THREADS_COLLECTION)),
    getDocs(collectionGroup(db, SUPPORT_MESSAGES_SUBCOLLECTION)),
  ]);

  const unwrapDocs = (index, label) => {
    const item = settled[index];
    if (item?.status === "fulfilled") return item.value.docs || [];
    console.warn(`[ANALYTICS] fallback read skipped for ${label}`, item?.reason || "unknown");
    return [];
  };

  const clientsDocs = unwrapDocs(0, CLIENTS_COLLECTION);
  const ambassadorsDocs = unwrapDocs(1, AMBASSADORS_COLLECTION);
  const roomsDocs = unwrapDocs(2, ROOMS_COLLECTION);
  const ordersDocs = unwrapDocs(3, ORDERS_SUBCOLLECTION);
  const withdrawalsDocs = unwrapDocs(4, WITHDRAWALS_SUBCOLLECTION);
  const xchangesDocs = unwrapDocs(5, XCHANGES_SUBCOLLECTION);
  const referralRewardDocs = unwrapDocs(6, REFERRAL_REWARDS_SUBCOLLECTION);
  const referralsDocs = unwrapDocs(7, REFERRALS_SUBCOLLECTION);
  const channelDocs = unwrapDocs(8, CHANNEL_COLLECTION);
  const threadDocs = unwrapDocs(9, SUPPORT_THREADS_COLLECTION);
  const supportMessageDocs = unwrapDocs(10, SUPPORT_MESSAGES_SUBCOLLECTION);
  const referrals = referralsDocs.map(referralRecord);
  const botDifficulty = await fetchFallbackBotDifficulty();

  return {
    botDifficulty,
    clients: clientsDocs.map(snapshotRecord),
    ambassadors: ambassadorsDocs.map(snapshotRecord),
    rooms: roomsDocs.map(snapshotRecord),
    orders: ordersDocs.map(subcollectionRecord),
    withdrawals: withdrawalsDocs.map(subcollectionRecord),
    xchanges: xchangesDocs.map(subcollectionRecord),
    referralRewards: referralRewardDocs.map(subcollectionRecord),
    clientReferrals: referrals.filter((item) => item.ownerCollection === CLIENTS_COLLECTION),
    ambassadorReferrals: referrals.filter((item) => item.ownerCollection === AMBASSADORS_COLLECTION),
    channelMessages: channelDocs.map(snapshotRecord),
    supportThreads: threadDocs.map(snapshotRecord),
    supportMessages: supportMessageDocs.map(supportMessageRecord),
    generatedAtMs: Date.now(),
  };
}

function orderAmountHtg(order) {
  return safeInt(order.amount || order.amountHtg);
}

function withdrawalAmountHtg(item) {
  return safeInt(item.requestedAmount ?? item.amount ?? item.amountHtg);
}

function xchangeAmountHtg(item) {
  return safeInt(item.amountGourdes || item.amountHtg);
}

function xchangeAmountDoes(item) {
  return safeInt(item.amountDoes || 0);
}

function classifyXchange(item) {
  const type = String(item.type || "").toLowerCase();
  if (type === "xchange_buy" || type === "exchange_htg_to_does") return "buy";
  if (type === "xchange_sell" || type === "exchange_does_to_htg") return "sell";
  if (type === "game_entry" || type === "game_cost") return "entry";
  if (type === "game_reward") return "reward";
  if (type.includes("referral")) return "referral";
  return "other";
}

function computeReferralGraph(clients) {
  const clientsById = new Map();
  const childrenByParent = new Map();
  const hasChildren = new Set();
  const activeParentIds = new Set();

  clients.forEach((client) => {
    clientsById.set(String(client.id), client);
  });

  clients.forEach((client) => {
    const clientId = String(client.id || "").trim();
    const parentId = String(client.referredByUserId || "").trim();
    if (!clientId || !parentId || clientId === parentId) return;
    activeParentIds.add(parentId);
    hasChildren.add(parentId);
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(clientId);
  });

  const depthMemo = new Map();
  const depthCounts = {};

  function computeDepth(clientId, trail = new Set()) {
    if (depthMemo.has(clientId)) return depthMemo.get(clientId);
    if (trail.has(clientId)) return 0;

    const client = clientsById.get(clientId);
    const parentId = String(client?.referredByUserId || "").trim();
    if (!parentId || !clientsById.has(parentId) || parentId === clientId) {
      depthMemo.set(clientId, 1);
      return 1;
    }

    trail.add(clientId);
    const depth = computeDepth(parentId, trail) + 1;
    trail.delete(clientId);
    depthMemo.set(clientId, depth);
    return depth;
  }

  clients.forEach((client) => {
    const clientId = String(client.id || "").trim();
    if (!String(client.referredByUserId || "").trim()) return;
    const depth = Math.max(1, computeDepth(clientId) - 1);
    depthCounts[depth] = safeInt(depthCounts[depth]) + 1;
  });

  const descendantsMemo = new Map();

  function collectDescendants(parentId, trail = new Set()) {
    if (descendantsMemo.has(parentId)) return descendantsMemo.get(parentId);
    if (trail.has(parentId)) return [];

    trail.add(parentId);
    const direct = asArray(childrenByParent.get(parentId));
    const nested = [];
    direct.forEach((childId) => {
      nested.push(childId);
      collectDescendants(childId, trail).forEach((nestedId) => nested.push(nestedId));
    });
    trail.delete(parentId);
    descendantsMemo.set(parentId, nested);
    return nested;
  }

  const roots = [...hasChildren]
    .filter((id) => {
      const client = clientsById.get(id);
      const parentId = String(client?.referredByUserId || "").trim();
      return !parentId || !clientsById.has(parentId);
    })
    .sort((left, right) => collectDescendants(right).length - collectDescendants(left).length);

  const parentStats = [...hasChildren].map((parentId) => {
    const directCount = asArray(childrenByParent.get(parentId)).length;
    const descendants = collectDescendants(parentId);
    return {
      parentId,
      directCount,
      descendantCount: descendants.length,
    };
  }).sort((left, right) => {
    if (right.descendantCount !== left.descendantCount) return right.descendantCount - left.descendantCount;
    return right.directCount - left.directCount;
  });

  return {
    clientsById,
    childrenByParent,
    roots,
    depthCounts,
    parentStats,
    activeReferrerIds: activeParentIds,
  };
}

function buildLevelNodes(rootId, graph, depthLimit) {
  const levels = [];
  let current = [rootId];

  for (let depth = 1; depth <= depthLimit; depth += 1) {
    const next = [];
    current.forEach((parentId) => {
      asArray(graph.childrenByParent.get(parentId)).forEach((childId) => next.push(childId));
    });
    if (!next.length) break;
    levels.push(next);
    current = next;
  }

  return levels;
}

function computeMetrics(raw, range) {
  const clients = asArray(raw.clients);
  const ambassadors = asArray(raw.ambassadors);
  const rooms = asArray(raw.rooms);
  const orders = asArray(raw.orders);
  const withdrawals = asArray(raw.withdrawals);
  const xchanges = asArray(raw.xchanges);
  const referralRewards = asArray(raw.referralRewards);
  const channelMessages = asArray(raw.channelMessages);
  const supportThreads = asArray(raw.supportThreads);
  const supportMessages = asArray(raw.supportMessages);
  const ambassadorReferrals = asArray(raw.ambassadorReferrals);

  const referralGraph = computeReferralGraph(clients);
  const clientsById = referralGraph.clientsById;

  const newPlayersInRange = clients.filter((item) => withinRange(getCreatedMs(item), range));
  const periodRooms = rooms.filter((room) => withinRange(getRoomPeriodMs(room), range));
  const completedRooms = periodRooms.filter((room) => String(room.status || "") === "ended");

  const matchesByBots = {
    0: 0,
    1: 0,
    2: 0,
    3: 0,
  };

  let totalStakeDoes = 0;
  let totalRewardDoes = 0;
  let totalHumans = 0;
  let totalBots = 0;

  completedRooms.forEach((room) => {
    const humans = Math.max(1, safeInt(room.humanCount || asArray(room.playerUids).filter(Boolean).length || 1));
    const bots = Math.max(0, Math.min(3, safeInt(room.botCount)));
    const entryCostDoes = Math.max(0, safeInt(room.entryCostDoes || room.stakeDoes || 100));
    const winnerSeat = typeof room.winnerSeat === "number" ? Math.trunc(room.winnerSeat) : -1;
    const hasWinner = Boolean(String(room.winnerUid || "").trim()) || winnerSeat >= 0;

    matchesByBots[bots] = safeInt(matchesByBots[bots]) + 1;
    totalHumans += humans;
    totalBots += bots;
    totalStakeDoes += humans * entryCostDoes;
    if (hasWinner) totalRewardDoes += resolveRoomRewardDoes(room);
  });

  const ordersInRange = orders.filter((item) => withinRange(getCreatedMs(item), range));
  const approvedOrders = ordersInRange.filter((item) => String(item.status || "") === "approved");
  const pendingOrders = ordersInRange.filter((item) => String(item.status || "") === "pending");
  const reviewOrders = ordersInRange.filter((item) => String(item.status || "") === "review");
  const rejectedOrders = ordersInRange.filter((item) => String(item.status || "") === "rejected");
  const approvedDepositsHtg = approvedOrders.reduce((sum, item) => sum + orderAmountHtg(item), 0);
  const allDepositsHtg = ordersInRange.reduce((sum, item) => sum + orderAmountHtg(item), 0);

  const withdrawalsInRange = withdrawals.filter((item) => withinRange(getCreatedMs(item), range));
  const approvedWithdrawals = withdrawalsInRange.filter((item) => String(item.status || "") === "approved");
  const approvedWithdrawalsHtg = approvedWithdrawals.reduce((sum, item) => sum + withdrawalAmountHtg(item), 0);

  const xchangesInRange = xchanges.filter((item) => withinRange(getCreatedMs(item), range));
  const referralRewardsInRange = referralRewards.filter((item) => withinRange(getCreatedMs(item), range));
  const xchangeMix = {
    buyHtg: 0,
    buyDoes: 0,
    sellHtg: 0,
    sellDoes: 0,
    entryDoes: 0,
    rewardDoes: 0,
    referralDoes: 0,
  };

  xchangesInRange.forEach((item) => {
    const type = classifyXchange(item);
    if (type === "buy") {
      xchangeMix.buyHtg += xchangeAmountHtg(item);
      xchangeMix.buyDoes += xchangeAmountDoes(item);
    } else if (type === "sell") {
      xchangeMix.sellHtg += xchangeAmountHtg(item);
      xchangeMix.sellDoes += xchangeAmountDoes(item);
    } else if (type === "entry") {
      xchangeMix.entryDoes += xchangeAmountDoes(item);
    } else if (type === "reward") {
      xchangeMix.rewardDoes += xchangeAmountDoes(item);
    } else if (type === "referral") {
      xchangeMix.referralDoes += xchangeAmountDoes(item);
    }
  });

  const referralRewardEvents = referralRewardsInRange
    .map((item) => ({
      ...item,
      rewardDoes: safeInt(item.rewardDoes || item.amountDoes || USER_REFERRAL_DEPOSIT_REWARD),
      createdMs: getCreatedMs(item),
      playerId: String(item.clientId || item.referrerUid || "").trim(),
      source: "referral_reward",
    }))
    .filter((item) => item.rewardDoes > 0);

  const walletLedger = xchangesInRange
    .map((item) => ({
      id: String(item.id || ""),
      playerId: String(item.clientId || item.uid || "").trim(),
      createdMs: getCreatedMs(item),
      deltaDoes: getLedgerDeltaDoes(item),
      source: String(item.type || "wallet"),
      raw: item,
    }))
    .filter((item) => item.createdMs > 0 && item.deltaDoes !== 0);

  const rewardLedger = referralRewardEvents.map((item) => ({
    id: String(item.id || ""),
    playerId: String(item.playerId || ""),
    createdMs: item.createdMs,
    deltaDoes: safeInt(item.rewardDoes),
    source: "referral_reward",
    raw: item,
  }));

  const fullLedger = [...walletLedger, ...rewardLedger];

  const userReferredClients = clients.filter((item) => String(item.referredByUserId || "").trim());
  const approvedReferredClients = userReferredClients.filter((item) => item.hasApprovedDeposit === true);
  const payingPlayerIds = new Set(approvedOrders.map((item) => String(item.clientId || item.uid || "").trim()).filter(Boolean));
  const playerParticipation = new Map();

  periodRooms.forEach((room) => {
    uniqueStrings(room.playerUids).forEach((uid) => {
      playerParticipation.set(uid, safeInt(playerParticipation.get(uid)) + 1);
    });
  });

  const topPlayers = [...playerParticipation.entries()]
    .map(([uid, matches]) => {
      const client = clientsById.get(uid) || {};
      return {
        id: uid,
        name: String(client.name || client.email || uid),
        email: String(client.email || ""),
        matches,
        doesBalance: safeInt(client.doesBalance),
      };
    })
    .sort((left, right) => right.matches - left.matches || right.doesBalance - left.doesBalance)
    .slice(0, MAX_TOP_ROWS);

  const topReferrers = referralGraph.parentStats
    .slice(0, MAX_TOP_ROWS)
    .map((item) => {
      const client = clientsById.get(item.parentId) || {};
      const rewardTotalDoes = referralRewardEvents
        .filter((reward) => reward.playerId === item.parentId)
        .reduce((sum, reward) => sum + safeInt(reward.rewardDoes), 0);
      return {
        id: item.parentId,
        name: String(client.name || client.email || item.parentId),
        email: String(client.email || ""),
        directCount: item.directCount,
        descendantCount: item.descendantCount,
        depositCount: clients.filter((candidate) => String(candidate.referredByUserId || "").trim() === item.parentId && candidate.hasApprovedDeposit === true).length,
        rewardTotalDoes,
      };
    });

  const ambassadorNetwork = new Map();
  ambassadorReferrals.forEach((item) => {
    const ambassadorId = String(item.ownerId || "").trim();
    if (!ambassadorId) return;
    const depth = Math.max(1, safeInt(item.depth || 1));
    if (depth > 3) return;
    if (!ambassadorNetwork.has(ambassadorId)) {
      ambassadorNetwork.set(ambassadorId, {
        visibleNetwork: 0,
        deltaDoes: 0,
        depth1: 0,
        depth2: 0,
        depth3: 0,
      });
    }
    const target = ambassadorNetwork.get(ambassadorId);
    target.visibleNetwork += 1;
    target.deltaDoes += safeSignedInt(item.ambassadorDoesDelta);
    target[`depth${depth}`] = safeInt(target[`depth${depth}`]) + 1;
  });

  const topAmbassadors = ambassadors
    .map((item) => {
      const network = ambassadorNetwork.get(String(item.id)) || {
        visibleNetwork: 0,
        deltaDoes: 0,
        depth1: 0,
        depth2: 0,
        depth3: 0,
      };
      return {
        id: String(item.id),
        name: String(item.name || item.promoCode || item.id),
        promoCode: String(item.promoCode || ""),
        doesBalance: safeSignedInt(item.doesBalance),
        totalGames: safeInt(item.totalGames),
        totalDeposits: safeInt(item.totalDeposits),
        visibleNetwork: network.visibleNetwork,
        deltaDoes: network.deltaDoes,
        depth1: network.depth1,
        depth2: network.depth2,
        depth3: network.depth3,
      };
    })
    .sort((left, right) => {
      if (right.visibleNetwork !== left.visibleNetwork) return right.visibleNetwork - left.visibleNetwork;
      return right.totalGames - left.totalGames;
    })
    .slice(0, MAX_TOP_ROWS);

  const supportMessagesInRange = supportMessages.filter((item) => withinRange(getCreatedMs(item), range));
  const channelMessagesInRange = channelMessages.filter((item) => withinRange(getCreatedMs(item), range));
  const backlogThreads = supportThreads.filter((item) => item.unreadForAgent === true).length;

  const approvalRate = ordersInRange.length
    ? (approvedOrders.length / ordersInRange.length) * 100
    : 0;
  const avgDeposit = approvedOrders.length
    ? approvedDepositsHtg / approvedOrders.length
    : 0;
  const referralDepositConversion = userReferredClients.length
    ? (approvedReferredClients.length / userReferredClients.length) * 100
    : 0;
  const payoutRate = totalStakeDoes > 0
    ? (totalRewardDoes / totalStakeDoes) * 100
    : 0;
  const botRate = completedRooms.length
    ? ((completedRooms.length - matchesByBots[0]) / completedRooms.length) * 100
    : 0;

  const referralRewardDoesTotal = referralRewardEvents.reduce((sum, item) => sum + safeInt(item.rewardDoes), 0);
  const rewardByPlayer = new Map();
  referralRewardEvents.forEach((item) => {
    const playerId = String(item.playerId || "").trim();
    if (!playerId) return;
    rewardByPlayer.set(playerId, safeInt(rewardByPlayer.get(playerId)) + safeInt(item.rewardDoes));
  });

  const topReferralRewardPlayers = [...rewardByPlayer.entries()]
    .map(([playerId, amount]) => {
      const client = clientsById.get(playerId) || {};
      return {
        id: playerId,
        name: String(client.name || client.email || playerId),
        amount,
      };
    })
    .sort((left, right) => right.amount - left.amount)
    .slice(0, 5);

  const largestGainEntry = [...fullLedger]
    .filter((item) => safeSignedInt(item.deltaDoes) > 0)
    .sort((left, right) => safeSignedInt(right.deltaDoes) - safeSignedInt(left.deltaDoes))[0] || null;
  const largestLossEntry = [...fullLedger]
    .filter((item) => safeSignedInt(item.deltaDoes) < 0)
    .sort((left, right) => Math.abs(safeSignedInt(right.deltaDoes)) - Math.abs(safeSignedInt(left.deltaDoes)))[0] || null;

  const gainByPlayer = new Map();
  const lossByPlayer = new Map();
  fullLedger.forEach((entry) => {
    const playerId = String(entry.playerId || "").trim();
    if (!playerId) return;
    const delta = safeSignedInt(entry.deltaDoes);
    if (delta > 0) {
      gainByPlayer.set(playerId, safeInt(gainByPlayer.get(playerId)) + delta);
    } else if (delta < 0) {
      lossByPlayer.set(playerId, safeInt(lossByPlayer.get(playerId)) + Math.abs(delta));
    }
  });

  const topGainPlayers = [...gainByPlayer.entries()]
    .map(([playerId, amount]) => {
      const client = clientsById.get(playerId) || {};
      return {
        id: playerId,
        name: String(client.name || client.email || playerId),
        amount,
      };
    })
    .sort((left, right) => right.amount - left.amount)
    .slice(0, 4);

  const topLossPlayers = [...lossByPlayer.entries()]
    .map(([playerId, amount]) => {
      const client = clientsById.get(playerId) || {};
      return {
        id: playerId,
        name: String(client.name || client.email || playerId),
        amount,
      };
    })
    .sort((left, right) => right.amount - left.amount)
    .slice(0, 4);

  const dayExtremes = buildPeriodExtremes(fullLedger, "day");
  const weekExtremes = buildPeriodExtremes(fullLedger, "week");
  const monthExtremes = buildPeriodExtremes(fullLedger, "month");

  const approvedDepositsSorted = approvedOrders
    .map((item) => ({
      ...item,
      amountHtg: orderAmountHtg(item),
      playerId: String(item.clientId || item.uid || "").trim(),
    }))
    .filter((item) => item.amountHtg > 0)
    .sort((left, right) => right.amountHtg - left.amountHtg);

  const approvedWithdrawalsSorted = approvedWithdrawals
    .map((item) => ({
      ...item,
      amountHtg: withdrawalAmountHtg(item),
      playerId: String(item.clientId || item.uid || "").trim(),
    }))
    .filter((item) => item.amountHtg > 0)
    .sort((left, right) => right.amountHtg - left.amountHtg);

  const maxDepositByPlayer = new Map();
  approvedDepositsSorted.forEach((item) => {
    const playerId = item.playerId;
    if (!playerId || maxDepositByPlayer.has(playerId)) return;
    maxDepositByPlayer.set(playerId, item);
  });

  const maxWithdrawalByPlayer = new Map();
  approvedWithdrawalsSorted.forEach((item) => {
    const playerId = item.playerId;
    if (!playerId || maxWithdrawalByPlayer.has(playerId)) return;
    maxWithdrawalByPlayer.set(playerId, item);
  });

  const topDepositPlayers = [...maxDepositByPlayer.entries()]
    .map(([playerId, item]) => {
      const client = clientsById.get(playerId) || {};
      return {
        id: playerId,
        name: String(client.name || client.email || playerId),
        amountHtg: safeInt(item.amountHtg),
      };
    })
    .sort((left, right) => right.amountHtg - left.amountHtg)
    .slice(0, 3);

  const topWithdrawalPlayers = [...maxWithdrawalByPlayer.entries()]
    .map(([playerId, item]) => {
      const client = clientsById.get(playerId) || {};
      return {
        id: playerId,
        name: String(client.name || client.email || playerId),
        amountHtg: safeInt(item.amountHtg),
      };
    })
    .sort((left, right) => right.amountHtg - left.amountHtg)
    .slice(0, 3);

  const completedMatchDurations = completedRooms
    .map((room) => {
      const startedMs = tsToMs(room.startedAt) || safeSignedInt(room.startedAtMs);
      const endedMs = tsToMs(room.endedAt) || safeSignedInt(room.endedAtMs) || tsToMs(room.updatedAt);
      if (!startedMs || !endedMs || endedMs < startedMs) return 0;
      return endedMs - startedMs;
    })
    .filter((value) => value > 0);

  const queueWaitDurations = periodRooms
    .map((room) => {
      const createdMs = getCreatedMs(room);
      const startedMs = tsToMs(room.startedAt) || safeSignedInt(room.startedAtMs);
      if (!createdMs || !startedMs || startedMs < createdMs) return 0;
      return startedMs - createdMs;
    })
    .filter((value) => value > 0);

  const firstDepositDelays = clients
    .map((item) => safeSignedInt(item.firstDepositDelayMs))
    .filter((value) => value > 0);

  const supportFirstReplyDurations = supportThreads
    .map((item) => {
      const createdMs = getCreatedMs(item);
      const replyMs = tsToMs(item.firstAgentReplyAt) || safeSignedInt(item.firstAgentReplyAtMs);
      if (!createdMs || !replyMs || replyMs < createdMs) return 0;
      return replyMs - createdMs;
    })
    .filter((value) => value > 0);

  const supportResolutionDurations = supportThreads
    .map((item) => {
      const createdMs = getCreatedMs(item);
      const resolvedMs = tsToMs(item.resolvedAt) || safeSignedInt(item.resolvedAtMs);
      if (!createdMs || !resolvedMs || resolvedMs < createdMs) return 0;
      return resolvedMs - createdMs;
    })
    .filter((value) => value > 0);

  const browserCounts = countValues(clients, (item) => item.browser);
  const countryCounts = countValues(clients, (item) => item.country);
  const marketingSourceCounts = countValues(clients, (item) => item.utmSource);
  const resolutionTagCounts = countValues(supportThreads, (item) => item.resolutionTag);

  const nowMs = Date.now();
  const retention = {
    seen1d: clients.filter((item) => {
      const lastSeenMs = tsToMs(item.lastSeenAt) || safeSignedInt(item.lastSeenAtMs);
      return lastSeenMs > 0 && lastSeenMs >= nowMs - (24 * 60 * 60 * 1000);
    }).length,
    seen7d: clients.filter((item) => {
      const lastSeenMs = tsToMs(item.lastSeenAt) || safeSignedInt(item.lastSeenAtMs);
      return lastSeenMs > 0 && lastSeenMs >= nowMs - (7 * 24 * 60 * 60 * 1000);
    }).length,
    seen30d: clients.filter((item) => {
      const lastSeenMs = tsToMs(item.lastSeenAt) || safeSignedInt(item.lastSeenAtMs);
      return lastSeenMs > 0 && lastSeenMs >= nowMs - (30 * 24 * 60 * 60 * 1000);
    }).length,
    game7d: clients.filter((item) => {
      const lastGameMs = tsToMs(item.lastGameAt);
      return lastGameMs > 0 && lastGameMs >= nowMs - (7 * 24 * 60 * 60 * 1000);
    }).length,
    deposit30d: clients.filter((item) => {
      const lastDepositMs = tsToMs(item.lastDepositAt);
      return lastDepositMs > 0 && lastDepositMs >= nowMs - (30 * 24 * 60 * 60 * 1000);
    }).length,
  };

  const average = (items) => items.length
    ? items.reduce((sum, value) => sum + value, 0) / items.length
    : 0;

  return {
    range,
    totals: {
      players: clients.length,
      newPlayersInRange: newPlayersInRange.length,
      completedMatches: completedRooms.length,
      totalMatchesAllTime: rooms.filter((room) => String(room.status || "") === "ended").length,
      activeReferrers: referralGraph.activeReferrerIds.size,
      approvedDepositsHtg,
      approvedWithdrawalsHtg,
      netTreasuryHtg: approvedDepositsHtg - approvedWithdrawalsHtg,
      gameProfitDoes: totalStakeDoes - totalRewardDoes,
      gameProfitHtgEquivalent: (totalStakeDoes - totalRewardDoes) / RATE_HTG_TO_DOES,
      payingPlayers: payingPlayerIds.size,
      xchangeBuyHtg: xchangeMix.buyHtg,
      xchangeBuyDoes: xchangeMix.buyDoes,
      xchangeSellHtg: xchangeMix.sellHtg,
      xchangeSellDoes: xchangeMix.sellDoes,
    },
    game: {
      completedRooms,
      matchesByBots,
      botMatches: completedRooms.length - matchesByBots[0],
      humanOnlyMatches: matchesByBots[0],
      totalStakeDoes,
      totalRewardDoes,
      payoutRate,
      botRate,
      averageHumans: completedRooms.length ? totalHumans / completedRooms.length : 0,
      averageBots: completedRooms.length ? totalBots / completedRooms.length : 0,
    },
    finance: {
      ordersInRange,
      approvedOrders,
      pendingOrders,
      reviewOrders,
      rejectedOrders,
      allDepositsHtg,
      approvedDepositsHtg,
      approvedWithdrawalsHtg,
      avgDeposit,
      approvalRate,
      xchangeMix,
    },
    support: {
      backlogThreads,
      supportMessagesInRange,
      channelMessagesInRange,
      openThreads: supportThreads.filter((item) => String(item.status || "open") !== "closed").length,
    },
    advanced: {
      avgMatchDurationMs: average(completedMatchDurations),
      avgQueueWaitMs: average(queueWaitDurations),
      avgFirstDepositDelayMs: average(firstDepositDelays),
      avgSupportFirstReplyMs: average(supportFirstReplyDurations),
      avgSupportResolutionMs: average(supportResolutionDurations),
      topBrowser: topCountLabel(browserCounts, "Navigateur non remonté"),
      topCountry: topCountLabel(countryCounts, "Pays non remonté"),
      topMarketingSource: topCountLabel(marketingSourceCounts, "Aucune source"),
      topResolutionTag: topCountLabel(resolutionTagCounts, "Aucun tag"),
      retention,
    },
    referrals: {
      userReferredClients,
      approvedReferredClients,
      referralDepositConversion,
      graph: referralGraph,
      ambassadorNetwork,
    },
    rankings: {
      topPlayers,
      topReferrers,
      topAmbassadors,
    },
    records: {
      referralRewardEvents,
      referralRewardDoesTotal,
      topReferralRewardPlayers,
      largestGainEntry,
      largestLossEntry,
      topGainPlayers,
      topLossPlayers,
      dayExtremes,
      weekExtremes,
      monthExtremes,
      largestDeposit: approvedDepositsSorted[0] || null,
      largestWithdrawal: approvedWithdrawalsSorted[0] || null,
      topDepositPlayers,
      topWithdrawalPlayers,
    },
  };
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = String(value);
}

function renderKpis(metrics) {
  setText("kpiPlayers", formatInt(metrics.totals.players));
  setText("kpiPlayersNote", `${formatInt(metrics.totals.newPlayersInRange)} nouveaux sur la periode`);
  setText("kpiCompletedMatches", formatInt(metrics.totals.completedMatches));
  setText("kpiCompletedMatchesNote", `${formatInt(metrics.totals.totalMatchesAllTime)} au total`);
  setText("kpiReferrers", formatInt(metrics.totals.activeReferrers));
  setText(
    "kpiReferrersNote",
    `${formatPercent(metrics.referrals.referralDepositConversion)} conversion • ${formatDoes(metrics.records.referralRewardDoesTotal)} primes`
  );
  setText("kpiApprovedDeposits", formatCurrencyHtg(metrics.totals.approvedDepositsHtg));
  setText(
    "kpiApprovedDepositsNote",
    `${formatInt(metrics.finance.approvedOrders.length)} depots approuves`
  );
  setText("kpiNetTreasury", formatCurrencyHtg(metrics.totals.netTreasuryHtg));
  setText(
    "kpiNetTreasuryNote",
    `${formatCurrencyHtg(metrics.totals.approvedWithdrawalsHtg)} retraits approuves`
  );
  setText("kpiGameProfit", formatDoes(metrics.totals.gameProfitDoes));
  setText(
    "kpiGameProfitNote",
    `${formatCurrencyHtg(metrics.totals.gameProfitHtgEquivalent)} eq. HTG`
  );
  setText("kpiXchangeBuy", formatCurrencyHtg(metrics.totals.xchangeBuyHtg));
  setText(
    "kpiXchangeBuyNote",
    `${formatDoes(metrics.totals.xchangeBuyDoes)} credites`
  );
  setText("kpiXchangeSell", formatCurrencyHtg(metrics.totals.xchangeSellHtg));
  setText(
    "kpiXchangeSellNote",
    `${formatDoes(metrics.totals.xchangeSellDoes)} reconvertis`
  );

  setText("miniBotMatches", formatInt(metrics.game.botMatches));
  setText("miniHumanMatches", formatInt(metrics.game.humanOnlyMatches));
  setText("miniBot1", formatInt(metrics.game.matchesByBots[1]));
  setText("miniBot2", formatInt(metrics.game.matchesByBots[2]));
  setText("miniBot3", formatInt(metrics.game.matchesByBots[3]));
  setText("miniSupportBacklog", formatInt(metrics.support.backlogThreads));
  setText("miniApprovalRate", formatPercent(metrics.finance.approvalRate));
  setText("miniAvgDeposit", formatCurrencyHtg(metrics.finance.avgDeposit));
  setText("miniPayingPlayers", formatInt(metrics.totals.payingPlayers));
  setText("miniSupportMessages", formatInt(metrics.support.supportMessagesInRange.length));
}

function destroyChart(name) {
  if (chartState[name]) {
    chartState[name].destroy();
    chartState[name] = null;
  }
}

function renderCharts(metrics) {
  const ChartLib = window.Chart;
  if (!ChartLib) return;

  destroyChart("matches");
  destroyChart("finance");
  destroyChart("depth");

  const matchesCtx = document.getElementById("matchesMixChart");
  const financeCtx = document.getElementById("financeMixChart");
  const depthCtx = document.getElementById("referralDepthChart");
  if (!matchesCtx || !financeCtx || !depthCtx) return;

  chartState.matches = new ChartLib(matchesCtx, {
    type: "bar",
    data: {
      labels: ["4 humains", "1 robot", "2 robots", "3 robots"],
      datasets: [{
        label: "Matchs",
        data: [
          metrics.game.matchesByBots[0],
          metrics.game.matchesByBots[1],
          metrics.game.matchesByBots[2],
          metrics.game.matchesByBots[3],
        ],
        backgroundColor: [
          "rgba(104, 215, 255, 0.62)",
          "rgba(124, 92, 255, 0.62)",
          "rgba(255, 156, 95, 0.62)",
          "rgba(75, 231, 184, 0.62)",
        ],
        borderRadius: 12,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: {
          ticks: { color: "#dfe8ff" },
          grid: { color: "rgba(163, 184, 255, 0.08)" },
        },
        y: {
          beginAtZero: true,
          ticks: { color: "#dfe8ff" },
          grid: { color: "rgba(163, 184, 255, 0.08)" },
        },
      },
    },
  });

  chartState.finance = new ChartLib(financeCtx, {
    type: "doughnut",
    data: {
      labels: ["Depots approuves", "Retraits approuves", "Xchange HTG->Does", "Xchange Does->HTG"],
      datasets: [{
        data: [
          Math.max(0, metrics.totals.approvedDepositsHtg),
          Math.max(0, metrics.totals.approvedWithdrawalsHtg),
          Math.max(0, metrics.totals.xchangeBuyHtg),
          Math.max(0, metrics.totals.xchangeSellHtg),
        ],
        backgroundColor: [
          "rgba(75, 231, 184, 0.78)",
          "rgba(255, 125, 141, 0.72)",
          "rgba(104, 215, 255, 0.74)",
          "rgba(255, 191, 105, 0.74)",
        ],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "66%",
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#dfe8ff",
            usePointStyle: true,
            padding: 16,
          },
        },
      },
    },
  });

  const depthCounts = metrics.referrals.graph.depthCounts;
  const depthLabels = Object.keys(depthCounts)
    .map((item) => safeInt(item))
    .filter((item) => item > 0)
    .sort((left, right) => left - right)
    .slice(0, 5);

  chartState.depth = new ChartLib(depthCtx, {
    type: "line",
    data: {
      labels: depthLabels.length ? depthLabels.map((item) => `N${item}`) : ["N1"],
      datasets: [{
        label: "Filleuls",
        data: depthLabels.length ? depthLabels.map((item) => safeInt(depthCounts[item])) : [0],
        borderColor: "rgba(124, 92, 255, 1)",
        backgroundColor: "rgba(124, 92, 255, 0.18)",
        fill: true,
        tension: 0.35,
        pointRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: "#dfe8ff",
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#dfe8ff" },
          grid: { color: "rgba(163, 184, 255, 0.08)" },
        },
        y: {
          beginAtZero: true,
          ticks: { color: "#dfe8ff" },
          grid: { color: "rgba(163, 184, 255, 0.08)" },
        },
      },
    },
  });
}

function makeInsight(tone, title, body) {
  const wrap = document.createElement("article");
  wrap.className = "insight";

  const tag = document.createElement("div");
  tag.className = `insight-tag ${tone}`;
  tag.textContent = title;

  const content = document.createElement("p");
  content.className = "insight-body";
  content.textContent = body;

  wrap.append(tag, content);
  return wrap;
}

function renderInsights(metrics) {
  if (!dom.insights) return;
  dom.insights.innerHTML = "";

  const insights = [];

  if (metrics.game.payoutRate >= 90) {
    insights.push({
      tone: "warn",
      title: "Payout eleve",
      body: `Le payout match est a ${formatPercent(metrics.game.payoutRate)}. La marge gameplay est faible sur la periode.`,
    });
  } else {
    insights.push({
      tone: "good",
      title: "Marge gameplay",
      body: `Le payout match reste sous controle a ${formatPercent(metrics.game.payoutRate)} avec ${formatDoes(metrics.totals.gameProfitDoes)} de marge.`,
    });
  }

  if (metrics.game.botRate >= 60) {
    insights.push({
      tone: "warn",
      title: "Dependance bots",
      body: `${formatPercent(metrics.game.botRate)} des matchs termines incluent des robots. Cela peut indiquer un manque de densite joueur en temps reel.`,
    });
  } else {
    insights.push({
      tone: "good",
      title: "Mix humain sain",
      body: `Le ratio de matchs avec robots est contenu a ${formatPercent(metrics.game.botRate)}.`,
    });
  }

  if (metrics.support.backlogThreads > 0) {
    insights.push({
      tone: "warn",
      title: "Backlog support",
      body: `${formatInt(metrics.support.backlogThreads)} conversation(s) attendent encore une reponse agent.`,
    });
  } else {
    insights.push({
      tone: "good",
      title: "Support fluide",
      body: "Aucun fil support n'est actuellement marque en attente cote agent.",
    });
  }

  if (metrics.finance.approvalRate < 45 && metrics.finance.ordersInRange.length > 0) {
    insights.push({
      tone: "bad",
      title: "Conversion depot faible",
      body: `Seulement ${formatPercent(metrics.finance.approvalRate)} des depots soumis sont approuves sur la periode.`,
    });
  } else {
    insights.push({
      tone: "good",
      title: "Funnel depot",
      body: `Le taux d'approbation depot est de ${formatPercent(metrics.finance.approvalRate)}.`,
    });
  }

  if (metrics.referrals.userReferredClients.length > 0) {
    insights.push({
      tone: metrics.referrals.referralDepositConversion >= 35 ? "good" : "warn",
      title: "Referral conversion",
      body: `${formatPercent(metrics.referrals.referralDepositConversion)} des filleuls utilisateurs ont deja passe un premier depot approuve.`,
    });
  }

  insights.slice(0, 5).forEach((item) => {
    dom.insights.appendChild(makeInsight(item.tone, item.title, item.body));
  });
}

function createDataRow(name, meta, value) {
  const row = document.createElement("div");
  row.className = "data-row";

  const left = document.createElement("div");
  const title = document.createElement("div");
  title.className = "data-name";
  title.textContent = name;
  const info = document.createElement("div");
  info.className = "data-meta";
  info.textContent = meta;
  left.append(title, info);

  const right = document.createElement("div");
  right.className = "data-value";
  right.textContent = value;

  row.append(left, right);
  return row;
}

function renderDataList(target, rows, emptyLabel) {
  if (!target) return;
  target.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = emptyLabel;
    target.appendChild(empty);
    return;
  }

  rows.forEach((row) => target.appendChild(row));
}

function renderRankings(metrics) {
  renderDataList(
    dom.topPlayers,
    metrics.rankings.topPlayers.map((item) => createDataRow(
      item.name,
      `${item.email || "Sans email"} • ${formatDoes(item.doesBalance)}`,
      `${formatInt(item.matches)} matchs`
    )),
    "Aucune participation sur la periode."
  );

  renderDataList(
    dom.topReferrers,
    metrics.rankings.topReferrers.map((item) => createDataRow(
      item.name,
      `${formatInt(item.directCount)} directs • ${formatInt(item.depositCount)} filleuls avec depot`,
      `${formatInt(item.descendantCount)} descendants • ${formatDoes(item.rewardTotalDoes)}`
    )),
    "Aucun parrain actif pour l'instant."
  );

  renderDataList(
    dom.topAmbassadors,
    metrics.rankings.topAmbassadors.map((item) => createDataRow(
      item.name,
      `R1:${formatInt(item.depth1)} • R2:${formatInt(item.depth2)} • R3:${formatInt(item.depth3)}`,
      `${formatInt(item.visibleNetwork)} reseau • ${formatSignedDoes(item.deltaDoes)}`
    )),
    "Aucun ambassadeur ou reseau visible."
  );
}

function renderRecords(metrics) {
  const clientMap = metrics.referrals.graph.clientsById;
  const resolvePlayer = (playerId) => {
    const client = clientMap.get(String(playerId || "").trim()) || {};
    return String(client.name || client.email || playerId || "Inconnu");
  };

  const referralRows = [
    createDataRow(
      "Primes parrainage total",
      `${formatInt(metrics.records.referralRewardEvents.length)} bonus de premier depot sur la periode`,
      formatDoes(metrics.records.referralRewardDoesTotal)
    ),
    ...metrics.records.topReferralRewardPlayers.map((item) => createDataRow(
      item.name,
      "Cumul recu via filleuls convertis",
      formatDoes(item.amount)
    )),
  ];

  const gainLossRows = [];
  if (metrics.records.largestGainEntry) {
    gainLossRows.push(createDataRow(
      "Plus gros gain ponctuel",
      `${resolvePlayer(metrics.records.largestGainEntry.playerId)} • ${sourceLabel(metrics.records.largestGainEntry.source)} • ${formatDateLabel(metrics.records.largestGainEntry.createdMs)}`,
      formatSignedDoes(metrics.records.largestGainEntry.deltaDoes)
    ));
  }
  if (metrics.records.largestLossEntry) {
    gainLossRows.push(createDataRow(
      "Plus grosse perte ponctuelle",
      `${resolvePlayer(metrics.records.largestLossEntry.playerId)} • ${sourceLabel(metrics.records.largestLossEntry.source)} • ${formatDateLabel(metrics.records.largestLossEntry.createdMs)}`,
      formatSignedDoes(metrics.records.largestLossEntry.deltaDoes)
    ));
  }

  [
    ["Jour", metrics.records.dayExtremes],
    ["Semaine", metrics.records.weekExtremes],
    ["Mois", metrics.records.monthExtremes],
  ].forEach(([label, bucket]) => {
    if (bucket?.bestGain) {
      gainLossRows.push(createDataRow(
        `Pic gain ${label.toLowerCase()}`,
        `${formatPeriodLabel(bucket.bestGain.bucketMs, label === "Jour" ? "day" : label === "Semaine" ? "week" : "month")} • ${formatInt(bucket.bestGain.events)} operations`,
        formatSignedDoes(bucket.bestGain.positiveDoes)
      ));
    }
    if (bucket?.worstLoss) {
      gainLossRows.push(createDataRow(
        `Pic perte ${label.toLowerCase()}`,
        `${formatPeriodLabel(bucket.worstLoss.bucketMs, label === "Jour" ? "day" : label === "Semaine" ? "week" : "month")} • ${formatInt(bucket.worstLoss.events)} operations`,
        formatSignedDoes(-bucket.worstLoss.negativeDoes)
      ));
    }
  });

  metrics.records.topGainPlayers.forEach((item) => {
    gainLossRows.push(createDataRow(
      `Top gagnant: ${item.name}`,
      "Somme des credits sur la periode",
      formatDoes(item.amount)
    ));
  });
  metrics.records.topLossPlayers.forEach((item) => {
    gainLossRows.push(createDataRow(
      `Top perdant: ${item.name}`,
      "Somme des debits sur la periode",
      formatSignedDoes(-item.amount)
    ));
  });

  const financeRows = [];
  if (metrics.records.largestDeposit) {
    financeRows.push(createDataRow(
      "Plus gros depot global",
      `${resolvePlayer(metrics.records.largestDeposit.playerId)} • ${formatDateLabel(getCreatedMs(metrics.records.largestDeposit))}`,
      formatCurrencyHtg(metrics.records.largestDeposit.amountHtg)
    ));
  }
  if (metrics.records.largestWithdrawal) {
    financeRows.push(createDataRow(
      "Plus gros retrait global",
      `${resolvePlayer(metrics.records.largestWithdrawal.playerId)} • ${formatDateLabel(getCreatedMs(metrics.records.largestWithdrawal))}`,
      formatCurrencyHtg(metrics.records.largestWithdrawal.amountHtg)
    ));
  }
  metrics.records.topDepositPlayers.forEach((item) => {
    financeRows.push(createDataRow(
      `Record depot: ${item.name}`,
      "Max depot unique du joueur",
      formatCurrencyHtg(item.amountHtg)
    ));
  });
  metrics.records.topWithdrawalPlayers.forEach((item) => {
    financeRows.push(createDataRow(
      `Record retrait: ${item.name}`,
      "Max retrait unique du joueur",
      formatCurrencyHtg(item.amountHtg)
    ));
  });

  renderDataList(
    dom.referralRewards,
    referralRows,
    "Aucune prime de parrainage detectee sur la periode."
  );
  renderDataList(
    dom.gainLossRecords,
    gainLossRows,
    "Aucun flux Does positif ou negatif sur la periode."
  );
  renderDataList(
    dom.financeRecords,
    financeRows,
    "Aucun depot ou retrait approuve sur la periode."
  );
}

function renderReferralTree(metrics) {
  if (!dom.treeWrap) return;
  dom.treeWrap.innerHTML = "";

  const graph = metrics.referrals.graph;
  const depthLimit = Math.max(2, Math.min(5, safeInt(dom.treeDepth?.value || 3)));
  const roots = graph.roots.slice(0, MAX_TREE_ROOTS);

  if (!roots.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Aucune branche user referral detectee.";
    dom.treeWrap.appendChild(empty);
    return;
  }

  roots.forEach((rootId) => {
    const root = graph.clientsById.get(rootId) || {};
    const rootStats = graph.parentStats.find((item) => item.parentId === rootId) || { descendantCount: 0 };
    const card = document.createElement("article");
    card.className = "tree-root";

    const title = document.createElement("h3");
    title.className = "tree-title";
    title.textContent = String(root.name || root.email || rootId);

    const caption = document.createElement("p");
    caption.className = "tree-caption";
    caption.textContent = `${formatInt(rootStats.descendantCount)} descendant(s) • ${root.email || rootId}`;

    const levelsWrap = document.createElement("div");
    levelsWrap.className = "tree-levels";

    const levels = buildLevelNodes(rootId, graph, depthLimit);
    levels.forEach((levelNodes, index) => {
      const level = document.createElement("div");
      level.className = "tree-level";

      const label = document.createElement("div");
      label.className = "tree-level-label";
      label.textContent = `Niveau ${index + 1} • ${formatInt(levelNodes.length)} noeud(s)`;

      const badges = document.createElement("div");
      badges.className = "tree-badges";

      levelNodes.slice(0, 18).forEach((nodeId) => {
        const node = graph.clientsById.get(nodeId) || {};
        const badge = document.createElement("div");
        badge.className = "tree-badge";
        badge.textContent = String(node.name || node.email || nodeId);
        badges.appendChild(badge);
      });

      if (levelNodes.length > 18) {
        const more = document.createElement("div");
        more.className = "tree-badge";
        more.textContent = `+${formatInt(levelNodes.length - 18)} autres`;
        badges.appendChild(more);
      }

      level.append(label, badges);
      levelsWrap.appendChild(level);
    });

    card.append(title, caption, levelsWrap);
    dom.treeWrap.appendChild(card);
  });
}

function renderRecommendedMetrics(metrics = null) {
  if (!dom.recommendedMetrics) return;
  dom.recommendedMetrics.innerHTML = "";

  const advanced = metrics?.advanced || null;
  const items = advanced ? [
    {
      tone: "good",
      title: "Timing matchs",
      body: `Duree moyenne: ${formatDuration(advanced.avgMatchDurationMs)} • attente moyenne: ${formatDuration(advanced.avgQueueWaitMs)}.`,
    },
    {
      tone: "good",
      title: "Conversion 1er depot",
      body: `Delai moyen avant premier depot approuve: ${formatDuration(advanced.avgFirstDepositDelayMs)}.`,
    },
    {
      tone: "good",
      title: "Session & device",
      body: `Top navigateur: ${advanced.topBrowser} • top pays: ${advanced.topCountry}.`,
    },
    {
      tone: "good",
      title: "SLA support",
      body: `1ere reponse: ${formatDuration(advanced.avgSupportFirstReplyMs)} • resolution moyenne: ${formatDuration(advanced.avgSupportResolutionMs)} • tag dominant: ${advanced.topResolutionTag}.`,
    },
    {
      tone: "good",
      title: "Attribution marketing",
      body: `Source la plus presente: ${advanced.topMarketingSource}. Les depots heritent maintenant de la source d'acquisition du client.`,
    },
    {
      tone: "good",
      title: "Cohortes retention",
      body: `J1: ${formatInt(advanced.retention.seen1d)} • J7: ${formatInt(advanced.retention.seen7d)} • J30: ${formatInt(advanced.retention.seen30d)} • joueurs actifs 7j: ${formatInt(advanced.retention.game7d)}.`,
    },
  ] : [
    {
      tone: "warn",
      title: "Collecte avancee",
      body: "Les variables avancees seront affichees ici des que les donnees sont chargees.",
    },
  ];

  items.forEach((item) => {
    dom.recommendedMetrics.appendChild(makeInsight(item.tone, item.title, item.body));
  });
}

function renderAll(metrics) {
  renderKpis(metrics);
  renderInsights(metrics);
  renderRankings(metrics);
  renderRecords(metrics);
  renderReferralTree(metrics);
  renderRecommendedMetrics(metrics);
  renderCharts(metrics);
}

async function refreshAnalytics() {
  try {
    await ensureFinanceDashboardSession({
      title: "Global Analytics",
      description: "Connecte-toi avec le compte admin finance pour charger les indicateurs globaux.",
    });
    setStatus("Chargement des donnees...", "warn");
    const raw = await fetchAllAnalyticsData();
    state.raw = raw;
    renderBotDifficultyControls(raw?.botDifficulty);
    state.computed = computeMetrics(raw, readDateRangeFromInputs());
    renderAll(state.computed);
    setStatus(
      `Derniere mise a jour: ${formatDateLabel(Date.now())} • ${formatInt(state.computed.totals.players)} joueurs charges`,
      "success"
    );
  } catch (error) {
    console.error("[ANALYTICS] refresh error", error);
    setStatus(error?.message || "Impossible de charger les analytics.", "error");
  }
}

function applyFilters() {
  if (!state.raw) {
    refreshAnalytics();
    return;
  }
  state.computed = computeMetrics(state.raw, readDateRangeFromInputs());
  renderAll(state.computed);
  setStatus(
    `Filtre applique du ${formatDateLabel(state.computed.range.fromMs)} au ${formatDateLabel(state.computed.range.toMs)}`,
    "neutral"
  );
}

async function applyBotDifficulty(level) {
  const nextLevel = normalizeBotDifficulty(level);
  try {
    await ensureFinanceDashboardSession({
      title: "Global Analytics",
      description: "Connecte-toi avec le compte admin finance pour piloter le niveau des bots.",
    });
    setStatus(`Changement du niveau bot vers ${botDifficultyLabel(nextLevel)}...`, "warn");
    const result = await setBotDifficultySecure({ botDifficulty: nextLevel });
    const appliedLevel = normalizeBotDifficulty(result?.botDifficulty || nextLevel);
    renderBotDifficultyControls(appliedLevel);
    if (state.raw) state.raw.botDifficulty = appliedLevel;
    setStatus(`Niveau des bots mis a jour: ${botDifficultyLabel(appliedLevel)}.`, "success");
  } catch (error) {
    console.error("[ANALYTICS] bot difficulty error", error);
    renderBotDifficultyControls(state.botDifficulty);
    setStatus(error?.message || "Impossible de changer le niveau des bots.", "error");
  }
}

function initDefaultFilters() {
  const now = new Date();
  const from = new Date(now.getTime() - (29 * 24 * 60 * 60 * 1000));
  if (dom.dateFrom) dom.dateFrom.value = getDateInputValue(from);
  if (dom.dateTo) dom.dateTo.value = getDateInputValue(now);
}

function bindEvents() {
  dom.refreshBtn?.addEventListener("click", refreshAnalytics);
  dom.applyBtn?.addEventListener("click", applyFilters);
  dom.treeDepth?.addEventListener("change", applyFilters);
  dom.dateFrom?.addEventListener("change", applyFilters);
  dom.dateTo?.addEventListener("change", applyFilters);
  dom.botDifficultyButtons.forEach((button) => {
    button.addEventListener("click", () => {
      applyBotDifficulty(button.dataset.botLevel);
    });
  });
}

async function init() {
  initDefaultFilters();
  bindEvents();
  renderBotDifficultyControls(DEFAULT_BOT_DIFFICULTY);
  renderRecommendedMetrics(null);
  await refreshAnalytics();
}

init();
