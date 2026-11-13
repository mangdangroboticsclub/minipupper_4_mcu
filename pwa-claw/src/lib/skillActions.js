export function marketplaceSkillType(skill) {
  const type = String(skill?.skill_type || "").toLowerCase();
  return type === "wasm" || type === "awa" ? type : null;
}

export function registryRunName(entry, entries = null) {
  if (!entry) return null;
  const duplicates = entries?.filter((candidate) => candidate?.valid !== false && candidate?.slug === entry.slug) || [];
  if (entry.slug && (!entries || duplicates.length === 1)) return entry.slug;
  return (entry.file || "").replace(/^\//, "") || null;
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

export function normalizeSkillPath(path) {
  const value = String(path || "").trim();
  return value && !value.startsWith("/") ? `/${value}` : value;
}

function skillStem(path) {
  const name = normalizeSkillPath(path).split("/").pop() || "";
  return name.replace(/\.(?:wasm|mpxe)$/i, "");
}

/** Match a Store package to its exact installed file, not a prefix of it. */
export function registryEntryForSkill(entries, skillId, deployedPaths = []) {
  for (const path of deployedPaths || []) {
    const normalized = normalizeSkillPath(path);
    const match = (entries || []).find((entry) => normalizeSkillPath(entry?.file) === normalized);
    if (match) return match;
  }
  const tail = String(skillId || "").split("~").pop();
  const matches = (entries || []).filter((entry) => entry?.slug === tail || skillStem(entry?.file) === tail);
  return matches.length === 1 ? matches[0] : null;
}

export function normalizeDeployedSkills(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([skillId, paths]) => {
      if (!Array.isArray(paths)) return [];
      const clean = [...new Set(paths.filter((path) => typeof path === "string").map(normalizeSkillPath).filter(Boolean))];
      return clean.length ? [[skillId, clean]] : [];
    }),
  );
}

/** The registry, not browser storage, decides whether a package is installed. */
export function reconcileDeployedSkills(deployed, entries) {
  const installed = new Set((entries || []).map((entry) => normalizeSkillPath(entry?.file)));
  return Object.fromEntries(
    Object.entries(normalizeDeployedSkills(deployed)).flatMap(([skillId, paths]) => {
      const hasSkill = paths.some((path) => /\.(?:wasm|mpxe)$/i.test(path) && installed.has(path));
      return hasSkill ? [[skillId, paths]] : [];
    }),
  );
}

/** Lua deployment is queued, so wait until the firmware indexes every skill file. */
export async function waitForSkillFiles(paths, {
  fetchImpl = globalThis.fetch,
  attempts = 120,
  intervalMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const wanted = paths
    .filter((path) => /\.(?:wasm|mpxe)$/i.test(path))
    .map((path) => normalizeSkillPath(path));
  if (!wanted.length) throw new Error("Deployment did not include a motion skill file");

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let listing = null;
    try {
      const response = await fetchImpl("/v1/skills/registry", { cache: "no-store" });
      if (response.ok) listing = await response.json();
    } catch {
      // The deploy worker can briefly compete with HTTP; retry until the deadline.
    }
    if (listing) {
      const entries = listing.skills || [];
      const indexed = wanted.map((path) => entries.find((entry) => normalizeSkillPath(entry.file) === path));
      const invalid = indexed.find((entry) => entry?.valid === false);
      if (invalid) throw new Error(invalid.error || "The skill failed its integrity check");
      if (indexed.every(Boolean)) return;
    }
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  throw new Error("The robot did not index the skill. Check Skills or Files, then try again.");
}

/** Download and execute every deployment step, then verify the robot index. */
export async function installMotionSkill(skillId, { deploySkill, enqueueLua, onPaths, ...waitOptions } = {}) {
  const data = await deploySkill(skillId);
  const scripts = (data.skills || []).flatMap((entry) =>
    (entry.commands || []).map((command) => command.script).filter(Boolean),
  );
  const paths = [...new Set(skillPathsFromScripts(scripts))];
  if (!skillRunNameFromPaths(paths)) throw new Error("Deployment did not include a motion skill file");
  await onPaths?.(paths);
  for (const script of scripts) await enqueueLua(script);
  await waitForSkillFiles(paths, waitOptions);
  return { paths, scripts };
}

/** Delete all known package files and preserve state if any delete fails. */
export async function deleteSkillFiles(paths, { fetchImpl = globalThis.fetch } = {}) {
  // Keep the runnable file until every auxiliary delete succeeds. Otherwise
  // registry reconciliation could forget the package and orphan its leftovers.
  const ordered = [...new Set((paths || []).map(normalizeSkillPath).filter(Boolean))]
    .sort((a, b) => Number(/\.(?:wasm|mpxe)$/i.test(a)) - Number(/\.(?:wasm|mpxe)$/i.test(b)));
  for (const path of ordered) {
    const response = await fetchImpl("/v1/fs/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, sudo: true }),
    });
    if (!response.ok) {
      const detail = response.text ? (await response.text()).trim() : "";
      throw new Error(`Couldn't delete ${path} (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ""}`);
    }
  }
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
    const runName = registryRunName(entry, entries);
    if (entry.valid === false || !runName || seen.has(runName)) continue;
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
