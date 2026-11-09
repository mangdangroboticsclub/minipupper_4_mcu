import assert from "node:assert/strict";
import test from "node:test";
import {
  recordSuccessfulConnection,
  shouldShowWelcome,
  WELCOME_AFTER_MS,
} from "../src/lib/welcomeGate.js";

function memoryStorage(initialValue = null) {
  const values = new Map(initialValue === null ? [] : [["mpx_last_successful_connection", initialValue]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("welcome is required before the first successful connection", () => {
  assert.equal(shouldShowWelcome(Date.now(), memoryStorage()), true);
});

test("recently connected browsers skip welcome", () => {
  const now = Date.now();
  const storage = memoryStorage(String(now - WELCOME_AFTER_MS + 1));
  assert.equal(shouldShowWelcome(now, storage), false);
});

test("welcome returns after a day without a successful connection", () => {
  const now = Date.now();
  const storage = memoryStorage(String(now - WELCOME_AFTER_MS));
  assert.equal(shouldShowWelcome(now, storage), true);
});

test("invalid or future timestamps fail safe to welcome", () => {
  const now = Date.now();
  for (const value of ["not-a-number", "0", String(now + 1)]) {
    assert.equal(shouldShowWelcome(now, memoryStorage(value)), true);
  }
});

test("only a successful robot response records the connection", () => {
  const now = Date.now();
  const storage = memoryStorage();
  recordSuccessfulConnection(now, storage);
  assert.equal(storage.getItem("mpx_last_successful_connection"), String(now));
  assert.equal(shouldShowWelcome(now, storage), false);
});

test("storage failures keep the app usable and show welcome", () => {
  const storage = {
    getItem() { throw new Error("storage blocked"); },
    setItem() { throw new Error("storage blocked"); },
  };
  assert.equal(shouldShowWelcome(Date.now(), storage), true);
  assert.doesNotThrow(() => recordSuccessfulConnection(Date.now(), storage));
});
