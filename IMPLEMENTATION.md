# Implementation Plan — Key Management & Skill Protection

**This is the "what to do" document.** It turns the two analysis documents into
ordered, verifiable work:

- `KEY_MANAGEMENT.md` — UUID + AES-256-GCM key lifecycle, findings F1–F12, target design.
- `SKILL_PROTECTION.md` — anti-piracy threat model, findings S1–S12, detection design.
- **`IMPLEMENTATION.md` (this file)** — the work packages, in the order they must ship.

Roots: firmware `/home/hharis/Mangdang/md-mpx-dog`, cloud
`/home/hharis/Mangdang/cloud/mpx-server`, admin `/home/hharis/Mangdang/mpx-admin`.
All `main.py` / `crypto.py` / `robots.py` / `marketplace.py` references are under
`cloud/mpx-server/core_gateway/`.

No code was changed while writing these documents.

---

## 0. The one-paragraph summary

Today a stranger can enumerate the fleet, download any skill as plaintext, publish
it as their own, and delist the original — all with unauthenticated HTTP. The
robot key is a git-tracked compile-time constant, flash encryption is off, and
skills sit as plaintext in GCS. Fix that first (P0/P1, ~2 weeks, no firmware
change). Then stop key copying with eFuse-bound identity (P3) and make
proliferation detectable and attributable (P2/P4).

---

## 1. Work packages at a glance

| ID | Package | Effort | Depends on | Firmware? | Kills |
|---|---|---|---|---|---|
| **P0** | Close the free paths (auth + no plaintext deploy) | 2–3 d | — | no | S1 S2 S3 S4 S5 S11 |
| **P1** | Secret hygiene in cloud (KMS envelope, key cache, GCS) | 5–6 d | P0 | no | S6 S8 |
| **P2** | Publish gate + fingerprints + reviewer queue | 8–10 d | P0 | no | S10 |
| **P3** | Device hardening: flash enc, secure boot, JTAG, eFuse | 8–10 d | — | **yes** | S7 |
| **P4** | Hardware-bound identity: `device_id` AAD + attestation | 10 d | P3 | **yes** | S9 |
| **P5** | Attribution: watermark + deploy telemetry | 2–3 d | P2 | no | S12 |
| **P6** | Policy: ToS, enforcement runbook, takedown flow | 1 d + counsel | P2 | no | — |
| **P7** | Crypto correctness fixes (nonce reuse, replay) | 1–2 d | — | no | F3 F4 |

**Total ≈ 38 dev-days.** P0 is the only genuinely urgent package.

---

## 2. First 48 hours

Ship these five edits before anything else. Each is small and independently
revertable.

| # | File:line | Change |
|---|---|---|
| 1 | `main.py:851` | Delete `encrypted = body.get("encrypted", True)`. Replace with `encrypted = True` and a server-side env check. |
| 2 | `main.py:929-944` | If `encrypted` cannot be satisfied, return **409** — do not fall through to plaintext (`:932-937`). |
| 3 | `main.py:559-579` | Add admin auth to `DELETE /v1/skills/{skill_id}`. |
| 4 | `main.py:403-440` | Add admin auth to `PATCH /v1/skills/{skill_id}`; developers keep edit rights only for rows they own. |
| 5 | `robots.py:38,81` | Add service-token auth to `POST /v1/robots` and `GET /v1/robots`. Reuse the pattern in `robot_rpc.py:215-330`. |

Also, before deploying: **rotate `CONFIG_APP_CHAT_AES_KEY_HEX` and remove it from
`git` history** (`sdkconfig:1058`) — the old value must be considered public.

---

## 3. P0 — Close the free paths

**Goal:** no unauthenticated path returns a skill artifact, a key, or a fleet list.

**Why:** S1–S5, S11 in `SKILL_PROTECTION.md` §3. A copycat needs four HTTP requests
today; the goal is that they need a robot.

### Changes

