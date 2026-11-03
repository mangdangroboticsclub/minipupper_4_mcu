<script>
  import { tick } from "svelte";
  import {
    fetchPreview,
    fetchPreviewManifest,
    playbackStride,
    previewFileUrl,
  } from "./previewTrace.js";

  /** Optional detail.preview: { available:boolean, base?:string }. */
  let { skillId, version, preview } = $props();

  let available = $state(false);
  let checking = $state(true);
  let opened = $state(false);
  let loading = $state(false);
  let ready = $state(false);
  let error = $state("");
  let stageEl = $state(null);
  let viewer = null;
  let manifest = null;
  let base = "";
  let posterUrl = $state("");
  let posterVisible = $state(true);
  let playing = $state(false);
  let currentMs = $state(0);
  let durationMs = $state(0);
  let rate = $state(1);
  let rates = $state([]);
  let generation = 0;

  const seconds = (ms) => `${Math.round((ms || 0) / 1000)} s`;
  const presetLabel = (name) => name.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());

  $effect(() => {
    const id = skillId, v = version, detailPreview = preview;
    const myGeneration = ++generation;
    available = false;
    checking = true;
    opened = false;
    ready = false;
    error = "";
    manifest = null;
    viewer?.dispose();
    viewer = null;

    // Older/on-device relays have no detail.preview field: probe the manifest.
    // An explicit false from current cloud detail avoids even that request.
    if (detailPreview?.available === false) {
      checking = false;
      return;
    }
    base = detailPreview?.base || "";
    fetchPreviewManifest(id, v, { base })
      .then((m) => {
        if (myGeneration !== generation) return;
        manifest = m;
        available = !!m;
        const hasPoster = m?.files?.some((f) => f.name === "poster-hero.webp");
        posterUrl = hasPoster ? previewFileUrl(id, v, "poster-hero.webp", base) : "";
      })
      .catch(() => { if (myGeneration === generation) available = false; })
      .finally(() => { if (myGeneration === generation) checking = false; });

    return () => {
      viewer?.dispose();
      viewer = null;
    };
  });

  async function openPreview() {
    if (opened || loading || !manifest) return;
    opened = true;
    loading = true;
    ready = false;
    error = "";
    posterVisible = true;
    const myGeneration = ++generation;
    await tick();
    try {
      const data = await fetchPreview(skillId, version, { base, manifest });
      const { init } = await import("./preview3d.js");
      if (myGeneration !== generation || !stageEl) return;
      viewer = await init(stageEl, {
        ...data,
        onTime: (ms) => { if (myGeneration === generation) currentMs = ms; },
        onEnd: () => { if (myGeneration === generation) playing = false; },
      });
      if (myGeneration !== generation) { viewer.dispose(); viewer = null; return; }
      durationMs = manifest.preview.strategy === "truncated"
        ? data.trace.header.durationMs
        : manifest.source.duration_ms;
      rate = manifest.preview.speed;
      rates = [...new Set([0.5, 1, 2, rate])];
      ready = true;
    } catch (e) {
      if (myGeneration === generation) error = e.message || "The 3D preview couldn't load.";
    } finally {
      if (myGeneration === generation) loading = false;
    }
  }

  function togglePlayback() {
    if (!ready || !viewer) return;
    posterVisible = false;
    playing = !playing;
    if (playing) viewer.play(); else viewer.pause();
  }

  function scrub(event) {
    posterVisible = false;
    currentMs = Number(event.currentTarget.value);
    viewer?.seek(currentMs);
  }

  function selectRate(event) {
    rate = Number(event.currentTarget.value);
    viewer?.setRate(rate);
  }

  function retry() {
    viewer?.dispose();
    viewer = null;
    opened = false;
    ready = false;
    playing = false;
    currentMs = 0;
    openPreview();
  }
</script>

