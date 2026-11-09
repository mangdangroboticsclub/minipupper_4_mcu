#include "wasm/wasm_decrypt.h"
#include "network/crypto.h"
#include "mpx_identity.h"

#include <cstdio>
#include <cstring>
#include <cstdlib>

#include "esp_log.h"
#include "sdkconfig.h"

static const char *TAG = "wasm_decrypt";

// ── MPXE blob format constants ──────────────────────────────
static constexpr uint32_t MPXE_MAGIC      = 0x4558504D;  // "MPXE" (little-endian)
static constexpr uint8_t  MPXE_VERSION_1  = 0x01;
static constexpr uint8_t  KEY_ALGO_DIRECT = 0x00;

// Offsets within the MPXE header
static constexpr size_t OFF_MAGIC            = 0;
static constexpr size_t OFF_VERSION          = 4;
static constexpr size_t OFF_WRAP_IV          = 5;
static constexpr size_t OFF_WRAPPED_KEY      = 17;   // 32 bytes ct + 16 bytes tag
static constexpr size_t OFF_KEY_ALGO         = 65;
static constexpr size_t OFF_SKILL_ID_HASH    = 66;   // SHA-256 first 8 bytes
static constexpr size_t OFF_WASM_IV          = 74;
static constexpr size_t OFF_ENCRYPTED_WASM   = 86;

static constexpr size_t HEADER_SIZE          = 86;   // total fixed header
static constexpr size_t GCM_TAG_SIZE         = 16;
static constexpr size_t MIN_MPXE_SIZE        = HEADER_SIZE + 1 + GCM_TAG_SIZE;  // 103

// ── Secure zeroing (compiler-proof) ─────────────────────────
// Plain memset() on a buffer that is about to be freed may be
// optimised away by the compiler as a dead store.  Using a
// volatile pointer forces the compiler to emit the stores.
static void secure_zero(void *ptr, size_t len)
{
    volatile uint8_t *p = static_cast<volatile uint8_t *>(ptr);
    for (size_t i = 0; i < len; i++) {
        p[i] = 0;
    }
}

