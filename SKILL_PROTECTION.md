# Skill Protection & Marketplace Anti-Proliferation

**Companion documents:** `KEY_MANAGEMENT.md` (UUID/key lifecycle, F1–F12),
`IMPLEMENTATION.md` (ordered work packages).

**Constraining decision:** the hardware does **not** change. The ESP32-S3 stays.
This document is therefore about two achievable goals only:

1. **Raise cost** — make copying a skill require physical access, eFuse work, or
   a code-execution exploit, instead of one HTTP request or one `read_flash`.
2. **Detect and attribute** — make proliferation visible to a human reviewer, and
   make a leaked artifact point back at the device it leaked from.

**Explicit non-goal:** preventing a determined attacker who physically owns a
robot from reading the WASM. On ESP32-S3 that is not achievable (§4.1) and
pretending otherwise wastes the entire budget.

No code was changed to produce this document.

---

## 1. Assets and attacker model

| Asset | Value | Where it lives |
|---|---|---|
| Skill logic (WASM bytecode) | the product | GCS plaintext; encrypted copy on device |
| Per-skill key | decrypts one blob | inside the MPXE blob, wrapped by robot key |
| Robot AES key | decrypts all of that robot's skills | `robots.aes_key_hex`; `CONFIG_APP_CHAT_AES_KEY_HEX` |
| Marketplace listing + revenue | commercial | `marketplace_skills`, Stripe payouts |
| Fleet identifiers | targeting | `robots.robot_uuid`, `GET /v1/robots` |

| Attacker | Capability | Primary goal |
|---|---|---|
| **A1 Copycat dev** | marketplace account, no robot, HTTP | re-upload someone's skill as their own |
| **A2 Curious customer** | one robot, root-ish access to the board | run a paid skill without paying, or share it |
| **A3 Scraper** | network access to the gateway | bulk-download artifacts or keys |
| **A4 Determined pirate** | lab bench: flash read, JTAG/UART, glitching | extract WASM, redistribute |
| **A5 Hostile competitor** | HTTP | delist / deface a rival's listing |

A1 and A5 are the realistic threats, and both are **almost free today**. A4 is
out of scope for "fully stop"; it is in scope for "expensive + attributable".

---

## 2. What exists today

### 2.1 Publishing (`cloud/mpx-server/core_gateway/main.py:673`)

`POST /v1/publish`:

- JWT required (`:689-704`), `developer_id` from `sub`.
- Body: `skill_id, title, skill_type, source_language, version, artifact (base64), manifest` (`:706-717`).
- Semver enforced (`:728-731`); `skill_type` ∈ `WASM|AWA|CAPABILITY` (`:722-727`).
- **No artifact validation at all** — no WASM magic check, no import policy check,
  no size limit, no hash stored.
- Upload to GCS at a *predictable* path `skills/{skill_id}/versions/v{version}/skill.wasm` (`:734-736`, `:752-762`).
- Upsert `marketplace_skills` (`:775-779`) / bump `current_version` (`:781-800`) / insert
  `skill_versions` (`:801-805`).
- Returns `{"status": "published"}` (`:807-811`) — **live immediately, no gate.**

### 2.2 Delivery (`main.py:820`)

`POST /v1/robots/{robot_uuid}/deploy`:

```python
encrypted = body.get("encrypted", True)      # :851  ← caller decides
...
wasm_data = await _anyio.to_thread.run_sync(blob.download_as_bytes)   # :920 plaintext
if skill_encrypted:
    if not robot_key_hex or len(robot_key_hex) != 64:
        logger.warning("... falling back to plain deploy")            # :932-937
        skill_encrypted = False
    else:
        wasm_data = encrypt_wasm_for_robot(robot_uuid, robot_key, skill_id, wasm_data)  # :940
```

`encrypt_wasm_for_robot()` (`core_gateway/crypto.py:260`) wraps a fresh 32-byte
skill key under the robot key (AAD `wasm-wrap:v1:<uuid>`) and encrypts the WASM
under the skill key (AAD `wasm-skill:v1:<sha256(skill_id)[:8]><hex>`). Sound AEAD
construction, wrong trust model around it.

### 2.3 Marketplace admin routes

| Route | Line | Auth |
|---|---|---|
| `GET /v1/skills` (public list, `include=` override) | `main.py:192` | none |
| `GET /v1/skills/{id}`, `/versions`, `/manifest` | `:255,290,344` | none |
| `PATCH /v1/skills/{id}` (title, price, currency, **visibility**) | `:403` | **none** |
| `DELETE /v1/skills/{id}` (admin takedown → `visibility='removed'`) | `:559` | **none** |
| `POST /v1/robots`, `GET /v1/robots` | `robots.py:38,81` | **none** |