| File:line | Change |
|---|---|
| `main.py:820-825` | Require auth on `POST /v1/robots/{uuid}/deploy`: robot token (`voice_gateway/vg/auth.py:120` construction) or service token. Reject with 401 before touching the DB. |
| `main.py:851` | Remove the caller-controlled `encrypted` flag. |
| `main.py:929-944` | On missing/invalid key: 409 `{"error": "robot has no usable key"}`. No plaintext fallback outside `MPX_ENV=dev`. |
| `main.py:403-440` | `PATCH`: admin scope for any skill; developer scope only when `developer_id` matches the JWT `sub`. |
| `main.py:559-579` | `DELETE`: admin scope only. |
| `main.py:214-220` | `include=hidden|all` requires admin scope; storefront default stays `visibility='public'`. |
| `robots.py:38-79` | `POST /v1/robots`: service token; reject `aes_key_hex` supplied by the caller once P1 lands (server generates). |
| `robots.py:81-99` | `GET /v1/robots`: service token; drop `last_seen_at` until something writes it. |
| `main.py:673-811` | `POST /v1/publish`: keep JWT, add artifact validation (WASM magic `\0asm`, version field, size cap, manifest schema). |

### Steps

1. Add a `require_admin(request)` helper next to the existing JWT decode block
   (`main.py:689-704`) and a `require_service(request)` mirroring
   `robot_rpc.py:215-330`. One place, three call sites minimum.
2. Apply per the table; keep each route's docstring in sync — `main.py:409-431`
   currently documents "the portal session is the gate", which is not true.
3. Add a startup assert: if `MPX_ENV != "dev"` and `MPX_DEV_AES_KEY_HEX` is set,
   refuse to boot.
4. Rotate the shipped key; document the new value only in the secret manager.

### Acceptance

```bash
BASE=https://<gateway>

# must be 401 for every one of these
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/v1/robots/MPX-DOG-01/deploy -d '{}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/v1/robots -d '{"robot_uuid":"X","aes_key_hex":"'$(printf 'a%.0s' {1..64})'"}'
curl -s -o /dev/null -w '%{http_code}\n' $BASE/v1/robots
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE $BASE/v1/skills/some~skill
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH $BASE/v1/skills/some~skill -d '{"visibility":"public"}'
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/v1/skills?include=all"

# must be 409, never plaintext
curl -s -X POST $BASE/v1/robots/no-such-robot/deploy -H "Authorization: Bearer $ROBOT" \
  -d '{"encrypted": false}'
# → {"error": "robot has no usable key"}; response body must NOT contain "wasm_base64"
```

**Rollback:** each route is an independent revert. Keep the old plaintext-deploy
behaviour behind `MPX_ENV=dev` so QA can still test locally.

**Effort:** 2–3 dev-days. **Risk:** medium — the PWA/admin portal may be relying
on the unauthenticated `PATCH`; confirm with whoever owns `mpx-marketplace`.

---

## 4. P1 — Secret hygiene in the cloud

**Goal:** a database dump or an object-storage mistake yields no usable key.

**Why:** S6, S8, F6, F8 in `KEY_MANAGEMENT.md` §6.

### Changes

| File:line | Change |
|---|---|
| `crypto.py:64-105` | Key store reads `aes_key_wrapped` + `kms_key_name`, unwraps via KMS, caches by `(uuid, key_version)` with a 5-minute TTL. |
| `crypto.py:100-102` | Stop swallowing refresh errors silently; surface them on `/healthz` (`main.py:135`). |
| `main.py:116` | Replace the single startup `load_keys_from_db(pool)` with the TTL/NOTIFY cache; add `LISTEN robot_keys_changed`. |
| `main.py:861-867` | Deploy path uses the same cache (no direct `SELECT aes_key_hex`). |
| `mpx-wasm-deploy.py:69` | Delete this path; call the deploy API instead. It is also a string-interpolated SQL bug (F12). |
| GCS (infra) | Private bucket, uniform bucket-level access, CMEK, access logs, no `allUsers`/`allAuthenticatedUsers`. |

