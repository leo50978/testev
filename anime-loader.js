let animeRuntimePromise = null;

export async function ensureAnimeRuntime() {
  if (typeof window === "undefined") return null;
  if (window.anime && typeof window.anime === "function") {
    return window.anime;
  }

  if (!animeRuntimePromise) {
    animeRuntimePromise = new Promise((resolve, reject) => {
      const existing = document.getElementById("anime-runtime-script");
      if (existing) {
        existing.addEventListener("load", () => resolve(window.anime || null), { once: true });
        existing.addEventListener("error", () => reject(new Error("Impossible de charger anime.js")), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.id = "anime-runtime-script";
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/animejs/3.2.1/anime.min.js";
      script.async = true;
      script.onload = () => resolve(window.anime || null);
      script.onerror = () => reject(new Error("Impossible de charger anime.js"));
      document.head.appendChild(script);
    }).catch((error) => {
      animeRuntimePromise = null;
      throw error;
    });
  }

  return animeRuntimePromise;
}