No middleware and no `Depends` anywhere in `core_gateway` (verified by search).

`marketplace.py:24` states the current posture in its own comment: *"no
telemetry, no reviews, no curation team."*

---

## 3. Findings

Severity: **C**ritical / **H**igh / **M**edium / **L**ow.

| ID | Finding | Sev | Ref |
|---|---|---|---|
| S1 | `encrypted:false` in the deploy body returns **plaintext WASM** to any caller | C | `main.py:851`, `:929-944` |
| S2 | `DELETE /v1/skills/{id}` is unauthenticated ⇒ anyone can delist a competitor | C | `main.py:559-579` |
| S3 | `PATCH /v1/skills/{id}` is unauthenticated ⇒ price/visibility tampering, un-remove a removed skill | C | `main.py:403-440` |
| S4 | `GET /v1/skills?include=all` exposes hidden **and admin-removed** listings without auth | H | `main.py:214-220` |
| S5 | `POST /v1/robots` + `GET /v1/robots` unauthenticated ⇒ fleet enumeration, key self-registration | C | `robots.py:38,66,81` |
| S6 | Plaintext `.wasm` sits in GCS; the bucket is the real IP boundary | H | `main.py:920` |
| S7 | Robot key is a git-tracked compile-time constant; flash encryption and secure boot are **off** | C | `sdkconfig:891,892,1058` |
| S8 | `robots.aes_key_hex` is plaintext ⇒ one DB dump decrypts every skill | H | `crypto.py:76`, `robots.py:66` |
| S9 | Skill blob AAD is `robot_uuid`, a *config string* ⇒ a copied flash image works on a clone board | H | `wasm_decrypt.cc:110-125` |
| S10 | Publish is instantaneous with no fingerprint, no review state, no approval gate | C | `main.py:807-811` |
| S11 | Deploy falls back to plaintext silently; only a `logger.warning` marks it | M | `main.py:932-937` |
| S12 | No deploy telemetry at all ⇒ proliferation is unobservable after the fact | M | `marketplace.py:24` |

**The shortest path an A1 copycat dev takes today:**

```
GET  /v1/robots                                             → enumerate the fleet          (S5)
POST /v1/robots/MPX-DOG-01/deploy {"encrypted": false}       → plaintext .wasm base64       (S1)
POST /v1/publish {artifact: <that base64>, version: 1.0.0}   → published instantly          (S10)
DELETE /v1/skills/haris_dev~backflipping                     → original delisted           (S2)
```

Four unauthenticated requests. No skill from any other developer should be
exfiltratable in fewer requests than it takes to deploy one.

---

## 4. Defense plan for fixed hardware

### 4.1 The hard limit, stated once

ESP32-S3 has **no Key Manager / HUK** (its security overview lists eFuse, AES,
SHA, RSA_DS, HMAC, Memory Protection only; Key Manager is C6/H2/P4-class). Its
eFuse key purposes are `USER` (*"software-only use"*), `XTS_AES_256_KEY_1/2`
(flash/PSRAM only), `HMAC_UP`, `DS`. Therefore:

- ❌ there is **no** non-extractable AES-GCM key. The robot key is in RAM while
  the frame or blob is being processed; any code execution on the chip yields it.
- ✅ an eFuse `HMAC_UP` key is hardware-only and unreadable.
- ✅ an eFuse `RSA_DS` RSA-3072 private key is hardware-only and unreadable.

So the achievable statement is: **a flash image or a key file is useless
elsewhere; a live-code attacker still wins.** Plan around that.

### 4.2 E1 — Close the free paths (hours, no firmware)

| Change | Ref |
|---|---|
| Delete the `encrypted` request parameter; the server decides | `main.py:851` |
| Refuse plaintext deploy unless `MPX_ENV=dev` **and** the caller is the robot owner | `main.py:929-944` |
| Auth `POST /v1/robots`, `GET /v1/robots` (service token, like `robot_rpc.py`) | `robots.py:38,81` |
| Auth `PATCH`/`DELETE /v1/skills/{id}` (admin scope, not developer scope) | `main.py:403,559` |
| Gate `include=hidden|all` behind admin auth | `main.py:214-220` |
| Auth `/deploy` (robot token, already implemented in `voice_gateway/vg/auth.py:120`) | `main.py:820` |

