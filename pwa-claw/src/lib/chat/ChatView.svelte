<script module>
  /* Shared by every ChatView ever mounted: a view that is torn down and
     mounted again quickly must not open a new socket each time. */
  let lastConnectAt = 0;
  const CONNECT_MIN_GAP_MS = 3000;
</script>

<script>
  import { onMount } from "svelte";
  import { marked } from "marked";
  import ChatSidebar from "./ChatSidebar.svelte";
  import ChatMessage from "./ChatMessage.svelte";
  import AgentActivity from "./AgentActivity.svelte";
  import EmptyChat from "./EmptyChat.svelte";
  import VoicePanel from "./VoicePanel.svelte";
  import {
    saveConversation,
    getConversation,
    listConversations,
    generateUUID,
    BRAINS,
    normalizeBrain,
    getPreferredBrain,
    setPreferredBrain,
    appendVoiceTurn,
    importVoiceHistory,
    markConversationRead,
    clearConversationMessages,
  } from "../conversationStore.js";

  /**
   * @prop navigate — (view) => void
   * @prop network  — robot link snapshot from app.svelte ({ online, linkState, … })
   */
  let { navigate, network = null } = $props();

  // ── UUID helper (matches original) ─────────
  function makeUUID() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
    );
  }

  // ── Session ID persistence ─────────────────
  const SESSION_STORAGE_KEY = "mpx_active_session_id";

  function restoreSessionId() {
    try {
      const saved = localStorage.getItem(SESSION_STORAGE_KEY);
      if (saved) return saved;
    } catch {}
    return makeUUID();
  }

  // ── State ──────────────────────────────────
  let ws = null;
  let reconnectTimer = null;   // single-flight reconnect guard (prevents socket storms)
  let connected = $state(false);
  let sending = $state(false);
  let sessionId = $state(restoreSessionId());
  let messages = $state([]);
  let inputText = $state("");
  let showSidebar = $state(false);
  let sidebarRefreshKey = $state(0);
  let sessionAckBadge = $state(false);
  let scrollAnchor = $state(null);
  let inputEl = $state(null);
  let pendingActions = $state([]);
  let conversationArchived = $state(false);
  let voiceState = $state({ state: "idle", id: null });
  let voiceWakeBusy = $state(false);
  let voiceWakeError = $state("");
  let voiceWakeRequested = $state(false);
  let showVoicePanel = $state(false);
  let voicePanelId = $state(null);
  let voicePanelConversation = $derived.by(() => {
    sidebarRefreshKey;
    return voicePanelId ? getConversation(voicePanelId) : null;
  });
  let voicePanelState = $derived(
    voiceState.id && voiceState.id === voicePanelId ? voiceState.state : "idle",
  );
  let voiceWakeMode = $derived(
    messages.length === 0 && !inputText.trim() && !sending && !conversationArchived,
  );

  /* Surface only the newest robot-owned voice transcript beside the composer.
   * Older conversations remain in History; a row of chips made the chat header
   * busy without showing enough of the conversation to be useful. */
  let latestVoice = $derived.by(() => {
    sidebarRefreshKey;  /* the store is not reactive; this is the tick */
    return listConversations().find((c) => c.source === "voice") || null;
  });
  let latestVoiceLive = $derived(
    voiceState.state !== "idle" &&
      (!latestVoice || !voiceState.id || voiceState.id === latestVoice.id),
  );

  function voiceTitle(convo) {
    const first = (convo.messages || []).find((m) => m.role === "user");
    return (first?.text || convo.title || "Voice chat").trim();
  }

  function voiceWhen(convo) {
    const ts = convo.updatedAt || convo.createdAt;
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  // ── Brain: who answers this conversation ───
  // "cloud" (OpenClaw, relayed by the robot) or "local" (ESP-Claw's agent
  // on the robot). Chosen before the first message and fixed from then on:
  // the robot keeps the two histories apart by conversation id, so a
  // conversation switching sides would lose its own past. The toggle in
  // the action bar is therefore live only while the conversation is empty;
  // a new conversation starts with the last choice made on this device.
  let brain = $state(getPreferredBrain());
  let brainLocked = $derived(messages.length > 0);
  // What the robot offers: fetched from /v1/ai. Until it answers, both are
  // shown; a robot without the agent greys out "Local".
  let localBrainAvailable = $state(true);
  let localBrainReason = $state("");

  function setBrain(next) {
    if (brainLocked) return;
    const b = normalizeBrain(next);
    if (b === BRAINS.LOCAL && !localBrainAvailable) return;
    brain = b;
    setPreferredBrain(b);
    // The robot starts a session on the chosen side for the empty
    // conversation, so the first message lands where expected.
    sendSessionReset(sessionId);
  }

  function brainLabel(b) {
    return b === BRAINS.LOCAL ? "Pupper" : "Cloud";
  }

  async function probeLocalBrain() {
    try {
      const res = await fetch("/v1/ai", { cache: "no-store" });
      if (!res.ok) return;
      const d = await res.json();
      const agent = d.agent || {};
      if (agent.available === false) {
        localBrainAvailable = false;
        localBrainReason = "This robot's firmware has no on-device agent.";
      } else if (agent.running === false) {
        localBrainAvailable = false;
        localBrainReason = "The robot's agent did not start — see its log.";
      } else if (d.mode === "off") {
        localBrainAvailable = false;
        localBrainReason = "AI is off on this robot (Settings › AI & Voice).";
      } else {
        localBrainAvailable = true;
        localBrainReason = "";
      }
      if (!localBrainAvailable && brain === BRAINS.LOCAL && !brainLocked) {
        brain = BRAINS.CLOUD;
      }
    } catch {
      // Offline or an older firmware without /v1/ai: leave both offered;
      // the robot answers a local message it cannot take with an error.
    }
  }

  /** Tell the robot which conversation (and brain) this socket is on. */
  function sendSessionReset(id, extra = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: "session_reset",
      session_id: id,
      brain,
      ts: Math.floor(Date.now() / 1000),
      ...extra,
    }));
  }

  // ── Render model: group consecutive `step` messages into one activity block ──
  let renderItems = $derived.by(() => {
    const items = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === "step") {
        const prev = items[items.length - 1];
        if (prev && prev.kind === "activity") {
          prev.steps.push(m);
          prev.endIndex = i;
        } else {
          items.push({ kind: "activity", steps: [m], startIndex: i, endIndex: i, firstMsg: m });
        }
      } else {
        items.push({ kind: "msg", msg: m, index: i });
      }
    }
    return items;
  });

  // Live timer for response counter
  let now = $state(Date.now());
  let lastSentTs = $state(null);
  $effect(() => {
    const id = setInterval(() => { now = Date.now(); }, 200);
    return () => clearInterval(id);
  });

  // Accumulator for chunked chat_reply reassembly
  let pendingChunks = {};

  // ── Markdown ───────────────────────────────
  const renderer = new marked.Renderer();
  renderer.link = ({ href, text }) =>
    `<a href="${href}" target="_blank" rel="noopener noreferrer" class="msg-link">${text}</a>`;
  marked.setOptions({ renderer, breaks: true, gfm: true });

  function renderMarkdown(text) {
    if (!text) return "";
    const raw = marked.parse(text, { async: false });
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/\son\w+\s*=\s*["']?[^"'\s>]+["']?/gi, "");
  }

  // ── Timestamp helpers ─────────────────────
  function normalizeTs(ts) { return ts < 100000000000 ? ts * 1000 : ts; }

  function formatTimestamp(ts) {
    if (!ts) return "";
    const d = new Date(normalizeTs(ts));
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function getMsgTs(msg) {
    if (msg.ts) return msg.ts;
    if (msg.history && msg.history.length > 0) return msg.history[0].ts;
    return null;
  }

  function isNewDay(a, b) {
    const tsA = getMsgTs(a);
    const tsB = getMsgTs(b);
    if (!tsA || !tsB) return false;
    const dA = new Date(normalizeTs(tsA));
    const dB = new Date(normalizeTs(tsB));
    return dA.getDate() !== dB.getDate() || dA.getMonth() !== dB.getMonth() || dA.getFullYear() !== dB.getFullYear();
  }

  function findPrevTimestampMsg(msgs, fromIdx) {
    for (let i = fromIdx; i >= 0; i--) {
      if (getMsgTs(msgs[i])) return msgs[i];
    }
    return msgs[fromIdx];
  }

  function formatDateLabel(msg) {
    const ts = getMsgTs(msg);
    if (!ts) return "";
    const d = new Date(normalizeTs(ts));
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dateDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((today - dateDay) / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      return days[d.getDay()];
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }

  // ── Auto-save ──────────────────────────────
  let debounceTimer;
  function persist() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (messages.length > 0) {
        saveConversation(sessionId, { messages, brain });
        sidebarRefreshKey++;
      }
    }, 500);
  }

  $effect(() => {
    const msgs = messages;
    if (msgs.length > 0) persist();
  });

  $effect(() => {
    try { localStorage.setItem(SESSION_STORAGE_KEY, sessionId); } catch {}
  });

  // ── Conversation actions ──────────────────
  function openVoicePanel(id = null) {
    voicePanelId = id || (voiceState.id?.startsWith("voice-") ? voiceState.id : latestVoice?.id || null);
    voiceWakeError = "";
    showVoicePanel = true;
  }

  function selectConversation(id) {
    const convo = getConversation(id);
    if (!convo) return;
    if (messages.length > 0) saveConversation(sessionId, { messages, brain });
    sidebarRefreshKey++;
    sessionId = convo.id;
    messages = convo.messages || [];
    // The conversation's own brain, whatever the toggle said last.
    brain = normalizeBrain(convo.brain);
    conversationArchived = !!convo.archived;
    markConversationRead(convo.id);
    voiceWakeError = "";
    voiceWakeRequested = false;
    sending = false;
    if (convo.source === "voice") openVoicePanel(convo.id);
    if (window.innerWidth < 768) showSidebar = false;
    sendSessionReset(sessionId);
  }

  /** An empty conversation on the brain the user last chose. */
  function startFresh(id = makeUUID(), nextBrain = getPreferredBrain()) {
    sessionId = id;
    messages = [];
    conversationArchived = false;
    voiceWakeError = "";
    voiceWakeRequested = false;
    sending = false;
    brain = nextBrain;
    if (brain === BRAINS.LOCAL && !localBrainAvailable) brain = BRAINS.CLOUD;
    sendSessionReset(sessionId);
  }

  async function newConversation() {
    if (messages.length > 0) saveConversation(sessionId, { messages, brain });
    sidebarRefreshKey++;
    if (brain === BRAINS.LOCAL) {
      try {
        const res = await fetch("/v1/voice/history/new", { method: "POST" });
        if (!res.ok) throw new Error("new voice conversation failed");
        const data = await res.json();
        startFresh(data.id, BRAINS.LOCAL);
      } catch {
        // MCP-only firmware or unavailable voice still supports local text.
        startFresh(undefined, BRAINS.LOCAL);
      }
    } else {
      startFresh(undefined, brain);
    }
    inputEl?.focus();
  }

  function handleDelete(id) {
    if (id === sessionId) startFresh();
  }

  // ── Permission response ────────────────────
  function respondPermission(actionId, approved) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: "permission_response",
      action_id: actionId,
      approved,
      ts: Math.floor(Date.now() / 1000),
    }));
    pendingActions = pendingActions.filter((a) => a.id !== actionId);
    // Update the matching system message
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].actionId === actionId) {
        const updated = { ...messages[i] };
        updated.pending = false;
        updated.kind = "permission";
        updated.status = approved ? "approved" : "denied";
        updated.description ??= (messages[i].text || "").replace("🔧 OpenClaw requests: ", "");
        updated.text = `${approved ? "Approved" : "Denied"}: ${updated.description}`;
        messages[i] = updated;
        break;
      }
    }
  }

  // ═══════════════════════════════════════════
  //  WebSocket — ported from working Chat.svelte
  // ═══════════════════════════════════════════
  const WS_URL = `ws://${location.host}/v1/chat/ui`;

  function scheduleReconnect() {
    // Single-flight: never stack more than one pending reconnect.
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (document.visibilityState !== "hidden") connect();
    }, 3000);
  }

  function connect() {
    // Don't open a second socket if one is already open OR still connecting.
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    // Rate limit: at most one new socket per CONNECT_MIN_GAP_MS. A reconnect
    // storm starves the robot's few HTTP sockets (see app.svelte).
    if (Date.now() - lastConnectAt < CONNECT_MIN_GAP_MS) { scheduleReconnect(); return; }
    lastConnectAt = Date.now();

    // Make sure any previous socket is fully torn down before opening a new one.
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try { ws.close(); } catch {}
      ws = null;
    }

    const socket = new WebSocket(WS_URL);
    ws = socket;   // claim the slot immediately so re-entrant calls are guarded

    socket.onopen = () => {
      if (socket !== ws) return;        // stale socket — ignore
      connected = true;
      sendSessionReset(sessionId, { pwa_build: "brains-v21" });
      probeLocalBrain();
      void loadVoiceHistory();
    };

    socket.onclose = () => {
      if (socket !== ws) return;        // a stale/replaced socket closing — do NOT reconnect
      connected = false;
      ws = null;
      scheduleReconnect();
    };

    socket.onerror = () => {
      if (socket === ws) connected = false;
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch (e) {
        console.warn("chat WS: unparseable frame dropped", e, event.data);
      }
    };
  }

  function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try { ws.close(); } catch {}
      ws = null;
    }
    connected = false;
  }

  /** Index of the most recent user message (steps/system frames may follow it). */
  function lastUserIdx() {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return i;
    }
    return -1;
  }

  async function loadVoiceHistory() {
    try {
      /* Fewer conversations keeps the LittleFS read short: the history handler
       * runs on the httpd task, and a long read stalls every other request. */
      const res = await fetch("/v1/voice/history?limit=6", { cache: "no-store" });
      if (!res.ok) return;
      importVoiceHistory(await res.json());
      // Refresh an open voice transcript; never steal focus from a text chat.
      const open = getConversation(sessionId);
      if (open?.source === "voice" && !sending) {
        messages = open.messages;
        brain = BRAINS.LOCAL;
        conversationArchived = !!open.archived;
        markConversationRead(sessionId);
      }
      sidebarRefreshKey++;
    } catch {
      // Older firmware and MCP/server brain have no local history endpoint.
    }
  }

  function handleMessage(data) {
    if (data.type === "voice_turn") {
      const convo = appendVoiceTurn(data, { activeId: sessionId });
      if (voiceWakeRequested && convo) {
        /* A wake from a fresh Cloud chat moves to the robot-owned voice
         * session as soon as its first transcript exists. */
        voiceWakeRequested = false;
        selectConversation(convo.id);
      } else if (convo && data.conversation_id === sessionId) {
        messages = convo.messages;
        brain = BRAINS.LOCAL;
        markConversationRead(sessionId);
      }
      sidebarRefreshKey++;
      return;
    }
    if (data.type === "voice_step") {
      if (data.conversation_id === sessionId && typeof data.text === "string") {
        messages = [...messages, { role: "step", text: data.text, ts: Date.now() }];
        saveConversation(sessionId, { messages, brain: BRAINS.LOCAL });
      }
      sidebarRefreshKey++;
      return;
    }
    if (data.type === "voice_state") {
      voiceState = { state: data.state || "idle", id: data.conversation_id || null };
      sidebarRefreshKey++;
      return;
    }

    // ── Chunked chat_reply reassembly (array-based like original) ──
    if (data.type === "chat_reply_chunk") {
      const sid = data.session_id;
      if (!pendingChunks[sid]) {
        pendingChunks[sid] = {
          parts: new Array(data.total),
          total: data.total,
          count: 0,
        };
      }
      const acc = pendingChunks[sid];
      if (acc.parts[data.seq] === undefined) {
        acc.parts[data.seq] = data.text;
        acc.count++;
      }
      if (acc.count < acc.total) return;
      const fullText = acc.parts.join("");
      delete pendingChunks[sid];
      handleMessage({ type: "chat_reply", text: fullText, commands: [], session_id: sid });
      return;
    }

    // ── openclaw_action ──
    if (data.type === "openclaw_action") {
      const action = {
        id: data.action_id || "",
        type: data.action_type || "unknown",
        description: data.description || "",
        status: data.status || "completed",
      };
      if (action.status === "pending" && action.id) {
        pendingActions = [...pendingActions, action];
      } else if (action.id) {
        pendingActions = pendingActions.filter((a) => a.id !== action.id);
        // Resolve the inline permission card if we still have it pending
        // (e.g. the user answered from the global modal, or it timed out).
        let resolved = false;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].actionId === action.id && messages[i].pending) {
            messages[i] = {
              ...messages[i],
              pending: false,
              kind: "permission",
              status: action.status,
              text: `${action.status}: ${action.description}`,
            };
            resolved = true;
            break;
          }
        }
        if (!resolved) {
          messages = [...messages, {
            role: "system",
            kind: "action_result",
            actionType: action.type,
            description: action.description,
            status: action.status,
            text: `OpenClaw action: ${action.type} — ${action.description} [${action.status}]`,
          }];
        }
      }
      if (action.status === "pending") {
        messages = [...messages, {
          role: "system",
          kind: "permission",
          text: `🔧 OpenClaw requests: ${action.description}`,
          description: action.description,
          actionId: action.id,
          actionType: action.type,
          pending: true,
          receivedAt: Date.now(),
        }];
      }
      sending = false;
      return;
    }

    // ── step ──
    if (data.type === "step") {
      // Update the most recent user message's history
      const lastIdx = lastUserIdx();
      if (lastIdx >= 0) {
        const updated = { ...messages[lastIdx] };
        if (!updated.history) updated.history = [];
        updated.status = `step_${data.seq}_of_${data.total}`;
        updated.history = [
          ...updated.history,
          { stage: "step", ts: data.ts, text: data.text, seq: data.seq, total: data.total },
        ];
        messages[lastIdx] = updated;
      }
      // Also append as a visible step message
      messages = [...messages, {
        role: "step",
        text: data.text,
        seq: data.seq,
        total: data.total,
        ts: data.ts,
      }];
      return;
    }

    // ── command_result ──
    if (data.type === "command_result") {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "bot") {
          const updated = { ...messages[i] };
          if (!updated.commandResults) updated.commandResults = [];
          updated.commandResults = [...updated.commandResults, {
            script: data.script,
            output: data.output,
            status: data.status,
          }];
          messages[i] = updated;
          break;
        }
      }
      return;
    }

    // ── chat_reply ──
    if (data.type === "chat_reply") {
      if (data.text && data.text.includes("Session reset acknowledged")) {
        sessionAckBadge = true;
        setTimeout(() => { sessionAckBadge = false; }, 3000);
        sending = false;
        return;
      }
      // Mark the most recent user message as completed
      const lastIdx = lastUserIdx();
      if (lastIdx >= 0) {
        const updated = { ...messages[lastIdx] };
        updated.status = "completed";
        if (!updated.history) updated.history = [];
        updated.history = [...updated.history, { stage: "completed", ts: data.ts }];
        updated.reply = data;
        messages[lastIdx] = updated;
      }
      // Dedupe — skip if last bot message has identical text
      const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
      const newMsg = {
        role: "bot",
        text: data.text,
        commands: data.commands || [],
        ts: data.ts || Date.now(),
      };
      if (lastMsg && lastMsg.role === "bot" && lastMsg.text === data.text) {
        messages = [...messages.slice(0, -1), newMsg];
      } else {
        messages = [...messages, newMsg];
      }
      sending = false;
      return;
    }

    // ── ack ──
    if (data.type === "ack") {
      const lastIdx = lastUserIdx();
      if (lastIdx >= 0 && messages[lastIdx].status !== "completed") {
        const updated = { ...messages[lastIdx] };
        updated.status = data.status || "sent";
        if (!updated.history) updated.history = [];
        updated.history = [...updated.history, { stage: data.status, ts: Date.now() }];
        messages[lastIdx] = updated;
      }
      return;
    }

    // ── error ──
    if (data.type === "error" && data.text) {
      messages = [...messages, { role: "system", text: `⚠️ ${data.text}` }];
      sending = false;
      return;
    }
  }

  // ── Send message / wake voice ─────────────
  async function wakeVoice() {
    if (voiceWakeBusy || !connected) return;
    openVoicePanel(voicePanelId);
    voiceWakeBusy = true;
    voiceWakeError = "";
    voiceWakeRequested = true;
    voiceState = { state: "starting", id: voicePanelId };
    try {
      const res = await fetch("/v1/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wake: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Voice chat could not start");
    } catch (error) {
      voiceWakeRequested = false;
      voiceState = { state: "idle", id: voicePanelId };
      voiceWakeError = error?.message || "Voice chat could not start";
    } finally {
      voiceWakeBusy = false;
    }
  }

  async function endVoiceSession() {
    if (voiceWakeBusy) return;
    voiceWakeBusy = true;
    voiceWakeError = "";
    try {
      const res = await fetch("/v1/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ end: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not end voice chat");
      voiceWakeRequested = false;
      voiceState = { state: "ended", id: voicePanelId };
    } catch (error) {
      voiceWakeError = error?.message || "Could not end voice chat";
    } finally {
      voiceWakeBusy = false;
    }
  }

  async function newVoiceSession() {
    if (voiceWakeBusy) return;
    voiceWakeBusy = true;
    voiceWakeError = "";
    try {
      const res = await fetch("/v1/voice/history/new", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.id) throw new Error(data.error || "Could not create a voice session");
      startFresh(data.id, BRAINS.LOCAL);
      voicePanelId = data.id;
      voiceState = { state: "idle", id: data.id };
      voiceWakeRequested = false;
      showVoicePanel = true;
      sidebarRefreshKey++;
    } catch (error) {
      voiceWakeError = error?.message || "Could not create a voice session";
    } finally {
      voiceWakeBusy = false;
    }
  }

  async function clearVoiceContext() {
    const id = voicePanelId;
    if (!id || voiceWakeBusy) return;
    if (!window.confirm("Clear this voice session's context and transcript from the robot and this phone?")) return;
    voiceWakeBusy = true;
    voiceWakeError = "";
    try {
      const res = await fetch("/v1/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear_context: id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not clear voice context");
      clearConversationMessages(id);
      if (sessionId === id) messages = [];
      voiceState = { state: "cleared", id };
      sidebarRefreshKey++;
    } catch (error) {
      voiceWakeError = error?.message || "Could not clear voice context";
    } finally {
      voiceWakeBusy = false;
    }
  }

  function submitChat() {
    if (voiceWakeMode) wakeVoice();
    else sendMessage(inputText);
  }

  function sendMessage(text) {
    if (!text.trim() || sending || conversationArchived || !ws || ws.readyState !== WebSocket.OPEN) return;

    const nowTs = Date.now();
    messages = [...messages, {
      role: "user",
      text: text.trim(),
      status: "sending",
      history: [{ stage: "sending", ts: nowTs }],
      ts: nowTs,
    }];
    inputText = "";
    sending = true;
    lastSentTs = nowTs;

    ws.send(JSON.stringify({
      type: "user_chat_input",
      text: text.trim(),
      session_id: sessionId,
      brain,
      ts: Math.floor(nowTs / 1000),
    }));
  }

  function onArchiveChange(event) {
    if (event.detail?.id === sessionId) {
      conversationArchived = !!event.detail.archived;
      sidebarRefreshKey++;
    }
  }

  // ── Lifecycle ──────────────────────────────
  onMount(() => {
    const convo = getConversation(sessionId);
    if (convo && convo.messages.length > 0) {
      messages = convo.messages;
      brain = normalizeBrain(convo.brain);
      conversationArchived = !!convo.archived;
    }
    connect();
    window.addEventListener("mpx-conversation-archive", onArchiveChange);
    // Dev-only: lets you replay server frames from the console, e.g.
    //   __mpxChat.inject({ type: "step", text: "Planning", seq: 1, total: 3 })
    if (import.meta.env.DEV) window.__mpxChat = { inject: handleMessage };
    return () => {
      window.removeEventListener("mpx-conversation-archive", onArchiveChange);
      disconnect();
      if (import.meta.env.DEV) delete window.__mpxChat;
    };
  });

  // ── Auto-scroll ────────────────────────────
  $effect(() => {
    if (messages.length > 0 && scrollAnchor) {
      requestAnimationFrame(() => {
        scrollAnchor.scrollIntoView({ behavior: "smooth", block: "end" });
      });
    }
  });

  // ── Auto-focus input ──────────────────────
  $effect(() => {
    if (!sending && inputEl && connected) {
      inputEl.focus();
    }
  });
