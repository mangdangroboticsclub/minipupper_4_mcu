# Robot UUID & AES-256-GCM Key Management

**Scope:** how the per-robot identifier and AES-256-GCM key flow between the
ESP32-S3 firmware (`md-mpx-dog`) and the cloud (`../cloud/mpx-server`), plus a
concrete plan for automating key generation and keeping the cloud database in
sync.

**Status of this document:** description of *what exists today* (§1–§5), a
security review of that state (§6), and a proposed design for automated
provisioning/rotation (§7–§9). No code was changed.

Files referenced by path:line are in `md-mpx-dog` unless prefixed with
`cloud/`, which means `../cloud/mpx-server`.

---

## 0. TL;DR

1. There is **one** 32-byte AES-256-GCM key per robot. The same key is used for
   three different jobs: chat-frame encryption, WASM skill decryption
   (key-wrapping), and robot authentication (HMAC bearer token).
2. Firmware side, both the key and the UUID come from **compile-time Kconfig
   strings** (`CONFIG_APP_CHAT_AES_KEY_HEX`, `CONFIG_APP_ROBOT_UUID`). There is
   no NVS or eFuse provisioning path implemented, and `sdkconfig` is committed
   to git.
3. Cloud side, keys live **plaintext hex** in Postgres (`robots.aes_key_hex`),
   loaded into process memory: once at startup in `core_gateway`, on a 5-minute
   TTL in `voice_gateway`.
4. The UUID is both the routing identifier and the GCM AAD, and it is truncated
   to 16 bytes on the wire (`strncpy(..., 16)`), so identifiers longer than 16
   characters silently collide.
5. There is **no automation** today: `POST /v1/robots` accepts a UUID and a hex
   key from anyone, with no authentication, and new keys only take effect in
   `core_gateway` after a restart.
6. Two real crypto defects found: **GCM nonce reuse** on the `session_reset`
   reply path (`cloud/core_gateway/main.py:1211`) and **no replay protection** on
   downstream frames.
7. Recommendation: envelope-encrypt the DB column under a Cloud KMS KEK, derive
   per-purpose subkeys with HKDF, provision the device key into a write/read
   protected eFuse block at manufacturing, add an authenticated provisioning API
   with an idempotent state machine, and support rotation without reflashing.

---

## 1. Crypto material inventory

| Material | Size / format | Where it is set (firmware) | Where it is set (cloud) | Used for |
|---|---|---|---|---|
| Robot UUID | UTF-8 string, **max 16 bytes on the wire** | `CONFIG_APP_ROBOT_UUID` — `main/Kconfig.projbuild:174`, value in `sdkconfig:1057` (`"MPX-DOG-01"`) | `robots.robot_uuid` (text, PK) | Routing header + GCM **AAD** + DB lookup key + robot-token prefix |
| Robot AES key | 32 bytes / 64 hex chars | `CONFIG_APP_CHAT_AES_KEY_HEX` — `main/Kconfig.projbuild:185`, value in `sdkconfig:1058` (`…0001`) | `robots.aes_key_hex`; dev fallback `MPX_DEV_AES_KEY_HEX` | Chat frame AEAD, WASM MPXE unwrap, robot-token HMAC |
| Frame IV | 12 bytes, random per upstream frame | `crypto::random_bytes()` (hardware TRNG) | `os.urandom(12)` | GCM nonce |
| Auth tag | 16 bytes | mbedTLS GCM | `cryptography` AESGCM | Frame integrity |
| Per-skill key (ephemeral) | 32 bytes | n/a (decrypt-only) | `os.urandom(32)` in `cloud/core_gateway/crypto.py:260` | WASM blob encryption, wrapped by robot key, discarded |
| Robot token | `<uuid>.<32 hex>` | derived at runtime, `main/agent/agent_config.cc:216` | verified, `cloud/voice_gateway/vg/auth.py:120` | Bearer auth for `/v1/llm` (ESP-Claw agent) |
| Voice device token | 40 hex chars | obtained by OTA, stored in NVS `mpx_voice/ws_token` | derived `HMAC(VOICE_SECRET, "dev:"+device_id)` — `cloud/voice_gateway/app.py:60` | Bearer auth for the xiaozhi voice socket |
| Service token | string | `CONFIG_APP_PI_POWER_TOKEN` (unrelated path) | `MPX_RPC_SERVICE_TOKEN` | `/v1/robots/{uuid}/rpc` control API |

Note the asymmetry: the **voice device token is keyed on the MAC-derived
`Device-Id`**, not on the AES key. Only the ESP-Claw agent path (`/v1/llm`) uses
the AES-derived robot token. `md-mpx-dog`'s own voice socket uses the OTA device
token (`main/voice/mpx_voice_ws.c:417-431`).

---

## 2. Canonical binary frame format

Defined identically in three places — firmware, cloud crypto, cloud protocol
model. Any change must touch all three.

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 16 | `robot_uuid` | plaintext, **also the GCM AAD**, null-padded/truncated |
| 16 | 12 | `iv` | 96-bit GCM nonce |
| 28 | N | `ciphertext` | AES-256-GCM payload (UTF-8 JSON) |
| 28+N | 16 | `auth_tag` | 128-bit GCM tag |

References:

- `main/network/chat_ws.h:14-25` (`BinaryFrameHeader`, `BINARY_FRAME_HEADER_SIZE = 28`)
- `main/network/crypto.h:8-10` (`KEY_SIZE=32`, `IV_SIZE=12`, `TAG_SIZE=16`)
- `cloud/core_gateway/protocol/packets.py:11-17` (`HEADER_SIZE=28`, `TAG_SIZE=16`)
- `cloud/core_gateway/crypto.py:145` (`decrypt_frame`)

