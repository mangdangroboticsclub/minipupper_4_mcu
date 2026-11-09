export function registryRunName(entry) {
  return entry?.slug || (entry?.file || "").replace(/^\//, "") || null;
}

export function skillActionId(runName) {
  return `skill:${runName}`;
}

/** Marketplace deploy scripts currently use fs.write; older ones used file_write. */
export function skillPathsFromScripts(scripts = []) {
  const paths = new Set();
  const pattern = /(?:fs\s*\.\s*write|file_write)\s*\(\s*["']([^"']+)["']/g;
  for (const script of scripts) {
    for (const match of (script || "").matchAll(pattern)) paths.add(match[1]);
  }
  return [...paths];
}

/** Lua deployment is queued, so wait until the files exist before starting one. */
export async function waitForSkillFiles(paths, {
  fetchImpl = globalThis.fetch,
  attempts = 120,
  intervalMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const wanted = paths
    .filter((path) => /\.(?:wasm|mpxe)$/i.test(path))
    .map((path) => path.replace(/^\/+/, ""));
  if (!wanted.length) throw new Error("Deployment did not include a motion skill file");

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl("/v1/fs/list?path=%2F", { cache: "no-store" });
      if (response.ok) {
        const listing = await response.json();
        const files = new Set((listing.f || []).map((file) => file.n));
        if (wanted.every((path) => files.has(path))) return;
      }
    } catch {
      // The deploy worker can briefly compete with HTTP; retry until the deadline.
    }
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  throw new Error("Skill install timed out. Check Files, then try Run again.");
}

export function prettySkillName(slug) {
  return (slug || "")
    .replace(/\.(wasm|mpxe)$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/(^|\s)\w/g, (c) => c.toUpperCase());
}

/** Installed motion skills use distinct ids so they cannot collide with gaits. */
export function skillActionsFromRegistry(entries = []) {
  const seen = new Set();
  const actions = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const runName = registryRunName(entry);
    if (!runName || seen.has(runName)) continue;
    seen.add(runName);
    actions.push({
      id: skillActionId(runName),
      label: prettySkillName(runName),
      emoji: "⚡",
      category: "skill",
      runName,
    });
  }
  return actions;
}

/** Include fresh Lua deployments even before the firmware's next registry scan. */
export function skillActionsFromInstalled(entries = [], deployed = {}) {
  const actions = skillActionsFromRegistry(entries);
  const ids = new Set(actions.map((action) => action.id));
  const registryFiles = new Set(entries.map((entry) => (entry?.file || "").replace(/^\/+/, "")));
  for (const paths of Object.values(deployed || {})) {
    const runName = skillRunNameFromPaths(paths);
    const id = runName ? skillActionId(runName) : null;
    if (!runName || registryFiles.has(runName) || ids.has(id)) continue;
    ids.add(id);
    actions.push({ id, label: prettySkillName(runName), emoji: "⚡", category: "skill", runName });
  }
  return actions;
}

export async function runSkill(runName, fetchImpl = globalThis.fetch) {
  if (!runName) throw new Error("Skill is not installed on the robot");
  const response = await fetchImpl("/v1/skills/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skill: runName }),
  });
  if (!response.ok) {
    throw new Error(response.status === 409
      ? "Another skill is running. Stop it first."
      : `Couldn't start skill (${response.status})`);
  }
  return response;
}

export function skillRunNameFromPaths(paths = []) {
  const path = paths.find((candidate) => /\.(?:wasm|mpxe)$/i.test(candidate));
  return path ? path.replace(/^\/+/, "") : null;
}
