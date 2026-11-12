# Voice gateway as the robot's STT/TTS, the local agent as the brain

Status: **first implementation complete; hardware validation pending.** Companion to
[FIRMWARE_HANDOFF.md](./FIRMWARE_HANDOFF.md) §3 (device brain) and §10 (LLM
proxy). Read that file's §3 before changing anything here; this document only
describes the firmware and PWA work needed to use it.

---

## 1. Goal

Today a voice turn is answered by the gateway's model, which drives the robot
over MCP (`features:{"mcp":true}`, `main/voice/voice_tools.cc`). The robot's own
ESP-Claw agent is a separate brain that only answers text from the PWA
(`brain:"local"` on `/v1/chat/ui`).

Target:

- the **gateway is a service**: speech recognition in, speech synthesis out. It
  never runs the conversation.
- the **local ESP-Claw agent is the brain** for voice turns, with the same tool
  table it already has for text, so "sit down" from the microphone runs
  `mpx_run_skill` exactly like it does from the phone.
- the **PWA shows the voice conversation** — live while it happens, and in the
  sidebar afterwards, including when the phone was not open.

That is the gateway's documented `brain:"device"` mode. No new server work.

Non-goals: changing the wire protocol, replacing the gateway's TTS, local
wake-word/TTS on the robot, and any per-unit build. MCP mode stays as a
fallback (see §5).

---

## 1a. Implementation status (2026-11-12)

F1–F9 and P1–P6 now have a first implementation. The local brain is selected
by `CONFIG_APP_VOICE_BRAIN_LOCAL` (default on when the agent is present);
hello advertises either `features.brain="device"` or MCP, never both. Voice
uses one NVS-backed rolling `voice-xxxxxxxx` session, a PSRAM worker, one
outstanding turn (the protocol has no turn id), 4-second fillers, an 80-second
timeout, and 3-second duplicate-STT suppression. Speech cleanup is a separate
ESP-free C module with host tests.

Transcripts live in `/fs/voice/*.jsonl` (16 newest files, 64 KiB/file, 200
lines retained when compacting). The PWA imports them from
`GET /v1/voice/history`, receives `voice_turn`, `voice_step`, and
`voice_state` on every chat socket, and supports archive/unarchive, unread
turns, new voice session, and local-only delete. `POST /v1/voice/history/clear`
erases transcripts only. Skill hold keeps the device-brain control socket
open so the agent can still answer, while wake word/music remain held.

The most recent voice conversation gets a compact preview directly above the
chat composer (`.voice-recent` in `pwa-claw/src/lib/chat/ChatView.svelte`):
first user turn, latest reply, timestamp, and a live listening/thinking/
speaking state. Tapping it opens the transcript. Older voice conversations
stay in the History drawer with the other chats, instead of occupying a
permanent chip row in the main chat window.

An empty new chat turns the send button (and Enter) into a microphone wake
button. It posts `POST /v1/voice {"wake":true}`, which starts hands-free if
necessary and calls `mpx_voice_wake_trigger()`. That trigger deliberately
enters the same `wake_auto` state machine as the physical WAKE button, so
provisioning, microphone ownership, barge-in and follow-up turns are shared
rather than duplicated in the HTTP handler. The first resulting voice turn
opens its transcript on the phone. Existing chats keep the ordinary send
button; the wake word and physical WAKE button remain available everywhere.

`pwa-claw/src/lib/chat/VoicePanel.svelte` is a dedicated voice-chat subwindow,
opened by that microphone, the latest-voice card, or a Voice row in History.
It shows the live STT/TTS transcript and large Start/Interrupt, End, New
session and Clear context controls. Start/Interrupt uses the same software
wake path as the physical button, so it also barges into playback. End posts
`{"end":true}`; New keeps the old transcript but rolls both ESP-Claw and
voice history to a fresh id; Clear posts `{"clear_context":"voice-…"}` and
deletes that session's public ESP-Claw history, JSONL transcript and phone
copy. Clearing is refused while its current agent answer is still pending.

Voice-end intent is decided by the agent, not keyword matching. The
voice-only prompt permits a final `[[END_VOICE]]` marker when the speaker
clearly wants to leave; the bridge strips it, speaks any preceding goodbye,
then ends on the gateway's playback-idle state. This avoids arbitrarily
ending a conversation merely because it contains a word such as "goodbye".
Ending retires the old id (a four-id ring consumes late agent output), aborts
playback/talk and disconnects without disabling the wake-word loop. Repeated
"One moment" filler is gone: the voice prompt requests one concise direct
answer, uses tools only for explicit physical actions, and has one 80-second
timeout instead of periodic spoken filler.

