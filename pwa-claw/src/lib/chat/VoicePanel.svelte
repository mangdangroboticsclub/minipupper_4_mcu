<script>
  let {
    conversation = null,
    voiceState = "idle",
    busy = false,
    error = "",
    onWake,
    onEnd,
    onNew,
    onClear,
    onClose,
  } = $props();

  let transcriptEl = $state(null);
  let turns = $derived(conversation?.messages || []);
  let live = $derived(!["idle", "ended", "cleared"].includes(voiceState));
  let statusLabel = $derived.by(() => {
    if (voiceState === "listening") return "Listening — speak naturally";
    if (voiceState === "thinking") return "Pupper is thinking";
    if (voiceState === "speaking") return "Speaking — you can interrupt";
    if (voiceState === "ended") return "Voice chat ended";
    if (voiceState === "cleared") return "Context cleared";
    return turns.length ? "Ready for a follow-up" : "Ready to start voice chat";
  });

  $effect(() => {
    turns.length;
    queueMicrotask(() => {
      if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight;
    });
  });
</script>

<div class="voice-panel-backdrop" role="presentation">
  <div class="voice-panel" role="dialog" aria-modal="true" aria-label="Voice chat">
    <header class="voice-panel-header">
      <div>
        <span class="eyebrow">Pupper voice</span>
        <h2>Voice chat</h2>
      </div>
      <button class="icon-button" aria-label="Close voice chat" title="Close" onclick={() => onClose?.()}>×</button>
    </header>

    <div class="voice-status" class:live>
      <span class="status-orb" class:pulsing={live} aria-hidden="true">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
        </svg>
      </span>
      <strong>{statusLabel}</strong>
      <span class="status-detail">Gateway STT/TTS · Pupper answers on the robot</span>
    </div>

    <div class="voice-transcript" bind:this={transcriptEl} aria-live="polite">
      {#if turns.length === 0}
        <div class="empty-transcript">
          <p>No voice turns in this session yet.</p>
          <span>Tap the microphone, then speak. You can interrupt a spoken reply with the same button.</span>
        </div>
      {:else}
        {#each turns as turn, index (`${turn.ts || index}-${index}`)}
          {#if turn.role !== "step"}
            <div class="turn" class:user={turn.role === "user"}>
              <span class="speaker">{turn.role === "user" ? "You" : "Pupper"}</span>
              <p>{turn.text}</p>
            </div>
          {/if}
        {/each}
      {/if}
    </div>

    {#if error}<p class="voice-error" role="alert">{error}</p>{/if}

    <div class="voice-primary-actions">
      <button
        class="wake-button"
        disabled={busy || voiceState === "thinking"}
        onclick={() => onWake?.()}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
        </svg>
        {busy ? "Working…" : voiceState === "speaking" ? "Interrupt & speak" : turns.length ? "Speak again" : "Start talking"}
      </button>
      <button class="end-button" disabled={busy || voiceState === "ended"} onclick={() => onEnd?.()}>
        <span aria-hidden="true">■</span> End voice chat
      </button>
    </div>

    <div class="voice-secondary-actions">
      <button disabled={busy} onclick={() => onNew?.()}>New session</button>
      <button
        disabled={busy || !conversation || voiceState === "thinking"}
        onclick={() => onClear?.()}
      >Clear context</button>
    </div>
    <p class="control-hint">New keeps this transcript and starts a fresh context. Clear deletes this session's robot memory and transcript.</p>
  </div>
</div>

<style>
  .voice-panel-backdrop {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    justify-content: center;
    background: rgba(0, 0, 0, 0.48);
    backdrop-filter: blur(5px);
  }

  .voice-panel {
    display: flex;
    flex-direction: column;
    width: min(100%, 620px);
    height: 100%;
    padding: 20px;
    background: var(--page);
    color: var(--ink);
    overflow: hidden;
  }

  .voice-panel-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .voice-panel-header h2 { margin: 2px 0 0; font-size: 24px; }
  .eyebrow { color: var(--sub); font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
  .icon-button { width: 42px; height: 42px; border: 1px solid var(--hair); border-radius: 50%; background: var(--panel, var(--page)); color: var(--ink); font-size: 28px; cursor: pointer; }

  .voice-status { display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 25px 10px 20px; text-align: center; }
  .status-orb { display: grid; place-items: center; width: 78px; height: 78px; margin-bottom: 5px; border-radius: 50%; background: var(--panel, var(--hair)); color: var(--sub); }
  .voice-status.live .status-orb { background: var(--mpx-yellow); color: var(--ink); }
  .status-orb.pulsing { animation: voice-panel-pulse 1.8s ease-in-out infinite; }
  .voice-status strong { font-size: 17px; }
  .status-detail { color: var(--sub); font-size: 12px; }

  .voice-transcript { flex: 1; min-height: 120px; overflow-y: auto; padding: 12px; border: 1px solid var(--hair); border-radius: 20px; background: var(--panel, var(--page)); }
  .empty-transcript { display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100%; padding: 24px; color: var(--sub); text-align: center; }
  .empty-transcript p { margin: 0 0 8px; color: var(--ink); font-weight: 700; }
  .empty-transcript span { max-width: 340px; font-size: 13px; line-height: 1.5; }
  .turn { max-width: 88%; margin: 10px 0; }
  .turn.user { margin-left: auto; text-align: right; }
  .speaker { color: var(--sub); font-size: 10px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; }
  .turn p { margin: 3px 0 0; padding: 10px 13px; border-radius: 15px 15px 15px 4px; background: var(--page); line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .turn.user p { border-radius: 15px 15px 4px 15px; background: var(--mpx-yellow); color: var(--ink); text-align: left; }

  .voice-error { margin: 10px 0 0; padding: 9px 12px; border-radius: 10px; background: rgba(200, 40, 40, 0.1); color: #c33; font-size: 13px; }
  .voice-primary-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 14px; }
  .voice-primary-actions button, .voice-secondary-actions button { min-height: 48px; border-radius: 14px; font: inherit; font-weight: 750; cursor: pointer; }
  .voice-primary-actions button:disabled, .voice-secondary-actions button:disabled { opacity: 0.45; cursor: default; }
  .wake-button { display: flex; align-items: center; justify-content: center; gap: 8px; border: 1px solid var(--mpx-yellow); background: var(--mpx-yellow); color: var(--ink); }
  .end-button { display: flex; align-items: center; justify-content: center; gap: 8px; border: 1px solid #b64343; background: transparent; color: #b64343; }
  .voice-secondary-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
  .voice-secondary-actions button { border: 1px solid var(--hair); background: var(--panel, var(--page)); color: var(--ink); font-size: 13px; }
  .control-hint { margin: 10px 4px 0; color: var(--sub); font-size: 11px; line-height: 1.4; text-align: center; }

  @keyframes voice-panel-pulse { 50% { transform: scale(1.06); box-shadow: 0 0 0 10px rgba(255, 213, 0, 0.12); } }
  @media (min-width: 621px) { .voice-panel { height: min(850px, calc(100% - 40px)); margin: 20px 0; border: 1px solid var(--hair); border-radius: 26px; } }
  @media (max-width: 390px) { .voice-panel { padding: 15px; } .voice-primary-actions { grid-template-columns: 1fr; } .voice-status { padding: 16px 8px 13px; } .status-orb { width: 62px; height: 62px; } }
</style>
