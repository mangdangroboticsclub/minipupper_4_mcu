<script>
  import { onMount, tick, untrack } from "svelte";
  import {
    cloudPreviewBase,
    fetchPreview,
    fetchPreviewManifest,
    previewFileUrl,
  } from "./previewTrace.js";
  import { revalidatedImport } from "./lazyChunk.js";

  /** Optional detail.preview: { available:boolean, base?:string }. */
  let { skillId, version, preview } = $props();

  let manifest = $state(null);
  let available = $state(false);
  let base = "";
  let posterUrl = $state("");
  let stageEl = $state(null);
  let sectionEl = $state(null);
  let viewer = null;
  let loadController = null;
  let started = $state(false);
  let loading = $state(false);
  let ready = $state(false);
  let playing = $state(false);
  let error = $state("");
  let posterVisible = $state(true);
  let currentMs = $state(0);
  let durationMs = $state(0);
  let rate = $state(1);
  let camera = $state("hero");
  let follow = $state(true);
  let heading = $state(true);
  let expanded = $state(false);
  let generation = 0;

  let seconds = $derived(Math.round((manifest?.preview?.duration_ms || durationMs) / 1000));
  let progress = $derived(durationMs > 0 ? Math.min(100, (currentMs / durationMs) * 100) : 0);
  let rates = $derived([...new Set([0.25, 0.5, 1, 2, 4, manifest?.preview?.speed || 1])]);
  let formatTime = (ms) => `${(Math.max(0, ms) / 1000).toFixed(2)}s`;

  $effect(() => {
    const id = skillId, v = version, detailPreview = preview;
    const gen = ++generation;
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    const oldPoster = untrack(() => posterUrl);
    if (oldPoster.startsWith("blob:")) URL.revokeObjectURL(oldPoster);
    viewer?.dispose();
    viewer = null;
    manifest = null;
    base = detailPreview?.base || "";
    posterUrl = "";
    available = false;
    started = false;
    loading = false;
    ready = false;
    playing = false;
    error = "";
    posterVisible = true;
    currentMs = 0;
    durationMs = 0;
    camera = "hero";
    follow = true;
    heading = true;
    expanded = false;

    // Current cloud detail can explicitly suppress the manifest probe.
    if (detailPreview?.available === false) return;

    void (async () => {
      let resolvedBase = await cloudPreviewBase(base);
      let data;
      try {
        data = await fetchPreviewManifest(id, v, { base: resolvedBase, signal: controller.signal });
        if (!data && resolvedBase) {
          resolvedBase = "";
          data = await fetchPreviewManifest(id, v, { base: "", signal: controller.signal });
        }
      } catch (error) {
        if (!resolvedBase || controller.signal.aborted) throw error;
        resolvedBase = "";
        data = await fetchPreviewManifest(id, v, { base: "", signal: controller.signal });
      }
      if (gen !== generation || !data) return;
      manifest = data;
      base = resolvedBase;
      available = true;
      await tick();
    })().catch(() => {
      if (gen === generation) available = false;
    });

    return () => {
      generation += 1;
      controller.abort();
      loadController?.abort();
      if (posterUrl.startsWith("blob:")) URL.revokeObjectURL(posterUrl);
      viewer?.dispose();
      viewer = null;
    };
  });

  $effect(() => {
    if (available && manifest && stageEl && !started) void openPreview();
  });

  onMount(() => {
    const syncFullscreen = () => {
      expanded = document.fullscreenElement === sectionEl;
    };
    const closeFallback = (event) => {
      if (event.key === "Escape" && expanded && !document.fullscreenElement) expanded = false;
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    window.addEventListener("keydown", closeFallback);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      window.removeEventListener("keydown", closeFallback);
    };
  });

  async function importRenderer() {
    try {
      return await import("./preview3d.js");
    } catch (error) {
      if (!import.meta.env.PROD) throw error;
      // A fragment alone is not enough: the HTTP cache key drops the fragment,
      // so an old text/html fallback at this URL is served again. Revalidate
      // the URL first, then import it under a fresh module identity. See
      // lazyChunk.js for why this can be cached at all.
      return revalidatedImport("/m-preview3d.js", ["/m-three.module.js"]);
    }
  }

  async function openPreview() {
    if (started || loading || !manifest || !stageEl) return;
    started = true;
    const gen = ++generation;
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    if (posterUrl.startsWith("blob:")) URL.revokeObjectURL(posterUrl);
    posterUrl = "";
    loading = true;
    error = "";
    playing = false;
    ready = false;
    posterVisible = true;
    currentMs = 0;
    durationMs = 0;
    try {
      // Serialize the optional poster with motion/geometry: the firmware relay
      // accepts only one uncached preview download at a time.
      if (manifest.files?.some((f) => f.name === "poster-hero.webp")) {
        try {
          const response = await fetch(previewFileUrl(skillId, version, "poster-hero.webp", base), { signal: controller.signal });
          if (response.ok) {
            const blob = await response.blob();
            if (gen === generation) posterUrl = URL.createObjectURL(blob);
          }
        } catch (posterError) {
          if (controller.signal.aborted) throw posterError;
          // Poster is decorative; continue with the dark loading stage.
        }
      }
      const data = await fetchPreview(skillId, version, { base, manifest, signal: controller.signal });
      const { init } = await importRenderer();
      if (gen !== generation || !stageEl) return;
      viewer?.dispose();
      const nextViewer = await init(stageEl, {
        ...data,
        onTime: (ms) => {
          if (gen === generation) currentMs = ms;
        },
        onEnd: () => {
          if (gen !== generation || !viewer) return;
          viewer.seek(0);
          viewer.play();
        },
      });
      if (gen !== generation) {
        nextViewer.dispose();
        return;
      }
      viewer = nextViewer;
      viewer.setPreset(camera);
      viewer.setFollow(follow, heading);
      durationMs = manifest.preview.strategy === "truncated"
        ? data.trace.header.durationMs
        : manifest.source.duration_ms;
      rate = manifest.preview.speed;
      ready = true;
      posterVisible = false;
      playing = true;
      viewer.play();
    } catch (e) {
      if (gen !== generation) return;
      console.error("Skill preview failed to load", e);
      error = "Preview couldn’t load. Check your connection and try again.";
      posterVisible = true;
      playing = false;
    } finally {
      if (gen === generation) loading = false;
    }
  }

  function toggle() {
    if (!viewer) return;
    if (playing) {
      viewer.pause();
      playing = false;
    } else {
      viewer.play();
      playing = true;
    }
  }

  function scrub(event) {
    if (!viewer) return;
    const ms = Number(event.currentTarget.value);
    viewer.seek(ms);
    currentMs = ms;
  }

  function selectRate(value) {
    if (!viewer) return;
    rate = value;
    viewer.setRate(rate);
  }

  function selectCamera(preset) {
    camera = preset;
    viewer?.setPreset(preset);
  }

  function selectFollow(value) {
    follow = value;
    viewer?.setFollow(follow, heading);
  }

  function selectHeading(value) {
    heading = value;
    viewer?.setFollow(follow, heading);
  }

  function stepFrames(delta) {
    if (!viewer) return;
    viewer.pause();
    playing = false;
    viewer.step(delta);
  }

  function stepTime(deltaMs) {
    if (!viewer) return;
    viewer.pause();
    playing = false;
    viewer.seek(currentMs + deltaMs);
  }

  function goStart() {
    if (!viewer) return;
    viewer.seek(0);
    currentMs = 0;
  }

  function goEnd() {
    if (!viewer) return;
    viewer.pause();
    playing = false;
    viewer.seek(durationMs);
  }

  function handleKeydown(event) {
    if (!ready || ["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A"].includes(event.target?.tagName)) return;
    if (event.code === "Space") {
      event.preventDefault();
      toggle();
    } else if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
      event.preventDefault();
      if (event.shiftKey) stepTime(event.code === "ArrowLeft" ? -1000 : 1000);
      else stepFrames(event.code === "ArrowLeft" ? -1 : 1);
    } else if (event.code === "Home" || event.code === "End") {
      event.preventDefault();
      if (event.code === "Home") goStart(); else goEnd();
    }
  }

  function restart() {
    if (!viewer) return;
    viewer.seek(0);
    currentMs = 0;
    viewer.play();
    playing = true;
  }

  async function toggleFullscreen() {
    if (!sectionEl) return;
    if (document.fullscreenElement === sectionEl) {
      await document.exitFullscreen();
      expanded = false;
    } else if (expanded) {
      expanded = false;
    } else {
      try {
        if (!sectionEl.requestFullscreen) throw new Error("Fullscreen unavailable");
        await sectionEl.requestFullscreen();
      } catch {
        expanded = true;
        sectionEl.focus();
      }
    }
  }