Because the UUID is the AAD, a frame cannot be re-targeted to another robot
without breaking the tag — that part of the design is sound. What is *not* in
the AAD is a direction flag, a key id, or a counter (see §6).

---

## 3. Firmware side

### 3.1 Where UUID and key come from

Both are **compile-time constants baked into the app image**:

```c
// main/network/chat_ws.cc:49
static constexpr const char *ROBOT_UUID  = CONFIG_APP_ROBOT_UUID;
static uint8_t s_aes_key[crypto::KEY_SIZE] = {};          // :52
```

Loaded once by `load_aes_key()` (`main/network/chat_ws.cc:588`), which calls
`crypto::hex_to_bytes(CONFIG_APP_CHAT_AES_KEY_HEX, s_aes_key, 32)`. If the
Kconfig string is not exactly 64 hex chars the chat pipeline is disabled
(`init_chat_pipeline()` at `main/network/chat_ws.cc:1453`).

`main/Kconfig.projbuild:174-232` documents the *intended* production model and
explicitly admits it is not implemented:

- "In production, this should be a factory-provisioned UUID and should match the
  key in NVS." — no NVS read exists anywhere for this key
  (`chat_ws.cc` only uses NVS for `allow_writes`).
- `CONFIG_APP_MPX_EFUSE_BLK` (`:215-232`) says: "eFuse key block support is not
  yet implemented. … the key is always read from Kconfig."
- Default key `000…0001` and default UUID `MPX-DOG-01` are committed in
  `sdkconfig:1057-1058` (tracked by git).

`wasm_decrypt.cc` is the only consumer that refuses an all-zero key, and only in
`NDEBUG` builds (`main/wasm/wasm_decrypt.cc:56-64`). The chat path happily runs
with the default key.

### 3.2 Chat encryption (upstream / downstream)

`build_upstream_frame()` (`main/network/chat_ws.cc:611`):

```c
std::memset(hdr->robot_uuid, 0, 16);
std::strncpy((char *)hdr->robot_uuid, ROBOT_UUID, 16);   // silent truncation
crypto::random_bytes(hdr->iv, crypto::IV_SIZE);          // fresh nonce per frame
crypto::gcm_encrypt(s_aes_key, hdr->iv,
                    hdr->robot_uuid, 16,                // AAD = uuid
                    json, json_len, ciphertext, tag);
```

`process_downstream_frame()` (`main/network/chat_ws.cc:723`) reads UUID and IV
**from the header** and calls `crypto::gcm_decrypt()` with the local
`s_aes_key`; the UUID in the header is *not* compared against
`CONFIG_APP_ROBOT_UUID` — the tag check is what binds it.

The AEAD primitive itself is thin mbedTLS (`main/network/crypto.cc:12-72`),
using the ESP32-S3 hardware AES engine transparently via
`CONFIG_MBEDTLS_HARDWARE_AES`. `hex_to_bytes()` (`crypto.cc:106`) is strict:
rejects wrong length and non-hex characters.

### 3.3 WASM skill decryption (MPXE)

`main/wasm/wasm_decrypt.cc` implements a two-layer scheme:

```
robot_root_key (CONFIG_APP_CHAT_AES_KEY_HEX)
    └─ GCM-unwrap ──→ per_skill_key            AAD "wasm-wrap:v1:<uuid>"     (:115-125)
            └─ GCM-decrypt ──→ wasm bytes      AAD "wasm-skill:v1:<sha256[:8]>" (:141-160)
```

Blob layout (fixed 86-byte header, mirrors the Python producer):

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `MPXE` |
| 4 | 1 | version `0x01` |
| 5 | 12 | `wrap_iv` |
| 17 | 48 | wrapped skill key (32 ct + 16 tag) |
| 65 | 1 | `key_algo` (reserved, 0x00) |
| 66 | 8 | `sha256(skill_id)[:8]` |
| 74 | 12 | `wasm_iv` |
| 86 | N | encrypted WASM ct |
| 86+N | 16 | tag |

Loaded through `wasm_sandbox.cc:474-512` — only `.wasm` and `.mpxe` extensions
are accepted, `.mpxe` is decrypted in memory, then the plaintext buffer is
zeroed and freed (`:532`). Note the AAD is the UUID string, so **a skill blob is
bound to one robot**: decrypting it under another robot's key fails the tag
check even if the key leaked between devices.

Caveat: the per-skill key is wrapped with the *same* root key that encrypts
chat, with the same 12-byte IV space and no direction separation. Both use
random IVs, so collision probability is negligible (96-bit birthday), but key
separation is still cleaner (see §7.2).

### 3.4 Robot token (HMAC bearer)

`main/agent/agent_config.cc:216-236`:

```c
const std::string msg = std::string("mpx-ai-v1:") + CONFIG_APP_ROBOT_UUID;
mbedtls_md_hmac(sha256, key, 32, msg.data(), msg.size(), mac);
return CONFIG_APP_ROBOT_UUID + "." + hex(mac[0..15]);   // 32 hex chars
```

Injected as the OpenAI-compatible `api_key` for the ESP-Claw agent when
`CONFIG_APP_AGENT_ENABLE` and the AI mode is `mangdang`
(`main/agent/agent_runtime.cc:65-75` + `main/Kconfig.projbuild:552-561`). The
token is recomputed on every boot and never persisted, so rotating the
underlying key rotates the token automatically.

Verification is `cloud/voice_gateway/vg/auth.py:120`:
`HMAC(robot_key, "mpx-ai-v1:" + uuid)` compared with `hmac.compare_digest`,
key looked up by UUID string. This is a **static bearer credential**: no
expiry, no nonce, so replay is possible for the lifetime of the key.

