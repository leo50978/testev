import PaymentModal from "./payment.js";
import { getXchangeState } from "./xchange.js";
import {
  auth,
  db,
  collection,
  query,
  orderBy,
  onSnapshot,
} from "./firebase-init.js";
import { orderClientActionSecure } from "./secure-functions.js";
const BALANCE_DEBUG = true;

let stopOrdersListener = null;
let stopWithdrawalsListener = null;
let cachedOrders = [];
let cachedWithdrawals = [];
const MIN_DEPOSIT_HTG = 25;
let balanceHydrationSession = {
  uid: "",
  ordersReady: false,
  withdrawalsReady: false,
  promise: null,
  resolve: null,
};

function ensureBalanceHydrationSession(uid) {
  const safeUid = String(uid || "").trim();
  if (!safeUid) return null;
  if (balanceHydrationSession.uid === safeUid && balanceHydrationSession.promise) {
    return balanceHydrationSession;
  }
  balanceHydrationSession = {
    uid: safeUid,
    ordersReady: false,
    withdrawalsReady: false,
    promise: null,
    resolve: null,
  };
  balanceHydrationSession.promise = new Promise((resolve) => {
    balanceHydrationSession.resolve = resolve;
  });
  return balanceHydrationSession;
}

function markBalanceHydrationReady(kind, uid) {
  const session = ensureBalanceHydrationSession(uid);
  if (!session) return;
  if (kind === "orders") session.ordersReady = true;
  if (kind === "withdrawals") session.withdrawalsReady = true;
  if (session.ordersReady && session.withdrawalsReady && typeof session.resolve === "function") {
    const resolve = session.resolve;
    session.resolve = null;
    resolve(true);
  }
}

export async function waitForBalanceHydration(uid = auth.currentUser?.uid, timeoutMs = 2200) {
  const session = ensureBalanceHydrationSession(uid);
  if (!session) return false;
  if (session.ordersReady && session.withdrawalsReady) return true;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(false), Math.max(300, Number(timeoutMs) || 2200));
    session.promise.then(() => {
      window.clearTimeout(timer);
      resolve(true);
    });
  });
}

function formatAmount(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat("fr-HT", {
    style: "currency",
    currency: "HTG",
    maximumFractionDigits: 0,
  }).format(amount);
}

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildClientFromAuth() {
  const user = auth.currentUser;
  if (!user) return null;
  return {
    id: user.uid,
    uid: user.uid,
    name: user.displayName || (user.email ? user.email.split("@")[0] : "Client"),
    email: user.email || "",
  };
}

function openPaymentDepositDirectly(amount = 500) {
  const numericAmount = Number(amount || 0);
  if (numericAmount < MIN_DEPOSIT_HTG) return false;

  const client = buildClientFromAuth();
  if (!client) return false;

  new PaymentModal({
    amount: numericAmount,
    client,
    cart: [
      {
        id: `deposit_${Date.now()}`,
        name: "Depot de solde",
        price: numericAmount,
        quantity: 1,
        image: "",
        weight: 0,
      },
    ],
    delivery: null,
    onSuccess: () => {
      const event = new CustomEvent("balanceDepositSuccess", { detail: { amount: numericAmount } });
      document.dispatchEvent(event);
    },
  });

  return true;
}

function updateSoldBadge(balanceValue) {
  const badge = document.getElementById("soldBadge");
  if (!badge) return;

  const baseBalance = Number(balanceValue || 0);
  const xState = getXchangeState(baseBalance, auth.currentUser?.uid);
  const availableBalance = Number(xState.availableGourdes || 0);
  if (BALANCE_DEBUG) {
    console.log("[BALANCE_DEBUG][SOLDE] updateSoldBadge", {
      inputBalanceValue: balanceValue,
      baseBalance,
      uid: auth.currentUser?.uid || null,
      exchangedGourdes: xState.exchangedGourdes,
      does: xState.does,
      availableBalance,
      prevUserBaseBalance: window.__userBaseBalance,
      prevUserBalance: window.__userBalance,
    });
  }

  if (availableBalance > 0) {
    badge.innerHTML = `
      <span class="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-[11px]">+</span>
      <span>${formatAmount(availableBalance)}</span>
    `;
  } else {
    badge.innerHTML = `
      <span class="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/20 text-[11px]">+</span>
      <span>Faire un dépôt</span>
    `;
  }

  window.__userBaseBalance = baseBalance;
  window.__userBalance = availableBalance;
  window.dispatchEvent(
    new CustomEvent("userBalanceUpdated", {
      detail: { balance: availableBalance, baseBalance },
    })
  );
}