</script>

{#snippet lockIcon()}
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2"/>
    <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
  </svg>
{/snippet}

<div class="chat-root">
  <!-- Sidebar (slide animation) -->
  <div class="sidebar-backdrop" class:visible={showSidebar} role="presentation" onclick={() => (showSidebar = false)}></div>
  <div class="sidebar-panel" class:open={showSidebar}>
    <ChatSidebar
      activeId={sessionId}
      refreshKey={sidebarRefreshKey}
      onSelect={selectConversation}
      onNew={newConversation}
      onDelete={handleDelete}
    />
  </div>

  <!-- Main chat area -->
  <div class="chat-main">
    <header class="bar">
      <button
        type="button"
        class="round"
        class:on={showSidebar}
        onclick={() => (showSidebar = !showSidebar)}
        aria-label="Conversation history"
        aria-expanded={showSidebar}
        title="Conversation history"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9"/>
          <polyline points="12 7 12 12 15.5 14"/>
        </svg>
      </button>

      <!-- Brain: fixed once the conversation has a message -->
      <div
        class="seg"
        class:locked={brainLocked}
        role="radiogroup"
        aria-label="Who answers this conversation"
        title={brainLocked
          ? `This conversation is with ${brainLabel(brain)}. Start a new one to change.`
          : "Who answers the next message: Pupper (the robot's own agent) or the Cloud"}
      >
        <button
          type="button"
          class:on={brain === BRAINS.LOCAL}
          role="radio"
          aria-checked={brain === BRAINS.LOCAL}
          disabled={brainLocked || !localBrainAvailable}
          title={!localBrainAvailable ? localBrainReason : undefined}
          onclick={() => setBrain(BRAINS.LOCAL)}
        >
          {#if brainLocked && brain === BRAINS.LOCAL}
            {@render lockIcon()}
          {:else}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="4" y="7" width="16" height="12" rx="3"/>
              <circle cx="9" cy="13" r="1.4" fill="currentColor" stroke="none"/>
              <circle cx="15" cy="13" r="1.4" fill="currentColor" stroke="none"/>
              <line x1="12" y1="3" x2="12" y2="7"/>
            </svg>
          {/if}
          <span>Pupper</span>
        </button>
        <button
          type="button"
          class:on={brain === BRAINS.CLOUD}
          role="radio"
          aria-checked={brain === BRAINS.CLOUD}
          disabled={brainLocked}
          onclick={() => setBrain(BRAINS.CLOUD)}
        >
          {#if brainLocked && brain === BRAINS.CLOUD}
            {@render lockIcon()}
          {:else}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M7 18a4 4 0 0 1-.6-7.95A6 6 0 0 1 18 9.5a3.5 3.5 0 0 1 .5 7H7z"/>
            </svg>
          {/if}
          <span>Cloud</span>
        </button>
      </div>

      <button
        type="button"
        class="round"
        onclick={newConversation}
        aria-label="New conversation"
        title="New conversation"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14"/>
        </svg>
      </button>
    </header>

    <!-- Messages or Empty state -->
    {#if messages.length === 0 && !sending}
      <EmptyChat online={connected && network?.online !== false} onSuggest={(t) => sendMessage(t)} />
    {:else}
      <div class="messages-area">
        <div class="messages-scroll">
          {#each renderItems as item, k (item.kind === "msg" ? `m${item.index}` : `a${item.startIndex}`)}
            {#if item.kind === "activity"}
              <AgentActivity steps={item.steps} active={sending && k === renderItems.length - 1} />
            {:else}
              {@const i = item.index}
              {@const msg = item.msg}
              <!-- Date delineator -->
              {#if i === 0 || (i > 0 && isNewDay(findPrevTimestampMsg(messages, i - 1), msg))}
                <div class="date-delineator">
                  <span>{formatDateLabel(msg)}</span>
                </div>
              {/if}
              <ChatMessage
                {msg}
                isFirst={i === 0}
                isLastInGroup={i === messages.length - 1 || messages[i + 1]?.role !== msg.role}
                busy={i === messages.length - 1}
                {respondPermission}
              />
            {/if}
          {/each}

          <!-- Thinking indicator (before the first step arrives) -->
          {#if sending && lastSentTs && messages[messages.length - 1]?.role !== "step"}
            <div class="sending-indicator">
              <span class="typing"><span></span><span></span><span></span></span>
              <span class="timer">{Math.floor((now - lastSentTs) / 1000)}s</span>
            </div>
          {/if}

          <div bind:this={scrollAnchor}></div>
        </div>
      </div>
    {/if}

    <!-- Input bar -->
    <div class="input-bar">
      {#if latestVoice || voiceState.state !== "idle"}
        <button
          type="button"
          class="voice-chip"
          class:live={latestVoiceLive}
          aria-label={latestVoice ? "Open latest voice conversation" : "Open voice conversation in progress"}
          title={latestVoice ? `Open voice conversation (${voiceWhen(latestVoice)})` : "Voice conversation in progress"}
          onclick={() => openVoicePanel(latestVoice?.id || null)}
        >
          <span class="voice-chip-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="3" width="6" height="11" rx="3"/>
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>
            </svg>
          </span>
          {#if latestVoiceLive}<span class="voice-dot" aria-hidden="true"></span>{/if}
          <span class="voice-chip-title">
            {latestVoice ? (latestVoiceLive ? `${voiceState.state} · ${voiceTitle(latestVoice)}` : voiceTitle(latestVoice)) : "Listening now…"}
          </span>
          <span class="voice-chip-when">{latestVoice ? voiceWhen(latestVoice) : "Now"}</span>
        </button>
      {/if}
      {#if voiceWakeError && !showVoicePanel}
        <div class="voice-wake-error" role="alert">{voiceWakeError}</div>
      {/if}
      <div class="input-row">
        <input
          bind:this={inputEl}
          bind:value={inputText}
          oninput={() => voiceWakeError = ""}
          onkeydown={(e) => e.key === "Enter" && submitChat()}
          placeholder={conversationArchived ? "Unarchive this conversation to reply" : sending ? "Pupper is working…" : voiceWakeMode ? "Type, or tap the mic to talk…" : connected ? "Ask Pupper to do something…" : "Pupper is waking up…"}
          disabled={conversationArchived || sending || !connected}
          class="chat-input"
          enterkeyhint={voiceWakeMode ? "go" : "send"}
        />
        <button
          class="send-btn"
          class:wake-mode={voiceWakeMode}
          aria-label={voiceWakeMode ? "Start voice chat" : "Send message"}
          title={voiceWakeMode ? "Start voice chat without the wake word" : "Send message"}
          onclick={submitChat}
          disabled={voiceWakeBusy || conversationArchived || sending || !connected || (!voiceWakeMode && !inputText.trim())}
        >
          {#if sending || voiceWakeBusy}
            <span class="spinner small"></span>
          {:else if voiceWakeMode}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3"/>
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>
            </svg>
          {:else}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          {/if}
        </button>
      </div>
    </div>
  </div>

  {#if showVoicePanel}
    <VoicePanel
      conversation={voicePanelConversation}
      voiceState={voicePanelState}
      busy={voiceWakeBusy}
      error={voiceWakeError}
      onWake={wakeVoice}
      onEnd={endVoiceSession}
      onNew={newVoiceSession}
      onClear={clearVoiceContext}
      onClose={() => showVoicePanel = false}
    />
  {/if}
</div>

<style>
  /* Newest voice transcript as a compact chip, not a banner: one line, so the
   * transcript above stays the focus. Older transcripts live in History. */
  .voice-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    width: fit-content;
    max-width: calc(var(--page-max) - 32px);
    margin: 0 auto 8px;
    padding: 4px 10px 4px 8px;
    border: 1px solid var(--hair);
    border-radius: 999px;
    background: var(--panel, var(--page));
    color: var(--sub);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .voice-chip:hover { border-color: var(--sub); color: var(--ink); }
  .voice-chip:focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; }
  .voice-chip.live { border-color: var(--accent, var(--sub)); color: var(--ink); }

  .voice-chip-icon { display: grid; place-items: center; flex: 0 0 auto; }

  .voice-chip-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink);
    font-weight: 650;
  }

  .voice-chip-when {
    flex: 0 0 auto;
    color: var(--sub);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .voice-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    flex: 0 0 auto;
    animation: voice-pulse 1.2s ease-in-out infinite;
  }

  @keyframes voice-pulse {
    0%, 100% { opacity: 0.25; }
    50% { opacity: 1; }
  }

  .chat-root {
    display: flex;
    flex: 1;
    min-height: 0;
    background: var(--page);
    color: var(--ink);
    position: relative;
  }

  /* ── Sidebar (slide) ──────────────────── */
  .sidebar-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.3);
    z-index: 40;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s ease;
  }
  .sidebar-backdrop.visible {
    opacity: 1;
    pointer-events: auto;
  }

  .sidebar-panel {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: min(300px, 86vw);
    z-index: 50;
    transform: translateX(-100%);
    transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
    box-shadow: 4px 0 12px rgba(0,0,0,0.08);
  }
  .sidebar-panel.open {
    transform: translateX(0);
  }

  /* ── Main chat area ──────────────────── */
  .chat-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  /* ── Header ───────────────────────────── */
  .bar {
    flex-shrink: 0;
    height: calc(64px + var(--safe-top));
    padding: calc(10px + var(--safe-top)) 16px 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    max-width: var(--page-max);
    width: 100%;
    margin: 0 auto;
  }
  .round {
    width: 44px; height: 44px; border-radius: 22px; border: none; flex-shrink: 0;
    background: var(--ground); color: var(--ink);
    display: grid; place-items: center; cursor: pointer;
    transition: background var(--dur-fast);
  }
  .round.on { background: var(--mpx-yellow); }

  /* Brain: same segmented control as Skills' On robot / Library */
  .seg {
    flex: 1;
    max-width: 240px;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px;
    padding: 4px;
    border-radius: 16px;
    background: var(--hair);
  }
  .seg button {
    height: 36px;
    border: none;
    border-radius: 12px;
    background: transparent;
    color: #4F4C46;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .seg button.on { background: #fff; color: var(--ink); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12); }
  .seg button:disabled { cursor: default; }
  .seg button:disabled:not(.on) { opacity: 0.45; }
  .seg.locked button.on { background: var(--mpx-yellow); box-shadow: none; }

  button:focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; }

  /* ── Date delineator ──────────────────── */
  .date-delineator { display: flex; justify-content: center; margin: 10px 0; }
  .date-delineator span {
    font-size: 12px;
    font-weight: 700;
    color: var(--sub);
    background: var(--ground);
    padding: 4px 12px;
    border-radius: var(--r-pill);
  }

  /* ── Messages ─────────────────────────── */
  .messages-area { flex: 1; overflow-y: auto; min-height: 0; -webkit-overflow-scrolling: touch; }
  .messages-scroll {
    padding: 8px 0 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: var(--page-max);
    margin: 0 auto;
    width: 100%;
  }

  .sending-indicator {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    margin: 2px 16px;
    border-radius: 20px 20px 20px 6px;
    background: #fff;
    border: 1px solid var(--line);
    width: fit-content;
  }
  .typing { display: inline-flex; gap: 4px; }
  .typing span {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--mpx-yellow-deep);
    animation: bounce 1.2s ease-in-out infinite;
  }
  .typing span:nth-child(2) { animation-delay: 0.15s; }
  .typing span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-4px); opacity: 1; } }

  .spinner {
    width: 18px; height: 18px;
    border: 2.5px solid rgba(255, 230, 5, 0.4);
    border-top-color: var(--mpx-yellow);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .spinner.small { width: 16px; height: 16px; border-width: 2px; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .timer { font-size: 12px; font-weight: 700; color: var(--sub); font-variant-numeric: tabular-nums; }

  /* ── Input bar ───────────────────────── */
  .input-bar {
    padding: 8px 16px 12px;
    background: var(--page);
    flex-shrink: 0;
  }
  .input-row {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--ground);
    border-radius: var(--r-pill);
    padding: 4px 4px 4px 18px;
    max-width: calc(var(--page-max) - 32px);
    margin: 0 auto;
  }
  .input-row:focus-within { outline: 3px solid var(--ink); outline-offset: 2px; }

  .voice-wake-error {
    max-width: calc(var(--page-max) - 32px);
    margin: 0 auto 7px;
    color: var(--danger, #b3261e);
    font-size: 12px;
    font-weight: 650;
  }

  .chat-input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    font-size: 16px;
    color: var(--ink);
    padding: 10px 0;
    min-width: 0;
  }
  .chat-input::placeholder { color: var(--sub); }
  .chat-input:disabled { opacity: 0.6; }

  .send-btn {
    width: 44px; height: 44px;
    border-radius: 50%;
    border: none;
    background: var(--ink);
    color: var(--mpx-yellow);
    display: grid; place-items: center;
    cursor: pointer;
    transition: transform var(--dur-fast), opacity var(--dur-fast);
    flex-shrink: 0;
  }
  .send-btn:active:not(:disabled) { transform: scale(0.94); }
  .send-btn.wake-mode { background: var(--mpx-yellow); color: var(--ink); }
  .send-btn:disabled { opacity: 0.35; cursor: default; }
</style>
