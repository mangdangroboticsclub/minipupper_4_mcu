<script>
  import { PS4_DEADZONE, ps4PoseAngles, ps4PowerSucceeded, ps4TurnRate } from "./ps4Control.js";

  /**
   * Mini Pupper's PS4 layout: L1 power, R1 Pose/Trot, left stick walks in
   * Trot, right stick turns in Trot and aims yaw/pitch in Pose. The D-pad
   * handles height/roll and the blue pentagon is the only action (Jump).
   */
  let { online = true, wide = false, rotated = false, onExitWide } = $props();

  const makeStick = () => ({ nx: 0, ny: 0, dx: 0, dy: 0, active: false, pointerId: null, cx: 0, cy: 0, r: 0 });
  let move = $state(makeStick());
  let pose = $state(makeStick());
  let pressed = $state(new Set());
  let powered = $state(false);
  let trotMode = $state(false);
  let transitioning = $state(false);
  let powerError = $state("");

  const stickOf = (which) => which === "move" ? move : pose;
  const controlsHeld = () => move.active || pose.active || pressed.size > 0;

  // ── Ordered robot commands ──────────────────────────────────
  let motionCommands = Promise.resolve();
  function sendGait(mode) {
    motionCommands = motionCommands.then(() => fetch("/v1/robot/gait", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    })).catch(() => null);
    return motionCommands;
  }

  let joyF = 0, joyS = 0, joyT = 0;
  let joyTimer = null;
  let joyInFlight = Promise.resolve(), joySending = false, joyAgain = false;
  function sendJoy() {
    if (joySending) { joyAgain = true; return joyInFlight; }
    joySending = true;
    joyInFlight = (async () => {
      try {
        do {
          joyAgain = false;
          try {
            await fetch("/v1/robot/joy", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ f: joyF, s: joyS, t: joyT }),
            });
          } catch { /* the held stick retries on the next tick */ }
        } while (joyAgain);
      } finally { joySending = false; }
    })();
    return joyInFlight;
  }
  function joyStartTimer() {
    if (!joyTimer) {
      sendJoy();
      joyTimer = setInterval(sendJoy, 100);
    }
  }
  function joyStopTimer() {
    if (joyTimer) clearInterval(joyTimer);
    joyTimer = null;
    return sendJoy();
  }
  function stopTrotIfIdle() {
    if (joyF !== 0 || joyS !== 0 || joyT !== 0) return;
    joyStopTimer();
    sendGait("none");
  }

  // One attitude request in flight; only the latest stick pose waits.
  let attitudePending = null, attitudeTimer = null;
  let attitudeInFlight = Promise.resolve(), attitudeSending = false;
  let attitudeLastSent = "";
  function attitudeSend() {
    attitudeTimer = null;
    if (!attitudePending) return;
    if (attitudeSending) { attitudeTimer = setTimeout(attitudeSend, 80); return; }
    const next = attitudePending;
    attitudePending = null;
    const key = `${next.roll},${next.pitch},${next.yaw}`;
    if (key === attitudeLastSent) return;
    attitudeLastSent = key;
    attitudeSending = true;
    attitudeInFlight = (async () => {
      try {
        await fetch(`/v1/robot/attitude?roll=${next.roll}&pitch=${next.pitch}&yaw=${next.yaw}`, { cache: "no-store" });
      } catch { /* transient; further stick movement retries */ }
    })().finally(() => {
      attitudeSending = false;
      if (attitudePending && !attitudeTimer) attitudeTimer = setTimeout(attitudeSend, 0);
    });
    attitudeTimer = setTimeout(attitudeSend, 80);
  }
  function sendAttitude(roll, pitch, yaw) {
    attitudePending = { roll, pitch, yaw };
    if (!attitudeTimer) attitudeSend();
  }
  async function attitudeNow(roll, pitch, yaw) {
    if (attitudeTimer) clearTimeout(attitudeTimer);
    attitudeTimer = null;
    attitudePending = null;
    await attitudeInFlight;
    attitudeLastSent = `${roll},${pitch},${yaw}`;
    try {
      await fetch(`/v1/robot/attitude?roll=${roll}&pitch=${pitch}&yaw=${yaw}`, { cache: "no-store" });
    } catch { /* power-off still gates every subsequent control */ }
  }

  function resetControls() {
    if (joyTimer) clearInterval(joyTimer);
    joyTimer = null;
    joyF = joyS = joyT = 0;
    move = makeStick();
    pose = makeStick();
    pressed = new Set();
  }
  async function neutralizeRobot() {
    resetControls();
    await sendJoy();                 // includes a trailing zero packet
    await sendGait("none");
    await attitudeNow(0, 0, 0);
  }

  // ── Sticks ──────────────────────────────────────────────────
  function stickDown(e, which) {
    const s = stickOf(which);
    if (!powered || transitioning || s.active || pressed.size > 0) return;
    if (which === "move" && !trotMode) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    s.cx = rect.left + rect.width / 2;
    s.cy = rect.top + rect.height / 2;
    s.r = rect.width * 0.32;
    s.active = true;
    s.pointerId = e.pointerId;
    capture(e.currentTarget, e.pointerId);
    stickUpdate(e, which);
  }
  function stickMove(e, which) {
    const s = stickOf(which);
    if (!s.active || e.pointerId !== s.pointerId) return;
    e.preventDefault();
    stickUpdate(e, which);
  }
  function stickUp(e, which) {
    const s = stickOf(which);
    if (!s.active || e.pointerId !== s.pointerId) return;
    s.active = false;
    s.pointerId = null;
    s.nx = s.ny = s.dx = s.dy = 0;
    if (!trotMode) {
      sendAttitude(0, 0, 0);
      return;
    }
    if (which === "move") joyF = joyS = 0;
    else joyT = 0;
    stopTrotIfIdle();
  }
  function stickUpdate(e, which) {
    const s = stickOf(which);
    let dx = e.clientX - s.cx;
    let dy = e.clientY - s.cy;
    if (rotated) { const sx = dx; dx = dy; dy = -sx; }
    if (trotMode && which === "pose") dy = 0;
    const dist = Math.hypot(dx, dy);
    if (dist > s.r) { dx = dx / dist * s.r; dy = dy / dist * s.r; }
    let nx = s.r > 0 ? +(dx / s.r).toFixed(4) : 0;
    let ny = s.r > 0 ? +(dy / s.r).toFixed(4) : 0;
    if (Math.hypot(nx, ny) < PS4_DEADZONE) { nx = 0; ny = 0; }
    s.dx = dx; s.dy = dy; s.nx = nx; s.ny = ny;

    if (!trotMode) {
      const angles = ps4PoseAngles(nx, ny);
      sendAttitude(0, angles.pitch, angles.yaw);
      return;
    }
    if (which === "move") {
      joyF = -ny;
      joyS = -nx;
    } else {
      joyT = ps4TurnRate(nx);
    }
    if (joyF !== 0 || joyS !== 0 || joyT !== 0) joyStartTimer();
    else stopTrotIfIdle();
  }

  // ── D-pad and the single Jump action ────────────────────────
  const BODY_ROLL = { "dpad-left": -15, "dpad-right": 15 };
  const HEIGHT_GAIT = { "dpad-up": "heightup", "dpad-down": "heightdown" };
  function press(id) {
    if (!powered || transitioning || controlsHeld()) return;
    pressed = new Set(pressed).add(id);
    if (id in BODY_ROLL) sendAttitude(BODY_ROLL[id], 0, 0);
    else if (id in HEIGHT_GAIT) sendGait(HEIGHT_GAIT[id]);
    else if (id === "jump") sendGait("jump");
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch {} }
  }
  function release(id) {
    if (!pressed.has(id)) return;
    const next = new Set(pressed); next.delete(id); pressed = next;
    if (id in BODY_ROLL) sendAttitude(0, 0, 0);
    else if (id in HEIGHT_GAIT) sendGait("none");
  }

  // ── L1 power and R1 mode ────────────────────────────────────
  async function sendPower(action) {
    const r = await fetch("/v1/robot/power", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!r.ok) throw new Error("power request rejected");
    const j = await r.json();
    if (!ps4PowerSucceeded(j, action)) throw new Error("unexpected power state");
  }
  async function togglePower() {
    if (transitioning) return;
    transitioning = true;
    powerError = "";
    try {
      if (powered) {
        await neutralizeRobot();
        await sendPower("hold");
        powered = false;
        trotMode = false;
      } else {
        await sendPower("wake");
        await neutralizeRobot();      // wake into a known, stationary Pose
        trotMode = false;
        powered = true;
      }
    } catch {
      powerError = "Power command failed";
    } finally {
      transitioning = false;
    }
  }
  async function toggleMode() {
    if (!powered || transitioning) return;
    transitioning = true;
    await neutralizeRobot();
    trotMode = !trotMode;
    transitioning = false;
  }
  async function emergencyStop() {
    if (transitioning) return;
    transitioning = true;
    await neutralizeRobot();
    transitioning = false;
  }

  function capture(el, pointerId) {
    try { el.setPointerCapture(pointerId); } catch { /* synthetic/inactive pointer */ }
  }
  function btnDown(e, id) { e.preventDefault(); capture(e.currentTarget, e.pointerId); press(id); }
  function btnUp(e, id) { release(id); }
  function btnKey(e, id) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault(); e.stopPropagation();
    if (e.type === "keydown") press(id); else release(id);
  }
  function windowKey(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    emergencyStop();
  }

  $effect(() => () => {
    // Changing tabs/schemes or closing the wide controller must not strand a
    // held gait or pose. neutralizeRobot includes the trailing Joy zero.
    void neutralizeRobot();
  });

  const DPAD = [
    { id: "dpad-up", pos: "up", label: "Body up", path: "M12 6l7 10H5z" },
    { id: "dpad-left", pos: "left", label: "Roll body left", path: "M6 12l10-7v14z" },
    { id: "dpad-right", pos: "right", label: "Roll body right", path: "M18 12L8 5v14z" },
    { id: "dpad-down", pos: "down", label: "Body down", path: "M12 18L5 8h14z" },
  ];