function getOrderUiStatus(order) {
  if (!order) return "pending";
  if (order.status === "approved") return "approved";
  if (order.status === "rejected") return "rejected";
  if (order.status === "review") return "review";
  return "pending";
}

function renderOrderCard(order) {
  const kind = order.type === "withdrawal" ? "withdrawal" : "order";
  const status = getOrderUiStatus(order);
  const code = escapeHtml(order.uniqueCode || order.id || "-");
  const amountValue = Number(order.requestedAmount ?? order.amount ?? 0);
  const amount = formatAmount(amountValue);
  const createdAt = order.createdAt ? new Date(order.createdAt).toLocaleString() : "-";
  const title = kind === "withdrawal" ? "Retrait" : "Commande";
  const amountPrefix = kind === "withdrawal" ? "-" : "";

  let badgeClass = "bg-[#a16a28]/30 text-[#ffd7a7]";
  let badgeLabel = "En attente";

  if (status === "review") {
    badgeClass = "bg-[#2b4f79]/40 text-[#b8dcff]";
    badgeLabel = "En examen";
  }
  if (status === "rejected") {
    badgeClass = "bg-[#7a2b2b]/40 text-[#ffbdbd]";
    badgeLabel = "Rejetée";
  }

  return `
    <div class="rounded-2xl border border-white/20 bg-white/10 p-4 shadow-[8px_8px_18px_rgba(18,25,42,0.35),-6px_-6px_14px_rgba(121,135,173,0.2)]">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-sm font-semibold text-white">${title} ${code}</p>
          <p class="text-xs text-white/70">${createdAt}</p>
        </div>
        <span class="rounded-full px-2 py-1 text-[11px] font-semibold ${badgeClass}">${badgeLabel}</span>
      </div>

      <div class="mt-3 text-sm text-white/85">
        <p>Montant: <span class="font-semibold">${amountPrefix}${amount}</span></p>
        <p>Méthode: ${escapeHtml(order.methodName || "-")}</p>
      </div>

      ${status === "rejected" ? `
        <div class="mt-3 rounded-xl bg-[#7a2b2b]/25 p-3 text-xs text-[#ffd1d1]">
          Commande rejetée à cause d'une erreur.
        </div>
        <div class="mt-3 flex gap-2">
          <button data-action="hide" data-kind="${kind}" data-order-id="${escapeHtml(order.id)}" class="flex-1 rounded-xl border border-white/20 bg-white/10 py-2 text-xs font-semibold text-white">Supprimer</button>
          <button data-action="review" data-kind="${kind}" data-order-id="${escapeHtml(order.id)}" class="flex-1 rounded-xl border border-[#ffb26e] bg-[#F57C00] py-2 text-xs font-semibold text-white">Demander un examen</button>
        </div>
      ` : ""}
    </div>
  `;
}

function renderOrdersSection(orders, withdrawals) {
  const listEl = document.getElementById("soldeOrdersList");
  if (!listEl) return;

  const ops = [
    ...(orders || []).map((o) => ({ ...o, type: "order" })),
    ...(withdrawals || []).map((w) => ({ ...w, type: "withdrawal" })),
  ];
  const visible = ops
    .filter((o) => o && !o.userHiddenByClient && o.status !== "approved")
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  if (visible.length === 0) {
    listEl.innerHTML = `<p class="text-sm text-white/70">Aucune commande en attente.</p>`;
    return;
  }

  listEl.innerHTML = visible.map(renderOrderCard).join("");
}

async function hideOrderForUser(orderId) {
  const user = auth.currentUser;
  if (!user || !orderId) return;
  await orderClientActionSecure({
    kind: "order",
    id: orderId,
    action: "hide",
  });
}

async function requestReview(orderId) {
  const user = auth.currentUser;
  if (!user || !orderId) return;
  await orderClientActionSecure({
    kind: "order",
    id: orderId,
    action: "review",
  });
}

async function hideOperationForUser(orderId, kind) {
  if (kind === "withdrawal") {
    const user = auth.currentUser;
    if (!user || !orderId) return;
    await orderClientActionSecure({
      kind: "withdrawal",
      id: orderId,
      action: "hide",
    });
    return;
  }
  await hideOrderForUser(orderId);
}

