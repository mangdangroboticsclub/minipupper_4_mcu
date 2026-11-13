<script>
  import {
    listSkills,
    listRobotSkills,
    toggleSkill,
    deploySkill,
    enqueueLua,
  } from "./marketplaceApi.js";
  import {
    deleteSkillFiles,
    installMotionSkill,
    marketplaceSkillType,
    normalizeDeployedSkills,
    prettySkillName,
    reconcileDeployedSkills,
    registryEntryForSkill,
    registryRunName,
    runSkill,
    skillActionId,
  } from "./skillActions.js";

  /**
   * Web skills run in the Agent and are switched on or off. Move skills are
   * files installed into the robot's storage. The firmware registry is the
   * installed-source-of-truth, so manually installed and encrypted skills
   * survive reboots and appear even when the Store cannot be reached.
   *
   * @prop onNavigate — ("store") => void
   * @prop pinned — Quick action ids
   * @prop onTogglePin — (quickActionId) => void
   * @prop onRegistryChange — (registryEntries) => void
   * @prop onDeployedChange — (browser-known deployed paths by skill id) => void
   */
  let { onNavigate, online = true, pinned = [], onTogglePin, onRegistryChange, onDeployedChange } = $props();

  let tab = $state("web");              // "web" (Agent) | "move" (robot)
  let owned = $state([]);               // /v1/marketplace/robot/skills
  let catalog = $state({});             // skill id -> { description }
  let registry = $state([]);            // /v1/skills/registry skills
  let running = $state(null);           // name of the skill running now
  let loading = $state(true);
  let storeError = $state(false);
  let robotError = $state(false);
  let refreshGeneration = 0;
  let busy = $state(null);
  let toast = $state(null);
  let toastTimer = null;

  function say(text, tone = "ok") {
    toast = { text, tone };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 2600);
  }

  // Motion skills installed from the store: file paths written on install,
  // so Remove can delete them again.
  const DEPLOYED_KEY = "mpx_deployed_skills";
  let deployed = $state({});
  try {
    const raw = localStorage.getItem(DEPLOYED_KEY);
    if (raw) deployed = normalizeDeployedSkills(JSON.parse(raw));
  } catch {}
  function saveDeployed() { try { localStorage.setItem(DEPLOYED_KEY, JSON.stringify(deployed)); } catch {} }
  $effect(() => { onDeployedChange?.(deployed); });

  async function refresh({ quiet = false } = {}) {
    const generation = ++refreshGeneration;
    if (!quiet) loading = true;
    const [ownedRes, catRes, regRes, statRes] = await Promise.allSettled([
      listRobotSkills(),
      listSkills(),
      fetch("/v1/skills/registry", { cache: "no-store" }).then(async (r) => {
        if (!r.ok) throw new Error(`Registry (${r.status})`);
        return r.json();
      }),
      fetch("/v1/skills/status", { cache: "no-store" }).then(async (r) => {
        if (!r.ok) throw new Error(`Skill status (${r.status})`);
        return r.json();
      }),
    ]);
    if (generation !== refreshGeneration) return;

    storeError = ownedRes.status !== "fulfilled";
    if (ownedRes.status === "fulfilled" && Array.isArray(ownedRes.value)) owned = ownedRes.value;
    if (catRes.status === "fulfilled" && Array.isArray(catRes.value)) {
      catalog = Object.fromEntries(catRes.value.map((s) => [s.id, s]));
    }
    robotError = regRes.status !== "fulfilled" || !Array.isArray(regRes.value?.skills);
    if (!robotError) {
      registry = regRes.value.skills;
      const reconciled = reconcileDeployedSkills(deployed, registry);
      if (JSON.stringify(reconciled) !== JSON.stringify(deployed)) {
        deployed = reconciled;
        saveDeployed();
      }
      onRegistryChange?.(registry);
    }
    if (statRes.status === "fulfilled") {
      running = statRes.value?.running ? statRes.value.name || "" : null;
      announceResult(statRes.value);
    }
    loading = false;
  }

  // A failed run is reported once per run, not on every reconnect or poll.
  let announcedResult = null;
  function announceResult(status) {
    if (!status || status.running) {
      announcedResult = null;
      return;
    }
    if (!status.result) return;
    const key = `${status.result}:${status.result_code}`;
    if (key === announcedResult) return;
    announcedResult = key;
    if (status.result === "failed") say("Skill stopped because it failed to load or execute", "err");
  }
  $effect(() => {
    if (online) refresh();
    return () => clearTimeout(toastTimer);
  });

  // Reflect completion and externally started skills without a manual reload.
  $effect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      try {
        const response = await fetch("/v1/skills/status", { cache: "no-store" });
        if (response.ok) {
          const status = await response.json();
          running = status.running ? status.name || "" : null;
          announceResult(status);
        }
      } catch { /* Keep the last known state until the robot answers. */ }
    }, 1000);
    return () => clearInterval(timer);
  });

  const isMotion = (s) => marketplaceSkillType(s) === "wasm";
  const tail = (id) => (id || "").split("~").pop();
  const pretty = prettySkillName;

  const items = $derived.by(() => {
    const list = owned.filter((s) => marketplaceSkillType(s)).map((s) => {
      const motion = isMotion(s);
      const reg = motion ? registryEntryForSkill(registry, s.skill_id, deployed[s.skill_id]) : null;
      return {
        key: s.skill_id,
        name: s.title || pretty(tail(s.skill_id)),
        desc: reg?.valid === false ? (reg.error || "Skill failed validation") : (catalog[s.skill_id]?.description || ""),
        motion,
        installed: !!reg,
        enabled: !!s.enabled,
        runName: registryRunName(reg, registry),
        file: reg?.file || null,
        valid: reg?.valid !== false,
        error: reg?.error || "",
        src: s,
      };
    });
    // Files on the robot that no owned Store package accounts for.
    const claimed = new Set(list.map((item) => item.file).filter(Boolean));
    for (const entry of registry) {
      const runName = registryRunName(entry, registry);
      if (!runName || claimed.has(entry.file)) continue;
      list.push({
        key: "local:" + entry.file,
        name: pretty(runName),
        desc: entry.valid === false ? (entry.error || "Skill failed validation") : "Installed on the robot",
        motion: true,
        installed: true,
        runName,
        file: entry.file,
        valid: entry.valid !== false,
        error: entry.error || "",
        src: null,
      });
    }
    return list;
  });
  const webSkills = $derived(items.filter((item) => !item.motion));
  const moveSkills = $derived(items.filter((item) => item.motion));
  const shown = $derived(tab === "web" ? webSkills : moveSkills);

  // ── Actions ──
  async function setEnabled(item, on) {
    busy = item.key;
    try {
      await toggleSkill(item.key, on);
      await refresh({ quiet: true });
      say(`${item.name} ${on ? "is on" : "is off"}`);
    } catch (error) { say(error.message || "Couldn't change that skill", "err"); }
    busy = null;
  }

  async function install(item) {
    busy = item.key;
    try {
      await installMotionSkill(item.key, {
        deploySkill,
        enqueueLua,
        onPaths: (paths) => {
          // Keep auxiliary paths even if a later step fails, so Remove can
          // clean up a partial deployment instead of leaving orphan files.
          deployed = { ...deployed, [item.key]: paths };
          saveDeployed();
        },
      });
      await refresh({ quiet: true });
      say(`${item.name} is on the robot`);
    } catch (error) {
      say(error.message || "Install failed", "err");
    }
    busy = null;
  }

  async function remove(item) {
    if (running && running === item.runName) {
      say("Stop the skill before removing it", "err");
      return;
    }
    if (!confirm(`Remove ${item.name} from the robot?`)) return;
    busy = item.key;
    try {
      await deleteSkillFiles([...(deployed[item.key] || []), item.file]);
      const next = { ...deployed };
      delete next[item.key];
      deployed = next;
      saveDeployed();
      await refresh({ quiet: true });
      say(`${item.name} removed from the robot`);
    } catch (error) {
      // Keep the package mapping unless every file was deleted successfully.
      say(error.message || "Couldn't remove it", "err");
    }
    busy = null;
  }

  async function run(item) {
    busy = item.key;
    try {
      if (running && running === item.runName) {
        const response = await fetch("/v1/skills/stop", { method: "POST" });
        if (!response.ok) throw new Error(`Couldn't stop skill (${response.status})`);
        // Stop is cooperative; keep showing Stop until status confirms exit.
        say(`Stopping ${item.name}`);
      } else {
        await runSkill(item.runName);
        running = item.runName;
        say(`Running ${item.name}`);
      }
    } catch (error) {
      say(error.message || "Couldn't reach the robot", "err");
    }
    busy = null;
  }
