import assert from "node:assert/strict";
import test from "node:test";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

globalThis.localStorage = memoryStorage();
const store = await import("../src/lib/conversationStore.js");

test("live voice turn creates a local robot-sourced conversation without selecting it", () => {
  localStorage.clear?.();
  store.clearAllConversations();
  const convo = store.appendVoiceTurn({
    conversation_id: "voice-1234abcd", role: "user", text: "sit down", ts: 1000,
  });
  assert.equal(convo.brain, "local");
  assert.equal(convo.source, "voice");
  assert.equal(convo.unread, 1);
  assert.equal(store.listConversations()[0].messages[0].text, "sit down");
});

test("voice turn dedupes live reconnect and matching local-agent reply", () => {
  store.clearAllConversations();
  const frame = { conversation_id: "voice-1234abcd", role: "assistant", text: "Sitting", ts: 2000, spoken: true };
  store.appendVoiceTurn(frame);
  store.appendVoiceTurn(frame);
  store.appendVoiceTurn({ ...frame, ts: 2001 });
  assert.equal(store.getConversation("voice-1234abcd").messages.length, 1);
  assert.equal(store.getConversation("voice-1234abcd").messages[0].role, "bot");
});

test("generic reply then voice_turn and history keeps one authoritative answer", () => {
  store.clearAllConversations();
  store.saveConversation("voice-1234abcd", {
    brain: "local", source: "voice",
    messages: [{ role: "bot", text: "Sitting", ts: 0 }],
  });
  store.appendVoiceTurn({
    conversation_id: "voice-1234abcd", role: "assistant", text: "Sitting", ts: 2000, spoken: true,
  });
  let convo = store.getConversation("voice-1234abcd");
  assert.equal(convo.messages.length, 1);
  assert.equal(convo.messages[0].ts, 2000);
  assert.equal(convo.messages[0].spoken, true);
  store.importVoiceHistory({ conversations: [{
    id: "voice-1234abcd",
    messages: [{ role: "assistant", text: "Sitting", ts: 2000, spoken: true }],
  }] });
  convo = store.getConversation("voice-1234abcd");
  assert.equal(convo.messages.length, 1);
});

test("persisting a voice conversation keeps its source and timestamps", () => {
  store.clearAllConversations();
  store.appendVoiceTurn({
    conversation_id: "voice-5678abcd", role: "user", text: "hello", ts: 1000,
  });
  // ChatView's persist() passes only messages+brain; source must survive that.
  store.saveConversation("voice-5678abcd", {
    brain: "local",
    messages: [{ role: "user", text: "hello", ts: 1000 }],
  });
  const convo = store.getConversation("voice-5678abcd");
  assert.equal(convo.source, "voice");
  assert.equal(convo.createdAt > 0, true);
  assert.deepEqual(store.listConversations().filter((c) => c.source === "voice").map((c) => c.id),
    ["voice-5678abcd"]);
});

test("history merge preserves typed messages and archived state", () => {
  store.clearAllConversations();
  store.saveConversation("voice-1234abcd", {
    brain: "local", source: "voice", archived: true,
    messages: [{ role: "user", text: "typed follow-up", ts: 1500 }],
  });
  const count = store.importVoiceHistory({ conversations: [{
    id: "voice-1234abcd", title: "sit down", updatedAt: 3000,
    messages: [
      { role: "user", text: "sit down", ts: 1000 },
      { role: "assistant", text: "Sitting", ts: 2000, spoken: true },
    ],
  }] });
  const convo = store.getConversation("voice-1234abcd");
  assert.equal(count, 1);
  assert.equal(convo.archived, true);
  assert.deepEqual(convo.messages.map((m) => m.text), ["sit down", "typed follow-up", "Sitting"]);
  store.importVoiceHistory({ conversations: [{
    id: "voice-1234abcd", messages: [
      { role: "user", text: "sit down", ts: 1000 },
      { role: "assistant", text: "Sitting", ts: 2000, spoken: true },
    ],
  }] });
  assert.equal(convo.messages.length, 3);
});

test("clearing voice context empties turns but keeps the robot-owned session", () => {
  store.clearAllConversations();
  store.appendVoiceTurn({
    conversation_id: "voice-1234abcd", role: "user", text: "goodbye", ts: 1000,
  });
  const cleared = store.clearConversationMessages("voice-1234abcd");
  assert.deepEqual(cleared.messages, []);
  assert.equal(cleared.source, "voice");
  assert.equal(cleared.brain, "local");
  assert.equal(cleared.title, "Voice chat");
  assert.equal(store.getConversation("voice-1234abcd").unread, 0);
});

test("active voice conversation is read; archive is reversible", () => {
  store.clearAllConversations();
  const convo = store.appendVoiceTurn({
    conversation_id: "voice-1234abcd", role: "user", text: "wave", ts: 1000,
  }, { activeId: "voice-1234abcd" });
  assert.equal(convo.unread, 0);
  store.setConversationArchived(convo.id, true);
  assert.equal(store.getConversation(convo.id).archived, true);
  store.setConversationArchived(convo.id, false);
  store.markConversationRead(convo.id);
  assert.equal(store.getConversation(convo.id).archived, false);
  assert.equal(store.getConversation(convo.id).unread, 0);
});
