/**
 * Conversation Store — persists chat conversations in localStorage.
 *
 * Data model per conversation:
 * {
 *   id: string,          // UUID (same as sessionId)
 *   title: string,       // derived from first user message
 *   brain: string,       // "cloud" | "local" -- who answers, fixed for the
 *                        // conversation's life (see BRAINS below)
 *   createdAt: number,   // Date.now()
 *   updatedAt: number,   // Date.now() or the robot's last turn timestamp
 *   source?: "voice",   // robot-owned transcript, imported into this cache
 *   archived?: boolean,
 *   unread?: number,
 *   messages: [          // serialisable message objects
 *     { role, text, status?, history?, commands?, ts? }
 *   ]
 * }
 */

const STORAGE_KEY = "mpx_chat_conversations";
const BRAIN_KEY = "mpx_chat_brain";

/**
 * The two brains a conversation can talk to. "cloud" is the OpenClaw
 * ingress the robot relays to (the only brain before Phase 5); "local" is
 * ESP-Claw's agent running on the robot itself. The choice is made when a
 * conversation starts and the robot keeps the two sessions apart by the
 * conversation id, so a conversation never changes brain -- its history
 * lives on one side only.
 */
export const BRAINS = Object.freeze({ CLOUD: "cloud", LOCAL: "local" });
// New conversations go to the robot's own agent unless the user picks
// Cloud: that is what mpv2-claw's chat does (it has no cloud brain).
// Stored conversations without a brain are still cloud (normalizeBrain).
export const DEFAULT_BRAIN = BRAINS.LOCAL;

export function normalizeBrain(brain) {
  return brain === BRAINS.LOCAL ? BRAINS.LOCAL : BRAINS.CLOUD;
}

/** The brain the next new conversation will use (remembered on this device). */
export function getPreferredBrain() {
  try {
    const stored = localStorage.getItem(BRAIN_KEY);
    return stored ? normalizeBrain(stored) : DEFAULT_BRAIN;
  } catch {
    return DEFAULT_BRAIN;
  }
}

export function setPreferredBrain(brain) {
  try {
    localStorage.setItem(BRAIN_KEY, normalizeBrain(brain));
  } catch (e) {
    console.warn("conversationStore: unable to remember the brain", e);
  }
}

// ── UUID (matches Chat.svelte) ─────────────────────────────────
function generateUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );
}

// ── Internal helpers ───────────────────────────────────────────

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeAll(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("conversationStore: unable to write to localStorage", e);
  }
}