E1 alone kills A1 (no more plaintext grab), A3 (no enumeration), and A5 (no
unauthenticated takedown). It is the highest-value change in this document.

### 4.3 E2 — Make the artifact useless off-device (firmware config, ~1 week)

1. `CONFIG_SECURE_BOOT=y`, Secure Boot v2 / RSA-3072, key held offline.
2. `CONFIG_SECURE_FLASH_ENC_ENABLED=y` + `CONFIG_SECURE_FLASH_ENCRYPTION_MODE_RELEASE=y`.
3. Burn per unit: `RD_DIS`/`WR_DIS`, `DIS_DOWNLOAD_MODE`,
   `DIS_DOWNLOAD_MANUAL_ENCRYPT`, `SOFT_DIS_JTAG`/`HARD_DIS_JTAG`, `DIS_USB_JTAG`.
4. NVS encryption for anything secret stored outside eFuse.

Result: `read_flash` returns ciphertext; unsigned firmware will not boot; the
UART/USB download path can no longer read or write. Kills the "dump and diff"
half of A4 at hobbyist cost.

### 4.4 E3 — Bind the blob to the silicon, not to a string (1–2 weeks)

Today `wasm-skill:v1:<sha256(skill_id)[:8]>` and `wasm-wrap:v1:<robot_uuid>` bind
a blob to identifiers the attacker also possesses. Add hardware-derived material:

```
device_id  = HMAC(efuse_hmac_key, "mpx/v1/dev-id")        # unreadable, per-chip
wrap_aad   = "wasm-wrap:v2:" || device_id || skill_id || version || not_after
skill_aad  = "wasm-skill:v2:" || device_id || skill_id || version || not_after
```

`device_id` and `DS_pubkey` are registered at provisioning. Use RSA_DS to sign a
server nonce on every boot and gate delivery on that signature.

Consequence: a clone board with a byte-perfect copy of the flash and the key
still fails — it has no HMAC eFuse key to compute `device_id` and no DS private
key to sign. **This is the only change that makes key copying pointless on fixed
hardware.** Requires the `v2` AAD on both sides, so it ships behind a protocol
version byte (`wasm_decrypt.cc:141-160`, `crypto.py:296-300`).

### 4.5 E4 — `not_after` (days, piggybacks on E3)

Add an expiry to the AAD. A leaked `.mpxe` self-destructs. Re-issue on an
authenticated heartbeat (the robot already polls; `http_server.cc:2504` has the
gateway config path). Does nothing against a *decrypted* WASM, which is why E5
and E6 exist.

### 4.6 E5 — Detection (§5)

Fingerprint every published artifact and route suspicious uploads to a human.
This is the answer to "same skill proliferating for free by another dev".

### 4.7 E6 — Attribution (§6)

Per-device watermark in the deployed artifact so a leaked-then-re-uploaded copy
identifies the source device.

### 4.8 Priority

| Order | Change | Effort | Stops |
|---|---|---|---|
| 1 | E1 | 2–3 d | A1, A3, A5 — all free paths |
| 2 | E2 | 5 d + burn | offline decrypt, custom firmware |
| 3 | E5 | 8–10 d | undetected re-upload |
| 4 | E3 + E4 | 10 d | clone-with-copied-key |
| 5 | E6 | 2 d | unattributable leak |

---

## 5. Detection — fingerprinting and human review

### 5.1 Signals to compute at publish time

Run in a thread (the upload path already uses `_anyio.to_thread` for GCS):

| Signal | How | Survives |
|---|---|---|
| `sha256(file)` | trivial | nothing (exact only) |
| `sha256(wat_norm)` | `wasm-tools print` → drop custom + name sections, normalize locals/whitespace/comments | re-encode, `wasm-opt` layout changes |
| **function hash set** | parse the code section; for each function hash the opcode stream with immediates masked into a separate multiset | function reordering, renamed exports, added wrappers, dead-code insertion |
| string multiset | hash each data-segment string literal | literal renaming, but not rewriting |
| TLSH | fuzzy hash of the whole binary | loose net / near-copies |
| manifest capability set | imports + `requires[]` | intent-level similarity |

The **function hash set** is the workhorse: `J(A,B) = |A∩B| / |A∪B|` over sorted
32-byte digests. It is explainable to a reviewer ("47 of 52 functions identical")
and robust to everything a re-uploader can do in an afternoon.

### 5.2 Decision policy (only across *different* developers)