Stack budget matters more than usual here: the history endpoint runs on the
`esp_http_server` task (`main/network/http_server.cc:3116`, `stack_size =
8192`), so no handler may carry a multi-kilobyte frame. The first cut of
`main/voice/voice_history.cc` read transcripts through `char line[8192]` and
the following `opendir()` wrote callee frames past the end of that task's
stack into the neighbouring heap block; the damage surfaced as a TLSF walk
panic in `heap_caps_get_largest_free_block()` during the LittleFS read
(`voice_history.cc:62` → `http_voice.cc:440`). Lines are now read into a
growing `std::string` (`read_line()`), and `voice_history::list_json()` sends
at most 60 turns per conversation and 300 overall, because 16 transcripts of
200 turns parsed into one cJSON tree does not fit next to Wi-Fi, LWIP and
LVGL.

Remaining validation is on hardware: STT/TTS timing, spoken end intent,
barge-in, voice tools during a turn, reboot/reconnect continuity, and the
complete PWA visual flow. The build-time MCP fallback needs a separate compile/profile check.

---

## 2. Where we are

Existing building blocks used by the implementation:

| Thing | Where |
|---|---|
| `mpx_voice_set_device_brain(on, stt_sink)` | `main/voice/mpx_voice_link.h:249`, body `main/voice/mpx_voice_ws.c:54` |
| `{"type":"speak","text":…,"last":…}` sender | `main/voice/mpx_voice_ws.c:143` |
| `stt` → sink (heap copy, sink owns it) | `main/voice/mpx_voice_ws.c:256` |
| hello advertises `brain:"device"` when set | `main/voice/mpx_voice_ws.c:181` |
| `agent::submit(session,text)` / outbound callback | `main/agent/agent_runtime.h:44,56` |
| agent ↔ PWA frames (`chat_reply`, `step`) | `main/network/chat_ws.cc:1152`, `:1417`, `:1962` |
| hands-free loop already waits on `tts stop` / re-arms | `main/voice/mpx_voice_wake.c:599,729` |
| agent LLM already proxied through the gateway (`mangdang`) | `main/agent/agent_runtime.cc:65` |

Missing — this is the whole job:

1. **No caller of `mpx_voice_set_device_brain()`.** `voice_send_hello()` adds
   `mcp:true` unconditionally (`main/voice/mpx_voice_ws.c:181`), and
   `voice_tools::start()` (called from `voice_glue::start()`,
   `main/voice/voice_glue.cc:205`) registers the MCP sink unconditionally. The
   live mode is server brain.
2. **No bridge** `stt` → agent → `speak`. The two halves do not know each other.
3. **No transcript store**, and `broadcast_to_pwa()` only reaches clients bound
   to the same session (`main/network/chat_ws.cc:956`), so a phone showing
   another conversation sees nothing.
4. **Skill runs disconnect voice.** `mpx_run_skill`
   (`main/agent/robot_tools.cc:453`) → `network::skill_start()` →
   `voice_glue::hold("skill")` (`main/network/http_server.cc:389`) closes the
   WebSocket and aborts playback. A voice turn that moves the robot would kill
   its own TTS path, then block up to 90 s (`robot_tools.cc:485`) against the
   gateway's 90 s speak deadline.

---

## 3. Target flow

```
mic ──Opus 16k──► gateway ──stt──► voice_brain ──agent::submit──► ESP-Claw
                                              │                       │
                                              │                  tools/text
                                              │                       │
                                              ▼                       ▼
                                        voice log ◄──── chat_reply (final)
                                              │                       │
                                    voice_turn frames           speak(text,last)
                                              │                       │
                                              ▼                       ▼
                                        PWA (WS)  ◄──────── gateway ──Opus 24k──► speaker
```

One turn owns one epoch. A newer `stt`/`tts start` invalidates the previous
epoch, so a slow agent reply that arrives after a barge-in is logged and never
spoken (the gateway already cancelled it; `brain.py` sends no `tts stop` for a
cancelled reply).

---

## 4. Decisions (agreed)