</script>

<svelte:window onkeydown={windowKey} />

{#snippet stick(which, s)}
  <div class="stick-wrap">
    <div
      class="well"
      class:active={s.active}
      class:disabled={which === "move" && !trotMode}
      role="slider"
      tabindex="0"
      aria-label={which === "move" ? trotMode ? "Move stick: drag to walk" : "Move stick: available in Trot mode" : trotMode ? "Turn stick: drag left or right to turn" : "Pose stick: drag to yaw and pitch the body"}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={Math.round(Math.min(1, Math.hypot(s.nx, s.ny)) * 100)}
      onpointerdown={(e) => stickDown(e, which)}
      onpointermove={(e) => stickMove(e, which)}
      onpointerup={(e) => stickUp(e, which)}
      onpointercancel={(e) => stickUp(e, which)}
    >
      <span class="well-ring" aria-hidden="true"></span>
      <span class="knob" class:held={s.active} style="transform: translate({s.dx}px, {s.dy}px)" aria-hidden="true">
        {#if which === "pose" && trotMode}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/></svg>
        {:else if which === "pose"}
          <span class="knob-eyes"><i></i><i></i></span>
        {:else}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>
        {/if}
      </span>
    </div>
    <span class="cap">{which === "move" ? "Move" : trotMode ? "Turn" : "Pose"}</span>
  </div>
{/snippet}

{#snippet dpad()}
  <div class="cluster">
    <div class="dpad">
      {#each DPAD as k (k.id)}
        <button type="button" class="dkey {k.pos}" class:pressed={pressed.has(k.id)} aria-label="{k.label} (hold)"
          onpointerdown={(e) => btnDown(e, k.id)} onpointerup={(e) => btnUp(e, k.id)} onpointercancel={(e) => btnUp(e, k.id)}
          onkeydown={(e) => btnKey(e, k.id)} onkeyup={(e) => btnKey(e, k.id)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={k.path}/></svg>
        </button>
      {/each}
      <span class="dhub" aria-hidden="true"></span>
    </div>
    <span class="cap soft">Body</span>
  </div>
{/snippet}

{#snippet jump()}
  <div class="cluster">
    <div class="faces">
      <button type="button" class="fbtn bottom" class:pressed={pressed.has("jump")} style="--tone: #2D6BCB" aria-label="Jump"
        onpointerdown={(e) => btnDown(e, "jump")} onpointerup={(e) => btnUp(e, "jump")} onpointercancel={(e) => btnUp(e, "jump")}
        onkeydown={(e) => btnKey(e, "jump")} onkeyup={(e) => btnKey(e, "jump")}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 6.5-3.4 10.5H6.4L3 9.5z"/></svg>
      </button>
    </div>
    <span class="cap soft">Jump</span>
  </div>
{/snippet}

{#snippet tools()}
  {#if wide && onExitWide}
    <div class="tools">
      <button type="button" class="tool" onclick={onExitWide} aria-label="Back to portrait">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
      </button>
    </div>
  {/if}
{/snippet}

{#snippet shoulder(side)}
  <button type="button" class="shoulder {side}" class:on={side === "l" ? powered : trotMode}
    disabled={side === "r" && !powered} aria-label={side === "l" ? powered ? "L1: power off" : "L1: power on" : trotMode ? "R1: switch to Pose" : "R1: switch to Trot"}
    onclick={side === "l" ? togglePower : toggleMode}>
    {#if side === "l"}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3v8"/><path d="M6.3 7.2a7.5 7.5 0 1 0 11.4 0"/></svg>
      <span>L1</span>
    {:else}
      <span>{trotMode ? "Trot" : "Pose"}</span>
      <span>R1</span>
    {/if}
  </button>
{/snippet}

<div class="box" class:wide>
  <section class="shell" class:offline={!online} class:unpowered={!powered} aria-label="PS4 controller">
    {#if wide}
      <div class="row-top">{@render shoulder("l")}{@render shoulder("r")}</div>
      <div class="body">
        {@render dpad()}
        <div class="centre">{@render tools()}<div class="sticks">{@render stick("move", move)}{@render stick("pose", pose)}</div></div>
        {@render jump()}
      </div>
    {:else}
      <div class="row-top">{@render shoulder("l")}{@render tools()}{@render shoulder("r")}</div>
      <div class="row-mid">{@render dpad()}{@render jump()}</div>
      <div class="sticks">{@render stick("move", move)}{@render stick("pose", pose)}</div>
    {/if}
    {#if powerError}<span class="power-error" role="alert">{powerError}</span>{/if}
  </section>
</div>

<style>
  .box { container-type: inline-size; width: 100%; }
  .box.wide { container-type: size; height: 100%; display: grid; align-items: center; }
  .shell {
    --btn: clamp(42px, 13.6cqw, 60px); --stick: clamp(118px, 42cqw, 200px); --side: clamp(12px, 4.6cqw, 20px);
    position: relative; border-radius: 40px; padding: 0 var(--side) 18px;
    background: radial-gradient(120% 70% at 50% 0%, rgba(255,255,255,.38), transparent 60%), linear-gradient(180deg, #FFE24A 0%, #FFD31A 55%, #F2C200 100%);
    box-shadow: inset 0 2px 0 rgba(255,255,255,.55), inset 0 -6px 0 rgba(160,120,0,.25), 0 14px 30px rgba(120,90,0,.18);
    display: flex; flex-direction: column; user-select: none; -webkit-user-select: none;
    transition: opacity var(--dur-med), filter var(--dur-med);
  }
  .shell.offline { opacity: .6; filter: saturate(.4); }
  .row-top { display: flex; align-items: flex-start; justify-content: space-between; margin: 0 calc(-1 * var(--side)); }
  .row-mid { display: flex; align-items: center; justify-content: space-between; margin-top: clamp(10px, 3.4cqw, 18px); }
  .sticks { display: flex; justify-content: space-between; align-items: flex-end; margin-top: clamp(14px, 5cqw, 24px); }
  .wide .shell { --btn: clamp(40px, 14cqh, 64px); --stick: clamp(110px, 42cqh, 210px); --side: clamp(14px, 3cqw, 28px); height: min(100%, 520px); border-radius: 44px; padding-bottom: clamp(10px, 4cqh, 22px); }
  .wide .body { flex: 1; min-height: 0; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: clamp(10px, 3cqw, 32px); }
  .wide .centre { display: flex; flex-direction: column; align-items: center; gap: clamp(8px, 3cqh, 18px); min-width: 0; }
  .wide .sticks { margin-top: 0; justify-content: center; gap: clamp(14px, 5cqw, 56px); }
  .wide .tools { padding-top: 0; }
  .cluster { display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .cap { font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: var(--ink); }
  .cap.soft { font-size: 11px; color: rgba(17,17,17,.62); }
  .shoulder { height: clamp(52px, 16cqw, 64px); min-width: clamp(86px, 26cqw, 120px); white-space: nowrap; border: none; display: flex; align-items: center; gap: 8px; padding: 0 clamp(12px, 4.4cqw, 18px); font-size: 14px; font-weight: 800; letter-spacing: .06em; color: var(--ink); background: linear-gradient(180deg, #F4C800, #E2B400); box-shadow: inset 0 -3px 0 rgba(110,80,0,.25); cursor: pointer; touch-action: none; }
  .shoulder svg { width: 24px; height: 24px; flex-shrink: 0; }
  .shoulder.l { border-radius: 40px 0 28px 0; justify-content: flex-start; }
  .shoulder.r { border-radius: 0 40px 0 28px; justify-content: flex-end; }
  .wide .shoulder.l { border-radius: 44px 0 28px 0; }
  .wide .shoulder.r { border-radius: 0 44px 0 28px; }
  .shoulder.on { box-shadow: inset 0 -3px 0 rgba(110,80,0,.25), 0 0 0 3px rgba(46,204,113,.35); }
  .shoulder:disabled { opacity: .45; cursor: not-allowed; }
  .tools { display: flex; gap: 8px; padding-top: 12px; }
  .tool { width: 44px; height: 44px; border-radius: 22px; border: none; background: rgba(17,17,17,.08); color: var(--ink); display: grid; place-items: center; cursor: pointer; }
  .tool svg { width: 18px; height: 18px; }
  .unpowered :is(.dpad, .faces, .well) { opacity: .45; filter: saturate(.3); cursor: not-allowed; transition: opacity var(--dur-med), filter var(--dur-med); }
  .power-error { align-self: center; margin-top: 10px; font-size: 12px; font-weight: 700; color: #8B1E1E; }
  .dpad { position: relative; display: grid; grid-template-columns: repeat(3, var(--btn)); grid-template-rows: repeat(3, var(--btn)); grid-template-areas: ". up ." "left hub right" ". down ."; }
  .dkey { border: none; background: #FFFCF0; color: var(--ink); box-shadow: 0 3px 0 rgba(130,95,0,.35); display: grid; place-items: center; cursor: pointer; touch-action: none; }
  .dkey svg { width: 36%; height: 36%; fill: currentColor; }
  .dkey.up { grid-area: up; border-radius: 12px 12px 4px 4px; }
  .dkey.down { grid-area: down; border-radius: 4px 4px 12px 12px; }
  .dkey.left { grid-area: left; border-radius: 12px 4px 4px 12px; }
  .dkey.right { grid-area: right; border-radius: 4px 12px 12px 4px; }
  .dhub { grid-area: hub; background: #FFFCF0; }
  .dkey.pressed { transform: translateY(3px); box-shadow: 0 0 0 rgba(130,95,0,.35); background: #fff; }
  .faces { display: grid; grid-template-columns: repeat(3, var(--btn)); grid-template-rows: repeat(3, var(--btn)); grid-template-areas: ". top ." "left . right" ". bottom ."; place-items: center; }
  .fbtn { width: var(--btn); height: var(--btn); border-radius: 50%; border: none; background: #FFFCF0; box-shadow: 0 3px 0 rgba(130,95,0,.35); display: grid; place-items: center; cursor: pointer; touch-action: none; }
  .fbtn svg { width: 42%; height: 42%; fill: none; stroke: var(--tone); stroke-width: 2.6; stroke-linejoin: round; }
  .fbtn.bottom { grid-area: bottom; }
  .fbtn.pressed { transform: translateY(3px); box-shadow: 0 0 0 transparent; background: var(--tone); }
  .fbtn.pressed svg { stroke: #fff; }
  .stick-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .well { position: relative; width: var(--stick); height: var(--stick); border-radius: 50%; background: #26262A; box-shadow: inset 0 6px 14px rgba(0,0,0,.55), 0 2px 0 rgba(255,255,255,.45); display: grid; place-items: center; touch-action: none; cursor: grab; }
  .well.active { cursor: grabbing; }
  .well.disabled { opacity: .45; cursor: not-allowed; }
  .well-ring { position: absolute; inset: 9%; border-radius: 50%; border: 1.5px dashed rgba(255,255,255,.14); pointer-events: none; }
  .knob { width: 50%; height: 50%; border-radius: 50%; background: radial-gradient(circle at 40% 32%, #FFF 0%, #ECEAE4 60%, #D3D0C8 100%); box-shadow: 0 6px 12px rgba(0,0,0,.45), inset 0 -3px 0 rgba(0,0,0,.12); display: grid; place-items: center; color: #6B6862; pointer-events: none; transition: transform 160ms cubic-bezier(.3,1.5,.5,1); }
  .knob.held { transition: none; }
  .knob svg { width: 34%; height: 34%; }
  .knob-eyes { display: flex; gap: 10%; width: 32%; justify-content: center; }
  .knob-eyes i { width: 9px; height: 16px; border-radius: 3px; background: var(--ink); }
  button:focus-visible, .well:focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; }
</style>