| Condition | Action |
|---|---|
| `sha256` or `sha256_wat` matches an existing artifact | **reject** with `409 duplicate_of`, write `skill_fingerprints` evidence |
| `J ≥ 0.70` **or** string-set `J ≥ 0.60` | `review_state='pending'`, `visibility='hidden'`, queue for human |
| `0.40 ≤ J < 0.70` | auto-publish with `similar_to` badge; reviewer optional |
| `J < 0.40` | auto-publish |
| same `developer_id` | never gated (these are versions of one skill) |

Threshold rationale: bytecode-level forks retain the majority of function bodies;
independent implementations of the same behaviour share almost none. Tune on the
first 50 real pairs before tightening.

### 5.3 Schema

```sql
ALTER TABLE marketplace_skills
  ADD COLUMN IF NOT EXISTS review_state text NOT NULL DEFAULT 'pending'
      CHECK (review_state IN ('pending','approved','rejected','flagged')),
  ADD COLUMN IF NOT EXISTS reviewed_by text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS similar_to text;      -- "<skill_id>@<version>" or NULL

CREATE TABLE IF NOT EXISTS skill_fingerprints (
  skill_id      text NOT NULL,
  version       text NOT NULL,
  developer_id  bigint NOT NULL,
  sha256        text NOT NULL,
  sha256_wat    text,
  tlsh          text,
  func_hashes   bytea[] NOT NULL,
  string_hashes bytea[] NOT NULL,
  similarity_max real NOT NULL DEFAULT 0,        -- vs other developers
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version)
);
CREATE INDEX ON skill_fingerprints (developer_id);

CREATE TABLE IF NOT EXISTS skill_review (
  id          bigserial PRIMARY KEY,
  skill_id    text NOT NULL,
  version     text NOT NULL,
  similar_to  text,
  similarity  real,
  decision    text NOT NULL,           -- approve | reject | attribution | escalate
  reviewer    text NOT NULL,
  note        text,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skill_deploy_log (
  id          bigserial PRIMARY KEY,
  robot_uuid  text NOT NULL,
  skill_id    text NOT NULL,
  version     text NOT NULL,
  ip          inet,
  encrypted   boolean NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON skill_deploy_log (skill_id, at DESC);
```

`marketplace_skills.visibility` currently has `public|hidden|removed` and every
read path already filters on it (`marketplace.py:200,329`; `main.py:216-227`), so
`hidden` + `review_state='pending'` gates the storefront with **zero read-path
changes**.

### 5.4 Publish flow after the change

```
POST /v1/publish
  ├─ validate JWT, semver, skill_type                     (existing)
  ├─ NEW: WASM magic + header check, size cap, manifest schema
  ├─ NEW: fingerprint(file) → insert skill_fingerprints
  ├─ NEW: compare vs fingerprints of other developer_id
  │        ├─ exact match → 409 duplicate_of        (reject)
  │        ├─ J ≥ 0.70    → review_state=pending, visibility=hidden
  │        └─ else        → review_state=approved,  visibility=public
  └─ respond {"status": "published" | "pending_review", "similar_to": …}
```

Never return `published` when the row is hidden — the current `:807-811`
response is what makes the absence of review invisible to the developer and to
the storefront.

### 5.5 Reviewer queue (`mpx-admin`)

`mpx-admin` already reads skills (`server/src/db.ts:107-108` `GET /skills`) but
has no write routes. Add one screen and one action endpoint:

```
QUEUE  (review_state='pending' ORDER BY created_at)

┌───────────────────────────────────────────────────────────────────────────┐
│ backflip-pro v1.2.0        dev_1137            92% similar                │
│   match: haris_dev~backflipping v1.0.3   by dev_2041   11 weeks earlier   │
│   47/52 functions identical · 8/9 string literals shared · TLSH distance 12│
│   dev_1137 history: 3 publishes, 0 prior flags · price $4.99              │
│   [Approve as original] [Reject: duplicate] [Approve with attribution]    │
│   [Request source] [Escalate]                          note: ___________   │
└───────────────────────────────────────────────────────────────────────────┘
```

Every action writes `skill_review` plus the `marketplace_skills` update in one
transaction, so the audit trail and the storefront state cannot diverge.

### 5.6 Precedence

Precedence = earliest `skill_fingerprints.created_at` for the matching hash set,
recorded immutably at publish. It does **not** depend on who complains first, and
it survives a `DELETE`/`visibility` change. Store it, don't recompute it.

---

## 6. Attribution — watermarking

Honest framing: a watermark does not prevent extraction. It converts "someone
leaked our skill" into "device `a1b2c3d4` leaked it on 2025-09-14", which is what
makes enforcement and charging possible.