| Question | Decision |
|---|---|
| Where does history live | Firmware JSONL on LittleFS + PWA import; survives a closed phone and a cleared browser |
| Session grouping | One rolling voice conversation, stable agent session; rolled by "New voice conversation" in the PWA or after a long idle gap |
| MCP / server brain | Kept behind a switch, off by default |
| This pass | This document only |

Additional UX requested: **new conversation** and **archive** controls in the
PWA sidebar.

---

## 5. Brain selection

Rule, evaluated per WebSocket connection in `mpx_voice_connect()`:

```
device brain  iff  CONFIG_APP_AGENT_ENABLE
               &&  agent::running()
               &&  CONFIG_APP_VOICE_BRAIN_LOCAL          (new, default y)
               &&  agent_config::mode() != Off
else server brain (mcp), exactly today's behaviour
```

A robot built with `CONFIG_APP_AGENT_ENABLE=n`, or one an owner set to "off" AI,
keeps working with the old path — the stubs in `agent_runtime.cc:259` already
return `ESP_ERR_INVALID_STATE`, so the check is cheap and honest.

`voice_send_hello()` then advertises **either** `brain:"device"` **or** `mcp:true`,
never both. `voice_tools::start()` runs only in server-brain mode (it costs a
sink registration and nothing else, but there is no reason to keep a dead MCP
server reachable).

Kconfig (`main/Kconfig.projbuild`, under `APP_VOICE_ENABLE`):

```
config APP_VOICE_BRAIN_LOCAL
    bool "Answer voice with the on-device agent (gateway = STT + TTS)"
    default y
    help
      Advertises hello features.brain="device". The gateway then only
      transcribes and speaks; ESP-Claw answers, with its own tools. Off =
      the server's model answers and drives the robot over MCP.
```

---

## 6. Firmware work items

Each item lists the files it touches. Items F1–F4 are one commit; F5–F7 a
second; F8–F9 a third.

### F1 — brain switch and hello

- `main/voice/voice_glue.cc:205` — register the bridge (§F2) and call
  `mpx_voice_set_device_brain(true, bridge_stt)` instead of
  `voice_tools::start()` when the rule in §5 says device brain; still call
  `voice_tools::start()` otherwise.
- `main/voice/voice_glue.cc` — re-evaluate on `apply_mode()` (AI mode change)
  and on `agent::start()` ordering (agent starts before voice,
  `main/main.cc:221`).
- `main/voice/mpx_voice_ws.c:181` — hello emits `brain:"device"` **or**
  `mcp:true`.
- `main/Kconfig.projbuild` — `APP_VOICE_BRAIN_LOCAL`.

Acceptance: boot log line naming the chosen brain; `[mpx_voice_ws] -> {…}` on
connect shows exactly one of the two features.

### F2 — `main/voice/voice_brain.cc` (new)

One small module, the only place that knows both halves exist. Declared in a
new `main/voice/voice_brain.h`, added to `set(sources …)` in
`main/CMakeLists.txt` (a new `.cc` does not compile until it is listed).

```
voice_brain::start()      // registers the sink, sets agent outbound via a
                          // small dispatcher that fans out to chat_ws and here
void voice_brain::on_stt(char *text)     // owns text; frees it
void voice_brain::on_agent(const char *session, const char *text, bool step)
void voice_brain::on_tts_stop()          // close the epoch
```

Rules:

- `on_stt`: bump epoch, `voice_log_append(user,…)`, broadcast `voice_turn`,
  `agent::submit("voice-<id>", text)`. A `submit` failure (agent off, no key)
  must speak a short apology rather than leave dead air.
- `on_agent(step=true)`: broadcast a `voice_step` frame; never spoken.
- `on_agent(step=false)`: if the epoch is still current, sanitise (§8), speak
  it (`mpx_voice_send_speak(txt, true)`), log it, broadcast it. If the epoch
  moved on, log it with `spoken:false` and drop the audio.
- Filler: if no reply after 4000 ms and the epoch is current, send
  `mpx_voice_send_speak("One moment.", false)`. The gateway speaks `last:false`
  chunks and keeps waiting, so this is legal and cheap. It also stops the user
  thinking the robot died.
- Reply is capped at 300 characters spoken; the full text still goes to the
  transcript and the PWA.

Concurrency note: `agent::submit()` is fire-and-forget into the ESP-Claw IM
channel (`main/agent/agent_runtime.cc:233`). Whether two sessions can be in
flight at once is **not** established — spike S1 (§12). If they serialise, a
voice turn queued behind a PWA turn can outlive its 90 s budget; the epoch
guard makes that harmless, and the transcript still records it.