### Schema (migration; the repo has none today — put it in `cloud/migrations/`)

```sql
ALTER TABLE robots
  ADD COLUMN IF NOT EXISTS key_version     integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS aes_key_wrapped bytea,
  ADD COLUMN IF NOT EXISTS kms_key_name    text,
  ADD COLUMN IF NOT EXISTS key_fingerprint text,
  ADD COLUMN IF NOT EXISTS status          text NOT NULL DEFAULT 'active';

CREATE TABLE IF NOT EXISTS robot_key_audit (
  id bigserial PRIMARY KEY,
  robot_uuid text NOT NULL,
  key_version integer NOT NULL,
  action text NOT NULL,
  actor text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
```

Backfill: wrap every existing `aes_key_hex` with KMS, write `key_fingerprint`,
leave the plaintext column in place for one release as a shadow, then drop it
(`ALTER TABLE robots DROP COLUMN aes_key_hex`).

### Acceptance

- `grep -rn "aes_key_hex" cloud/` returns only the migration and the backfill script.
- `psql -c "select robot_uuid, length(aes_key_wrapped) from robots"` → non-null, `bytea`.
- Registering a robot while the gateway is running works **without restart**
  (`NOTIFY` path) within 2 s; a deleted robot is rejected within 60 s (TTL path).
- `/healthz` reports `keys_cached`, `cache_age_s`, `last_refresh_error`.

**Effort:** 5–6 dev-days. **Risk:** medium — KMS IAM and the NOTIFY listener are
the two things that break in production. Ship behind a flag, dual-read
(wrapped-or-plaintext) for one release.

---

## 5. P2 — Publish gate and review

**Goal:** no skill reaches the storefront without a fingerprint and, when
suspicious, a human decision.

**Why:** S10, S12; `SKILL_PROTECTION.md` §5.

### Changes

| File:line | Change |
|---|---|
| `main.py:745-750` | Validate the artifact before upload: WASM magic, declared size, manifest schema, `skill_type` consistency. |
| `main.py:752-767` | Compute fingerprints (file sha256, normalized-WAT sha256, function hash set, string multiset, TLSH) before the GCS upload. |
| `main.py:775-779` | Insert with `visibility='hidden'`, `review_state` from the similarity decision. |
| `main.py:807-811` | Return `{"status": "pending_review", "similar_to": …}` instead of `published` when gated. |
| new `core_gateway/fingerprint.py` | Similarity module: `fingerprint(bytes) -> Fingerprint`, `compare(a, b) -> dict`. |
| `mpx-admin/server/src/db.ts:107` | New `GET /skills/queue`, `POST /skills/{id}/review`. |
| `mpx-admin/client/src/screens/` | New `ReviewQueue.tsx` using the wireframe in `SKILL_PROTECTION.md` §5.5. |

### Steps

1. Land the DDL from `SKILL_PROTECTION.md` §5.3.
2. Implement `fingerprint.py` against `wasm-tools print` (or the `wasmparser`
   crate via a small sidecar) — function hash set first, TLSH optional.
3. Compute similarity lazily against fingerprints of **other** `developer_id`s
   only; cap the comparison set (e.g. latest 500 versions) to keep publish fast.
4. Default `review_state` to `pending`; auto-approve only when `J < 0.40`.
5. Build the queue screen and the review action (transactional with
   `visibility`).
6. Backfill fingerprints for existing skills before enforcing.

### Acceptance

- Publishing a byte-identical copy of an existing skill from another developer
  returns `409 duplicate_of`.
- Publishing a `wasm-opt`-reprocessed copy returns `pending_review` with `J ≥ 0.70`.
- Publishing a genuinely new skill returns `published` and is visible in
  `GET /v1/skills`.
- A `pending_review` row is absent from `GET /v1/skills` and present in the admin
  queue.
- Reviewer approval flips `visibility` and writes exactly one `skill_review` row.

