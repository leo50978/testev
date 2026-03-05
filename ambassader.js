import "./firebase-init.js";
import { withButtonLoading } from "./loading-ui.js";
import {
  authenticateAmbassador,
  getAmbassadorDashboardData,
  parseAmbassadorSession,
  serializeAmbassadorSession,
  formatDateTime,
  formatSignedDoes,
} from "./referral.js";

const AMBASSADOR_SESSION_KEY = "domino_ambassador_session_v1";
const AMBASSADOR_UI_ENABLED = false;

const elements = {
  loginPanel: document.getElementById("ambLoginPanel"),
  dashboardPanel: document.getElementById("ambDashboardPanel"),
  logoutBtn: document.getElementById("ambLogoutBtn"),
  loginForm: document.getElementById("ambLoginForm"),
  promoInput: document.getElementById("ambPromoCodeInput"),
  authInput: document.getElementById("ambAuthCodeInput"),
  loginBtn: document.getElementById("ambLoginBtn"),
  loginError: document.getElementById("ambLoginError"),

  name: document.getElementById("ambName"),
  codes: document.getElementById("ambCodes"),
  linkInput: document.getElementById("ambLinkInput"),
  copyLinkBtn: document.getElementById("copyAmbLinkBtn"),

  does: document.getElementById("ambDoes"),
  signups: document.getElementById("ambSignups"),
  deposits: document.getElementById("ambDeposits"),
  games: document.getElementById("ambGames"),
  wins: document.getElementById("ambWins"),
  losses: document.getElementById("ambLosses"),

  refreshBtn: document.getElementById("refreshAmbDashBtn"),
  referralsTable: document.getElementById("ambReferralsTable"),
  referralsEmpty: document.getElementById("ambReferralsEmpty"),
  perfChart: document.getElementById("ambPerfChart"),
  mixChart: document.getElementById("ambRefMixChart"),
};

let currentAmbassadorId = "";
let performanceChartInstance = null;
let mixChartInstance = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setLoginError(message) {
  if (elements.loginError) {
    elements.loginError.textContent = message || "";
  }
}

function setLoggedIn(loggedIn) {
  if (elements.loginPanel) {
    elements.loginPanel.classList.toggle("hidden", loggedIn);
  }
  if (elements.dashboardPanel) {
    elements.dashboardPanel.classList.toggle("hidden", !loggedIn);
  }
  if (elements.logoutBtn) {
    elements.logoutBtn.classList.toggle("hidden", !loggedIn);
  }
}

async function copyToClipboard(text) {
  const value = String(text || "").trim();
  if (!value) return false;

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
}

function destroyCharts() {
  if (performanceChartInstance) {
    performanceChartInstance.destroy();
    performanceChartInstance = null;
  }
  if (mixChartInstance) {
    mixChartInstance.destroy();
    mixChartInstance = null;
  }
}

function shortReferralLabel(item) {
  const source = String(item?.email || item?.userId || "").trim();
  if (!source) return "-";

  if (source.includes("@")) {
    const alias = source.split("@")[0] || "user";
    return alias.length <= 10 ? alias : `${alias.slice(0, 9)}…`;
  }

  return source.length <= 10 ? source : `${source.slice(0, 9)}…`;
}

function buildPerformanceChart(data) {
  const ChartLib = window.Chart;
  if (!elements.perfChart || !ChartLib) return;

  const referrals = Array.isArray(data?.referrals) ? [...data.referrals] : [];
  referrals.sort((a, b) => Number(b.totalGamesTracked || b.totalGames || 0) - Number(a.totalGamesTracked || a.totalGames || 0));
  const topReferrals = referrals.slice(0, 8);

  const labels = topReferrals.length ? topReferrals.map(shortReferralLabel) : ["Aucun"];
  const gamesData = topReferrals.length ? topReferrals.map((item) => Number(item.totalGamesTracked || item.totalGames || 0)) : [0];
  const deltaData = topReferrals.length ? topReferrals.map((item) => Number(item.ambassadorDoesDelta || 0)) : [0];

  const ctx = elements.perfChart.getContext("2d");
  performanceChartInstance = new ChartLib(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Parties",
          data: gamesData,
          backgroundColor: "rgba(57, 181, 255, 0.62)",
          borderColor: "rgba(57, 181, 255, 1)",
          borderWidth: 1,
          borderRadius: 10,
          yAxisID: "y",
        },
        {
          label: "Delta Does",
          type: "line",
          data: deltaData,
          borderColor: "rgba(255, 146, 69, 1)",
          backgroundColor: "rgba(255, 146, 69, 0.25)",
          borderWidth: 2.5,
          tension: 0.34,
          pointRadius: 3,
          pointHoverRadius: 5,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      scales: {
        x: {
          ticks: { color: "#cfe4ff" },
          grid: { color: "rgba(148, 163, 184, 0.14)" },
        },
        y: {
          beginAtZero: true,
          ticks: { color: "#cfe4ff" },
          grid: { color: "rgba(148, 163, 184, 0.14)" },
          title: {
            display: true,
            text: "Parties",
            color: "#b9d8ff",
          },
        },
        y1: {
          position: "right",
          ticks: { color: "#ffc089" },
          grid: { drawOnChartArea: false },
          title: {
            display: true,
            text: "Delta Does",
            color: "#ffc089",
          },
        },
      },
      plugins: {
        legend: {
          labels: {
            color: "#dcebff",
            boxWidth: 14,
            usePointStyle: true,
          },
        },
      },
    },
  });
}