</script>

{#if available && manifest}
  <section
    class:expanded
    class="preview"
    bind:this={sectionEl}
    aria-label={`${skillId} 3D preview`}
    role={expanded ? "dialog" : undefined}
    aria-modal={expanded ? "true" : undefined}
    tabindex="-1"
    onkeydown={handleKeydown}
  >
    <div class="preview-stage" bind:this={stageEl}>
      {#if posterVisible && posterUrl}
        <img
          class="preview-poster"
          src={posterUrl}
          alt="{skillId} preview poster"
          onerror={() => { posterUrl = ""; }}
        />
      {/if}

      <div class="preview-topbar">
        <span class="preview-label"><span class="preview-dot"></span>3D PREVIEW</span>
        <div class="preview-actions">
          <button class="preview-icon" title="Restart preview" aria-label="Restart preview" disabled={!ready} onclick={restart}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11a9 9 0 1 1 2.64 6.36M3 4v7h7"/></svg>
          </button>
          <button class="preview-icon" title={expanded ? "Exit fullscreen" : "Fullscreen"} aria-label={expanded ? "Exit fullscreen" : "Fullscreen"} onclick={toggleFullscreen}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={expanded ? "M8 3v5H3m13-5v5h5M8 21v-5H3m13 5v-5h5" : "M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5"}/></svg>
          </button>
        </div>
      </div>

      {#if loading}
        <div class="preview-status"><span class="preview-spinner"></span>Loading motion…</div>
      {/if}

      {#if error}
        <div class="preview-error" role="alert">
          <strong>Preview unavailable</strong>
          <span>{error}</span>
          <button onclick={() => { started = false; void openPreview(); }}>Try again</button>
        </div>
      {:else}
        <div class="preview-transport">
          <div class="preview-scrubber">
            <input
              aria-label="Preview position"
              type="range"
              min="0"
              max={durationMs || 1}
              step="1"
              value={currentMs}
              disabled={!ready}
              style={`--progress:${progress}%`}
              oninput={scrub}
            />
          </div>
          <div class="preview-controls">
            <div class="preview-buttons">
              <button class="preview-play" aria-label={playing ? "Pause preview" : "Play preview"} title="Play / pause (Space)" disabled={!ready} onclick={toggle}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d={playing ? "M7 5h4v14H7zm6 0h4v14h-4z" : "M8 5v14l11-7z"}/></svg>
              </button>
              <button class="preview-step" aria-label="Go to start" title="Start (Home)" disabled={!ready} onclick={goStart}>⏮</button>
              <button class="preview-step" aria-label="Previous frame" title="Previous frame (←)" disabled={!ready} onclick={() => stepFrames(-1)}>◀|</button>
              <button class="preview-step" aria-label="Next frame" title="Next frame (→)" disabled={!ready} onclick={() => stepFrames(1)}>|▶</button>
              <button class="preview-step" aria-label="Go to end" title="End (End)" disabled={!ready} onclick={goEnd}>⏭</button>
            </div>
            <div class="preview-rates" role="group" aria-label="Playback speed">
              {#each rates as r}
                <button class:active={rate === r} aria-pressed={rate === r} disabled={!ready} onclick={() => selectRate(r)}>{r}×</button>
              {/each}
            </div>
            <div class="preview-clock"><strong>{formatTime(currentMs)}</strong><span> / {formatTime(durationMs)}</span></div>
          </div>
        </div>
      {/if}
    </div>

    <div class="preview-footer">
      <div class="preview-cameras" aria-label="Camera angle">
        {#each Object.keys(manifest.camera_presets || {}) as preset}
          <button class:active={camera === preset} aria-pressed={camera === preset} disabled={!ready} onclick={() => selectCamera(preset)}>{preset.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase())}</button>
        {/each}
      </div>
      <div class="preview-follow" role="group" aria-label="Camera tracking">
        <button class:active={follow} aria-pressed={follow} disabled={!ready} onclick={() => selectFollow(!follow)}>Follow</button>
        <button class:active={follow && heading} aria-pressed={follow && heading} disabled={!ready || !follow} onclick={() => selectHeading(!heading)}>Heading</button>
      </div>
      <span class="preview-duration">{seconds}s · loops</span>
    </div>
    {#if manifest.preview.speed > 1 && rate === 1}<p class="preview-note">Real-time playback. Select {manifest.preview.speed}× for the smoother baked preview.</p>{/if}
  </section>
{/if}

<style>
  .preview { margin: 16px 0; }
  .preview-stage {
    position: relative;
    height: 340px;
    overflow: hidden;
    border-radius: 18px;
    background: #191a17;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.08);
    isolation: isolate;
  }
  .preview-stage :global(canvas) { display: block; width: 100%; height: 100%; }
  .preview-poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .preview-topbar {
    position: absolute;
    z-index: 4;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px;
    pointer-events: none;
  }
  .preview-label {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 7px 10px;
    border-radius: 999px;
    color: rgba(255,255,255,.88);
    background: rgba(20,21,18,.56);
    backdrop-filter: blur(12px);
    font-size: 10px;
    font-weight: 750;
    letter-spacing: .13em;
  }
  .preview-dot { width: 6px; height: 6px; border-radius: 50%; background: #f5d90a; box-shadow: 0 0 0 3px rgba(245,217,10,.15); }
  .preview-actions { display: flex; gap: 7px; pointer-events: auto; }
  .preview-icon, .preview-play {
    display: grid;
    place-items: center;
    border: 0;
    color: #fff;
    background: rgba(20,21,18,.6);
    backdrop-filter: blur(12px);
    cursor: pointer;
  }
  .preview-icon { width: 34px; height: 34px; border-radius: 50%; }
  .preview-icon svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .preview-icon:hover, .preview-play:hover, .preview-step:hover { background: rgba(20,21,18,.85); }
  .preview-icon:disabled, .preview-play:disabled, .preview-step:disabled { opacity: .35; cursor: default; }
  .preview-transport {
    position: absolute;
    z-index: 3;
    left: 12px;
    right: 12px;
    bottom: 12px;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 7px;
    padding: 10px 12px;
    border: 1px solid rgba(255,255,255,.1);
    border-radius: 14px;
    background: rgba(20,21,18,.72);
    backdrop-filter: blur(16px);
    color: #fff;
  }
  .preview-play { flex: 0 0 auto; width: 34px; height: 34px; padding: 0; border-radius: 50%; background: #f5d90a; color: #191a17; }
  .preview-play:hover { background: #ffe72a; }
  .preview-play svg { width: 18px; height: 18px; fill: currentColor; }
  .preview-controls { display: flex; align-items: center; gap: 10px; }
  .preview-buttons { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; }
  .preview-step { width: 28px; height: 30px; padding: 0; border: 0; border-radius: 7px; color: #fff; background: rgba(255,255,255,.08); font-size: 11px; cursor: pointer; }
  .preview-rates { display: flex; flex: 1; justify-content: center; gap: 3px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .preview-rates::-webkit-scrollbar { display: none; }
  .preview-rates button { flex: 0 0 auto; padding: 5px 8px; border: 0; border-radius: 6px; color: rgba(255,255,255,.62); background: transparent; font-size: 10px; cursor: pointer; }
  .preview-rates button.active { color: #191a17; background: #f5d90a; font-weight: 750; }
  .preview-rates button:disabled { opacity: .35; cursor: default; }
  .preview-clock { flex: 0 0 auto; min-width: 116px; text-align: right; color: rgba(255,255,255,.5); font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .preview-clock strong { color: #fff; font-weight: 650; }
  .preview-scrubber { width: 100%; min-width: 0; }
  .preview-scrubber input {
    --progress: 0%;
    display: block;
    width: 100%;
    height: 16px;
    margin: 0;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }
  .preview-scrubber input::-webkit-slider-runnable-track { height: 3px; border-radius: 3px; background: linear-gradient(to right, #f5d90a var(--progress), rgba(255,255,255,.25) var(--progress)); }
  .preview-scrubber input::-webkit-slider-thumb { width: 11px; height: 11px; margin-top: -4px; appearance: none; border: 0; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px #0008; }
  .preview-scrubber input::-moz-range-track { height: 3px; border-radius: 3px; background: rgba(255,255,255,.25); }
  .preview-scrubber input::-moz-range-progress { height: 3px; background: #f5d90a; }
  .preview-scrubber input::-moz-range-thumb { width: 11px; height: 11px; border: 0; border-radius: 50%; background: #fff; }
  .preview-scrubber input:disabled { cursor: default; opacity: .45; }

  .preview-status {
    position: absolute;
    z-index: 2;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: rgba(255,255,255,.85);
    background: rgba(15,16,14,.18);
    font-size: 12px;
  }
  .preview-spinner { width: 17px; height: 17px; border: 2px solid rgba(255,255,255,.25); border-top-color: #f5d90a; border-radius: 50%; animation: spin .7s linear infinite; }
  .preview-error {
    position: absolute;
    z-index: 3;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 64px 28px 28px;
    text-align: center;
    color: #fff;
    background: rgba(20,21,18,.72);
    backdrop-filter: blur(5px);
  }
  .preview-error strong { font-size: 15px; }
  .preview-error span { max-width: 280px; color: rgba(255,255,255,.65); font-size: 12px; line-height: 1.45; }
  .preview-error button { margin-top: 5px; padding: 8px 15px; border: 0; border-radius: 999px; background: #f5d90a; color: #191a17; font-weight: 700; cursor: pointer; }
  .preview-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
  .preview-cameras { display: flex; flex: 1; min-width: 0; gap: 4px; padding: 3px; overflow-x: auto; border-radius: 10px; background: #eeeae1; scrollbar-width: none; }
  .preview-cameras::-webkit-scrollbar { display: none; }
  .preview-cameras button { flex: 0 0 auto; padding: 6px 10px; border: 0; border-radius: 7px; background: transparent; color: #827f76; font-size: 11px; cursor: pointer; }
  .preview-cameras button.active { color: #34342e; background: #fff; box-shadow: 0 1px 4px #29291b12; font-weight: 700; }
  .preview-cameras button:disabled { cursor: default; opacity: .55; }
  .preview-follow { display: flex; flex: 0 0 auto; gap: 3px; padding: 3px; border-radius: 10px; background: #eeeae1; }
  .preview-follow button { padding: 6px 9px; border: 0; border-radius: 7px; color: #827f76; background: transparent; font-size: 11px; cursor: pointer; }
  .preview-follow button.active { color: #34342e; background: #fff; box-shadow: 0 1px 4px #29291b12; font-weight: 700; }
  .preview-follow button:disabled { cursor: default; opacity: .45; }
  .preview-duration { flex: 0 0 auto; color: #a09b90; font-size: 10px; white-space: nowrap; }
  .preview button:focus-visible, .preview input:focus-visible, .preview :global(canvas):focus-visible { outline: 2px solid #f5d90a; outline-offset: 2px; }
  .preview-note { margin: 8px 2px 0; color: #a09b90; font-size: 10px; }
  .preview.expanded, .preview:fullscreen { position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column; justify-content: center; margin: 0; padding: 16px; background: #191a17; }
  .preview.expanded .preview-stage, .preview:fullscreen .preview-stage { flex: 1; width: 100%; height: auto; min-height: 0; border-radius: 0; }
  .preview.expanded .preview-transport, .preview:fullscreen .preview-transport { left: 24px; right: 24px; bottom: 24px; }
  .preview.expanded .preview-footer, .preview:fullscreen .preview-footer { flex: 0 0 auto; }
  .preview.expanded .preview-duration, .preview:fullscreen .preview-duration { display: block; color: rgba(255,255,255,.55); }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (min-width: 700px) { .preview-stage { height: 420px; } }
  @media (max-width: 480px) {
    .preview-duration { display: none; }
    .preview-controls { flex-wrap: wrap; gap: 6px; }
    .preview-rates { order: 3; flex-basis: 100%; justify-content: flex-start; }
    .preview-clock { margin-left: auto; }
    .preview-footer { flex-wrap: wrap; }
  }
  @media (max-width: 380px) {
    .preview-stage { height: 300px; }
    .preview-transport { gap: 8px; padding: 8px; }
    .preview-cameras button { padding: 6px 8px; }
  }
  @media (pointer: coarse) {
    .preview-icon, .preview-play { width: 44px; height: 44px; }
    .preview-step { width: 44px; height: 44px; }
    .preview-rates button { min-width: 40px; min-height: 44px; }
    .preview-cameras button, .preview-follow button { min-height: 44px; }
  }
  @media (prefers-reduced-motion: reduce) { .preview-spinner { animation-duration: 1.5s; } }
</style>