namespace wasm {

// Outcome of one payload-decryption attempt. AuthFail and Oom are kept apart
// because they map to different DecryptResult values.
enum class PayloadTry { Ok, AuthFail, Oom };

// Decrypt the WASM payload assuming the frame ends after `ct_len` bytes of
// ciphertext, i.e. the tag is the 16 bytes at OFF_ENCRYPTED_WASM + ct_len.
//
// The format has no length field, so the tag is located purely by position
// (file_size - 16). That makes the frame sensitive to any byte appended at the
// end by whatever wrote the file: the tag window shifts by one and the GCM
// check fails even though every field before it is intact.
static PayloadTry decrypt_payload_try(const uint8_t *data, size_t data_size,
                                     size_t ct_len, const uint8_t *skill_key,
                                     const char *aad, size_t aad_len,
                                     uint8_t **out_plaintext, size_t *out_size)
{
    *out_plaintext = nullptr;
    *out_size = 0;

    const uint8_t *encrypted_wasm = data + OFF_ENCRYPTED_WASM;
    const uint8_t *wasm_tag = encrypted_wasm + ct_len;

    // The tag must be fully inside the buffer. malloc(0) is avoided because a
    // zero-byte payload is not a valid frame.
    if (ct_len == 0 ||
        OFF_ENCRYPTED_WASM + ct_len + GCM_TAG_SIZE > data_size) {
        return PayloadTry::AuthFail;
    }

    uint8_t *plaintext = static_cast<uint8_t *>(std::malloc(ct_len));
    if (!plaintext) {
        ESP_LOGE(TAG, "OOM allocating %zu bytes for decrypted WASM", ct_len);
        return PayloadTry::Oom;
    }

    const bool ok = crypto::gcm_decrypt(
        skill_key,
        data + OFF_WASM_IV,
        reinterpret_cast<const uint8_t *>(aad),
        aad_len,
        encrypted_wasm, ct_len,
        wasm_tag,
        plaintext);

    if (!ok) {
        secure_zero(plaintext, ct_len);
        std::free(plaintext);
        return PayloadTry::AuthFail;
    }

    *out_plaintext = plaintext;
    *out_size = ct_len;
    return PayloadTry::Ok;
}

// The two key sizes are the same number for the same reason: 32 bytes is the
// AES-256 key the identity holds and the one the MPXE header wraps.
static_assert(crypto::KEY_SIZE == MPX_KEY_LEN,
              "identity key size must match the frame key size");

// ── Core decryption (steps 1-4) — caller already verified MPXE format ──
static DecryptResult decrypt_mpxe_core(const uint8_t *data, size_t data_size,
                                       uint8_t **out_plaintext, size_t *out_size)
{
    *out_plaintext = nullptr;
    *out_size = 0;

    // ── Step 1: Validate header ──────────────────────────────
    if (data_size < MIN_MPXE_SIZE) {
        ESP_LOGE(TAG, "MPXE blob too small: %zu bytes (min %zu)",
                 data_size, MIN_MPXE_SIZE);
        return DecryptResult::Truncated;
    }

    uint8_t version = data[OFF_VERSION];
    if (version != MPXE_VERSION_1) {
        ESP_LOGE(TAG, "Unsupported MPXE version: 0x%02x", version);
        return DecryptResult::UnsupportedVersion;
    }

    uint8_t key_algo = data[OFF_KEY_ALGO];
    if (key_algo != KEY_ALGO_DIRECT) {
        ESP_LOGW(TAG, "Unexpected key_algo 0x%02x, continuing anyway", key_algo);
    }

    // ── Parse header fields ──────────────────────────────────
    const uint8_t *wrap_iv         = data + OFF_WRAP_IV;
    const uint8_t *wrapped_key_ct  = data + OFF_WRAPPED_KEY;       // 48 bytes (32 ct + 16 tag)
    const uint8_t *blob_skill_hash = data + OFF_SKILL_ID_HASH;     // 8 bytes

    size_t wasm_ct_len = data_size - OFF_ENCRYPTED_WASM - GCM_TAG_SIZE;

    // ── Step 2: Load robot key ───────────────────────────────
    // No Kconfig parse and no "is it all zeros" check here any more: both live
    // in components/mpx_identity, which refuses to hand out a key for a unit
    // that has no identity.
    uint8_t robot_key[crypto::KEY_SIZE];
    if (!mpx_identity_robot_key(robot_key)) {
        return DecryptResult::KeyNotLoaded;
    }

    // ── Step 3: Unwrap the per-skill key ─────────────────────
    // AAD = "wasm-wrap:v1:" + robot_id, from the identity: a blob wrapped for
    // one robot cannot unwrap on another.
    char wrap_aad_buf[128];
    int wrap_aad_len = snprintf(wrap_aad_buf, sizeof(wrap_aad_buf),
                                "wasm-wrap:v1:%s", mpx_identity_robot_id());

    uint8_t skill_key[crypto::KEY_SIZE];
    bool unwrap_ok = crypto::gcm_decrypt(
        robot_key,
        wrap_iv,
        reinterpret_cast<const uint8_t *>(wrap_aad_buf),
        static_cast<size_t>(wrap_aad_len),
        wrapped_key_ct, crypto::KEY_SIZE,
        wrapped_key_ct + crypto::KEY_SIZE,  // tag follows ciphertext
        skill_key);

    secure_zero(robot_key, sizeof(robot_key));

    if (!unwrap_ok) {
        ESP_LOGE(TAG, "Key unwrap failed — blob was encrypted for a "
                 "different robot or tampered in transit");
        return DecryptResult::UnwrapFailed;
    }

    ESP_LOGI(TAG, "Per-skill key unwrapped successfully");

    // ── Step 4: Decrypt the WASM binary ──────────────────────
    // AAD = "wasm-skill:v1:" + hex(blob_skill_hash[0:8])
    char wasm_aad_buf[128];
    char hash_hex[17];
    for (int i = 0; i < 8; i++) {
        snprintf(&hash_hex[i * 2], 3, "%02x", blob_skill_hash[i]);
    }
    hash_hex[16] = '\0';
    int wasm_aad_len = snprintf(wasm_aad_buf, sizeof(wasm_aad_buf),
                                "wasm-skill:v1:%s", hash_hex);

    uint8_t *plaintext = nullptr;
    size_t plaintext_len = 0;
    PayloadTry attempt = decrypt_payload_try(data, data_size, wasm_ct_len,
                                            skill_key, wasm_aad_buf,
                                            static_cast<size_t>(wasm_aad_len),
                                            &plaintext, &plaintext_len);

    // A byte appended after the tag moves the tag window by one, so the
    // canonical frame is rejected while every header field still verifies.
    // Retry the same frame one byte shorter — still an authenticated check of
    // the exact ciphertext, not a relaxed one — and say so loudly, because the
    // real defect is in whatever wrote the file.
    bool had_trailing_byte = false;
    if (attempt == PayloadTry::AuthFail && wasm_ct_len > 0) {
        attempt = decrypt_payload_try(data, data_size, wasm_ct_len - 1,
                                      skill_key, wasm_aad_buf,
                                      static_cast<size_t>(wasm_aad_len),
                                      &plaintext, &plaintext_len);
        if (attempt == PayloadTry::Ok) {
            had_trailing_byte = true;
        }
    }

    secure_zero(skill_key, sizeof(skill_key));

    if (attempt == PayloadTry::Oom) {
        return DecryptResult::OutOfMemory;
    }

    if (attempt != PayloadTry::Ok) {
        ESP_LOGE(TAG, "WASM decryption failed — blob is corrupted or tampered "
                 "(size=%zu, ciphertext=%zu, tag@%zu)",
                 data_size, wasm_ct_len, OFF_ENCRYPTED_WASM + wasm_ct_len);
        return DecryptResult::DecryptFailed;
    }

    if (had_trailing_byte) {
        ESP_LOGW(TAG, "MPXE blob has a stray trailing byte: %zu bytes on disk, "
                 "authenticated frame ends at %zu. Decrypting the valid frame; "
                 "the writer appended a byte after the GCM tag (check the deploy "
                 "script's byte count against what fs.write receives)",
                 data_size, data_size - 1);
    }

    ESP_LOGI(TAG, "WASM decrypted successfully (%zu bytes plaintext)", plaintext_len);

    *out_plaintext = plaintext;
    *out_size = plaintext_len;
    return DecryptResult::Success;
}

DecryptResult decrypt_mpxe(const uint8_t *data, size_t data_size,
                           uint8_t **out_plaintext, size_t *out_size)
{
    // No magic check — caller already knows this is MPXE
    // (e.g., by file extension .mpxe).
    return decrypt_mpxe_core(data, data_size, out_plaintext, out_size);
}

DecryptResult decrypt_mpxe_autodetect(const uint8_t *data, size_t data_size,
                                      uint8_t **out_plaintext, size_t *out_size)
{
    *out_plaintext = nullptr;
    *out_size = 0;

    // Check magic bytes — if not "MPXE", it's plain data
    if (data_size < 4) {
        return DecryptResult::NotEncrypted;
    }

    uint32_t magic;
    std::memcpy(&magic, data + OFF_MAGIC, 4);
    if (magic != MPXE_MAGIC) {
        return DecryptResult::NotEncrypted;
    }

    ESP_LOGI(TAG, "MPXE magic detected, entering decryption pipeline");
    return decrypt_mpxe_core(data, data_size, out_plaintext, out_size);
}

}  // namespace wasm