### F3 — session identity

- `voice_brain` owns the voice conversation id: `voice-%08x` from
  `esp_random()`, stored in NVS (`voice/conv_id`), rolled by
  `POST /v1/voice/history/new` and after `CONFIG_APP_VOICE_CONV_IDLE_HOURS`
  (new Kconfig, default 12) with no turns.
- The same id is the ESP-Claw session id, so agent memory
  (`/fs/agent/sessions/…`, see `third_party/esp-claw/…/claw_memory_utils.c:95`)
  gives continuity for free across wake-ups and reconnects.
- Text from the PWA can join the same conversation: the PWA already sends
  `brain:"local"` with a conversation id; when that id is the voice id, text and
  voice share one agent session. The PWA change is in P4.

### F4 — transcript store `main/voice/voice_log.cc` (new)

- One file per voice conversation: `/fs/voice/<conv_id>.jsonl`, one JSON object
  per line: `{"ts":1699…,"role":"user"|"assistant","text":"…","spoken":true}`.
- In-RAM ring in PSRAM (cap 200 turns) + flush via `fs::write_file()`
  (`main/fs/littlefs_manager.h:33`) at each turn end. `write_file` overwrites
  the whole file, so per-turn cost is the file size; with 200 turns that is
  ~24 KB, twice per exchange, at most 12 turns/min. Acceptable; do **not** add
  an append API for this.
- Retention: keep the newest 16 conversation files, delete the rest on
  rotation. Total budget 256 KB, checked against `fs::stats()`.
- Flush failure is logged, never fatal — a robot that cannot write history must
  still talk.

Do **not** parse or rewrite ESP-Claw's `sessions/*.log` + `.idx`; that format is
undocumented and vendored.

### F5 — skill hold without dropping the link

`voice_glue::hold()` currently calls `mpx_voice_disconnect()`. A voice turn must
not. Change:

- `hold("skill")` keeps the WebSocket **open**; it stops the wake front end,
  music, and playback as today.
- While held, `stt` frames are still accepted and still submitted; audio in is
  paused (the front end is down anyway), so a held robot cannot hear.
- Add `voice_glue::hold_audio_only()` or an argument so the Pi-takeover path
  (which wants the socket gone) keeps its current behaviour.
- The agent's `mpx_run_skill` result may then be spoken. If the skill itself
  needs the microphone (`mpx_mic_start`), voice stays held and the reply is
  logged `spoken:false` with a spoken apology if the socket is still up.

Acceptance: "sit down" over voice → pose changes, agent reply is spoken, socket
stays up, `GET /v1/voice` reports `held:true` during the run and `false` after.

### F6 — history REST

New handlers in `main/network/http_voice.cc`, registered in
`network::register_voice_routes()` (`:428`), guarded by
`CONFIG_APP_VOICE_ENABLE`:

| Route | Meaning |
|---|---|
| `GET /v1/voice/history?limit=50` | `{"active":"voice-…","conversations":[{"id","title","updatedAt","messages":[…]}], "dropped":n}` newest first |
| `POST /v1/voice/history/new` | roll the voice conversation id, return `{"id":"voice-…"}` |
| `POST /v1/voice/history/clear` | delete all voice transcripts, keep the agent session (memory untouched) |

Title = first user turn, truncated to 60 chars, computed in firmware so the
sidebar does not have to wait for the PWA import path to finish.

### F7 — live frames to every PWA client

`broadcast_to_pwa(session_id, …)` skips clients bound to a different session.
Add `broadcast_all_to_pwa(json)` (a filter bypass in
`main/network/chat_ws.cc:956`) used only by voice frames, and a bound so a PWA
viewing a long text conversation is not spammed: drop the frame if the client
has no chat socket open — nothing else to do, history fills the gap.

Frames (all server→client on `/v1/chat/ui`):

```json
{"type":"voice_turn","conversation_id":"voice-1a2b3c4d","role":"user",
 "text":"sit down","ts":1699000000000,"spoken":true}
{"type":"voice_state","conversation_id":"voice-1a2b3c4d","state":"listening"}
{"type":"voice_step","conversation_id":"voice-1a2b3c4d","text":"move: sit"}
```

