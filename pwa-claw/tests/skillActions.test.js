import assert from "node:assert/strict";
import test from "node:test";
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
  skillActionsFromInstalled,
  skillActionsFromRegistry,
  skillPathsFromScripts,
  skillRunNameFromPaths,
  waitForSkillFiles,
} from "../src/lib/skillActions.js";

test("registry entries become distinct runnable quick actions", () => {
  const actions = skillActionsFromRegistry([
    { slug: "moonwalk", file: "/moonwalk.wasm" },
    { slug: "broken", file: "/broken.mpxe", valid: false },
    { file: "/spin-fast.wasm" },
    { slug: "moonwalk", file: "/duplicate.wasm" },
    {},
  ]);
  assert.deepEqual(actions, [
    { id: "skill:moonwalk.wasm", label: "Moonwalk", emoji: "⚡", category: "skill", runName: "moonwalk.wasm" },
    { id: "skill:spin-fast.wasm", label: "Spin Fast", emoji: "⚡", category: "skill", runName: "spin-fast.wasm" },
    { id: "skill:duplicate.wasm", label: "Duplicate", emoji: "⚡", category: "skill", runName: "duplicate.wasm" },
  ]);
  assert.notEqual(skillActionId("paw"), "paw");
});

test("fresh deployments are pinnable before the next registry scan", () => {
  const actions = skillActionsFromInstalled(
    [{ slug: "paw", file: "/paw.mpxe" }],
    { first: ["/paw.mpxe"], second: ["/notes.txt", "/spin.wasm"] },
  );
  assert.deepEqual(actions.map((action) => action.runName), ["paw", "spin.wasm"]);
  assert.equal(actions[1].id, "skill:spin.wasm");
});

test("only documented Web and Move marketplace types are classified", () => {
  assert.equal(marketplaceSkillType({ skill_type: "awa" }), "awa");
  assert.equal(marketplaceSkillType({ skill_type: "WASM" }), "wasm");
  assert.equal(marketplaceSkillType({ skill_type: "lua" }), null);
  assert.equal(marketplaceSkillType({}), null);
});

test("registry names and display labels handle files and slugs", () => {
  assert.equal(registryRunName({ file: "/give_paw.wasm" }), "give_paw.wasm");
  assert.equal(registryRunName({ slug: "paw", file: "/give_paw.wasm" }), "paw");
  assert.equal(registryRunName({}), null);
  assert.equal(prettySkillName("give_paw.wasm"), "Give Paw");
});

test("quick actions start skills through the skill API", async () => {
  let request;
  const response = await runSkill("moonwalk", async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200 };
  });
  assert.equal(response.ok, true);
  assert.equal(request.url, "/v1/skills/run");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), { skill: "moonwalk" });
});

test("skill execution reports conflicts and other HTTP failures", async () => {
  await assert.rejects(
    runSkill("moonwalk", async () => ({ ok: false, status: 409 })),
    /Another skill is running/,
  );
  await assert.rejects(
    runSkill("moonwalk", async () => ({ ok: false, status: 500 })),
    /Couldn't start skill \(500\)/,
  );
  await assert.rejects(runSkill(null), /not installed/);
});

test("deployment paths support fs.write and legacy file_write", () => {
  const paths = skillPathsFromScripts([
    'fs.write("/moonwalk.mpxe", bytes)',
    "fs . write( '/spin.wasm', bytes )",
    'file_write("/moonwalk.mpxe", bytes)',
    'fs.write(dynamic_path, bytes)',
  ]);
  assert.deepEqual(paths, ["/moonwalk.mpxe", "/spin.wasm"]);
  assert.equal(skillRunNameFromPaths(["/notes.txt", "/spin.wasm"]), "spin.wasm");
  assert.equal(skillRunNameFromPaths([]), null);
});

test("skill runner waits for asynchronously deployed files", async () => {
  let polls = 0;
  await waitForSkillFiles(["/moonwalk.mpxe"], {
    fetchImpl: async (url) => {
      assert.equal(url, "/v1/skills/registry");
      polls += 1;
      return {
        ok: true,
        json: async () => ({ skills: polls < 2 ? [] : [{ file: "/moonwalk.mpxe" }] }),
      };
    },
    attempts: 3,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(polls, 2);
});

test("skill install rejects files that fail firmware authentication", async () => {
  await assert.rejects(
    waitForSkillFiles(["/wrong-robot.mpxe"], {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ skills: [{ file: "/wrong-robot.mpxe", valid: false, error: "encrypted skill failed authentication" }] }),
      }),
    }),
    /failed authentication/,
  );
});