function buildMixChart(data) {
  const ChartLib = window.Chart;
  if (!elements.mixChart || !ChartLib) return;

  const ambassador = data?.ambassador || {};
  const rawData = [
    Number(ambassador.totalSignups || 0),
    Number(ambassador.totalDeposits || 0),
    Number(ambassador.totalInvitedWins || 0),
    Number(ambassador.totalInvitedLosses || 0),
  ];

  const hasAny = rawData.some((value) => value > 0);
  const chartData = hasAny ? rawData : [1, 1, 1, 1];
  const colors = hasAny
    ? ["#39b5ff", "#2dd4bf", "#ff9e56", "#ff6f7d"]
    : ["rgba(57,181,255,0.25)", "rgba(45,212,191,0.25)", "rgba(255,158,86,0.25)", "rgba(255,111,125,0.25)"];

  const ctx = elements.mixChart.getContext("2d");
  mixChartInstance = new ChartLib(ctx, {
    type: "doughnut",
    data: {
      labels: ["Inscrits", "Dépôts", "Invités gagnants", "Invités perdants"],
      datasets: [
        {
          data: chartData,
          backgroundColor: colors,
          borderWidth: 0,
          hoverOffset: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "68%",
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#dcebff",
            boxWidth: 14,
            usePointStyle: true,
            padding: 16,
          },
        },
        tooltip: {
          callbacks: {
            label(context) {
              const idx = context.dataIndex;
              const label = context.label || "";
              const value = rawData[idx] || 0;
              return `${label}: ${value}`;
            },
          },
        },
      },
    },
  });
}

function renderCharts(data) {
  destroyCharts();
  buildPerformanceChart(data);
  buildMixChart(data);
}

function clearDashboard() {
  if (elements.name) elements.name.textContent = "-";
  if (elements.codes) elements.codes.textContent = "Code promo: -";
  if (elements.linkInput) elements.linkInput.value = "";

  if (elements.does) elements.does.textContent = "0";
  if (elements.signups) elements.signups.textContent = "0";
  if (elements.deposits) elements.deposits.textContent = "0";
  if (elements.games) elements.games.textContent = "0";
  if (elements.wins) elements.wins.textContent = "0";
  if (elements.losses) elements.losses.textContent = "0";

  if (elements.referralsTable) elements.referralsTable.innerHTML = "";
  if (elements.referralsEmpty) elements.referralsEmpty.classList.remove("hidden");
  destroyCharts();
}