`state` ∈ `idle|listening|thinking|speaking`. `voice_state` is sent on wake,
after `stt`, on `tts start`, and on `tts stop`/`goodbye`.

### F8 — face hooks

`mpx_voice_ui_hooks_t` already drives the screen (`main/voice/voice_glue.cc:186`).
With device brain the `saying`/`reply_done` hooks fire from `tts`, not from the
gateway's own text, so they keep working; `emotion` will not (no `llm` frame).
Optional: map a small keyword list ("good", "sorry", "wow") to a mood in
`voice_brain` — do not block on this.

### F9 — housekeeping

- `docs/FILE_MAP.md` (root-owned — `docker exec … chown 1000:1000` first) gets
  this file and the two new modules.
- `tools/check_comments.py` clean; hard tabs in the new C/C++, matching
  neighbours.
- `GET /v1/voice` (`voice_glue::status_json()`) gains `brain:"device"|"server"`,
  `conversation_id`, `turns`.

---

## 7. PWA work items

Files: `pwa-claw/src/lib/conversationStore.js`,
`pwa-claw/src/lib/chat/ChatView.svelte`,
`pwa-claw/src/lib/chat/ChatSidebar.svelte`.

### P1 — voice turns land in the store

`handleMessage()` (`ChatView.svelte:397`) today appends `chat_reply`/`step` to
whatever conversation is open. Add `voice_turn`:

- unknown `conversation_id` → create it (`brain:"local"`, `source:"voice"`,
  `createdAt` = first turn `ts`) so it appears in the sidebar without stealing
  the view;
- known id and it *is* the open conversation → append live;
- known id, not open → append and mark unread (`unread` counter on the entry).

Dedupe by `(ts, role, text)` so a reconnect that re-imports history does not
double a message.

### P2 — history import

On chat socket open, `GET /v1/voice/history?limit=50` and merge into
`conversationStore` (`saveConversation`, `:120`) using the robot's ids. Never
overwrite a conversation that already has more turns locally. Mark imported
entries `source:"voice"`; do not re-send them to the robot.

### P3 — live status

`voice_state` frames drive a small indicator in the chat header / empty state
(`EmptyChat.svelte`): mic pulse while `listening`, dots while `thinking`, a
speaker icon while `speaking`. `voice_step` frames reuse `AgentActivity.svelte`.

### P4 — text into the voice conversation

A new conversation created as voice carries the robot's id, so the existing
`sendMessage` path already targets the same agent session — confirm the PWA does
not rewrite the id (`ChatView.svelte:584` sends `session_id` verbatim) and that
`sanitizeId`-style code does not choke on `voice-1a2b3c4d`.

### P5 — new / archive / delete

`ChatSidebar.svelte` (`listConversations` at `:2`, delete at `:53`):

- **New** — for `brain:"local"` conversations, call
  `POST /v1/voice/history/new` first, then start the conversation with the
  returned id; otherwise keep today's behaviour (fresh uuid).
- **Archive** — `archived: true` in the store, hidden behind an "Archived"
  disclosure at the bottom of the sidebar, `onSelect` still opens it read-only
  until the user un-archives or continues it.
- Deleting a voice conversation is local only (the robot keeps its transcript
  and its agent memory) — say so in the confirmation text, because "delete"
  that does not delete is a lie.

### P6 — tests

`pwa-claw/tests/`: a `voiceTurn` reducer test (new conversation, dedupe,
unread), a history-import test with a fixture, an archive filter test. Node 22
`node --test`, no framework.

Host tests go in `tools/host_tests/tests/` next to `test_identity.c` and wired
in `tools/host_tests/main.c`.

---

## 8. Speech sanitiser

Agent replies are markdown with tool notes. Before `speak`:

1. Drop fenced code blocks and inline `` `code` ``.
2. Drop URLs, `http…`, paths starting `/fs/`.
3. Flatten bullets/headings/numbered lists to sentences; drop table rows.
4. Strip emoji and `*`/`_`/`#`/`>` markers.
5. Collapse whitespace; cap 300 chars at a sentence boundary, else at a word.
6. Empty result → speak "Done." (never silence after a tool-only turn).

Unit-testable without ESP-IDF: pure `const char *` → `std::string`, so it goes in
`main/voice/voice_brain_text.cc` with a host test in
`tools/host_tests/tests/`. This is the one piece that must live where
`tools/host_tests/` can build it (no `esp_*.h`).

---