**Effort:** 8–10 dev-days. **Risk:** the similarity threshold is a policy choice,
not a technical one — ship with `J ≥ 0.70` and a `similar_to` badge, measure for
two weeks, then tighten.

---

## 6. P3 — Device hardening (firmware, no hardware change)

**Goal:** a flash image or a dumped key is worthless off-device.

**Why:** S7, F1, F10. Both platform protections are currently **off**:
`sdkconfig:891` `CONFIG_SECURE_BOOT` not set, `sdkconfig:892`
`CONFIG_SECURE_FLASH_ENC_ENABLED` not set.

### Changes

| Item | Detail |
|---|---|
| `sdkconfig` / `sdkconfig.defaults` | `CONFIG_SECURE_BOOT=y`, `CONFIG_SECURE_FLASH_ENC_ENABLED=y`, `CONFIG_SECURE_FLASH_ENCRYPTION_MODE_RELEASE=y`, `CONFIG_SECURE_BOOT_V2_RSA_*` per Espressif workflow. |
| Signing | RSA-3072 (or ECDSA on newer parts); signing key offline, never in CI secrets. |
| eFuse per unit | `RD_DIS`, `WR_DIS` on the key block; `DIS_DOWNLOAD_MODE`, `DIS_DOWNLOAD_MANUAL_ENCRYPT`, `SOFT_DIS_JTAG`/`HARD_DIS_JTAG`, `DIS_USB_JTAG`. |
| NVS | NVS encryption enabled for anything secret outside eFuse. |
| `main/Kconfig.projbuild:174-193` | Remove the shipped default key and UUID; make the build fail if they are left at the default in a non-dev build. |
| `sdkconfig:1057-1058` | Remove from git; replace with placeholders. |

Note the platform limit from `KEY_MANAGEMENT.md` §7.4 (corrected): the `USER`
eFuse purpose is software-readable, so there is no non-extractable GCM key on
ESP32-S3. P3 is about closing offline extraction, not about hiding the key from
live code.

### Acceptance

- `espefuse.py -p <port> summary` shows `RD_DIS`/`WR_DIS` set, `DIS_DOWNLOAD_MODE=1`, `HARD_DIS_JTAG=1`.
- `esptool.py read_flash` output contains no `\0asm` and no ASCII skill name.
- Flashing an unsigned image is refused by the bootloader.
- Booting with an erased NVS still recovers the key from eFuse (or fails closed).
- `git log -p -- sdkconfig | grep -i aes` shows no real key after the rotation.

**Effort:** 5 dev-days engineering + burn time per unit. **Risk:** high —
flash encryption in release mode is one-way per unit. Prototype on 3 sacrificial
boards with the production partition layout before any manufacturing claim.

---

## 7. P4 — Hardware-bound identity

**Goal:** copying the key (or the whole flash) to another board stops working.

**Why:** S9, F7. Today the AAD is `robot_uuid` — a config string the attacker
also copies (`wasm_decrypt.cc:110-125`, `crypto.py:283-300`).

### Changes

| Side | Change |
|---|---|
| Firmware | Burn `BLOCK_KEYn` purpose `HMAC_UP`; `device_id = esp_hmac_calculate(key, "mpx/v1/dev-id")`. Derive `wrap_aad` / `skill_aad` v2 with `device_id ‖ skill_id ‖ version ‖ not_after`. |
| Firmware | Optional but recommended: burn `BLOCK_KEYm` purpose `RSA_DS`; sign `server_nonce ‖ device_id ‖ boot_counter` on boot and send it with the deploy request. |
| Cloud | `crypto.py:260` `encrypt_wasm_for_robot()` takes `device_id` and writes the v2 AADs; `main.py:929-944` passes it from the robot record. |
| Cloud | `robots` gains `device_id text`, `ds_pubkey text`, `key_not_after timestamptz`. |
| Both | A protocol version byte so v1 blobs still load during migration (`wasm_decrypt.cc:141-160` and `crypto.py:296-300` must agree). |