/** Generate a short title from message text, falling back to a placeholder. */
function inferTitle(messages) {
  const firstUser = messages.find((m) => m.role === "user");
  if (firstUser) {
    const raw = firstUser.text.trim();
    // Take the first line or first 48 chars, whichever is shorter
    const newlineIdx = raw.indexOf("\n");
    const short = newlineIdx === -1 ? raw : raw.slice(0, newlineIdx);
    return short.length > 48 ? short.slice(0, 45) + "…" : short;
  }
  return "New Conversation";
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Return every saved conversation, newest first.
 */
export function listConversations() {
  const all = readAll();
  return Object.values(all).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Get a single conversation by id.
 */
export function getConversation(id) {
  const all = readAll();
  return all[id] || null;
}

/**
 * Persist (create or update) a conversation.
 */
export function saveConversation(id, {
  messages, title, brain, source, createdAt, updatedAt, archived, unread,
}) {
  const all = readAll();
  const existing = all[id];
  const now = Date.now();

  all[id] = {
    id,
    title: title ?? (messages ? inferTitle(messages) : existing?.title ?? "New Conversation"),
    // Conversations saved before the brain existed were all cloud ones.
    brain: normalizeBrain(brain ?? existing?.brain),
    source: source ?? existing?.source,
    createdAt: createdAt ?? existing?.createdAt ?? now,
    updatedAt: updatedAt ?? now,
    archived: archived ?? existing?.archived ?? false,
    unread: unread ?? existing?.unread ?? 0,
    messages: messages ?? existing?.messages ?? [],
  };

  writeAll(all);
  return all[id];
}

/** Remove displayed turns after the robot has cleared the same session. */
export function clearConversationMessages(id) {
  const all = readAll();
  const existing = all[id];
  if (!existing) return null;
  all[id] = {
    ...existing,
    title: existing.source === "voice" ? "Voice chat" : "New Conversation",
    messages: [],
    unread: 0,
    updatedAt: Date.now(),
  };
  writeAll(all);
  return all[id];
}

/**
 * Remove a conversation by id.
 */
export function deleteConversation(id) {
  const all = readAll();
  delete all[id];
  writeAll(all);
}

/**
 * Delete all conversations.
 */
export function clearAllConversations() {
  writeAll({});
}

/**
 * Return a JSON string of all conversations (for export).
 */
export function exportConversations() {
  return JSON.stringify(readAll(), null, 2);
}

/**
 * Merge imported conversations into the store.
 * Returns the number of conversations imported.
 * Optionally pass `onConflict: "skip" | "overwrite"` (default: "overwrite").
 */
export function importConversations(jsonStr, { onConflict = "overwrite" } = {}) {
  let imported;
  try {
    imported = JSON.parse(jsonStr);
  } catch {
    throw new Error("Invalid JSON");
  }
  if (typeof imported !== "object" || imported === null || Array.isArray(imported)) {
    throw new Error("Expected an object mapping session IDs to conversations");
  }

  const all = readAll();
  let count = 0;

  for (const [id, convo] of Object.entries(imported)) {
    if (!convo || typeof convo !== "object") continue;
    if (!convo.messages || !Array.isArray(convo.messages)) continue;

    if (onConflict === "skip" && all[id]) continue;

    all[id] = {
      id,
      title: convo.title || inferTitle(convo.messages),
      brain: normalizeBrain(convo.brain),
      createdAt: convo.createdAt ?? Date.now(),
      updatedAt: convo.updatedAt ?? Date.now(),
      messages: convo.messages,
    };
    count++;
  }

  writeAll(all);
  return count;
}

function voiceMessage(message) {
  if (!message || typeof message.text !== "string") return null;
  const role = message.role === "assistant" ? "bot" : message.role;
  if (role !== "user" && role !== "bot" && role !== "step") return null;
  return {
    role,
    text: message.text,
    ts: Number(message.ts) || 0,
    ...(message.spoken === undefined ? {} : { spoken: message.spoken }),
  };
}

function sameTurn(a, b) {
  return a && b && a.role === b.role && a.text === b.text &&
    !!a.ts && !!b.ts && a.ts === b.ts;
}

/** Append one robot-originated live voice turn without selecting its chat. */
export function appendVoiceTurn(frame, { activeId = null } = {}) {
  if (!frame || !/^voice-[0-9a-f]{8}$/.test(frame.conversation_id || "")) return null;
  const message = voiceMessage({ ...frame, role: frame.role });
  if (!message || (message.role !== "user" && message.role !== "bot")) return null;
  const id = frame.conversation_id;
  const all = readAll();
  const existing = all[id];
  const oldMessages = existing?.messages || [];
  const last = oldMessages[oldMessages.length - 1];
  // Compatibility with frames from older firmware: merge the authoritative
  // robot timestamp/spoken flag instead of dropping or duplicating the reply.
  const exact = oldMessages.findIndex((m) => sameTurn(m, message));
  const adjacent = last && last.role === message.role && last.text === message.text
    ? oldMessages.length - 1 : -1;
  const duplicate = exact >= 0 ? exact : adjacent;
  if (duplicate >= 0) {
    const messages = [...oldMessages];
    messages[duplicate] = {
      ...messages[duplicate], ...message,
      ts: message.ts || messages[duplicate].ts,
    };
    all[id] = { ...existing, messages };
    writeAll(all);
    return all[id];
  }
  const now = Date.now();
  const messages = [...oldMessages, message];
  const unread = id === activeId ? 0 : (existing?.unread || 0) + 1;
  all[id] = {
    id,
    title: existing?.title || inferTitle(messages),
    brain: BRAINS.LOCAL,
    source: "voice",
    createdAt: existing?.createdAt || message.ts || now,
    updatedAt: message.ts || now,
    archived: existing?.archived || false,
    unread,
    messages,
  };
  writeAll(all);
  return all[id];
}

/** Merge robot-owned history into the browser cache. Robot timestamps and ids
 * are retained; typed messages in the same voice session are not discarded. */
export function importVoiceHistory(payload) {
  if (!payload || !Array.isArray(payload.conversations)) return 0;
  const all = readAll();
  let count = 0;
  for (const remote of payload.conversations) {
    if (!remote || !/^voice-[0-9a-f]{8}$/.test(remote.id || "") ||
        !Array.isArray(remote.messages)) continue;
    const existing = all[remote.id];
    const messages = [...(existing?.messages || [])];
    for (const raw of remote.messages) {
      const message = voiceMessage(raw);
      if (!message) continue;
      const last = messages[messages.length - 1];
      const exact = messages.findIndex((m) => sameTurn(m, message));
      const adjacent = last && last.role === message.role && last.text === message.text
        ? messages.length - 1 : -1;
      const duplicate = exact >= 0 ? exact : adjacent;
      if (duplicate >= 0) {
        messages[duplicate] = {
          ...messages[duplicate], ...message,
          ts: message.ts || messages[duplicate].ts,
        };
      } else {
        messages.push(message);
      }
    }
    messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const updatedAt = Math.max(existing?.updatedAt || 0, Number(remote.updatedAt) || 0) || Date.now();
    all[remote.id] = {
      id: remote.id,
      title: remote.title || existing?.title || inferTitle(messages),
      brain: BRAINS.LOCAL,
      source: "voice",
      createdAt: existing?.createdAt || Number(remote.createdAt) || Number(messages[0]?.ts) || Date.now(),
      updatedAt,
      archived: existing?.archived || false,
      unread: existing?.unread || 0,
      messages,
    };
    count++;
  }
  writeAll(all);
  return count;
}

export function setConversationArchived(id, archived) {
  const all = readAll();
  if (!all[id]) return null;
  all[id] = { ...all[id], archived: !!archived };
  writeAll(all);
  return all[id];
}

export function markConversationRead(id) {
  const all = readAll();
  if (!all[id]) return;
  all[id] = { ...all[id], unread: 0 };
  writeAll(all);
}

export { generateUUID };
