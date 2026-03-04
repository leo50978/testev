import {
  auth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  sendEmailVerification,
  reload,
  applyActionCode,
} from "./firebase-init.js";

function formatAuthError(err, fallback) {
  const code = err && err.code ? String(err.code) : "";
  const map = {
    "auth/operation-not-allowed": "Méthode Email/Mot de passe non activée dans Firebase Auth.",
    "auth/invalid-api-key": "API key Firebase invalide.",
    "auth/unauthorized-domain": "Domaine non autorisé dans Firebase Authentication.",
    "auth/invalid-email": "Adresse email invalide.",
    "auth/email-already-in-use": "Cet email est déjà utilisé.",
    "auth/weak-password": "Mot de passe trop faible (min 6 caractères).",
    "auth/network-request-failed": "Erreur réseau vers Firebase.",
    "auth/too-many-requests": "Trop de tentatives, réessaie plus tard.",
    "auth/invalid-credential": "Email ou mot de passe incorrect.",
    "auth/user-not-found": "Compte introuvable.",
    "auth/wrong-password": "Mot de passe incorrect.",
    "auth/popup-closed-by-user": "Connexion Google annulée.",
    "auth/popup-blocked": "Popup Google bloquée par le navigateur.",
    "auth/cancelled-popup-request": "Requête popup Google annulée.",
    "auth/account-exists-with-different-credential": "Ce compte existe déjà avec une autre méthode de connexion.",
    "auth/invalid-action-code": "Le code de vérification est invalide ou déjà utilisé.",
    "auth/expired-action-code": "Le code de vérification a expiré.",
  };

  if (code && map[code]) return map[code] + " (" + code + ")";
  if (code) return (fallback || "Erreur d'authentification") + " (" + code + ")";
  return (err && err.message) || fallback || "Erreur d'authentification";
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || "").trim());
}

function isValidPassword(pass) {
  return typeof pass === "string" && pass.length >= 6;
}

async function loginWithEmail(email, password) {
  return signInWithEmailAndPassword(auth, String(email || "").trim(), String(password || ""));
}

async function signupWithEmail(email, password) {
  return createUserWithEmailAndPassword(auth, String(email || "").trim(), String(password || ""));
}

async function sendPasswordReset(email) {
  return sendPasswordResetEmail(auth, String(email || "").trim());
}

async function sendSignupVerificationEmail(user = auth.currentUser) {
  if (!user) throw new Error("Utilisateur introuvable pour envoyer l'email de vérification.");
  return sendEmailVerification(user);
}

async function refreshCurrentUser(user = auth.currentUser) {
  if (!user) return null;
  await reload(user);
  return auth.currentUser;
}

async function applyEmailVerificationCode(code) {
  return applyActionCode(auth, String(code || "").trim());
}

function isEmailPasswordUser(user) {
  if (!user || !Array.isArray(user.providerData)) return false;
  return user.providerData.some((provider) => provider?.providerId === "password");
}

async function logoutCurrentUser() {
  return signOut(auth);
}

function isGoogleRedirectSupportedOnCurrentHost() {
  if (typeof window === "undefined") return false;
  const host = String(window.location?.hostname || "").trim().toLowerCase();
  const protocol = String(window.location?.protocol || "").trim().toLowerCase();
  if (!host) return false;
  if (protocol === "file:") return false;
  if (protocol !== "http:" && protocol !== "https:") return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) {
    return false;
  }
  return true;
}

function isFirebaseHostedDomain() {
  if (typeof window === "undefined") return false;
  const host = String(window.location?.hostname || "").trim().toLowerCase();
  return host.endsWith(".firebaseapp.com") || host.endsWith(".web.app");
}

function shouldPreferGoogleRedirect() {
  if (typeof window === "undefined") return false;

  const ua = String(window.navigator?.userAgent || "").toLowerCase();
  const coarsePointer = typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;
  const smallViewport = Math.min(
    Number(window.screen?.width || 0),
    Number(window.screen?.height || 0)
  ) > 0 && Math.min(
    Number(window.screen?.width || 0),
    Number(window.screen?.height || 0)
  ) <= 900;

  const mobileUa =
    ua.includes("android") ||
    ua.includes("iphone") ||
    ua.includes("ipad") ||
    ua.includes("ipod") ||
    ua.includes("mobile");

  return coarsePointer || smallViewport || mobileUa;
}

