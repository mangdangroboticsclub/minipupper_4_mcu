import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Build identity, logged by src/main.js. Asset names are stable across builds
// (the firmware embeds a fixed file list), so without a stamp there is no way
// to tell "this browser is running an old cached m.js" from "the new bundle is
// broken" — a distinction that cost a full debugging cycle. Override with
// MPX_BUILD=<label> npm run build.
const buildId =
  process.env.MPX_BUILD || new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);

// Fixed chunk filenames are required by the firmware, but their exported
// minified names can change whenever a viewer imports another Three export.
// Stamp the shared dependency with the build ID: a newly loaded viewer then
// cannot link against an older m-three.module.js already in the browser's
// module map (HTTP revalidation alone cannot replace that evaluated module).
const versionedThreeChunk = {
  name: "mpx-versioned-three-chunk",
  renderChunk(code) {
    const url = `./m-three.module.js?v=${encodeURIComponent(buildId)}`;
    // Rollup emits single quotes; Terser may later rewrite them as double.
    const stamped = code.replace(/(["'])\.\/m-three\.module\.js\1/g, JSON.stringify(url));
    return stamped === code ? null : { code: stamped, map: null };
  },
};

export default defineConfig({
  plugins: [svelte(), versionedThreeChunk],

  define: {
    __MPX_BUILD__: JSON.stringify(buildId),
  },

  root: "src",
  publicDir: "../public",
  base: "/",

  build: {
    outDir: "../www",
    emptyOutDir: true,
    minify: "terser",
    terserOptions: {
      compress: {
        drop_console: false,
        drop_debugger: true,
      },
    },
    rollupOptions: {
      output: {
        entryFileNames: "m.js",
        // mpx-dog: the firmware embeds a fixed list of files (main/CMakeLists.txt
        // EMBED_FILES), so chunk names must be stable. The only split chunk is
        // the lazily imported three.js model viewer -> m-pupper3d.js.
        chunkFileNames: "m-[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) return "index.css";
          if (assetInfo.name?.endsWith(".svg")) return "[name][extname]";
          return "[name][extname]";
        },
      },
    },
  },

  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // Forward robot API + WebSocket calls to a live robot during development.
    // Override the target with:  ROBOT_HOST=192.168.x.x npm run dev
    proxy: {
      "/v1": {
        target: `http://${process.env.ROBOT_HOST || "192.168.1.107"}`,
        changeOrigin: true,
        ws: true,
      },
      "/api": {
        target: `http://${process.env.ROBOT_HOST || "192.168.1.107"}`,
        changeOrigin: true,
      },
    },
  },

  preview: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
  },
});
