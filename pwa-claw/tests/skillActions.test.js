import assert from "node:assert/strict";
import test from "node:test";
import {
  prettySkillName,
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
    { file: "/spin-fast.wasm" },
    { slug: "moonwalk", file: "/duplicate.wasm" },
    {},
  ]);
  assert.deepEqual(actions, [
    { id: "skill:moonwalk", label: "Moonwalk", emoji: "⚡", category: "skill", runName: "moonwalk" },
    { id: "skill:spin-fast.wasm", label: "Spin Fast", emoji: "⚡", category: "skill", runName: "spin-fast.wasm" },
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
      assert.equal(url, "/v1/fs/list?path=%2F");
      polls += 1;
      return {
        ok: true,
        json: async () => ({ f: polls < 2 ? [] : [{ n: "moonwalk.mpxe" }] }),
      };
    },
    attempts: 3,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(polls, 2);
});

test("skill runner reports missing or timed-out deployments", async () => {
  await assert.rejects(
    waitForSkillFiles(["/readme.txt"], { fetchImpl: async () => assert.fail("should not poll") }),
    /did not include a motion skill file/,
  );
  await assert.rejects(
    waitForSkillFiles(["/moonwalk.mpxe"], {
      fetchImpl: async () => ({ ok: true, json: async () => ({ f: [] }) }),
      attempts: 2,
      intervalMs: 0,
      sleep: async () => {},
    }),
    /install timed out/,
  );
});
