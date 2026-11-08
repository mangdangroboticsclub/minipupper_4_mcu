import { mount } from "svelte";
import App from "./app.svelte";
import "./app.css";

/* Which bundle is running. Asset URLs are stable across firmware builds, so a
   browser can keep executing cached shell code indefinitely; this line makes
   that visible in the very first console entry (window.__MPX_BUILD__ too). */
console.info("[mpx] build", __MPX_BUILD__);
window.__MPX_BUILD__ = __MPX_BUILD__;

const app = mount(App, {
  target: document.getElementById("app"),
});

export default app;

/* ── Service Worker Registration (PWA) ─────────────────────── */
if ("serviceWorker" in navigator && import.meta.env.DEV) {
  // The cache-first worker would pin stale modules during development —
  // make sure none is controlling the dev origin.
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((r) => r.unregister());
    if (regs.length && "caches" in window) {
      caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
    }
  });
} else if ("serviceWorker" in navigator) {
  // Register the service worker — wait until load for faster initial render
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
      });
      console.log("📡 SW registered:", registration.scope);
    } catch (err) {
      console.warn("⚠️  SW registration failed:", err.message);
    }
  });
}