async function requestOperationReview(orderId, kind) {
  if (kind === "withdrawal") {
    const user = auth.currentUser;
    if (!user || !orderId) return;
    await orderClientActionSecure({
      kind: "withdrawal",
      id: orderId,
      action: "review",
    });
    return;
  }
  await requestReview(orderId);
}

function bindOrdersActions() {
  const listEl = document.getElementById("soldeOrdersList");
  if (!listEl) return;

  listEl.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.getAttribute("data-action");
      const orderId = btn.getAttribute("data-order-id");
      const kind = btn.getAttribute("data-kind") || "order";
      if (!orderId) return;

      try {
        if (action === "hide") {
          await hideOperationForUser(orderId, kind);
        }
        if (action === "review") {
          await requestOperationReview(orderId, kind);
        }
      } catch (err) {
        console.error("Erreur action commande:", err);
      }
    });
  });
}

function attachOrdersListener() {
  const user = auth.currentUser;
  if (!user) return;
  ensureBalanceHydrationSession(user.uid);

  if (stopOrdersListener) {
    stopOrdersListener();
    stopOrdersListener = null;
  }

  const ordersRef = collection(db, "clients", user.uid, "orders");
  const q = query(ordersRef, orderBy("createdAt", "desc"));

  stopOrdersListener = onSnapshot(q, async (snapshot) => {
    const orders = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (BALANCE_DEBUG) {
      console.log("[BALANCE_DEBUG][SOLDE] orders snapshot", {
        count: orders.length,
        approvedCount: orders.filter((o) => o.status === "approved").length,
        preview: orders.slice(0, 3).map((o) => ({
          id: o.id,
          status: o.status,
          amount: o.amount,
          createdAt: o.createdAt,
        })),
      });
    }
    cachedOrders = orders;
    refreshBalanceFromCaches();
    markBalanceHydrationReady("orders", user.uid);

    // Cache automatiquement les commandes approuvées côté client (sans suppression DB)
    const approvedVisible = orders.filter((o) => o.status === "approved" && !o.userHiddenByClient);
    for (const order of approvedVisible) {
      try {
        await hideOrderForUser(order.id);
      } catch (err) {
        console.error("Erreur hide approved order:", err);
      }
    }

    renderOrdersSection(cachedOrders, cachedWithdrawals);
    bindOrdersActions();
  });
}

function attachWithdrawalsListener() {
  const user = auth.currentUser;
  if (!user) return;
  ensureBalanceHydrationSession(user.uid);

  if (stopWithdrawalsListener) {
    stopWithdrawalsListener();
    stopWithdrawalsListener = null;
  }

  const ref = collection(db, "clients", user.uid, "withdrawals");
  const q = query(ref, orderBy("createdAt", "desc"));

  stopWithdrawalsListener = onSnapshot(q, async (snapshot) => {
    const withdrawals = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (BALANCE_DEBUG) {
      console.log("[BALANCE_DEBUG][SOLDE] withdrawals snapshot", {
        count: withdrawals.length,
        pendingLikeCount: withdrawals.filter((w) => w.status !== "rejected").length,
        preview: withdrawals.slice(0, 3).map((w) => ({
          id: w.id,
          status: w.status,
          amount: w.amount,
          requestedAmount: w.requestedAmount,
          createdAt: w.createdAt,
        })),
      });
    }
    cachedWithdrawals = withdrawals;
    refreshBalanceFromCaches();
    markBalanceHydrationReady("withdrawals", user.uid);

    const approvedVisible = withdrawals.filter((o) => o.status === "approved" && !o.userHiddenByClient);
    for (const item of approvedVisible) {
      try {
        await hideOperationForUser(item.id, "withdrawal");
      } catch (err) {
        console.error("Erreur hide approved withdrawal:", err);
      }
    }

    renderOrdersSection(cachedOrders, cachedWithdrawals);
    bindOrdersActions();
  });
}

function refreshBalanceFromCaches() {
  const approvedDeposits = cachedOrders
    .filter((o) => o.status === "approved")
    .reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
  const reservedWithdrawals = cachedWithdrawals
    .filter((o) => o.status !== "rejected")
    .reduce((sum, o) => sum + Number(o.requestedAmount ?? o.amount ?? 0), 0);
  if (BALANCE_DEBUG) {
    console.log("[BALANCE_DEBUG][SOLDE] refreshBalanceFromCaches", {
      approvedDeposits,
      reservedWithdrawals,
      computedBase: Math.max(0, approvedDeposits - reservedWithdrawals),
      ordersCount: cachedOrders.length,
      withdrawalsCount: cachedWithdrawals.length,
    });
  }
  updateSoldBadge(Math.max(0, approvedDeposits - reservedWithdrawals));
}

