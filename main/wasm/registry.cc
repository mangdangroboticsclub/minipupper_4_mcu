#include "wasm/registry.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <mutex>

#include "esp_log.h"
#include "cJSON.h"

#include "fs/littlefs_manager.h"
#include "wasm/wasm_decrypt.h"

static const char *TAG = "registry";

namespace skills {
namespace {

std::vector<Entry> s_entries;
std::mutex s_mutex;
std::mutex s_rescan_mutex;

/* ── WebAssembly section walking ──────────────────────────────────────────
 *
 * The format is simple enough that pulling in a parser would cost more than
 * it saves: a module is an 8-byte header followed by (id, LEB128 length,
 * body). Custom sections have id 0 and begin with their own LEB128-prefixed
 * name.
 *
 * Every length is bounds-checked against the buffer. This parses a file that
 * may have arrived from a marketplace, so it is untrusted input and a
 * truncated or hostile module must produce "no metadata", never a read past
 * the end.
 */
bool read_leb128(const uint8_t *buf, std::size_t len, std::size_t &i,
                 std::uint32_t &out)
{
    std::uint32_t value = 0;
    int shift = 0;
    while (i < len) {
        const uint8_t byte = buf[i++];
        value |= static_cast<std::uint32_t>(byte & 0x7F) << shift;
        if (!(byte & 0x80)) {
            out = value;
            return true;
        }
        shift += 7;
        if (shift > 28) return false;      // > 32 bits: malformed
    }
    return false;
}

bool valid_module(const uint8_t *wasm, std::size_t len)
{
    if (len < 8 || std::memcmp(wasm, "\0asm\1\0\0\0", 8) != 0) return false;
    std::size_t i = 8;
    while (i < len) {
        ++i;  // section id; WAMR validates its semantics when executing
        std::uint32_t size = 0;
        if (!read_leb128(wasm, len, i, size) || size > len - i) return false;
        i += size;
    }
    return true;
}

bool find_mpx_section(const uint8_t *wasm, std::size_t len,
                      const uint8_t *&body, std::uint32_t &body_len)
{
    if (len < 8 || std::memcmp(wasm, "\0asm", 4) != 0) return false;

    std::size_t i = 8;
    while (i < len) {
        const uint8_t id = wasm[i++];
        std::uint32_t size = 0;
        if (!read_leb128(wasm, len, i, size)) return false;
        if (size > len - i) return false;              // truncated

        const std::size_t section_end = i + size;

        if (id == 0) {
            std::size_t j = i;
            std::uint32_t name_len = 0;
            if (read_leb128(wasm, section_end, j, name_len)
                && name_len <= section_end - j
                && name_len == 3
                && std::memcmp(wasm + j, "mpx", 3) == 0) {
                body     = wasm + j + 3;
                body_len = static_cast<std::uint32_t>(section_end - (j + 3));
                return true;
            }
        }
        i = section_end;
    }
    return false;
}

std::string json_str(const cJSON *obj, const char *key)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
    return (cJSON_IsString(v) && v->valuestring) ? std::string(v->valuestring)
                                                 : std::string();
}

bool is_skill_file(const std::string &name)
{
    if (name.size() < 6) return false;
    const std::string ext = name.substr(name.size() - 5);
    return ext == ".wasm" || ext == ".mpxe";
}

}  // namespace

bool parse_module(const uint8_t *wasm, std::size_t len, Entry &out)
{
    const uint8_t *body = nullptr;
    std::uint32_t  body_len = 0;
    if (!find_mpx_section(wasm, len, body, body_len) || body_len == 0) return false;

    cJSON *root = cJSON_ParseWithLength(reinterpret_cast<const char *>(body),
                                        body_len);
    if (!root) return false;

    out.slug          = json_str(root, "slug");
    out.provides_gait = json_str(root, "provides_gait");

    const cJSON *abi = cJSON_GetObjectItemCaseSensitive(root, "abi");
    if (cJSON_IsNumber(abi)) out.abi = abi->valueint;

    out.autorun   = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root, "autorun"));
    out.behaviour = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root, "behaviour"));

    out.on.clear();
    const cJSON *on = cJSON_GetObjectItemCaseSensitive(root, "on");
    if (cJSON_IsArray(on)) {
        const cJSON *ev = nullptr;
        cJSON_ArrayForEach(ev, on) {
            if (cJSON_IsString(ev) && ev->valuestring) out.on.push_back(ev->valuestring);
        }
    }

    cJSON_Delete(root);
    return true;
}

static void secure_erase_and_free(uint8_t *data, std::size_t size)
{
    if (!data) return;
    volatile uint8_t *p = data;
    for (std::size_t i = 0; i < size; ++i) p[i] = 0;
    std::free(data);
}