</script>

<div class="skills">
  <header class="head">
    <h1>Skills</h1>
    <div class="seg" role="tablist" aria-label="Skill type">
      <button type="button" role="tab" aria-selected={tab === "web"} class:on={tab === "web"} onclick={() => (tab = "web")}>
        Web skills{loading ? "" : ` · ${webSkills.length}`}
      </button>
      <button type="button" role="tab" aria-selected={tab === "move"} class:on={tab === "move"} onclick={() => (tab = "move")}>
        Move skills{loading ? "" : ` · ${moveSkills.length}`}
      </button>
    </div>
  </header>

  <div class="scroll">
    <div class="inner">
      {#if storeError && !loading}
        <p class="note">Couldn't reach the Store. Owned Web skills may be unavailable; installed Move skills still appear.</p>
      {/if}
      {#if robotError && !loading}
        <p class="note">Couldn't read the robot's skill index. Showing the last known list; install and run may be unavailable.</p>
      {/if}

      {#if loading}
        {#each [0, 1, 2] as _}<div class="card sk" aria-hidden="true"><span class="sk-ico"></span><span class="sk-line"></span></div>{/each}
      {:else if shown.length === 0}
        <div class="empty">
          <p class="empty-title">{tab === "web" ? "No Web skills yet" : "No Move skills yet"}</p>
          <p class="empty-desc">
            {tab === "web"
              ? "Web skills you own appear here and run in the Agent when turned on."
              : "Move skills you own appear here. Install one to run it on the robot."}
          </p>
          <button type="button" class="ghost" onclick={() => onNavigate?.("store")}>Go to the Store</button>
        </div>
      {:else}
        <ul class="list">
          {#each shown as item (item.key)}
            {@const isRunning = running && running === item.runName}
            <li class="card" class:busy={busy === item.key}>
              <span class="ico" class:motion={item.motion} aria-hidden="true">
                {#if item.motion}
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18c3-8 5-12 8-12s5 4 8 12"/><circle cx="12" cy="6" r="2"/></svg>
                {:else}
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z"/><path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z"/></svg>
                {/if}
              </span>
              <div class="info">
                <span class="name">{item.name}</span>
                {#if item.desc}<span class="desc">{item.desc}</span>{/if}
                <span class="chip" class:motion={item.motion}>{item.motion ? "Move skill · Robot" : "Web skill · Agent"}</span>
              </div>
              <div class="acts">
                {#if !item.motion}
                  <button type="button" class="btn" class:dark={item.enabled} disabled={busy === item.key} onclick={() => setEnabled(item, !item.enabled)} aria-label="{item.enabled ? 'Turn off' : 'Turn on'} {item.name}">
                    {item.enabled ? "Turn off" : "Turn on"}
                  </button>
                {:else if item.installed}
                  {#if item.valid !== false}
                    <button type="button" class="btn skill-run" class:running={isRunning} disabled={busy === item.key || (running && !isRunning)} onclick={() => run(item)} aria-label="{isRunning ? 'Stop' : 'Run'} {item.name}">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        {#if isRunning}<rect x="6" y="6" width="12" height="12" rx="2" />{:else}<path d="m8 5 11 7-11 7V5Z" />{/if}
                      </svg>
                      <span>{isRunning ? "Stop" : "Run"}</span>
                    </button>
                    {@const quickId = skillActionId(item.runName)}
                    {@const isPinned = pinned.includes(quickId)}
                    <button
                      type="button"
                      class="pin"
                      class:on={isPinned}
                      aria-pressed={isPinned}
                      aria-label="{isPinned ? 'Remove' : 'Add'} {item.name} {isPinned ? 'from' : 'to'} Quick actions"
                      onclick={() => onTogglePin?.(quickId)}
                    >{isPinned ? "Pinned" : "Pin"}</button>
                  {/if}
                  <button type="button" class="link" disabled={busy === item.key || isRunning} onclick={() => remove(item)} aria-label="Remove {item.name} from the robot">Remove</button>
                {:else}
                  <button type="button" class="btn" disabled={busy === item.key} onclick={() => install(item)} aria-label="Install {item.name}">
                    {busy === item.key ? "…" : "Install"}
                  </button>
                  {#if deployed[item.key]?.length}
                    <button type="button" class="link" disabled={busy === item.key} onclick={() => remove(item)} aria-label="Clean up partial {item.name} install">Clean up</button>
                  {/if}
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>

  {#if toast}
    <div class="toast" class:err={toast.tone === "err"} role="status">{toast.text}</div>
  {/if}
</div>

<style>
  .skills { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--page); color: var(--ink); }
  .head { flex-shrink: 0; width: 100%; max-width: var(--page-max); margin: 0 auto; padding: calc(26px + var(--safe-top)) 20px 8px; display: flex; flex-direction: column; gap: 16px; }
  h1 { font-size: 34px; font-weight: 800; letter-spacing: -0.02em; }
  .seg { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); background: var(--hair); border-radius: 16px; padding: 4px; gap: 4px; }
  .seg button { height: 44px; border: none; border-radius: 12px; background: transparent; color: #4F4C46; font-size: 15px; font-weight: 700; cursor: pointer; }
  .seg button.on { background: #fff; color: var(--ink); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12); }
  .seg button:focus-visible { outline: 3px solid var(--ink); outline-offset: 1px; }

  .scroll { flex: 1; min-height: 0; overflow-y: auto; }
  .inner { max-width: var(--page-max); margin: 0 auto; padding: 8px 20px 20px; display: flex; flex-direction: column; gap: 10px; }
  .note { font-size: 13px; color: #4F4C46; background: var(--ground); border-radius: 14px; padding: 10px 12px; }

  .list { list-style: none; display: flex; flex-direction: column; gap: 10px; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 20px; padding: 14px; display: flex; align-items: center; gap: 14px; transition: opacity var(--dur-fast); }
  .card.busy { opacity: 0.6; }
  .ico { width: 52px; height: 52px; border-radius: 15px; flex-shrink: 0; display: grid; place-items: center; background: var(--mpx-yellow); color: var(--ink); }
  .ico.motion { background: #CFE3FF; }
  .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .name { font-size: 16px; font-weight: 700; }
  .desc { font-size: 13px; color: var(--sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chip { align-self: flex-start; margin-top: 2px; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 8px; background: #FFF6B0; color: #5B4E00; }
  .chip.motion { background: #E3EEFF; color: #1F4F99; }
  .acts { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex-shrink: 0; }
  .btn { height: 40px; min-width: 84px; padding: 0 14px; border-radius: 20px; border: none; background: var(--ground); color: var(--ink); font-size: 14px; font-weight: 800; cursor: pointer; }
  .btn.dark { background: var(--ink); color: var(--mpx-yellow); }
  .skill-run { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-width: 96px; background: var(--mpx-yellow); color: var(--ink); box-shadow: 0 2px 5px #1f252d1a; transition: transform 120ms ease, box-shadow 120ms ease; }
  .skill-run:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 8px #1f252d26; }
  .skill-run:active:not(:disabled) { transform: translateY(0); box-shadow: 0 1px 3px #1f252d1a; }
  .skill-run.running { background: var(--ink); color: var(--mpx-yellow); }
  .skill-run svg { flex-shrink: 0; }
  .btn:disabled, .link:disabled { opacity: 0.6; cursor: default; }
  .pin { height: 32px; min-width: 84px; border: none; border-radius: 16px; background: transparent; color: var(--sub); font-size: 13px; font-weight: 700; cursor: pointer; }
  .pin.on { background: var(--mpx-yellow); color: var(--ink); }
  .link { height: 32px; border: none; background: transparent; color: #9B2C20; font-size: 13px; font-weight: 700; cursor: pointer; padding: 0 6px; }
  button:focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; }

  .empty { background: var(--ground); border-radius: 20px; padding: 28px 20px; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; }
  .empty-title { font-size: 17px; font-weight: 800; }
  .empty-desc { font-size: 14px; line-height: 1.45; color: var(--sub); max-width: 300px; }
  .ghost { margin-top: 6px; height: 44px; padding: 0 18px; border-radius: 22px; border: none; background: var(--ink); color: #fff; font-size: 15px; font-weight: 700; cursor: pointer; }

  .sk { height: 80px; }
  .sk-ico { width: 52px; height: 52px; border-radius: 15px; background: var(--hair); }
  .sk-line { height: 14px; width: 50%; border-radius: 7px; background: var(--hair); }

  .toast {
    position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%);
    background: var(--ink); color: #fff; padding: 10px 16px; border-radius: 14px;
    font-size: 14px; font-weight: 600; box-shadow: var(--shadow-float); max-width: calc(100% - 40px);
  }
  .toast.err { background: #9B2C20; }
</style>