### 3.5 Voice provisioning (separate credential)

`main/voice/mpx_voice_ota.c`:

- Derives a stable device UUID from the Wi-Fi MAC —
  `"%02x%02x%02x%02x-%02x%02x-4000-8000-%02x%02x%02x%02x%02x%02x"` (`:106-115`,
  repeated at `:213-221`). Survives NVS erase; **not** the robot UUID.
- POSTs device info to `MPX_VOICE_DEFAULT_OTA_URL`; stores `websocket.url` and
  `websocket.token` in NVS namespace `mpx_voice` (`:42-43`, `:178-189`).
- `mpx_voice_connect()` sends `Authorization: Bearer <stored token>`,
  `Device-Id: <MAC>`, `Client-Id: <MAC>` (`main/voice/mpx_voice_ws.c:417-431`).

Cloud side this is the *device* token, not the *robot* token:
`Auth.device_token()` = `HMAC(VOICE_SECRET, "dev:" + device_id)[:40]`
(`cloud/voice_gateway/app.py:60`, `cloud/voice_gateway/vg/auth.py:98`). It proves
nothing about the AES key — a device that merely knows its own MAC can get one.
That is deliberate ("abuse is bounded by the per-device limits, not by the
token" — `vg/auth.py:1-20`), but it means the voice socket is not
cryptographically bound to the robot identity.

---

## 4. Cloud side (`../cloud/mpx-server`)

### 4.1 `core_gateway` key store

`cloud/core_gateway/crypto.py`:

| Function | Line | Behaviour |
|---|---|---|
| `_normalize_uuid()` | 35 | strip trailing NULs, truncate to 16, right-pad |
| `_load_dev_key()` | 43 | `MPX_DEV_AES_KEY_HEX` (must be 32 bytes) + `MPX_DEV_ROBOT_UUID` (default `MPX-DOG-01`) |
| `_get_key_store()` | 67 | lazily creates an **in-process dict** |
| `load_keys_from_db(pool)` | 76 | `SELECT robot_uuid, aes_key_hex FROM robots`, `bytes.fromhex`, skips rows whose key isn't 32 bytes |
| `register_key()` | 108 | manual in-memory insert (validation only, no DB write) |
| `lookup_key_by_uuid()` | 121 | dict hit, then null-stripped retry |
| `decrypt_frame()` | 145 | split frame, lookup, `AESGCM.decrypt(iv, ct||tag, aad=uuid)` |
| `build_downstream_frame()` | 190 | **fresh** `os.urandom(12)` IV |
| `build_downstream_frame_with_iv()` | 225 | **caller-supplied** IV (reused) |
| `encrypt_wasm_for_robot()` | 260 | MPXE producer mirroring the firmware |

The store is populated exactly once, in the FastAPI lifespan
(`cloud/core_gateway/main.py:105-120`, `await load_keys_from_db(pool)` at `:116`).
Consequences: a robot registered after boot **cannot connect until the gateway
restarts**; in-flight rotation is impossible; and if the DB is down at startup
the store keeps only the dev key (the exception is swallowed,
`crypto.py:100-102`).

`register_key()` has no caller in production code — it exists for tests.

### 4.2 Database row shape (as used)

There are **no migrations in the repository** — the schema lives outside it.
Every query against the table implies this shape:

```sql
-- inferred from the queries below; not in the repo
robots(
  robot_uuid   text PRIMARY KEY,
  aes_key_hex  text NOT NULL,              -- 64 hex chars, plaintext
  created_at   timestamptz,
  last_seen_at timestamptz
)
```

| Consumer | Query |
|---|---|
| `cloud/core_gateway/crypto.py:89` | `SELECT robot_uuid, aes_key_hex FROM robots` |
| `cloud/core_gateway/main.py:861` | `SELECT robot_uuid, aes_key_hex FROM robots WHERE robot_uuid = $1` (deploy) |
| `cloud/core_gateway/robots.py:66` | `INSERT INTO robots (robot_uuid, aes_key_hex) VALUES ($1,$2)` |
| `cloud/core_gateway/robots.py:81` | `SELECT robot_uuid, created_at, last_seen_at …` |
| `cloud/voice_gateway/vg/auth.py:81` | `SELECT robot_uuid, aes_key_hex FROM robots` |
| `cloud/mpx-wasm-deploy.py:69` | `SELECT aes_key_hex FROM robots WHERE robot_uuid = '…'` (string-interpolated SQL) |

`last_seen_at` is read by the API but never written by the ingress code — it is
always stale.

### 4.3 Chat ingress

`cloud/core_gateway/main.py:1030` `_handle_ingress`:

1. `socket.accept()`, then `async for message in socket.iter_bytes()`.
2. First frame must decrypt; failure ⇒ close 1008. This is the **only**
   authentication: possession of the key *is* the identity.
3. On success the UUID is decoded (`rstrip("\x00")`) and registered with
   `robot_rpc.register_robot()` so the cloud can push RPCs down the same socket.
4. Every later frame is decrypted and routed; failures are silently skipped.
5. Downstream: `build_downstream_frame()` (fresh IV) for streamed replies, but
   `build_downstream_frame_with_iv(robot_uuid, key, iv, …)` for `session_reset`
   responses (`:1211`) and queued-reply delivery (`:1158`, which passes a fresh
   IV despite the name).

### 4.4 WASM encryption on deploy

`cloud/core_gateway/main.py:820` `POST /v1/robots/{robot_uuid}/deploy`:

- fetches `aes_key_hex` for the robot (`:861-867`);
- if `encrypted` (default **true**) and the key is 64 hex chars, downloads the
  artifact from GCS and calls `encrypt_wasm_for_robot()` (`:931-944`), switching
  the robot path from `/slug.wasm` to `/slug.mpxe`;
- if the key is missing/invalid it **silently falls back to plaintext** (`:932-937`);
- base64-encodes the blob (NUL-padded to a multiple of 3 to dodge the firmware's
  padding bug) and returns Lua commands that write it to LittleFS.

`cloud/mpx-wasm-deploy.py` duplicates the same MPXE producer for the CLI
(`get_robot_key()` at `:69`). Two implementations of the same format is a
drift risk — they must be changed together.

### 4.5 `voice_gateway` key store and robot-token verification

`cloud/voice_gateway/vg/auth.py`:

- `KeyStore.__init__` (`:43`) seeds the dev key from `MPX_DEV_AES_KEY_HEX` /
  `MPX_DEV_ROBOT_UUID`.
- `KeyStore.get()` (`:56`) refreshes when the UUID is unknown **or** the cache is
  older than 300 s; `_refresh()` (`:66`) connects with `asyncpg`, re-reads the
  whole table, and swallows connection errors so the dev key keeps working.
- `Auth.check_robot_token()` (`:120`) splits on the **last** dot, requires a
  32-hex signature, looks up the key, recomputes the HMAC, compares with
  `compare_digest`.
- `/v1/llm` (`cloud/voice_gateway/vg/llm_proxy.py:119-124`) is the only endpoint
  that accepts the robot token; the voice socket accepts either a robot token or
  a device token (`Auth.identify`, `auth.py:101`).

This is the only component with a **time-based refresh** — a good model for
`core_gateway` to adopt (§7.6).

### 4.6 Development key path

`cloud/docker-compose.yml:9-12` injects the same constants as the firmware
default:

```
MPX_DEV_AES_KEY_HEX: …0001
MPX_DEV_ROBOT_UUID: MPX-DOG-01
```

`.env.example` documents them. So a stock build of firmware and a stock
`docker compose up` share a publicly known key for `MPX-DOG-01`. That is
acceptable for development but must be impossible to reach in production
(§7.5, fail-closed guards).

---

## 5. End-to-end flows

### 5.1 Chat (PWA → cloud → robot)

```
PWA --ws text--> firmware chat_ws
                    │ build_upstream_frame(): uuid|iv|AESGCM(json, aad=uuid)|tag
                    ▼
      cloud _handle_ingress: decrypt_frame() → lookup_key_by_uuid()
                    │ first frame = authentication
                    ▼
              OpenClaw agent (plaintext JSON in cloud memory)
                    ▼
      build_downstream_frame(): fresh iv per message
                    ▼
 firmware process_downstream_frame(): gcm_decrypt(aad=uuid) → commands
```

### 5.2 WASM skill deploy

```
POST /v1/robots/{uuid}/deploy
   → SELECT aes_key_hex
   → GCS download plain .wasm
   → per-skill key = urandom(32)
   → wrap skill key with robot key   (AAD "wasm-wrap:v1:<uuid>")
   → encrypt wasm with skill key     (AAD "wasm-skill:v1:<sha256(skill_id)[:8]>")
   → MPXE blob → base64 → Lua fs.write("/slug.mpxe")
firmware wasm.run("/slug.mpxe")
   → MPXE magic → unwrap with CONFIG_APP_CHAT_AES_KEY_HEX → decrypt → instantiate
```

### 5.3 Robot token (agent LLM)

```
boot:  robot_token() = uuid + "." + HMAC(aes_key,"mpx-ai-v1:"+uuid)[:32]
       → ESP-Claw llm_api_key
POST /v1/llm  Authorization: Bearer <token>
   → KeyStore.get(uuid) [dev env or DB, 300 s TTL]
   → recompute HMAC, compare_digest
```

---

## 6. Security review of the current design

Severity: **C**ritical / **H**igh / **M**edium / **L**ow.

### F1 — Key and UUID are compile-time constants, and `sdkconfig` is in git (C)

`main/Kconfig.projbuild:174-193` + `sdkconfig:1057-1058` (tracked by
`git ls-files`). Any per-device key placed in Kconfig ends up in the image, in
the build artifact, in `sdkconfig.old`, and in the repository. Since
`CONFIG_APP_CHAT_AES_KEY_HEX` is the *only* source of the key, "unique key per
device" today means "edit Kconfig, rebuild, reflash".

### F2 — One key, three purposes, no domain separation (H)

Chat AEAD, MPXE key wrapping, and the HMAC bearer token all use the raw root
key. Cross-protocol attacks are not obvious here, but the correct construction
is a KDF: `HKDF-SHA256(root, salt=robot_uuid, info="mpx/v1/"+purpose)`.

### F3 — GCM nonce reuse on the `session_reset` reply (H, exploitable)

`cloud/core_gateway/main.py:1204-1212` re-encrypts the reply with **the same key
and the same IV** as the inbound frame (`build_downstream_frame_with_iv(...,
iv, …)`). Two distinct plaintexts under one (key, nonce) pair:

- keystream reuse ⇒ XOR of the two plaintexts is recoverable;
- GCM's authentication key can be recovered from repeated nonces, allowing tag
  forgery for that robot.

The docstring in `crypto.py:225-243` claims this is safe because "each
request–response pair is unique and the IV was generated by the robot's
hardware TRNG" — but uniqueness of the *pair* does not make the nonce unused.
The firmware reads the IV from the downstream header
(`chat_ws.cc:723-750`), so there is no reason to reuse it.

### F4 — No replay protection on downstream frames (M-H)

The AAD is only the UUID. A captured downstream frame can be replayed to the
robot and will authenticate (e.g. old Lua `fs.write`/`robot_move` commands).
Mitigation: include a monotonic counter and/or timestamp in the AAD, or track
per-robot counters server-side and in NVS.

### F5 — No authentication on robot registration (C, if reachable)

`cloud/core_gateway/robots.py:38` `POST /v1/robots` has no auth dependency and no
middleware exists anywhere in `main.py`. Anyone reaching the port can insert
`(arbitrary_uuid, their_own_key)`, then open `/v1/chat/ingress` and be treated as
that robot for RPC registration, skill assignment, checkout, etc. Same for
`/deploy` and `GET /v1/robots` (which enumerates the fleet).

### F6 — DB stores raw key material; no KMS, no rotation, no audit (H)

`aes_key_hex` is plaintext, so a DB dump/backup/read-replica leak is a full
fleet compromise. There is no `key_version`, no `status`, no audit table, no
rotation endpoint, and no way to revoke a robot short of deleting the row (which
`core_gateway` will not notice until it restarts).

### F7 — UUID is a 16-byte field doubling as identity (M)

`strncpy(hdr->robot_uuid, ROBOT_UUID, 16)` (`chat_ws.cc:626-630`) truncates
silently; two UUIDs sharing the first 16 bytes map to the same frame identity.
The DB keys on the *string*, the frame keys on the *first 16 bytes*, and
`_normalize_uuid()` papers over the difference (`crypto.py:35`). Any UUID with
non-ASCII characters or >16 bytes is a footgun. Also, the UUID is a routing
header in cleartext, so the fleet is enumerable passively.

### F8 — Startup-only key load in `core_gateway` (M)

`main.py:116` → registration after boot does not take effect; the mirror issue
is that a *deleted* robot keeps working until restart. `voice_gateway` already
solves this with a TTL refresh; `core_gateway` should too (or use
`LISTEN/NOTIFY`).

### F9 — Silent plaintext fallback on deploy (M)

`main.py:932-937`: a robot with a missing/short key gets an unencrypted skill
and only a `logger.warning`. The firmware will still load a plain `.wasm`, so
the failure is invisible in the product.

### F10 — Default key accepted by the chat path, dev key shared with the cloud (H)

`…0001` / `MPX-DOG-01` is the default on both sides. `wasm_decrypt.cc:56-64`
refuses an all-zero key in release builds, but the chat path does no such check
and `…0001` is not all zeros anyway — so the check would not catch the actual
shipped default.

### F11 — Robot token is a static bearer credential (M)

`agent_config.cc:216` + `vg/auth.py:120`: no expiry, no nonce, no binding to a
connection. Compromise of one 32-hex token (it is sent on every LLM request and
may land in proxy logs) lasts until key rotation — which today requires a
reflash.

### F12 — Command-line SQL injection in the deploy tool (M)

`cloud/mpx-wasm-deploy.py:69` interpolates `robot_uuid` into SQL. Internal tool,
but it is run by humans and the input comes from argv.

---

## 7. Proposed design: automated generation and continuous sync

### 7.1 Goals and invariants

1. **Unique key per device.** No two robots share a key, in dev or prod.
2. **Key never leaves a boundary in plaintext.** Plaintext exists only in device
   RAM (eFuse read is blocked) and in cloud process RAM; at rest it is wrapped by
   a KMS KEK.
3. **Provisioning is idempotent and auditable.** Re-running the station command
   for the same robot must be a no-op or an explicit rotation, never a duplicate.
4. **The cloud learns about a new key without a restart**, and stops trusting a
   revoked key within a bounded time.
5. **Rotation does not require reflashing.** A robot must be able to accept a new
   key version over its existing key (or over a burned eFuse slot).
6. **Devices fail closed.** No default key in a release build; no plaintext
   fallback on deploy.

### 7.2 Key hierarchy

```
Cloud KMS (HSM) key ring, per environment
  KEK ─── wrap/unwrap ──→ per-robot DEK (32 B, random, per key_version)
                              │
                              ├─HKDF(info="mpx/v1/chat-up")   → uplink AEAD key
                              ├─HKDF(info="mpx/v1/chat-down") → downlink AEAD key
                              ├─HKDF(info="mpx/v1/wasm-wrap") → MPXE root key
                              └─HKDF(info="mpx/v1/robot-auth")→ robot-token HMAC key
```

Why derive: it removes the class of bug in F3 (different keys per direction, so a
reused nonce across directions cannot collide), gives independent rotation of
the auth credential, and lets a future protocol version add a purpose without
changing the stored secret.

Why envelope encryption: the DB/service never needs a long-lived master secret;
unwrapping is a KMS call with IAM + audit; the DB dump alone is useless.

*Trade-off to state explicitly:* because the cloud must decrypt chat and build
per-robot WASM blobs, this is **not** end-to-end encryption — the cloud holds the
plaintext key in RAM by construction. The security property we can achieve is
"hardware-bound secret + KMS-protected at rest + audited use", not "cloud cannot
read".

### 7.3 Where the key is generated

Two models; pick per manufacturing capability.

**Model A — server-generated (recommended for this product).**
The cloud must know the key, so generate it where it can be recorded atomically:

1. Station authenticates (mTLS client cert or short-lived JWT) and calls
   `POST /v1/provisioning/robots` with `{robot_uuid, serial, hw_rev}`.
2. Cloud generates `DEK = KMS.GenerateRandom(32)` (HSM TRNG, not `os.urandom`),
   wraps it with the KEK (`KMS.Encrypt`), inserts the row in state `pending`,
   and returns `{key_hex, key_version, kms_key_name}` **exactly once**
   (idempotency key = serial; a replayed request returns 409 with no key).
3. Station burns the key into eFuse and confirms; cloud flips `pending → active`.
4. Plaintext key is never persisted by the station: pipe it into `espefuse`
   directly (`--keyfile` on a tmpfs file deleted immediately, or stdin), and log
   only `fingerprint = HMAC(DEK,"fp:v1")[:8]`.

**Model B — device-generated.** The device draws from its own TRNG, burns eFuse,
and registers the key (or a KMS-wrapped copy) using a factory claim credential.
Stronger against station compromise, but the station must still transport the
key to the server (or the server must accept a device-supplied secret), which
usually ends up weaker in practice. Keep Model A unless stations are considered
untrusted.

Either way: **never** reuse the same key for two devices, and never derive the
key from the MAC (predictable).

### 7.4 Burning the key into the device (ESP32-S3 specifics)

Espressif's own guidance: enable flash encryption, unique per-device keys, and
protect the eFuse blocks read/write
([Flash Encryption — ESP32-S3](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/security/flash-encryption.html),
[Host-Based Security Workflows](https://docs.espressif.com/projects/esp-idf/en/v5.3.5/esp32s3/security/host-based-security-workflows.html)).

Concrete approach, matching the placeholders already in `Kconfig.projbuild:215`:

> **Correction (ESP32-S3 limitation).** `espefuse` documents key purpose `USER`
> as *"User purposes (software-only use)"* — the AES peripheral cannot consume
> it. Only `XTS_AES_256_KEY_1/2` are peripheral-bound, and only for flash/PSRAM
> encryption. The S3 also has **no Key Manager / HUK** (its security overview
> lists eFuse, AES, SHA, RSA_DS, HMAC and Memory Protection only). So on this
> chip a 32-byte GCM key **must** be software-visible at some point; the
> achievable goal is "not recoverable from a flash dump", not "never in RAM".
> See `SKILL_PROTECTION.md` §4 for the consequences.

1. Reserve a `BLOCK_KEYn` (n = `CONFIG_APP_MPX_EFUSE_BLK`, 1–5) with purpose
   `USER`, burn the DEK, and immediately set `RD_DIS` + `WR_DIS` on that block
   ([Burn Key — espefuse](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/espefuse/burn-key-cmd.html)).
   The key is then unreadable *offline*; the app reads it once at boot into RAM,
   protected by flash encryption + Secure Boot (item 3).
2. For the primitives that genuinely never expose the key, use the two
   hardware-only blocks the S3 does have:
   - `BLOCK_KEYn` purpose `HMAC_UP` → `esp_hmac_calculate()` for
     `device_id = HMAC(k_efuse, "mpx/v1/dev-id")` and other derived identifiers;
   - `BLOCK_KEYm` purpose `RSA_DS` (RSA-3072) → per-boot attestation signatures,
     private key never readable.
   Point the HAL at these blocks and never call `esp_efuse_read_block()`.
   Fall back to Kconfig only in dev builds.
3. Enable the platform protections these keys depend on — currently both are off
   (`sdkconfig:891` `CONFIG_SECURE_BOOT` not set, `sdkconfig:892`
   `CONFIG_SECURE_FLASH_ENC_ENABLED` not set). Without them the eFuse key block
   is protected but the rest of the flash is not.
4. If an eFuse slot is not available (already burned), fall back to NVS with NVS
   encryption enabled — `nvs_keys` partition protected by flash encryption
   ([NVS Encryption](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/storage/nvs_encryption.html),
   [NVS Partition Generator](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/storage/nvs_partition_gen.html)).
   That gives at-rest protection with flash encryption but is weaker than eFuse
   (key is in flash, decryptable while running).
5. Store `key_version` next to the key (eFuse USER block has spare words, or a
   small NVS record) so rotation is detectable.

Rotation with eFuse: burn the *next* slot, bump `key_version`, and keep the old
slot readable until the cloud confirms the switch (dual-slot rotation). If only
one slot exists, rotation requires a reflash or NVS-encrypted delivery (§7.7).

### 7.5 Authentication for the provisioning API

The gaps in F5 are the blocker for any automation — an unauthenticated
`POST /v1/robots` makes the whole scheme moot. Minimum:

- **Station → cloud:** mTLS client certificates issued per station, or a
  short-lived OIDC token with a `provisioner` claim. Reject everything else.
- **`GET /v1/robots`:** require the same credential; drop it from the public
  surface (it enumerates the fleet).
- **`/deploy`, `/rpc`:** already have `MPX_RPC_SERVICE_TOKEN` / JWT paths — make
  them mandatory, not optional (F5).
- **Ingress:** keep "first frame must authenticate" as the identity check, but
  add per-IP connection and frame-rate limits, and log
  `uuid, ip, kms_key_name, key_version` on every accept (the data needed to
  detect key sharing).
- **Fail closed:** if `MPX_DEV_AES_KEY_HEX` is set in a non-dev environment
  (env flag `MPX_ENV=prod`), refuse to start.

### 7.6 Sync between DB and the running services

Replace the startup-only load with a bounded, observable cache — the pattern
already proven in `voice_gateway`:

```
lookup(uuid):
   entry = cache.get(uuid)
   if entry and now - entry.loaded_at < TTL (60 s):  return entry
   row = await db.fetchrow("SELECT ... FROM robots WHERE robot_uuid=$1 AND status='active'")
   ...unwrap via KMS (cached per key_version), cache, return
```

Plus a **push** channel so new robots work immediately:

- `LISTEN robot_keys_changed` (Postgres `NOTIFY` from the provisioning endpoint)
  → invalidate that UUID, or the whole cache on `all`.
- Fallback poll every 60 s (cheap: one indexed query, or `SELECT max(updated_at)`).
- Negative caching for unknown UUIDs (short TTL) so a scanner cannot make the
  gateway hammer Postgres.
- KMS unwrap cache keyed by `(robot_uuid, key_version)`, in-memory, TTL ≈ 5 min;
  the wrapped blob is what the DB stores, so no long-lived plaintext on disk.
- `/healthz` exposes `keys_cached`, `cache_age_s`, `last_refresh_error` — the
  visibility that `core_gateway` lacks today.

For the deploy tool and any one-shot script, call the same endpoint or read the
same wrapped column and unwrap with KMS — do not keep a second plaintext path
(the `mpx-wasm-deploy.py:69` SQL string interpolation should become a
parameterized query through the API).

### 7.7 Schema and API sketch

```sql
CREATE TABLE robots (
  robot_uuid        text PRIMARY KEY,
  serial            text UNIQUE NOT NULL,          -- manufacturing id, idempotency key
  key_version       integer NOT NULL DEFAULT 1,
  aes_key_wrapped   bytea NOT NULL,                -- KMS ciphertext of the 32-byte DEK
  kms_key_name      text  NOT NULL,                -- projects/…/cryptoKeys/…
  key_fingerprint   text  NOT NULL,                -- HMAC(DEK,"fp:v1")[:16], never the key
  status            text  NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','active','rotating','revoked')),
  provisioned_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz,
  last_seen_ip      inet
);

CREATE TABLE robot_key_audit (
  id           bigserial PRIMARY KEY,
  robot_uuid   text NOT NULL,
  key_version  integer NOT NULL,
  action       text NOT NULL,        -- provision|activate|rotate|revoke|unwrap|auth_ok|auth_fail
  actor        text NOT NULL,        -- station id / service account / 'ingress'
  detail       jsonb NOT NULL DEFAULT '{}',
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON robot_key_audit (robot_uuid, at DESC);

-- migration path from today:
ALTER TABLE robots ADD COLUMN IF NOT EXISTS key_version integer DEFAULT 1,
                   ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';
-- 1. add aes_key_wrapped; 2. backfill by wrapping aes_key_hex via KMS;
-- 3. flip readers to the wrapped column; 4. DROP COLUMN aes_key_hex.
```

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/v1/provisioning/robots` | station mTLS | create `pending` + return key once (idempotent on `serial`) |
| `POST` | `/v1/provisioning/robots/{uuid}/confirm` | station mTLS | eFuse burned → `active` |
| `POST` | `/v1/provisioning/robots/{uuid}/rotate` | station mTLS | new `key_version`, return once, `rotating` |
| `POST` | `/v1/provisioning/robots/{uuid}/revoke` | admin JWT | `revoked`, invalidate cache, `NOTIFY` |
| `GET` | `/v1/provisioning/robots/{uuid}/attest` | station / robot | challenge-response proving the key matches |

Attestation is the missing verification step: the station (or the device itself)
computes `HMAC(DEK, nonce)` and the server compares against the wrapped key. This
is exactly the robot-token construction, so it reuses code and requires no new
primitive.

Device-side self-check on boot (cheap, high value): derive the robot token, call
`/v1/llm` `GET /healthz`-style probe, and log a distinct error if it returns 401 —
that single line distinguishes "wrong key" from "wrong URL" in the field.

### 7.8 Rotation

| Situation | Mechanism |
|---|---|
| Routine (per robot, N years) | `rotate` → new DEK + `key_version`; device burns next eFuse slot → confirm; both versions accepted for a grace window |
| Field device, one slot only | deliver the new key wrapped under the current key over the authenticated chat socket (a new downstream message type, e.g. `{"type":"key_rotate","kv":2,"wrapped":…}`), robot stores in NVS-encrypted storage, acks, server flips |
| Suspected compromise | `revoke` → cache invalidation via `NOTIFY`, ingress rejects the UUID, `robot_key_audit` records it; physical re-provision |
| Dev/default key | refuse to start in `MPX_ENV=prod`; CI check that `sdkconfig` has no non-default key |

Keep the old version decryptable until the device confirms, then mark it retired
and drop it from the KMS-wrapped set. Never re-use a version number.

### 7.9 Failure modes to handle explicitly

| Failure | Today | Proposed |
|---|---|---|
| Key mismatch | ingress closes 1008, robot silent | structured `auth_fail` audit row + device-side 401 probe with distinct log |
| DB down at startup | dev key only, warning swallowed | serve from cache; `/healthz` degraded; retry with backoff |
| Robot registered after boot | invisible until restart | `NOTIFY` + TTL refresh |
| Missing key on deploy | silent plaintext | 409 refusal unless `?plain=1` in dev |
| Two stations provision same serial | duplicate row / overwrite | unique `serial`, idempotency key, `pending` state |
| eFuse already burned | unknown | detect `RD_DIS`/purpose, fall back to NVS-encrypted or fail loudly |
| KMS unavailable | n/a | serve cached unwraps within TTL, else fail closed with 503 |

---

## 8. Rollout plan

**Phase 0 — stop the bleeding (no schema change).**
Add auth to `/v1/robots` (§7.5), fix the nonce reuse at `main.py:1211` (use
`build_downstream_frame`, the firmware reads the header IV anyway), make the
deploy plaintext fallback explicit, and reject the dev key in
`MPX_ENV=prod`. These are small, isolated changes.

**Phase 1 — schema + KMS (no firmware change).**
Add the columns, wrap existing keys with a Cloud KMS KEK, switch readers to the
wrapped column while keeping `aes_key_hex` as a shadow for one release, add
`robot_key_audit`. Introduce the TTL/`NOTIFY` cache in `core_gateway` and reuse
it from `mpx-wasm-deploy.py`. *Firmware is untouched, so rollout is safe.*

**Phase 2 — provisioning service + station tool.**
`POST /v1/provisioning/robots` with mTLS, the state machine, and a
`tools/provision_robot.py` that generates → burns eFuse → confirms → attests.
Add the eFuse read path behind `CONFIG_APP_MPX_EFUSE_BLK` on the firmware side
(the Kconfig help already promises it) with Kconfig as dev-only fallback.

**Phase 3 — key separation and rotation.**
Introduce HKDF purpose subkeys **with a protocol version byte in the AAD**
(`b"mpx/v1/up" + uuid` and so on) so old and new frames are distinguishable;
add `key_rotate` downstream message and dual-slot eFuse handling; retire the
`…0001` default.

**Phase 4 — hardening.**
Replay counters, robot-token expiry (bind to a short-lived nonce issued by
`/v1/llm`), fleet dashboards from `robot_key_audit`, and a documented
compromise/revocation runbook. NIST SP 800-130 is a useful checklist for the
policy side of this
([NIST SP 800-130](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-130.pdf)).

---

## 9. Research notes — how this is normally done

- **Envelope encryption (KEK/DEK).** Google KMS: generate DEKs locally, store
  them encrypted at rest near the data, never reuse a DEK across users, rotate
  by generating a new DEK rather than re-wrapping ciphertext
  ([Envelope encryption](https://cloud.google.com/kms/docs/envelope-encryption)).
  This maps directly onto "one DEK per robot, wrapped by one KEK per
  environment".
- **OWASP Key Management.** Keys must never be committed to source control or
  baked into build artifacts; they belong in a dedicated secrets manager; key
  material must be protected in memory and at rest, and rotation must be
  planned for compromise, not only for schedule
  ([OWASP Key Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html)).
  Both F1 and F6 violate this.
- **Espressif device-key practice.** Flash encryption and its keys should be
  unique per device, generated with a good entropy source and deleted from the
  host after burning; eFuse blocks can be burned with a key purpose and
  read/write protected
  ([esp-idf flash encryption](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/security/flash-encryption.html),
  [espefuse burn-key](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/espefuse/burn-key-cmd.html),
  [ESP Product Security guide](https://docs.espressif.com/projects/esp-product-security/en/latest/security-implementation.html)).
  NVS encryption is the fallback when eFuse slots are gone
  ([NVS encryption](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/storage/nvs_encryption.html)).
- **Fleet provisioning at scale.** The industry pattern is a claim/bootstrap
  credential that a device or station presents once, after which the device
  receives its unique identity; AWS IoT Fleet Provisioning does exactly this
  with a short-lived ownership token and a provisioning template
  ([AWS IoT fleet provisioning](https://aws.amazon.com/blogs/iot/how-to-automate-onboarding-of-iot-devices-to-aws-iot-core-at-scale-with-fleet-provisioning/),
  [CreateKeysAndCertificate](https://docs.aws.amazon.com/iot/latest/developerguide/fleet-provision-api.html)).
  The `pending → active → rotating → revoked` state machine in §7.7 is the same
  idea reduced to what this product needs.
- **Cloud IoT key handling.** Central inventory of every device credential, a
  documented rotation path, and no per-request database round trip are the
  recurring recommendations
  ([Google Cloud IoT backend best practices](https://cloud.google.com/architecture/connected-devices/bps-running-iot-backend-securely)).
  The latter is why §7.6 caches unwraps rather than calling KMS per frame.
- **Key management systems framework.** NIST SP 800-130's lifecycle phases
  (pre-operational, operational, post-operational, destroy) are a convenient
  checklist for what §7.7/§7.8 must cover
  ([NIST SP 800-130](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-130.pdf)).

---

## 10. Quick reference — where each piece lives

| Concern | Firmware | Cloud |
|---|---|---|
| Frame layout | `main/network/chat_ws.h:14-25` | `cloud/core_gateway/protocol/packets.py:11-17` |
| AEAD primitive | `main/network/crypto.cc:12-72` | `AESGCM` in `cloud/core_gateway/crypto.py` |
| Key source | `CONFIG_APP_CHAT_AES_KEY_HEX` (`main/Kconfig.projbuild:185`) | `robots.aes_key_hex` / `MPX_DEV_AES_KEY_HEX` |
| UUID source | `CONFIG_APP_ROBOT_UUID` (`main/Kconfig.projbuild:174`) | `robots.robot_uuid` |
| Upstream encrypt | `chat_ws.cc:611` | `crypto.py:145` (decrypt) |
| Downstream decrypt | `chat_ws.cc:723` | `crypto.py:190`, `crypto.py:225` |
| WASM unwrap | `main/wasm/wasm_decrypt.cc:100-165` | `crypto.py:260` |
| Deploy encryption | `main/wasm/wasm_sandbox.cc:474-512` | `cloud/core_gateway/main.py:820-945` |
| Robot token mint | `main/agent/agent_config.cc:216` | verify `cloud/voice_gateway/vg/auth.py:120` |
| Voice device token | `main/voice/mpx_voice_ota.c:178-189` | mint `cloud/voice_gateway/app.py:60` |
| Key cache | in-RAM `s_aes_key` | `crypto.py:64` (once), `vg/auth.py:43` (TTL) |