test("skill runner reports missing or timed-out deployments", async () => {
  await assert.rejects(
    waitForSkillFiles(["/readme.txt"], { fetchImpl: async () => assert.fail("should not poll") }),
    /did not include a motion skill file/,
  );
  await assert.rejects(
    waitForSkillFiles(["/moonwalk.mpxe"], {
      fetchImpl: async () => ({ ok: true, json: async () => ({ skills: [] }) }),
      attempts: 2,
      intervalMs: 0,
      sleep: async () => {},
    }),
    /did not index the skill/,
  );
});

test("boot reconciliation keeps installed packages and drops stale browser state", () => {
  const deployed = {
    installed: ["moonwalk.mpxe", "/notes.txt", "/notes.txt"],
    deleted: ["/old.mpxe"],
    invalid: "not-a-path-list",
  };
  assert.deepEqual(
    reconcileDeployedSkills(deployed, [{ file: "/moonwalk.mpxe" }]),
    { installed: ["/moonwalk.mpxe", "/notes.txt"] },
  );
  assert.deepEqual(reconcileDeployedSkills(deployed, []), {});
  assert.deepEqual(normalizeDeployedSkills(null), {});
  assert.deepEqual(normalizeDeployedSkills({ bad: null, alsoBad: [null], good: ["spin.wasm"] }), {
    good: ["/spin.wasm"],
  });
});

test("Store packages match exact registry files instead of filename prefixes", () => {
  const registry = [
    { slug: "paw", file: "/paw.mpxe" },
    { slug: "other", file: "/paw-advanced.mpxe" },
  ];
  assert.equal(registryEntryForSkill(registry, "vendor~paw-advanced").file, "/paw-advanced.mpxe");
  assert.equal(registryEntryForSkill(registry, "vendor~renamed", ["paw.mpxe"]).slug, "paw");
  assert.equal(registryEntryForSkill(registry, "vendor~pa"), null);
  assert.equal(registryEntryForSkill([
    { slug: "same", file: "/one.mpxe" },
    { slug: "same", file: "/two.mpxe" },
  ], "vendor~same"), null);
});

test("Move install records paths, executes all steps, and waits for indexing", async () => {
  const events = [];
  const scripts = [
    'fs.write("/notes.txt", "x")',
    'fs.write("/moonwalk.mpxe", bytes)',
  ];
  const result = await installMotionSkill("vendor~moonwalk", {
    deploySkill: async () => ({ skills: [{ commands: scripts.map((script) => ({ script })) }] }),
    onPaths: (paths) => events.push(["paths", paths]),
    enqueueLua: async (script) => events.push(["enqueue", script]),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ skills: [{ file: "/moonwalk.mpxe" }] }),
    }),
    attempts: 1,
  });
  assert.deepEqual(result.paths, ["/notes.txt", "/moonwalk.mpxe"]);
  assert.deepEqual(events.map((event) => event[0]), ["paths", "enqueue", "enqueue"]);
});

test("Move install rejects payloads without a skill before queueing Lua", async () => {
  let queued = false;
  await assert.rejects(
    installMotionSkill("bad", {
      deploySkill: async () => ({ skills: [{ commands: [{ script: 'fs.write("/notes.txt", "x")' }] }] }),
      enqueueLua: async () => { queued = true; },
    }),
    /did not include a motion skill file/,
  );
  assert.equal(queued, false);
});

test("skill deletion checks every response and stops on the first failure", async () => {
  const deleted = [];
  await assert.rejects(
    deleteSkillFiles(["moonwalk.mpxe", "/notes.txt"], {
      fetchImpl: async (_url, options) => {
        const path = JSON.parse(options.body).path;
        deleted.push(path);
        return path === "/moonwalk.mpxe"
          ? { ok: false, status: 500, text: async () => "flash error" }
          : { ok: true };
      },
    }),
    /Couldn't delete \/moonwalk.mpxe \(500\): flash error/,
  );
  assert.deepEqual(deleted, ["/notes.txt", "/moonwalk.mpxe"]);
});

test("failed auxiliary deletion leaves the skill file for a complete retry", async () => {
  const deleted = [];
  await assert.rejects(
    deleteSkillFiles(["moonwalk.mpxe", "/notes.txt"], {
      fetchImpl: async (_url, options) => {
        const path = JSON.parse(options.body).path;
        deleted.push(path);
        return path === "/notes.txt"
          ? { ok: false, status: 500, text: async () => "flash error" }
          : { ok: true };
      },
    }),
    /Couldn't delete \/notes.txt/,
  );
  assert.deepEqual(deleted, ["/notes.txt"]);
});