### Acceptance

- A v2 blob deployed to robot A fails the tag check on robot B (test: copy the
  `.mpxe` and flip the eFuse HMAC key on a dev board).
- A v1 blob still loads on a v1-capable build (backwards compatibility).
- Cloud rejects a deploy request whose `device_id` does not match the registered
  record.
- With `key_not_after` in the past, the firmware refuses the blob and logs a
  distinct reason.

**Effort:** 10 dev-days (5 firmware, 5 cloud). **Risk:** high — an AAD change is
a protocol break; ship with the version byte and dual support.

---

## 8. P5 — Attribution

**Goal:** a leaked artifact identifies the device it came from.

**Why:** S12; `SKILL_PROTECTION.md` §6.

### Changes

| Item | Detail |
|---|---|
| `crypto.py:260` | Before step 4, inject marker T1 (`mpx.wm` custom section: `device_id[0:8] ‖ issue_epoch ‖ version`) and T2 (unused exported function returning an `i64` marker constant). |
| `main.py:820-1000` | Write a `skill_deploy_log` row per deployed skill (robot, skill, version, IP, encrypted). |
| `mpx-admin` | Add a "trace artifact" tool: upload a `.wasm`, search markers, resolve to `robot_uuid` → owner account. |

### Acceptance

- Downloading a deployed blob and decrypting it yields the marker section.
- Two robots deploying the same skill produce different markers.
- The admin trace tool maps a marker to a `device_id` in under 60 s.

**Effort:** 2–3 dev-days. **Risk:** low. Do **not** claim tamper-proofness —
`wasm-opt -O` strips T2, and anyone stripping T1 leaves no marker. The
fingerprint detector (P2) is the primary instrument; the watermark only helps
attribute *careless* leaks.

---

## 9. P6 — Policy

**Goal:** technical controls have a consequence attached.

1. ToS: originality warranty, distribution grant, re-upload prohibition.
2. Takedown runbook: notice → 72 h → decision → appeal, all logged in
   `skill_review`.
3. Escalation ladder: warning → delist (`visibility='removed'`) → payout hold →
   suspension → ban. Payout tooling already exists at
   `mpx-admin/server/src/payouts.ts:155`.
4. Public-facing statement of the review process — deterrence value comes from
   it being known.

**Effort:** 1 day writing + counsel review.

---

## 10. P7 — Crypto correctness

**Goal:** fix the two real cryptographic defects, independent of everything else.

| Ref | Change |
|---|---|
| `main.py:1204-1212` | Stop reusing the inbound IV: replace `build_downstream_frame_with_iv(robot_uuid, key, iv, …)` with `build_downstream_frame(...)`. The firmware reads the IV from the header (`chat_ws.cc:723`), so this is a one-line fix. **This is a live keystream-reuse bug — do it now.** |
| `crypto.py:225-243` | Delete `build_downstream_frame_with_iv` or rename it and rewrite the docstring, which currently claims reuse is safe. |
| `main.py:1158` | Remove the confusing fresh-`os.urandom(12)` argument that makes the call site look like intentional reuse. |
| `chat_ws.cc:611-660`, `crypto.py:190-224` | Replay protection: add a monotonic counter (or timestamp) to the downstream AAD; firmware tracks the last accepted value in NVS. |
| `main.py:775-805` | Publish path: also verify the version-bump comparison cannot be bypassed by a malformed `current_version`. |

**Effort:** 1–2 dev-days. **Risk:** low for the nonce fix; medium for replay
protection (AAD change → same version-byte treatment as P4).

---

## 11. Sequencing

Two engineers, ~10 weeks:

| Week | Engineer A (cloud) | Engineer B (firmware) |
|---|---|---|
| 1 | P0 (2 d) → P7 nonce fix (1 d) → P1 schema + KMS | P3 prototyping on sacrificial boards |
| 2 | P1 cache + NOTIFY + GCS hardening | P3 flash encryption + secure boot bring-up |
| 3–4 | P2 fingerprints + schema + backfill | P3 JTAG/eFuse burn script + manufacturing doc |
| 5 | P2 admin queue + review actions | P4 `device_id` derivation + AAD v2 (dev board) |
| 6 | P2 threshold tuning on real data | P4 firmware side complete, dual-version support |
| 7 | P4 cloud side (encrypt with `device_id`, `not_after`) | P4 verification on hardware |
| 8 | P5 deploy log + trace tool | P5 watermark support in decryptor (read marker) |
| 9 | P6 policy + dashboards from §9 metrics | Burn-in, factory test fixtures |
| 10 | Buffer / cutover | Buffer / cutover |

If only one engineer: P0 → P7 → P1 → P2 → P3 → P5 → P4 → P6. P4 is the most
expensive and the least urgent, because P0 already removes the free path.

---

## 12. Do not do

- ❌ Wait for a hardware change before shipping P0. P0 is pure cloud work.
- ❌ Add more encryption layers to the `.mpxe` format. One RAM dump defeats them.
- ❌ Rely on `CONFIG_APP_MPX_EFUSE_BLK` as currently designed — the `USER` purpose
  is software-readable and the AES peripheral cannot consume it.
- ❌ Derive the key from the MAC address. It publishes the secret and turns one
  leak into a fleet-wide break.
- ❌ Trust `robot_uuid` as an identity in the AAD. It is a copyable config string.
- ❌ Ship the review gate with `review_state` defaulting to `approved`.
- ❌ Claim the watermark is tamper-proof in any customer-facing text.
- ❌ Turn on flash encryption in release mode before the partition layout is
  final — it is one-way per unit.

---

## 13. Open decisions (need a human)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 1 | Key generation model | server-generated (Model A) vs device-generated (Model B) | Model A — the cloud must decrypt anyway (`KEY_MANAGEMENT.md` §7.3) |
| 2 | Admin auth mechanism | service token vs OIDC/JWT with `admin` claim | OTX/OIDC if an IdP exists, otherwise `MPX_RPC_SERVICE_TOKEN` pattern |
| 3 | Similarity thresholds | 0.70 / 0.40 vs tighter | start at 0.70, measure 2 weeks |
| 4 | `not_after` window | 7 / 30 / 90 days | 30 days with a heartbeat re-issue |
| 5 | Attribution vs takedown default | delist vs revenue-share | revenue-share for `J ≥ 0.85`, delist for exact copies |
| 6 | Secure Boot key custody | offline HSM vs escrow | offline, two-person rule; document recovery |
| 7 | Is a robot allowed to run skills with no marketplace order | yes (free tier) vs no | decide before writing P5 metrics — this drives the "bypass" alarm |

---

## 14. Definition of done

Ship-complete when all of the following hold:

1. Every market/deploy/robot route returns 401 without a credential
   (`SKILL_PROTECTION.md` §2.3 table all green).
2. No code path returns `wasm_base64` that was not encrypted for that specific
   robot.
3. `grep -rn "aes_key_hex" cloud/` finds only migration/backfill artifacts.
4. A new robot registered at runtime works within 2 s without a restart; a
   revoked one is rejected within 60 s.
5. Publishing a copy (identical, or `wasm-opt`-reprocessed) from another developer
   lands in `pending_review` or is rejected — never straight to `public`.
6. The admin queue has a working approve/reject action that writes both
   `skill_review` and `marketplace_skills`.
7. `esptool read_flash` on a production unit yields no `\0asm` and no key; an
   unsigned image will not boot.
8. A v2 skill blob fails to decrypt on a board whose eFuse HMAC key differs.
9. A deployed artifact carries a per-device marker that the admin tool can resolve
   to an owner.
10. The nonce-reuse call at `main.py:1211` is gone.
11. `KEY_MANAGEMENT.md` §9 metrics and `SKILL_PROTECTION.md` §9 metrics are on a
    dashboard.
