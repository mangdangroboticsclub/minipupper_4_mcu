<script>
  import { onMount, tick, untrack } from "svelte";
  import {
    cloudPreviewBase,
    fetchPreview,
    fetchPreviewManifest,
    previewFileUrl,
  } from "./previewTrace.js";
  import { revalidatedImport, threeModuleUrl } from "./lazyChunk.js";

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
      return revalidatedImport("/m-preview3d.js", [threeModuleUrl]);
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
        <div class="preview-view-controls">
          <div class="preview-cameras" role="group" aria-label="Camera angle">
            {#each Object.keys(manifest.camera_presets || {}) as preset}
              <button
                class:active={camera === preset}
                aria-pressed={camera === preset}
                title={preset.replaceAll("_", " ")}
                disabled={!ready}
                onclick={() => selectCamera(preset)}
              >{preset === "three_quarter" ? "¾" : preset[0].toUpperCase() + preset.slice(1)}</button>
            {/each}
          </div>
          <div class="preview-follow" role="group" aria-label="Camera tracking">
            <button class:active={follow} aria-pressed={follow} disabled={!ready} onclick={() => selectFollow(!follow)}>Follow</button>
            <button class:active={follow && heading} aria-pressed={follow && heading} disabled={!ready || !follow} onclick={() => selectHeading(!heading)}>Heading</button>
          </div>
        </div>
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
              <button class="preview-step" aria-label="Go to start" title="Start (Home)" disabled={!ready} onclick={goStart}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14M19 5 9 12l10 7V5z"/></svg></button>
              <button class="preview-step" aria-label="Previous frame" title="Previous frame (←)" disabled={!ready} onclick={() => stepFrames(-1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M19 5l-9 7 9 7V5z"/></svg></button>
              <button class="preview-step" aria-label="Next frame" title="Next frame (→)" disabled={!ready} onclick={() => stepFrames(1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5v14M5 5l9 7-9 7V5z"/></svg></button>
              <button class="preview-step" aria-label="Go to end" title="End (End)" disabled={!ready} onclick={goEnd}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14M5 5l10 7-10 7V5z"/></svg></button>
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

    {#if manifest.preview.speed > 1 && rate === 1}<p class="preview-note">Real-time playback. Select {manifest.preview.speed}× for the smoother baked preview.</p>{/if}
  </section>
{/if}

<style>
  .preview {
    --preview-accent: #f5c20d;
    --preview-panel: rgba(10,30,58,.78);
    --preview-line: rgba(199,230,255,.18);
    margin: 16px 0;
  }
  .preview-stage {
    position: relative;
    height: 340px;
    overflow: hidden;
    border: 1px solid rgba(127,157,192,.28);
    border-radius: 16px;
    background: #0a1e3a;
    box-shadow: 0 10px 30px rgba(10,30,58,.12), inset 0 0 0 1px rgba(255,255,255,.03);
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
    align-items: flex-start;
    gap: 8px;
    padding: 12px;
    pointer-events: none;
  }
  .preview-view-controls { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; pointer-events: auto; }
  .preview-cameras, .preview-follow {
    display: flex;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--preview-line);
    border-radius: 8px;
    background: var(--preview-panel);
    box-shadow: 0 4px 16px rgba(0,0,0,.12);
    backdrop-filter: blur(14px);
  }
  .preview-cameras button, .preview-follow button {
    flex: 0 0 auto;
    min-width: 30px;
    padding: 6px 8px;
    border: 0;
    border-radius: 5px;
    color: rgba(231,240,250,.68);
    background: transparent;
    font-size: 10px;
    font-weight: 600;
    cursor: pointer;
  }
  .preview-cameras button:hover, .preview-follow button:hover { color: #fff; background: rgba(255,255,255,.07); }
  .preview-cameras button.active, .preview-follow button.active { color: #0a1e3a; background: var(--preview-accent); box-shadow: none; }
  .preview-cameras button:disabled, .preview-follow button:disabled { cursor: default; opacity: .4; }
  .preview-actions { display: flex; flex: 0 0 auto; gap: 6px; margin-left: auto; pointer-events: auto; }
  .preview-icon, .preview-play {
    display: grid;
    place-items: center;
    border: 1px solid var(--preview-line);
    color: #fff;
    background: var(--preview-panel);
    backdrop-filter: blur(14px);
    cursor: pointer;
  }
  .preview-icon { width: 34px; height: 34px; padding: 0; border-radius: 8px; }
  .preview-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .preview-icon:hover, .preview-step:hover { background: rgba(26,54,89,.94); }
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
    border: 1px solid var(--preview-line);
    border-radius: 12px;
    background: var(--preview-panel);
    box-shadow: 0 8px 24px rgba(0,0,0,.16);
    backdrop-filter: blur(16px);
    color: #fff;
  }
  .preview-play { flex: 0 0 auto; width: 34px; height: 34px; padding: 0; border-color: var(--preview-accent); border-radius: 7px; background: var(--preview-accent); color: #0a1e3a; }
  .preview-play:hover { background: #ffda32; }
  .preview-play svg { width: 17px; height: 17px; fill: currentColor; }
  .preview-controls { display: flex; align-items: center; gap: 9px; }
  .preview-buttons { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; }
  .preview-step { display: grid; place-items: center; width: 28px; height: 30px; padding: 0; border: 1px solid rgba(199,230,255,.1); border-radius: 6px; color: rgba(255,255,255,.82); background: rgba(255,255,255,.04); cursor: pointer; }
  .preview-step svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .preview-rates { display: flex; flex: 1; justify-content: center; gap: 2px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .preview-rates::-webkit-scrollbar { display: none; }
  .preview-rates button { flex: 0 0 auto; padding: 5px 8px; border: 0; border-radius: 5px; color: rgba(231,240,250,.58); background: transparent; font-size: 10px; cursor: pointer; }
  .preview-rates button:hover { color: #fff; }
  .preview-rates button.active { color: #0a1e3a; background: var(--preview-accent); font-weight: 750; }
  .preview-rates button:disabled { opacity: .35; cursor: default; }
  .preview-clock { flex: 0 0 auto; min-width: 116px; text-align: right; color: rgba(231,240,250,.5); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
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
  .preview-scrubber input::-webkit-slider-runnable-track { height: 3px; border-radius: 3px; background: linear-gradient(to right, var(--preview-accent) var(--progress), rgba(199,230,255,.2) var(--progress)); }
  .preview-scrubber input::-webkit-slider-thumb { width: 10px; height: 14px; margin-top: -5.5px; appearance: none; border: 0; border-radius: 2px; background: var(--preview-accent); box-shadow: 0 0 0 2px rgba(10,30,58,.65); }
  .preview-scrubber input::-moz-range-track { height: 3px; border-radius: 3px; background: rgba(199,230,255,.2); }
  .preview-scrubber input::-moz-range-progress { height: 3px; background: var(--preview-accent); }
  .preview-scrubber input::-moz-range-thumb { width: 10px; height: 14px; border: 0; border-radius: 2px; background: var(--preview-accent); }
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
  .preview-spinner { width: 17px; height: 17px; border: 2px solid rgba(255,255,255,.25); border-top-color: var(--preview-accent); border-radius: 50%; animation: spin .7s linear infinite; }
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
    background: rgba(10,30,58,.84);
    backdrop-filter: blur(5px);
  }
  .preview-error strong { font-size: 15px; }
  .preview-error span { max-width: 280px; color: rgba(255,255,255,.65); font-size: 12px; line-height: 1.45; }
  .preview-error button { margin-top: 5px; padding: 8px 15px; border: 0; border-radius: 7px; background: var(--preview-accent); color: #0a1e3a; font-weight: 700; cursor: pointer; }
  .preview button:focus-visible, .preview input:focus-visible, .preview :global(canvas):focus-visible { outline: 2px solid var(--preview-accent); outline-offset: 2px; }
  .preview-note { margin: 8px 2px 0; color: #a09b90; font-size: 10px; }
  .preview.expanded, .preview:fullscreen { position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column; justify-content: center; margin: 0; padding: 16px; background: #061426; }
  .preview.expanded .preview-stage, .preview:fullscreen .preview-stage { flex: 1; width: 100%; height: auto; min-height: 0; border-radius: 0; }
  .preview.expanded .preview-transport, .preview:fullscreen .preview-transport { left: 24px; right: 24px; bottom: 24px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (min-width: 700px) { .preview-stage { height: 420px; } }
  @media (max-width: 600px) {
    .preview-topbar { gap: 6px; padding: 9px; }
    .preview-view-controls { gap: 5px; }
    .preview-cameras button, .preview-follow button { min-width: 26px; padding: 5px 6px; font-size: 9px; }
    .preview-icon { width: 31px; height: 31px; }
  }
  @media (max-width: 480px) {
    .preview-controls { flex-wrap: wrap; gap: 6px; }
    .preview-rates { order: 3; flex-basis: 100%; justify-content: flex-start; }
    .preview-clock { margin-left: auto; }
  }
  @media (max-width: 380px) {
    .preview-stage { height: 320px; }
    .preview-transport { left: 8px; right: 8px; bottom: 8px; gap: 8px; padding: 8px; }
    .preview-actions { position: absolute; top: 9px; right: 9px; }
    .preview-view-controls { box-sizing: border-box; width: 100%; padding-right: 100px; }
    .preview-cameras { min-width: 0; max-width: 100%; overflow-x: auto; scrollbar-width: none; }
    .preview-cameras::-webkit-scrollbar { display: none; }
  }
  @media (pointer: coarse) {
    .preview-icon, .preview-play { width: 44px; height: 44px; }
    .preview-step { width: 44px; height: 44px; }
    .preview-rates button { min-width: 40px; min-height: 44px; }
    .preview-cameras button, .preview-follow button { min-height: 44px; }
  }
  @media (max-width: 480px) and (pointer: coarse) {
    .preview-stage { height: 420px; }
  }
  @media (prefers-reduced-motion: reduce) { .preview-spinner { animation-duration: 1.5s; } }
</style>