{#if available}
  <section class="preview-section" aria-label="3D preview">
    <div class="preview-head">
      <h2>3D preview</h2>
      {#if !opened}
        <button type="button" class="preview-open" onclick={openPreview} disabled={checking}>View preview</button>
      {/if}
    </div>

    <p class="preview-duration">
      {seconds(manifest.preview.duration_ms)} preview of a {seconds(manifest.source.duration_ms)} skill · {manifest.preview.speed.toFixed(1)}×
    </p>

    {#if opened}
      <div class="preview-stage" bind:this={stageEl}>
        {#if posterUrl && posterVisible}
          <img src={posterUrl} alt="Skill preview hero frame" onerror={() => (posterUrl = "")} />
        {/if}
        {#if loading}
          <span class="preview-loading">Loading 3D preview…</span>
        {/if}
      </div>

      {#if error}
        <div class="preview-error" role="alert">
          <span>{error}</span>
          <button type="button" onclick={retry}>Try again</button>
        </div>
      {:else}
        <div class="preview-transport">
          <button type="button" class="preview-play" onclick={togglePlayback} disabled={!ready} aria-label={playing ? "Pause preview" : "Play preview"}>
            {playing ? "Pause" : "Play"}
          </button>
          <span class="preview-time">{seconds(currentMs)} / {seconds(durationMs)}</span>
        </div>
        <input
          class="preview-scrub"
          type="range"
          min="0"
          max={durationMs || 1}
          step="10"
          value={currentMs}
          oninput={scrub}
          disabled={!ready}
          aria-label="Skill time"
        />
        <div class="preview-options">
          <label>Speed
            <select value={rate} onchange={selectRate} disabled={!ready}>
              {#each rates as r}
                <option value={r}>{r}×{r === 1 && manifest.preview.speed > 1 ? " (real time)" : ""}{r === manifest.preview.speed && r !== 1 ? " (preview)" : ""}</option>
              {/each}
            </select>
          </label>
        </div>
        {#if manifest.preview.speed > 1}
          <p class="preview-note">
            Real time (1×) is low-fps on this sped-up preview: about {playbackStride(1, manifest.preview.speed, manifest.preview.fps).effectiveFps.toFixed(1)} fps.
          </p>
        {/if}
        <div class="preview-presets" aria-label="Camera angle">
          {#each Object.keys(manifest.camera_presets || {}) as name}
            <button type="button" onclick={() => viewer?.setPreset(name)} disabled={!ready}>{presetLabel(name)}</button>
          {/each}
        </div>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .preview-section { display: flex; flex-direction: column; gap: 10px; }
  .preview-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .preview-head h2 { font-size: 18px; font-weight: 800; }
  .preview-open { height: 38px; padding: 0 15px; border: none; border-radius: 19px; background: var(--ink); color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; }
  .preview-duration { font-size: 13px; line-height: 1.4; color: var(--sub); }
  .preview-stage { position: relative; width: 100%; height: 300px; overflow: hidden; border-radius: 18px; background: #F5F3EE; }
  .preview-stage img { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; object-fit: cover; }
  .preview-loading { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; background: rgba(245, 243, 238, 0.72); color: var(--ink); font-size: 14px; font-weight: 700; }
  .preview-transport { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .preview-play { min-width: 76px; height: 38px; border: none; border-radius: 19px; background: var(--ink); color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; }
  .preview-time { font-family: var(--mono); font-size: 12px; color: var(--sub); }
  .preview-scrub { width: 100%; accent-color: var(--ink); cursor: pointer; }
  .preview-options { display: flex; justify-content: flex-end; }
  .preview-options label { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; color: var(--sub); }
  .preview-options select { height: 34px; border: none; border-radius: 10px; background: var(--ground); color: var(--ink); padding: 0 8px; font-size: 13px; font-weight: 700; }
  .preview-note { font-size: 12px; line-height: 1.45; color: var(--sub); }
  .preview-presets { display: flex; flex-wrap: wrap; gap: 6px; }
  .preview-presets button { height: 32px; padding: 0 10px; border: none; border-radius: 10px; background: var(--ground); color: var(--ink); font-size: 12px; font-weight: 700; cursor: pointer; }
  .preview-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-radius: 12px; background: #FBEAE7; color: #9B2C20; font-size: 13px; }
  .preview-error button { border: none; background: transparent; color: inherit; font-weight: 800; cursor: pointer; }
  button:disabled, select:disabled, input:disabled { opacity: 0.5; cursor: default; }
  button:focus-visible, select:focus-visible, input:focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; }
  @media (min-width: 700px) { .preview-stage { height: 380px; } }
</style>
