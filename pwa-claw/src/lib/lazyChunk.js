// Loading a lazily split chunk the firmware serves.
//
// The firmware embeds a fixed list of file names (main/CMakeLists.txt
// EMBED_FILES), so the lazy chunks keep stable URLs — `/m-preview3d.js`, not
// `/assets/preview3d-<hash>.js`. Until the `Cache-Control: no-cache` change in
// main/network/http_server.cc, those stable URLs were served
// `public, max-age=31536000, immutable`, and a request that arrived while the
// chunk was not yet in LittleFS got the SPA fallback instead: index.html,
// under that same one-year directive. The browser then holds `text/html` at the
// chunk's URL, and `import()` fails with
//
//   Expected a JavaScript-or-Wasm module script but the server responded with
//   a MIME type of "text/html"
//
// A retry with a different fragment does NOT clear that. A fragment changes the
// module identity the browser remembers, but the HTTP cache key is the URL with
// the fragment stripped, so the poisoned entry is served again — measured, not
// assumed (a fragment-only retry fails against a text/html entry marked
// immutable; see the comment in SkillPreview.svelte's importRenderer).
// `cache: "reload"` is
// what forces the revalidation and replaces the entry; the fragment import
// after it then resolves from the replacement.
//
// There is no service worker to lean on here: the PWA is served over plain
// http:// on the robot's LAN address, which is not a secure context, so
// `navigator.serviceWorker` does not exist and pwa-claw/public/sw.js never runs.
//
// Cost: one revalidation round trip, only after an import has already failed.

const importFresh = (url) => import(/* @vite-ignore */ `${url}#retry=${Date.now()}`);

/** Re-fetch `url` past the HTTP cache; throw if what comes back is not JS. */
async function revalidate(url) {
  const response = await fetch(url, { cache: "reload" });
  const type = response.headers.get("content-type") || "";

  // Do not hand a fresh HTML fallback back to the HTTP cache and then report
  // it as a module: if this is not JavaScript, the firmware really is missing
  // the file and the caller should say so.
  if (!response.ok || !type.includes("javascript")) {
    throw new Error(`${url} is not a JavaScript module (${response.status} ${type || "no content-type"})`);
  }
}

/**
 * Re-fetch `url` past the HTTP cache, then import it under a fresh module
 * identity.
 *
 * @param {string} url origin-relative chunk URL, e.g. "/m-preview3d.js"
 * @param {string[]} [deps] origin-relative URLs this chunk imports, e.g.
 *   ["/m-three.module.js"]. Repaired on the second attempt: a chunk can fail
 *   because one of its *own* imports holds a poisoned entry — `/m-three.module.js`
 *   is not present in older firmware at all, so it can carry a year-old
 *   text/html fallback — and then the error still names the chunk, not the dep.
 * @returns {Promise<any>} the imported module namespace
 */
export async function revalidatedImport(url, deps = []) {
  await revalidate(url);
  try {
    return await importFresh(url);
  } catch (error) {
    if (!deps.length) throw error;
    for (const dep of deps) await revalidate(dep);
    return importFresh(url);
  }
}