function renderReferrals(referrals) {
  if (!elements.referralsTable || !elements.referralsEmpty) return;

  if (!Array.isArray(referrals) || referrals.length === 0) {
    elements.referralsTable.innerHTML = "";
    elements.referralsEmpty.classList.remove("hidden");
    return;
  }

  elements.referralsEmpty.classList.add("hidden");
  elements.referralsTable.innerHTML = referrals
    .map((item) => {
      const deltaText = formatSignedDoes(item.ambassadorDoesDelta || 0);
      const deltaClass = Number(item.ambassadorDoesDelta || 0) >= 0 ? "text-emerald-400" : "text-rose-400";
      const parentText = String(item.parentClientUid || item.parentClientId || "-") || "-";
      const totalGames = Number(item.totalGamesTracked || item.totalGames || 0);
      const wins = Number(item.winsTracked || item.winCount || 0);
      const losses = Number(item.lossesTracked || item.lossCount || 0);
      return `
        <tr class="border-b border-slate-700/55 transition">
          <td class="px-3 py-3">
            <p class="font-semibold text-[#deebff]">${escapeHtml(item.displayName || item.email || item.userId || "-")}</p>
            <p class="text-xs text-[#9ab3d7]">${escapeHtml(item.email || item.userId || "-")}</p>
          </td>
          <td class="px-3 py-3 text-[#d7e6ff]">Niveau ${Number(item.depth || 1)}</td>
          <td class="px-3 py-3 text-xs text-[#9ab3d7]">${escapeHtml(parentText)}</td>
          <td class="px-3 py-3 text-xs text-[#9ab3d7]">${escapeHtml(formatDateTime(item.createdAt))}</td>
          <td class="px-3 py-3 text-[#d7e6ff]">${item.hasApprovedDeposit ? "Oui" : "Non"}</td>
          <td class="px-3 py-3 text-[#d7e6ff]">${totalGames}</td>
          <td class="px-3 py-3 text-[#d7e6ff]">${wins}</td>
          <td class="px-3 py-3 text-[#d7e6ff]">${losses}</td>
          <td class="px-3 py-3 font-semibold ${deltaClass}">${escapeHtml(deltaText)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderDashboard(data) {
  const ambassador = data?.ambassador || null;
  if (!ambassador) {
    clearDashboard();
    return;
  }

  if (elements.name) elements.name.textContent = ambassador.name || "Ambassadeur";
  if (elements.codes) {
    elements.codes.textContent = `Code promo: ${ambassador.promoCode || "-"} | Code lien: ${ambassador.linkCode || "-"}`;
  }
  if (elements.linkInput) elements.linkInput.value = ambassador.referralLink || "";

  if (elements.does) elements.does.textContent = String(ambassador.doesBalance || 0);
  if (elements.signups) elements.signups.textContent = String(Math.max(Number(ambassador.totalSignups || 0), Number(data?.referrals?.length || 0)));
  if (elements.deposits) elements.deposits.textContent = String(ambassador.totalDeposits || 0);
  if (elements.games) elements.games.textContent = String(ambassador.totalGames || 0);
  if (elements.wins) elements.wins.textContent = String(ambassador.totalInvitedWins || 0);
  if (elements.losses) elements.losses.textContent = String(ambassador.totalInvitedLosses || 0);

  renderReferrals(data?.referrals || []);
  renderCharts(data);
}

async function loadDashboard(ambassadorId) {
  if (!ambassadorId) return false;
  const data = await getAmbassadorDashboardData(ambassadorId);
  if (!data) return false;

  currentAmbassadorId = ambassadorId;
  setLoggedIn(true);
  renderDashboard(data);
  return true;
}

async function submitLogin(event) {
  event.preventDefault();
  setLoginError("");

  const promoCode = String(elements.promoInput?.value || "").trim();
  const authCode = String(elements.authInput?.value || "").trim();

  if (!promoCode || !authCode) {
    setLoginError("Code promo et code d'auth requis.");
    return;
  }

  try {
    await withButtonLoading(
      elements.loginBtn,
      async () => {
        const authResult = await authenticateAmbassador({ promoCode, authCode });
        if (!authResult?.ok || !authResult?.ambassador?.id) {
          throw new Error("Code promo ou code d'auth invalide.");
        }

        localStorage.setItem(AMBASSADOR_SESSION_KEY, serializeAmbassadorSession(authResult.ambassador));
        const loaded = await loadDashboard(authResult.ambassador.id);
        if (!loaded) {
          throw new Error("Impossible de charger le dashboard ambassadeur.");
        }
      },
      { loadingLabel: "Connexion..." }
    );
  } catch (err) {
    setLoginError(err?.message || "Erreur de connexion.");
    clearDashboard();
    setLoggedIn(false);
  }
}

function logoutAmbassador() {
  localStorage.removeItem(AMBASSADOR_SESSION_KEY);
  currentAmbassadorId = "";
  clearDashboard();
  setLoggedIn(false);
  setLoginError("");
  if (elements.authInput) elements.authInput.value = "";
}

async function restoreSession() {
  const session = parseAmbassadorSession(localStorage.getItem(AMBASSADOR_SESSION_KEY));
  if (!session?.id) {
    setLoggedIn(false);
    return;
  }

  try {
    const loaded = await loadDashboard(session.id);
    if (!loaded) {
      logoutAmbassador();
    }
  } catch (_) {
    logoutAmbassador();
  }
}

function bindEvents() {
  elements.loginForm?.addEventListener("submit", submitLogin);
  elements.logoutBtn?.addEventListener("click", logoutAmbassador);
  elements.refreshBtn?.addEventListener("click", async () => {
    if (!currentAmbassadorId) return;
    try {
      await withButtonLoading(
        elements.refreshBtn,
        async () => {
          await loadDashboard(currentAmbassadorId);
        },
        { loadingLabel: "Chargement..." }
      );
    } catch (_) {}
  });
  elements.copyLinkBtn?.addEventListener("click", async () => {
    const text = elements.linkInput?.value || "";
    await copyToClipboard(text);
  });
  elements.promoInput?.addEventListener("input", () => {
    const upper = String(elements.promoInput.value || "").toUpperCase();
    if (upper !== elements.promoInput.value) {
      elements.promoInput.value = upper;
    }
  });
}

function init() {
  if (!AMBASSADOR_UI_ENABLED) {
    document.body.innerHTML = `
      <main style="min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;font-family:Poppins,sans-serif;padding:24px;">
        <section style="width:min(92vw,640px);border:1px solid rgba(148,163,184,.35);border-radius:20px;background:rgba(15,23,42,.72);padding:24px;box-shadow:0 20px 50px rgba(2,6,23,.45);">
          <h1 style="margin:0 0 10px;font-size:1.35rem;font-weight:800;">Module ambassadeur désactivé</h1>
          <p style="margin:0;color:#cbd5e1;line-height:1.5;">
            Cette interface n'est plus disponible. Le système ambassadeur a été neutralisé pour l'application.
          </p>
        </section>
      </main>
    `;
    return;
  }
  bindEvents();
  clearDashboard();
  setLoggedIn(false);
  restoreSession();
}

init();
