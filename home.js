import "./firebase-init.js";
import { auth, watchAuthState } from "./auth.js";
import { renderPage2 } from "./page2.js";

let lastRenderedAuthUid = "__initial__";

function renderHomeFromAuth(user) {
  const uid = String(user?.uid || "");
  if (uid === lastRenderedAuthUid) return;
  lastRenderedAuthUid = uid;
  renderPage2(user || null);
}

renderHomeFromAuth(auth.currentUser || null);

watchAuthState((user) => {
  renderHomeFromAuth(user || null);
});