async function waitForResolvedPopupUser(timeoutMs = 4500) {
  if (auth.currentUser) return auth.currentUser;

  return new Promise((resolve) => {
    let settled = false;
    const finalize = (user) => {
      if (settled) return;
      settled = true;
      try {
        unsubscribe();
      } catch (_) {}
      window.clearTimeout(timer);
      resolve(user || null);
    };

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) finalize(user);
    });

    const timer = window.setTimeout(() => {
      finalize(auth.currentUser || null);
    }, Math.max(250, Number(timeoutMs) || 1800));
  });
}

async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  // Keep redirect flow only on Firebase-hosted domains.
  // On custom-hosted fronts (ex: GitHub Pages + custom domain), popup is
  // significantly more reliable and avoids redirect-return loops.
  const canUseRedirect = isGoogleRedirectSupportedOnCurrentHost() && isFirebaseHostedDomain();

  if (canUseRedirect && shouldPreferGoogleRedirect()) {
    await signInWithRedirect(auth, provider);
    return { mode: "redirect", result: null };
  }

  try {
    const res = await signInWithPopup(auth, provider);
    return { mode: "popup", result: res };
  } catch (err) {
    const code = err?.code ? String(err.code) : "";
    if (code === "auth/popup-blocked" && canUseRedirect) {
      await signInWithRedirect(auth, provider);
      return { mode: "redirect", result: null };
    }
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
      const resolvedUser = await waitForResolvedPopupUser();
      if (resolvedUser) {
        return { mode: "popup", result: { user: resolvedUser } };
      }
      if (canUseRedirect) {
        await signInWithRedirect(auth, provider);
        return { mode: "redirect", result: null };
      }
    }
    throw err;
  }
}

async function completeGoogleRedirectIfAny() {
  const result = await getRedirectResult(auth);
  if (result?.user) return result;
  if (auth.currentUser) {
    return { user: auth.currentUser };
  }
  return result;
}

function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

export {
  auth,
  formatAuthError,
  isValidEmail,
  isValidPassword,
  loginWithEmail,
  loginWithGoogle,
  completeGoogleRedirectIfAny,
  signupWithEmail,
  sendPasswordReset,
  sendSignupVerificationEmail,
  refreshCurrentUser,
  applyEmailVerificationCode,
  isEmailPasswordUser,
  logoutCurrentUser,
  watchAuthState,
};