function ensureSoldeModal() {
  const existing = document.getElementById("soldeModalOverlay");
  if (existing) return existing;

  if (!document.getElementById("soldeModalScrollStyle")) {
    const style = document.createElement("style");
    style.id = "soldeModalScrollStyle";
    style.textContent = `
      #soldePanel {
        scrollbar-width: none;
        -ms-overflow-style: none;
      }

      #soldePanel::-webkit-scrollbar {
        width: 0;
        height: 0;
        display: none;
      }
    `;
    document.head.appendChild(style);
  }

  const overlay = document.createElement("div");
  overlay.id = "soldeModalOverlay";
  overlay.className = "fixed inset-0 z-[3100] hidden items-center justify-center bg-black/45 p-4 backdrop-blur-sm";

  overlay.innerHTML = `
    <div id="soldePanel" class="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-3xl border border-white/20 bg-[#3F4766]/55 p-5 shadow-[14px_14px_34px_rgba(16,23,40,0.5),-10px_-10px_24px_rgba(112,126,165,0.2)] backdrop-blur-xl sm:p-6">
      <div class="flex items-start justify-between">
        <div>
          <p class="text-xs font-semibold uppercase tracking-[0.16em] text-white/70">Solde</p>
          <h3 class="mt-1 text-2xl font-bold text-white">Faire un dépôt</h3>
        </div>
        <button id="soldeClose" type="button" class="grid h-10 w-10 place-items-center rounded-full border border-white/20 bg-white/10 text-white shadow-[8px_8px_18px_rgba(18,25,42,0.42),-6px_-6px_14px_rgba(121,135,173,0.2)]">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>

      <div class="mt-4 rounded-2xl border border-white/20 bg-white/10 p-4">
        <p class="text-sm font-semibold text-white">Opérations en cours</p>
        <div id="soldeOrdersList" class="mt-3 grid gap-3"></div>
      </div>

      <div class="mt-5 rounded-2xl border border-white/20 bg-white/10 p-4 shadow-[inset_6px_6px_12px_rgba(19,26,43,0.42),inset_-6px_-6px_12px_rgba(120,134,172,0.22)]">
        <label for="soldeAmount" class="block text-sm font-medium text-white/90">Montant (HTG)</label>
        <input id="soldeAmount" type="number" min="25" step="25" value="25" class="mt-2 h-12 w-full rounded-xl border border-white/25 bg-white/10 px-4 text-white outline-none" />
        <div class="mt-3 grid grid-cols-3 gap-2">
          <button class="solde-quick rounded-xl border border-white/20 bg-white/10 py-2 text-sm text-white shadow-[8px_8px_18px_rgba(18,25,42,0.35),-6px_-6px_14px_rgba(121,135,173,0.2)]" data-amount="25">25</button>
          <button class="solde-quick rounded-xl border border-white/20 bg-white/10 py-2 text-sm text-white shadow-[8px_8px_18px_rgba(18,25,42,0.35),-6px_-6px_14px_rgba(121,135,173,0.2)]" data-amount="50">50</button>
          <button class="solde-quick rounded-xl border border-white/20 bg-white/10 py-2 text-sm text-white shadow-[8px_8px_18px_rgba(18,25,42,0.35),-6px_-6px_14px_rgba(121,135,173,0.2)]" data-amount="100">100</button>
        </div>
      </div>

      <div class="mt-4 rounded-2xl border border-white/20 bg-white/10 px-4 py-3 text-sm text-white/90">
        Total du dépôt: <span id="soldeTotal" class="font-semibold text-white"></span>
      </div>

      <div id="soldeError" class="mt-3 min-h-5 text-sm text-[#ffb0b0]"></div>

      <button id="soldeCheckout" type="button" class="mt-2 h-12 w-full rounded-2xl border border-[#ffb26e] bg-[#F57C00] font-semibold text-white shadow-[9px_9px_20px_rgba(155,78,25,0.45),-7px_-7px_16px_rgba(255,173,96,0.2)] transition hover:-translate-y-0.5">
        Faire un autre dépôt
      </button>
    </div>
  `;

  document.body.appendChild(overlay);

  const panel = overlay.querySelector("#soldePanel");
  const closeBtn = overlay.querySelector("#soldeClose");
  const amountInput = overlay.querySelector("#soldeAmount");
  const totalEl = overlay.querySelector("#soldeTotal");
  const errorEl = overlay.querySelector("#soldeError");
  const checkoutBtn = overlay.querySelector("#soldeCheckout");

  const refreshTotal = () => {
    const amount = Number(amountInput?.value || 0);
    if (totalEl) totalEl.textContent = formatAmount(amount);
  };

  const close = () => {
    overlay.classList.add("hidden");
    overlay.classList.remove("flex");
    document.body.classList.remove("overflow-hidden");
    if (errorEl) errorEl.textContent = "";
  };

  const open = () => {
    refreshTotal();
    overlay.classList.remove("hidden");
    overlay.classList.add("flex");
    document.body.classList.add("overflow-hidden");
    attachOrdersListener();
    attachWithdrawalsListener();
    renderOrdersSection(cachedOrders, cachedWithdrawals);
    bindOrdersActions();
  };

  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });

  if (panel) panel.addEventListener("click", (ev) => ev.stopPropagation());
  if (closeBtn) closeBtn.addEventListener("click", close);
  if (amountInput) amountInput.addEventListener("input", refreshTotal);

  overlay.querySelectorAll(".solde-quick").forEach((btn) => {
    btn.addEventListener("click", () => {
      const amount = Number(btn.getAttribute("data-amount") || 0);
      if (amountInput) amountInput.value = String(amount);
      refreshTotal();
    });
  });

  if (checkoutBtn) {
    checkoutBtn.addEventListener("click", () => {
      const amount = Number(amountInput?.value || 0);
      if (amount < MIN_DEPOSIT_HTG) {
        if (errorEl) errorEl.textContent = `Le montant minimum est ${MIN_DEPOSIT_HTG} HTG.`;
        return;
      }

      const opened = openPaymentDepositDirectly(amount);
      if (!opened) {
        if (errorEl) errorEl.textContent = "Utilisateur non connecté.";
        return;
      }

      close();
    });
  }

  overlay.__openSolde = open;
  return overlay;
}