Injection point: `encrypt_wasm_for_robot()` (`crypto.py:260`) mutates
`wasm_bytes` **before** step 4 (`aesgcm_wasm.encrypt`), so the marker lives inside
the ciphertext of that one robot's blob.

| Tier | Technique | Cost | Durability |
|---|---|---|---|
| T1 | Append custom section `mpx.wm` = `device_id[0:8] ‖ issue_epoch ‖ skill_version` | 0.5 d | stripped by anyone who knows to look |
| T2 | Add an exported unused function returning an `i64` constant encoding the marker | 1 d | survives naive stripping, dies to `wasm-opt -O` + DCE |
| T3 | Semantically bound constant: perturb one benign parameter (e.g. gait scale) by `1e-7 × device_id` | 1 d | survives recompilation only if the code is not rewritten |

Recommend T1 + T2 together (2 d total). Tier 3 changes behaviour; only do it if
the motion team signs off on the tolerance.

Detection of a leaked marketplace upload: decompile with `wasm2wat`, search for
`mpx.wm` or the marker constant range; cross-reference `device_id` against
`robots`. Note the marker identifies the **device**, so pair it with
`skill_deploy_log` to name the account that owned that robot.

---

## 7. Policy and enforcement

Technical controls without a consequence are theatre. Minimum policy set:

1. **ToS:** originality warranty; grant of distribution rights for marketplace
   distribution; explicit ban on re-uploading another developer's artifact with
   or without modification.
2. **Process:** a DMCA-style notice → 72 h response window → decision by a named
   reviewer → appeal path. Log every step in `skill_review`.
3. **Escalation ladder:** warning → delist (`visibility='removed'`) → payout hold
   → account suspension → ban. `mpx-admin` already owns payouts
   (`server/src/payouts.ts:155`), so the ladder is executable with existing
   tooling.
4. **Evidence retention:** keep `skill_fingerprints` + `skill_review` +
   `skill_deploy_log` forever; a takedown without a recorded similarity snapshot
   is indefensible.
5. **Refund/attribution option:** "Approve with attribution" (revenue share to the
   original author) is often better commercially than a takedown — it keeps the
   listing live and converts a copy into a licence.

---

## 8. Residual risk (say it out loud)

| Risk | After all of §4–§7 |
|---|---|
| Attacker with the physical robot dumps RAM while a skill runs | **Still possible.** Requires a live-code position (exploit or glitching); watermark makes the copy attributable, `not_after` limits its useful life. |
| Attacker patches the firmware to print decrypted WASM before executing | Blocked by Secure Boot (E2) — until someone finds a signature-verification or glitching path. Published work exists for glitching older ESP32 parts; assume the class is live. |
| Attacker reverse-engineers and reimplements the logic by hand | Out of scope for any cryptography. Detection = similarity review; it will score low and is legally a clean-room copy. |
| Insider with GCS or DB access | Out of scope: they hold the plaintext by design. Mitigate with IAM, access logs, CMEK. |
| Cloud must decrypt ⇒ not end-to-end encrypted | Permanent property of this architecture. |

---

## 9. Metrics

Watch these weekly; each maps to a finding above:

| Metric | Healthy | Signals |
|---|---|---|
| unauthenticated 4xx on market/deploy routes | 0 | E1 deployed |
| `deploy` calls with `encrypted=false` | 0 in prod | S1 regression |
| share of publishes reaching `published` without review | trending to 0 | S10 fixed |
| `pending` review queue age (p95) | < 48 h | backlog → proliferation window |
| duplicate rejections / month | any | detector working |
| `similar_to` badge rate | < 2% of publishes | threshold sanity |
| `device_id` seen from > 1 IP in a day | 0 | clone / key copy |
| skills deployed from a robot with no marketplace order | 0 | A2 bypass |

---

## 10. Rollout order

1. **E1** — close the free paths (2–3 d). Without this, everything else is
   decoration.
2. **E2** — flash encryption + secure boot + JTAG disable (5 d + per-unit burn).
3. **E5** — fingerprints + `pending` gate + reviewer queue (8–10 d).
4. **E6** — watermark T1/T2 (2 d).
5. **E3 + E4** — `device_id` AAD + `not_after` (10 d, needs a protocol version byte).
6. **§7 policy** — ToS and the enforcement runbook (1 d + counsel).

Steps 1–4 need **no firmware change and no hardware change**, and they take the
copycat path from four unauthenticated requests to "own a robot, break Secure
Boot, defeat a reviewer, and survive a watermark check".
