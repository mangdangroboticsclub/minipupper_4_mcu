import test from "node:test";
import assert from "node:assert/strict";
import { PS4_DEADZONE, ps4PoseAngles, ps4PowerSucceeded, ps4TurnRate } from "../src/lib/ps4Control.js";

test("PS4 power accepts the firmware wake/hold response schema", () => {
  assert.equal(ps4PowerSucceeded({ ok: true, resting: false, holding: false, state: "awake" }, "wake"), true);
  assert.equal(ps4PowerSucceeded({ ok: true, resting: false, holding: true, state: "holding" }, "hold"), true);
  assert.equal(ps4PowerSucceeded({ ok: true, resting: false, holding: false }, "hold"), false);
  assert.equal(ps4PowerSucceeded({ ok: true, resting: false, holding: true }, "wake"), false);
  assert.equal(ps4PowerSucceeded({ ok: true, resting: true, holding: false }, "wake"), false);
  assert.equal(ps4PowerSucceeded({ ok: false, resting: false, holding: false }, "wake"), false);
});

test("PS4 turn stick respects deadzone and turns in the stick direction", () => {
  assert.equal(ps4TurnRate(0), 0);
  assert.equal(ps4TurnRate(PS4_DEADZONE - 0.01), 0);
  assert.ok(ps4TurnRate(-1) > 0, "left stick deflection produces firmware-left yaw");
  assert.ok(ps4TurnRate(1) < 0, "right stick deflection produces firmware-right yaw");
  assert.equal(ps4TurnRate(-1), -ps4TurnRate(1));
});

test("PS4 turn rate stays above the firmware motion threshold", () => {
  assert.ok(Math.abs(ps4TurnRate(PS4_DEADZONE + 0.01)) >= 0.1);
  assert.equal(Math.abs(ps4TurnRate(1)), 1);
});

test("PS4 Pose maps right to positive yaw and up to positive pitch", () => {
  assert.deepEqual(ps4PoseAngles(0, 0), { yaw: 0, pitch: 0 });
  assert.deepEqual(ps4PoseAngles(1, 0), { yaw: 30, pitch: 0 });
  assert.deepEqual(ps4PoseAngles(0, -1), { yaw: 0, pitch: 20 });
  assert.deepEqual(ps4PoseAngles(-1, 1), { yaw: -21, pitch: -14 });
});

test("PS4 Pose has a radial deadzone without reversing small inputs", () => {
  assert.deepEqual(ps4PoseAngles(0.1, 0.1), { yaw: 0, pitch: 0 });
  for (let a = PS4_DEADZONE; a <= 1; a += 0.01) {
    assert.ok(ps4PoseAngles(a, 0).yaw >= 0);
  }
});