function initLegacyAuthUI() {
  const wrap = document.createElement("div");
  wrap.id = "AuthRoot";
  wrap.className = "MarcoCanvas";
  wrap.setAttribute("visible", "true");
  wrap.style.position = "fixed";
  wrap.style.top = "1rem";
  wrap.style.left = "1rem";
  wrap.style.zIndex = "1500";
  wrap.style.padding = "0.6rem";
  wrap.style.background = "rgba(37,35,40,0.92)";
  wrap.style.color = "#fff";
  wrap.style.maxWidth = "22rem";

  wrap.innerHTML = `
    <div id="AuthLoggedOut">
      <div style="font-size:1.1rem; margin-bottom:0.4rem;">Compte</div>
      <label for="AuthEmail" style="display:block; font-size:0.9rem; margin-bottom:0.2rem;">Email *</label>
      <input id="AuthEmail" type="email" placeholder="nom@domaine.com" autocomplete="email" autocapitalize="off" spellcheck="false" style="width:100%;margin-bottom:0.15rem;" />
      <div id="AuthEmailHint" style="font-size:0.78rem; color:#cde7ff; margin-bottom:0.45rem;">Format attendu: nom@domaine.com</div>

      <label for="AuthPassword" style="display:block; font-size:0.9rem; margin-bottom:0.2rem;">Mot de passe *</label>
      <input id="AuthPassword" type="password" placeholder="Au moins 6 caractères" autocomplete="new-password" style="width:100%;margin-bottom:0.15rem;" />
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.45rem;">
        <div id="AuthPasswordHint" style="font-size:0.78rem; color:#cde7ff;">Minimum 6 caractères</div>
        <button id="AuthTogglePwdBtn" type="button" style="font-size:0.75rem;padding:0.2rem 0.4rem;">Afficher</button>
      </div>

      <div style="display:flex;gap:0.4rem;">
        <button id="AuthLoginBtn" style="flex:1;" disabled>Connexion</button>
        <button id="AuthSignupBtn" style="flex:1;" disabled>Créer compte</button>
      </div>
      <div id="AuthError" role="alert" style="color:#ff9c9c; margin-top:0.4rem; min-height:1.2rem;"></div>
    </div>
    <div id="AuthLoggedIn" style="display:none;">
      <div>Connecté: <span id="AuthUserEmail"></span></div>
      <div style="display:flex; gap:0.4rem; margin-top:0.4rem;">
        <button id="AuthLogoutBtn" style="flex:1;">Déconnexion</button>
        <button id="AuthLeaveRoomBtn" style="flex:1;">Quitter salle</button>
      </div>
      <div id="AuthStatus" style="margin-top:0.4rem; color:#cde7ff;"></div>
    </div>
  `;

  document.body.appendChild(wrap);

  const read = () => ({
    email: (document.getElementById("AuthEmail").value || "").trim(),
    pass: document.getElementById("AuthPassword").value || "",
  });

  const setError = (message) => {
    const el = document.getElementById("AuthError");
    if (el) el.textContent = message || "";
  };

  const setLoggedInUI = (user) => {
    const out = document.getElementById("AuthLoggedOut");
    const inEl = document.getElementById("AuthLoggedIn");
    const email = document.getElementById("AuthUserEmail");
    if (out) out.style.display = user ? "none" : "block";
    if (inEl) inEl.style.display = user ? "block" : "none";
    if (email) email.textContent = user ? user.email || user.uid : "";
  };

  const updateFormValidity = (showFieldErrors) => {
    const { email, pass } = read();
    const emailHint = document.getElementById("AuthEmailHint");
    const passHint = document.getElementById("AuthPasswordHint");
    const loginBtn = document.getElementById("AuthLoginBtn");
    const signupBtn = document.getElementById("AuthSignupBtn");

    const emailOk = isValidEmail(email);
    const passOk = isValidPassword(pass);
    const valid = emailOk && passOk;

    if (loginBtn) loginBtn.disabled = !valid;
    if (signupBtn) signupBtn.disabled = !valid;

    if (showFieldErrors) {
      if (emailHint) {
        emailHint.textContent = emailOk || email.length === 0 ? "Format attendu: nom@domaine.com" : "Email invalide (exemple: nom@domaine.com)";
        emailHint.style.color = emailOk || email.length === 0 ? "#cde7ff" : "#ff9c9c";
      }
      if (passHint) {
        passHint.textContent = passOk || pass.length === 0 ? "Minimum 6 caractères" : "Mot de passe trop court (min 6 caractères)";
        passHint.style.color = passOk || pass.length === 0 ? "#cde7ff" : "#ff9c9c";
      }
    }

    return { valid, email, pass };
  };

  const onLogin = async () => {
    const state = updateFormValidity(true);
    setError("");
    if (!state.valid) {
      setError("Vérifie les champs avant de continuer.");
      return;
    }
    try {
      await loginWithEmail(state.email, state.pass);
    } catch (err) {
      console.error("Firebase login error:", err);
      setError(formatAuthError(err, "Erreur de connexion"));
    }
  };

  const onSignup = async () => {
    const state = updateFormValidity(true);
    setError("");
    if (!state.valid) {
      setError("Vérifie les champs avant de continuer.");
      return;
    }
    try {
      await signupWithEmail(state.email, state.pass);
    } catch (err) {
      console.error("Firebase signup error:", err);
      setError(formatAuthError(err, "Erreur de création de compte"));
    }
  };

  const emailEl = document.getElementById("AuthEmail");
  const passEl = document.getElementById("AuthPassword");
  const togglePwdBtn = document.getElementById("AuthTogglePwdBtn");

  document.getElementById("AuthLoginBtn").addEventListener("click", onLogin);
  document.getElementById("AuthSignupBtn").addEventListener("click", onSignup);
  document.getElementById("AuthLogoutBtn").addEventListener("click", logoutCurrentUser);
  document.getElementById("AuthLeaveRoomBtn").addEventListener("click", async () => {
    if (window.LogiqueJeu && typeof window.LogiqueJeu.leaveRoom === "function") {
      await window.LogiqueJeu.leaveRoom();
    }
  });

  emailEl.addEventListener("input", () => {
    setError("");
    updateFormValidity(false);
  });
  passEl.addEventListener("input", () => {
    setError("");
    updateFormValidity(false);
  });
  emailEl.addEventListener("blur", () => updateFormValidity(true));
  passEl.addEventListener("blur", () => updateFormValidity(true));

  const submitOnEnter = (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      onLogin();
    }
  };
  emailEl.addEventListener("keydown", submitOnEnter);
  passEl.addEventListener("keydown", submitOnEnter);

  togglePwdBtn.addEventListener("click", () => {
    if (passEl.type === "password") {
      passEl.type = "text";
      togglePwdBtn.textContent = "Masquer";
    } else {
      passEl.type = "password";
      togglePwdBtn.textContent = "Afficher";
    }
  });

  updateFormValidity(false);
  watchAuthState((user) => {
    setLoggedInUI(user || null);
    setError("");
  });
}

if (window.__USE_LEGACY_AUTH_UI__ === true) {
  initLegacyAuthUI();
}