## 9. Turn lifecycle

```
idle ─wake─► listening ─stt─► thinking ─reply─► speaking ─tts stop─► listening
                                  │                   │
                                  └─4 s no reply─► filler speak (last:false)
barge-in: listening starts a new epoch; an in-flight reply is logged, not spoken
goodbye / socket drop: epoch closed, state idle, transcript kept
```

Deadlines: gateway speaks within 90 s (`vg/brain.py:86`); reply older than 85 s
is dropped. Gateway rate limit is 12 turns/min — a robot that talks fast gets
"I need a little rest now" from the server; nothing to do on our side.

---

## 10. Tests and checks

Agent-side (safe, no board):

- `cmake -S tools/host_tests -B /tmp/mpx-host-tests && cmake --build … && ctest …`
  — new: sanitiser, transcript ring/rotation, epoch guard.
- `python3 tools/check_comments.py`
- `docker exec "$CID" bash -lc 'cd /workspaces/md-mpx-dog && source /opt/esp/idf/export.sh >/dev/null 2>&1 && idf.py build'`
  (plus `-DMPX_BUILD_PWA=OFF` default-profile build and the pilot profile,
  which compiles the `@MPXPROV` listener the default profile drops).
- `(cd pwa-claw && npm test)`

Human-side (never claim these):

- with the phone closed: say the wake word, ask something, hear an answer, ask a
  follow-up ("and now sit") that proves context was kept;
- open the PWA afterwards: the voice conversation is in the sidebar with both
  turns, timestamped, marked as voice;
- open the PWA while talking: turns appear live, indicator changes;
- "sit down" by voice: pose changes, reply is spoken, `GET /v1/voice` shows no
  dropped session;
- barge-in: interrupt mid-reply, the robot stops talking and answers the new
  utterance, the interrupted reply is in the transcript as unspoken;
- boot log: internal RAM after each stage does not drop more than before.

---

## 11. Order of work

1. F1+F2+F3 (brain, bridge, session id) — smallest thing that makes a voice turn
   answered by the local agent.
2. F5 (hold) — without it, every robot-moving voice turn is broken.
3. F4+F6+F7 (store, REST, frames) — the phone side becomes possible.
4. P1–P5, P6 tests.
5. F8/F9 polish.

Each step is independently flashable and revertable except F3 (an NVS key; a
rollback just ignores it).

---

## 12. Spikes and open questions

- **S1** Does ESP-Claw serialise `cap_im_local_emit_user_message` per session
  and across sessions? Determines whether a PWA turn can starve a voice turn.
  Read `third_party/esp-claw/…/cap_im_local*` (read-only, never edit).
- **S2** Internal RAM with WebSocket + agent run + LVGL + esp-sr front end all
  live. `main.cc` logs free internal heap per stage — compare, and keep the
  bridge's buffers in PSRAM.
- **S3** Real gateway behaviour for a `speak` that arrives after cancellation,
  and whether it tolerates a `last:false` filler followed by `last:true`
  (documented, unverified against the running service).
- **S4** Agent reply latency distribution in `mangdang` mode (LLM through
  `/v1/llm`) vs `own`. If `own` with a slow provider regularly exceeds 85 s, the
  filler strategy needs a second stage.
- **Open** Should a voice turn be *refused* while a WASM skill holds the robot
  ("I'm busy"), or queued? Current plan: held → the microphone is closed, so the
  question does not arise; only an in-flight turn can meet a hold.
- **Open** `goodbye.reason=="stop"` stops music via `s_quiet_hook`
  (`main/voice/mpx_voice_ws.c:~330`); confirm "be quiet" should also cancel a
  pending agent turn.
- **Open** Does deleting a conversation in the PWA need to roll the robot's
  agent session too? Plan says no (local delete only), which keeps memory and
  transcript divergent on purpose.

---

## 13. What this does not change

- Gateway wire protocol, hello fields, audio formats, MCP mode (still selectable).
- Identity, keys, provisioning, eFuse.
- The skill sandbox, the WASM/Lua ABI, the tool table.
- `pwa-claw/www/` filenames and `main/CMakeLists.txt`'s `EMBED_FILES` — no new
  assets, so `tools/pwa_build.cmake` is untouched.
- Partition layout: history goes under `/fs/voice/` on the existing `storage`
  partition at `0x910000`. Any firmware that moves it wipes skills and history;
  say so in the flash note.