export function mountSoldeModal(options = {}) {
  const { triggerSelector = "#soldBadge" } = options;
  const overlay = ensureSoldeModal();
  const trigger = document.querySelector(triggerSelector);

  if (trigger && overlay.__openSolde) {
    trigger.addEventListener("click", () => {
      overlay.__openSolde();
    });
  }

  updateSoldBadge(0);
  attachOrdersListener();
  attachWithdrawalsListener();
  window.addEventListener("xchangeUpdated", () => {
    if (BALANCE_DEBUG) {
      console.log("[BALANCE_DEBUG][SOLDE] xchangeUpdated event", {
        __userBaseBalance: window.__userBaseBalance,
        __userBalance: window.__userBalance,
      });
    }
    updateSoldBadge(window.__userBaseBalance || 0);
  });
  window.addEventListener("withdrawalSubmitted", (ev) => {
    const detail = ev?.detail || {};
    const submittedAmount = Number(detail?.requestedAmount ?? detail?.amount ?? 0);
    if (BALANCE_DEBUG) {
      console.log("[BALANCE_DEBUG][SOLDE] withdrawalSubmitted event", {
        detail,
        submittedAmount,
        __userBaseBalance: window.__userBaseBalance,
        __userBalance: window.__userBalance,
      });
    }

    // Déduction immédiate et centrale du solde après soumission retrait.
    if (Number.isFinite(submittedAmount) && submittedAmount > 0) {
      const currentBase = Number(window.__userBaseBalance || 0);
      const nextBase = Math.max(0, currentBase - submittedAmount);
      if (BALANCE_DEBUG) {
        console.log("[BALANCE_DEBUG][SOLDE] immediate deduction", {
          currentBase,
          submittedAmount,
          nextBase,
        });
      }
      updateSoldBadge(nextBase);
    }

    if (detail && typeof(detail) === "object" && detail.id) {
      const exists = cachedWithdrawals.some((w) => w && w.id === detail.id);
      if (!exists) {
        cachedWithdrawals = [{ ...detail }, ...cachedWithdrawals];
        refreshBalanceFromCaches();
        renderOrdersSection(cachedOrders, cachedWithdrawals);
        bindOrdersActions();
      }
    }
    attachWithdrawalsListener();
  });

  window.openPaymentDepositDirectly = openPaymentDepositDirectly;
}