void rescan()
{
    // A slow decrypt from an older scan must never overwrite a newer install.
    std::lock_guard<std::mutex> rescan_lock(s_rescan_mutex);
    std::vector<Entry> next;
    auto names = fs::list_files("/");
    std::sort(names.begin(), names.end());

    // fs::list_files returns full paths ("/foo.wasm"); the www tree is
    // skipped because nothing in it is a skill and reading it all is slow.
    for (const std::string &name : names) {
        if (!is_skill_file(name)) continue;
        if (name.compare(0, 5, "/www/") == 0) continue;

        const std::string path = (name[0] == '/') ? name : "/" + name;
        auto bytes = fs::read_file(path.c_str());

        Entry e;
        e.file = path;
        e.slug = path.substr(1, path.size() - 6);
        if (bytes.empty()) {
            e.valid = false;
            e.error = "skill is empty or unreadable";
            next.push_back(std::move(e));
            continue;
        }

        if (path.compare(path.size() - 5, 5, ".mpxe") == 0) {
            uint8_t *plain = nullptr;
            std::size_t plain_size = 0;
            const auto result = wasm::decrypt_mpxe(bytes.data(), bytes.size(),
                                                   &plain, &plain_size);
            if (result == wasm::DecryptResult::Success) {
                if (valid_module(plain, plain_size)) {
                    // A valid module without a manifest is still runnable.
                    parse_module(plain, plain_size, e);
                } else {
                    e.valid = false;
                    e.error = "decrypted payload is not valid WebAssembly";
                }
            } else {
                e.valid = false;
                e.error = "encrypted skill failed authentication";
                ESP_LOGW(TAG, "Cannot index '%s': decrypt result=%d",
                         path.c_str(), static_cast<int>(result));
            }
            secure_erase_and_free(plain, plain_size);
        } else if (!valid_module(bytes.data(), bytes.size())) {
            e.valid = false;
            e.error = "invalid WebAssembly module";
        } else {
            // A plaintext module without a manifest is still runnable.
            parse_module(bytes.data(), bytes.size(), e);
        }
        if (e.slug.empty()) e.slug = path.substr(1, path.size() - 6);
        next.push_back(std::move(e));
    }

    {
        std::lock_guard<std::mutex> lock(s_mutex);
        s_entries.swap(next);
    }
    const auto snapshot = all();
    ESP_LOGI(TAG, "%d skill(s) installed", (int)snapshot.size());
    for (const Entry &e : snapshot) {
        ESP_LOGI(TAG, "  %-20s gait=%-12s autorun=%d behaviour=%d events=%d",
                 e.slug.c_str(),
                 e.provides_gait.empty() ? "-" : e.provides_gait.c_str(),
                 (int)e.autorun, (int)e.behaviour, (int)e.on.size());
    }
}

std::vector<Entry> all()
{
    std::lock_guard<std::mutex> lock(s_mutex);
    return s_entries;
}

std::optional<Entry> by_gait(const char *gait_name)
{
    if (!gait_name || !*gait_name) return std::nullopt;
    std::lock_guard<std::mutex> lock(s_mutex);
    std::optional<Entry> found;
    for (const Entry &e : s_entries) {
        if (!e.valid || e.provides_gait.empty() || e.provides_gait != gait_name) continue;
        if (found) return std::nullopt;
        found = e;
    }
    return found;
}

std::optional<Entry> by_slug(const char *slug)
{
    if (!slug || !*slug) return std::nullopt;
    std::lock_guard<std::mutex> lock(s_mutex);
    std::optional<Entry> found;
    for (const Entry &e : s_entries) {
        if (!e.valid || e.slug != slug) continue;
        if (found) return std::nullopt;
        found = e;
    }
    return found;
}

std::optional<Entry> by_file(const char *path)
{
    if (!path || !*path) return std::nullopt;
    std::lock_guard<std::mutex> lock(s_mutex);
    for (const Entry &e : s_entries) if (e.file == path) return e;
    return std::nullopt;
}

std::vector<Entry> by_event(const char *event)
{
    std::vector<Entry> out;
    if (!event || !*event) return out;
    for (const Entry &e : all()) {
        if (!e.valid) continue;
        for (const std::string &ev : e.on)
            if (ev == event) { out.push_back(e); break; }
    }
    return out;
}

std::optional<Entry> autorun_entry()
{
    std::optional<Entry> found;
    for (const Entry &e : all()) {
        if (!e.valid || !e.autorun) continue;
        if (found) {
            ESP_LOGW(TAG, "'%s' also claims autorun; ignoring (autorun is one "
                          "slot, not a queue) -- '%s' has it",
                     e.slug.c_str(), found->slug.c_str());
            continue;
        }
        found = e;
    }
    return found;
}

std::string to_json()
{
    cJSON *root = cJSON_CreateObject();
    if (!root) return "{\"skills\":[]}";
    cJSON *list = cJSON_AddArrayToObject(root, "skills");
    for (const Entry &e : all()) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "slug", e.slug.c_str());
        cJSON_AddStringToObject(item, "file", e.file.c_str());
        cJSON_AddNumberToObject(item, "abi", e.abi);
        cJSON_AddStringToObject(item, "provides_gait", e.provides_gait.c_str());
        cJSON_AddBoolToObject(item, "autorun", e.autorun);
        cJSON_AddBoolToObject(item, "behaviour", e.behaviour);
        cJSON_AddBoolToObject(item, "valid", e.valid);
        cJSON_AddStringToObject(item, "error", e.error.c_str());
        cJSON *events = cJSON_AddArrayToObject(item, "on");
        for (const std::string &event : e.on)
            cJSON_AddItemToArray(events, cJSON_CreateString(event.c_str()));
        cJSON_AddItemToArray(list, item);
    }
    char *printed = cJSON_PrintUnformatted(root);
    std::string out = printed ? printed : "{\"skills\":[]}";
    cJSON_free(printed);
    cJSON_Delete(root);
    return out;
}

}  // namespace skills
