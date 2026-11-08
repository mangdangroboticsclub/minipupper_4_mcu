#include "network/preview_proxy.h"
#include "network/wifi_sta.h"

#include <algorithm>
#include <cerrno>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <new>
#include <string>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>
#include <utime.h>
#include <vector>

#include "cJSON.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"
#include "mbedtls/sha256.h"
#include "sdkconfig.h"

static const char *TAG = "preview_proxy";

namespace network {
namespace {

constexpr const char *GATEWAY_HOST = CONFIG_APP_CHAT_SERVER_IP;
constexpr int GATEWAY_PORT = CONFIG_APP_CHAT_SERVER_PORT;
constexpr const char *URI_PREFIX = "/api/preview/";
constexpr const char *CACHE_ROOT = "/fs/preview";
constexpr size_t RECV_CHUNK = 16384;
constexpr size_t MAX_RESPONSE_HEADERS = 8192;
constexpr size_t MANIFEST_CAP = 65536;
constexpr size_t GLB_CAP = 512000;
constexpr size_t TRACE_CAP = 1228800;
constexpr size_t POSTER_CAP = 81920;
constexpr size_t VERSION_CACHE_CAP = 2 * 1024 * 1024;
constexpr size_t TOTAL_CACHE_CAP = 4 * 1024 * 1024;

struct PreviewPath {
    std::string skill_id;
    std::string version;
    std::string file;

    std::string relative_dir() const
    {
        return skill_id + "/" + version;
    }

    std::string final_path() const
    {
        return std::string(CACHE_ROOT) + "/" + relative_dir() + "/" + file;
    }

    std::string gateway_path() const
    {
        return "/v1/preview/" + relative_dir() + "/" + file;
    }
};

bool valid_component(const std::string &s, bool version)
{
    const size_t max_len = version ? 32 : 64;
    if (s.empty() || s.size() > max_len || s == "." || s == ".." ||
        s.find("..") != std::string::npos) {
        return false;
    }
    for (unsigned char c : s) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                        (version && ((c >= 'A' && c <= 'Z') || c == '.')) ||
                        c == '_' || c == '-' || (!version && c == '~');
        if (!ok) return false;
    }
    return true;
}

bool allowed_file(const std::string &file)
{
    static constexpr const char *FILES[] = {
        "manifest.json", "sku_1.glb", "sku_2.glb", "trace.bin.gz",
        "trace-full.bin.gz", "poster-hero.webp", "poster-side.webp",
        "poster-top.webp",
    };
    for (const char *allowed : FILES) {
        if (file == allowed) return true;
    }
    return false;
}

bool parse_uri(const char *uri, PreviewPath &out)
{
    if (!uri || std::strncmp(uri, URI_PREFIX, std::strlen(URI_PREFIX)) != 0) {
        return false;
    }
    const std::string rest(uri + std::strlen(URI_PREFIX));
    const size_t slash1 = rest.find('/');
    const size_t slash2 = slash1 == std::string::npos
                              ? std::string::npos
                              : rest.find('/', slash1 + 1);
    if (slash1 == std::string::npos || slash2 == std::string::npos ||
        rest.find('/', slash2 + 1) != std::string::npos) {
        return false;
    }
    out.skill_id = rest.substr(0, slash1);
    out.version = rest.substr(slash1 + 1, slash2 - slash1 - 1);
    out.file = rest.substr(slash2 + 1);
    return valid_component(out.skill_id, false) &&
           valid_component(out.version, true) && allowed_file(out.file);
}

size_t file_cap(const std::string &file)
{
    if (file == "manifest.json") return MANIFEST_CAP;
    if (file.size() >= 4 && file.compare(file.size() - 4, 4, ".glb") == 0) {
        return GLB_CAP;
    }
    if (file.find("trace") == 0) return TRACE_CAP;
    return POSTER_CAP;
}

const char *content_type(const std::string &file)
{
    if (file == "manifest.json") return "application/json";
    if (file.size() >= 4 && file.compare(file.size() - 4, 4, ".glb") == 0) {
        return "model/gltf-binary";
    }
    if (file.find("trace") == 0) return "application/octet-stream";
    return "image/webp";
}

bool is_trace(const std::string &file)
{
    return file.find("trace") == 0;
}

bool valid_hash(const std::string &hash)
{
    if (hash.size() != 64) return false;
    for (unsigned char c : hash) {
        if (!std::isxdigit(c)) return false;
    }
    return true;
}

std::string normalized_hash(std::string value)
{
    const size_t first = value.find_first_not_of(" \t");
    if (first == std::string::npos) return {};
    const size_t last = value.find_last_not_of(" \t");
    value = value.substr(first, last - first + 1);
    if (value.size() >= 2 && value.front() == '"' && value.back() == '"') {
        value = value.substr(1, value.size() - 2);
    }
    if (!valid_hash(value)) return {};
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    return value;
}

bool regular_file(const std::string &path, struct stat &st)
{
    return stat(path.c_str(), &st) == 0 && S_ISREG(st.st_mode);
}

bool make_cache_dirs(const PreviewPath &path)
{
    const std::string skill_dir = std::string(CACHE_ROOT) + "/" + path.skill_id;
    const std::string version_dir = skill_dir + "/" + path.version;
    for (const std::string &dir : {std::string(CACHE_ROOT), skill_dir, version_dir}) {
        if (mkdir(dir.c_str(), 0775) != 0 && errno != EEXIST) {
            ESP_LOGE(TAG, "mkdir %s failed: errno=%d", dir.c_str(), errno);
            return false;
        }
    }
    return true;
}

esp_err_t reply(httpd_req_t *req, const char *status, const char *message)
{
    httpd_resp_set_status(req, status);
    httpd_resp_set_type(req, "text/plain");
    httpd_resp_send(req, message, -1);
    return ESP_OK;
}

void set_preview_headers(httpd_req_t *req, const PreviewPath &path,
                         const std::string &hash)
{
    httpd_resp_set_type(req, content_type(path.file));
    httpd_resp_set_hdr(req, "Cache-Control", "public, max-age=31536000, immutable");
    if (is_trace(path.file)) {
        httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
    }
    if (valid_hash(hash)) {
        const std::string etag = "\"" + hash + "\"";
        httpd_resp_set_hdr(req, "ETag", etag.c_str());
    }
}

bool read_manifest_file(const std::string &path, std::string &json)
{
    struct stat st {};
    if (!regular_file(path, st) || st.st_size <= 0 ||
        static_cast<uint64_t>(st.st_size) > MANIFEST_CAP) {
        return false;
    }
    FILE *f = fopen(path.c_str(), "rb");
    if (!f) return false;
    json.resize(static_cast<size_t>(st.st_size));
    const size_t got = fread(&json[0], 1, json.size(), f);
    const bool close_ok = fclose(f) == 0;
    const bool ok = got == json.size() && close_ok;
    if (!ok) json.clear();
    return ok;
}

std::string manifest_hash(const std::string &json, const std::string &file)
{
    cJSON *root = cJSON_Parse(json.c_str());
    if (!root) return {};
    cJSON *files = cJSON_GetObjectItemCaseSensitive(root, "files");
    std::string hash;
    if (cJSON_IsArray(files)) {
        cJSON *entry = nullptr;
        cJSON_ArrayForEach(entry, files) {
            cJSON *name = cJSON_GetObjectItemCaseSensitive(entry, "name");
            if (cJSON_IsString(name) && file == name->valuestring) {
                cJSON *item = cJSON_GetObjectItemCaseSensitive(entry, "sha256");
                if (cJSON_IsString(item)) hash = normalized_hash(item->valuestring);
                break;
            }
        }
    }
    cJSON_Delete(root);
    return hash;
}

std::string cached_manifest_hash(const PreviewPath &path)
{
    if (path.file == "manifest.json") return {};
    PreviewPath manifest = path;
    manifest.file = "manifest.json";
    std::string json;
    return read_manifest_file(manifest.final_path(), json)
               ? manifest_hash(json, path.file)
               : std::string();
}

class Sha256 {
public:
    Sha256()
    {
        mbedtls_sha256_init(&ctx_);
        started_ = mbedtls_sha256_starts(&ctx_, 0) == 0;
    }

    ~Sha256() { mbedtls_sha256_free(&ctx_); }

    bool update(const char *data, size_t len)
    {
        return started_ && mbedtls_sha256_update(&ctx_,
                                                  reinterpret_cast<const unsigned char *>(data),
                                                  len) == 0;
    }

    std::string finish()
    {
        unsigned char digest[32];
        if (!started_ || mbedtls_sha256_finish(&ctx_, digest) != 0) return {};
        static constexpr char HEX[] = "0123456789abcdef";
        std::string out(64, '0');
        for (size_t i = 0; i < sizeof(digest); ++i) {
            out[i * 2] = HEX[digest[i] >> 4];
            out[i * 2 + 1] = HEX[digest[i] & 0x0f];
        }
        return out;
    }

private:
    mbedtls_sha256_context ctx_;
    bool started_ = false;
};

/** One raw-lwip HTTP/1.1 response, with its body exposed as a stream. */
class GatewayConnection {
public:
    ~GatewayConnection()
    {
        if (sock_ >= 0) close(sock_);
    }

    bool open(const char *path)
    {
        if (std::strcmp(GATEWAY_HOST, "echo") == 0) return false;

        struct addrinfo hints = {};
        struct addrinfo *res = nullptr;
        hints.ai_family = AF_INET;
        hints.ai_socktype = SOCK_STREAM;
        char port[8];
        std::snprintf(port, sizeof(port), "%d", GATEWAY_PORT);
        const int err = getaddrinfo(GATEWAY_HOST, port, &hints, &res);
        if (err != 0 || !res) {
            ESP_LOGW(TAG, "DNS failed for %s: %d", GATEWAY_HOST, err);
            return false;
        }

        sock_ = socket(res->ai_family, res->ai_socktype, 0);
        if (sock_ < 0) {
            ESP_LOGW(TAG, "socket failed: errno=%d", errno);
            freeaddrinfo(res);
            return false;
        }

        struct timeval tv = { .tv_sec = CONFIG_APP_MARKETPLACE_READ_TIMEOUT_S,
                              .tv_usec = 0 };
        setsockopt(sock_, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        struct timeval send_tv = { .tv_sec = 30, .tv_usec = 0 };
        setsockopt(sock_, SOL_SOCKET, SO_SNDTIMEO, &send_tv, sizeof(send_tv));
        struct linger lg = { .l_onoff = 1, .l_linger = 0 };
        setsockopt(sock_, SOL_SOCKET, SO_LINGER, &lg, sizeof(lg));

        const int flags = fcntl(sock_, F_GETFL, 0);
        fcntl(sock_, F_SETFL, flags | O_NONBLOCK);
        const int rc = connect(sock_, res->ai_addr, res->ai_addrlen);
        bool connected = rc == 0;
        if (rc != 0 && errno == EINPROGRESS) {
            fd_set writes;
            FD_ZERO(&writes);
            FD_SET(sock_, &writes);
            struct timeval timeout = { .tv_sec = 4, .tv_usec = 0 };
            if (select(sock_ + 1, nullptr, &writes, nullptr, &timeout) > 0) {
                int socket_error = 0;
                socklen_t len = sizeof(socket_error);
                getsockopt(sock_, SOL_SOCKET, SO_ERROR, &socket_error, &len);
                connected = socket_error == 0;
            }
        }
        fcntl(sock_, F_SETFL, flags);
        freeaddrinfo(res);
        if (!connected) {
            ESP_LOGW(TAG, "gateway connect failed/timeout");
            return false;
        }

        std::string request = std::string("GET ") + path + " HTTP/1.1\r\n" +
                              "Host: " + GATEWAY_HOST + ":" + port + "\r\n" +
                              "Connection: close\r\nAccept: */*\r\n\r\n";
        size_t sent = 0;
        while (sent < request.size()) {
            const int n = send(sock_, request.data() + sent, request.size() - sent, 0);
            if (n <= 0) {
                ESP_LOGW(TAG, "gateway send failed: errno=%d", errno);
                return false;
            }
            sent += static_cast<size_t>(n);
        }
        return read_headers();
    }

    int status() const { return status_; }
    bool has_content_length() const { return has_content_length_; }
    uint64_t content_length() const { return content_length_; }
    const std::string &etag() const { return etag_; }

    /** Returns bytes read; ok is false on truncation, timeout, or bad framing. */
    size_t read_body(char *dest, size_t capacity, bool &ok)
    {
        ok = false;
        if (eof_) {
            ok = true;
            return 0;
        }

        if (chunked_) {
            if (chunk_remaining_ == 0) {
                if (chunk_need_crlf_ && !consume_crlf()) return 0;
                chunk_need_crlf_ = false;
                std::string line;
                if (!read_line(line, 256)) return 0;
                char *end = nullptr;
                if (line.empty() || !std::isxdigit(static_cast<unsigned char>(line[0]))) {
                    return 0;
                }
                const unsigned long long size = std::strtoull(line.c_str(), &end, 16);
                if (end == line.c_str() ||
                    (*end != 0 && *end != ';' && !std::isspace(static_cast<unsigned char>(*end)))) {
                    return 0;
                }
                if (size == 0) {
                    do {
                        if (!read_line(line, 1024)) return 0;
                    } while (!line.empty());
                    eof_ = true;
                    ok = true;
                    return 0;
                }
                chunk_remaining_ = size;
            }
            const size_t wanted = static_cast<size_t>(
                std::min<uint64_t>(capacity, chunk_remaining_));
            const size_t got = read_some(dest, wanted, ok);
            if (!ok) return 0;
            chunk_remaining_ -= got;
            if (chunk_remaining_ == 0) chunk_need_crlf_ = true;
            return got;
        }

        if (has_content_length_) {
            if (content_length_ == 0) {
                eof_ = true;
                ok = true;
                return 0;
            }
            const size_t wanted = static_cast<size_t>(
                std::min<uint64_t>(capacity, content_length_));
            const size_t got = read_some(dest, wanted, ok);
            if (!ok) return 0;
            content_length_ -= got;
            if (content_length_ == 0) eof_ = true;
            return got;
        }

        if (!pending_.empty()) {
            const size_t n = std::min(capacity, pending_.size());
            std::memcpy(dest, pending_.data(), n);
            pending_.erase(0, n);
            ok = true;
            return n;
        }
        const int n = recv(sock_, dest, capacity, 0);
        if (n < 0) {
            ESP_LOGW(TAG, "gateway body recv failed: errno=%d", errno);
            return 0;
        }
        if (n == 0) {
            eof_ = true;
            ok = true;
            return 0;
        }
        ok = true;
        return static_cast<size_t>(n);
    }

private:
    size_t read_some(char *dest, size_t capacity, bool &ok)
    {
        if (!pending_.empty()) {
            const size_t n = std::min(capacity, pending_.size());
            std::memcpy(dest, pending_.data(), n);
            pending_.erase(0, n);
            ok = true;
            return n;
        }
        const int n = recv(sock_, dest, capacity, 0);
        if (n <= 0) {
            if (n < 0) ESP_LOGW(TAG, "gateway body recv failed: errno=%d", errno);
            ok = false;
            return 0;
        }
        ok = true;
        return static_cast<size_t>(n);
    }

    bool consume_crlf()
    {
        char crlf[2];
        size_t used = 0;
        while (used < sizeof(crlf)) {
            bool ok = false;
            const size_t n = read_some(crlf + used, sizeof(crlf) - used, ok);
            if (!ok) return false;
            used += n;
        }
        return crlf[0] == '\r' && crlf[1] == '\n';
    }

    bool read_line(std::string &line, size_t cap)
    {
        line.clear();
        char c = 0;
        while (line.size() < cap) {
            bool ok = false;
            if (read_some(&c, 1, ok) != 1 || !ok) return false;
            if (c == '\n') {
                if (!line.empty() && line.back() == '\r') line.pop_back();
                return true;
            }
            line += c;
        }
        return false;
    }

    bool read_headers()
    {
        std::string data;
        size_t end = std::string::npos;
        while ((end = data.find("\r\n\r\n")) == std::string::npos) {
            char buf[1024];
            const int n = recv(sock_, buf, sizeof(buf), 0);
            if (n <= 0) {
                ESP_LOGW(TAG, "gateway header recv failed: errno=%d", errno);
                return false;
            }
            data.append(buf, static_cast<size_t>(n));
            if (data.size() > MAX_RESPONSE_HEADERS) {
                ESP_LOGW(TAG, "gateway response headers too large");
                return false;
            }
        }
        pending_ = data.substr(end + 4);
        data.resize(end);

        const size_t first_eol = data.find("\r\n");
        const std::string status_line = data.substr(0, first_eol);
        const size_t space = status_line.find(' ');
        if (space == std::string::npos) return false;
        status_ = std::atoi(status_line.c_str() + space + 1);

        size_t pos = first_eol == std::string::npos ? data.size() : first_eol + 2;
        while (pos < data.size()) {
            const size_t eol = data.find("\r\n", pos);
            const std::string line = data.substr(pos, eol - pos);
            const size_t colon = line.find(':');
            if (colon != std::string::npos) {
                const std::string name = line.substr(0, colon);
                const size_t value_start = line.find_first_not_of(" \t", colon + 1);
                const std::string value = value_start == std::string::npos
                                              ? std::string()
                                              : line.substr(value_start);
                if (strcasecmp(name.c_str(), "Content-Length") == 0) {
                    char *end_ptr = nullptr;
                    const unsigned long long length = std::strtoull(value.c_str(), &end_ptr, 10);
                    if (end_ptr == value.c_str() || *end_ptr != 0) return false;
                    content_length_ = length;
                    has_content_length_ = true;
                } else if (strcasecmp(name.c_str(), "ETag") == 0) {
                    etag_ = normalized_hash(value);
                } else if (strcasecmp(name.c_str(), "Transfer-Encoding") == 0) {
                    std::string lower = value;
                    std::transform(lower.begin(), lower.end(), lower.begin(),
                                   [](unsigned char c) { return std::tolower(c); });
                    chunked_ = lower.find("chunked") != std::string::npos;
                }
            }
            if (eol == std::string::npos) break;
            pos = eol + 2;
        }
        return true;
    }

    int sock_ = -1;
    int status_ = 0;
    std::string pending_;
    std::string etag_;
    bool chunked_ = false;
    bool eof_ = false;
    bool has_content_length_ = false;
    uint64_t content_length_ = 0;
    uint64_t chunk_remaining_ = 0;
    bool chunk_need_crlf_ = false;
};

SemaphoreHandle_t preview_slot()
{
    static SemaphoreHandle_t slot = xSemaphoreCreateCounting(1, 1);
    return slot;
}

struct SlotGuard {
    SemaphoreHandle_t slot;
    ~SlotGuard()
    {
        if (slot) xSemaphoreGive(slot);
    }
};

struct CacheEntry {
    std::string path;
    std::string group;
    size_t size = 0;
    time_t accessed = 0;
};

void scan_cache(const std::string &dir, unsigned depth, std::vector<CacheEntry> &entries)
{
    DIR *d = opendir(dir.c_str());
    if (!d) return;
    while (dirent *entry = readdir(d)) {
        const std::string name = entry->d_name;
        if (name == "." || name == "..") continue;
        const std::string path = dir + "/" + name;
        struct stat st {};
        if (stat(path.c_str(), &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            if (depth < 2) scan_cache(path, depth + 1, entries);
        } else if (S_ISREG(st.st_mode) && depth == 2) {
            if (name.size() >= 5 && name.compare(name.size() - 5, 5, ".part") == 0) {
                unlink(path.c_str());  // interrupted downloads are never served
                continue;
            }
            const std::string relative = path.substr(std::strlen(CACHE_ROOT) + 1);
            const size_t slash = relative.find_last_of('/');
            entries.push_back({path, relative.substr(0, slash),
                               static_cast<size_t>(st.st_size), st.st_mtime});
        }
    }
    closedir(d);
}

void enforce_cache_budget(const std::string &protected_path,
                          const std::string &protected_group)
{
    std::vector<CacheEntry> entries;
    scan_cache(CACHE_ROOT, 0, entries);
    size_t total = 0;
    size_t group_total = 0;
    for (const CacheEntry &entry : entries) {
        total += entry.size;
        if (entry.group == protected_group) group_total += entry.size;
    }

    auto evict_oldest = [&](bool group_only, size_t &usage) {
        size_t oldest = entries.size();
        for (size_t i = 0; i < entries.size(); ++i) {
            const CacheEntry &candidate = entries[i];
            if (candidate.path.empty() || candidate.path == protected_path ||
                (group_only && candidate.group != protected_group)) {
                continue;
            }
            if (oldest == entries.size() || candidate.accessed < entries[oldest].accessed ||
                (candidate.accessed == entries[oldest].accessed &&
                 candidate.path < entries[oldest].path)) {
                oldest = i;
            }
        }
        if (oldest == entries.size()) return false;
        ESP_LOGI(TAG, "LRU evict %s (%zu bytes)", entries[oldest].path.c_str(),
                 entries[oldest].size);
        if (unlink(entries[oldest].path.c_str()) != 0) return false;
        usage -= entries[oldest].size;
        total -= entries[oldest].size;
        entries[oldest].path.clear();
        entries[oldest].size = 0;
        return true;
    };

    while (group_total > VERSION_CACHE_CAP) {
        if (!evict_oldest(true, group_total)) {
            ESP_LOGW(TAG, "could not enforce per-version preview cache cap");
            break;
        }
    }
    while (total > TOTAL_CACHE_CAP) {
        if (!evict_oldest(false, total)) {
            ESP_LOGW(TAG, "could not enforce total preview cache cap");
            break;
        }
    }
}

struct FetchResult {
    bool ok = false;
    bool downstream_started = false;
};

FetchResult fetch_to_cache(const PreviewPath &path, httpd_req_t *req,
                           std::string expected_hash, std::string *manifest_json)
{
    FetchResult result;
    GatewayConnection gateway;
    if (!gateway.open(path.gateway_path().c_str()) || gateway.status() != 200) {
        ESP_LOGW(TAG, "upstream %s failed (HTTP %d)", path.gateway_path().c_str(),
                 gateway.status());
        return result;
    }

    const size_t cap = file_cap(path.file);
    if (gateway.has_content_length() && gateway.content_length() > cap) {
        ESP_LOGW(TAG, "upstream %s exceeds cap: %llu > %zu", path.file.c_str(),
                 static_cast<unsigned long long>(gateway.content_length()), cap);
        return result;
    }
    if (expected_hash.empty()) expected_hash = gateway.etag();
    // manifest.json is the root of trust: it cannot contain its own hash and
    // the gateway has no sha256 ETag for it. Everything else it lists IS
    // verified, so the manifest itself is accepted unhashed (mesh-internal
    // trusted transport, same as the marketplace proxy).
    const bool is_manifest = path.file == "manifest.json";
    if (expected_hash.empty() && !is_manifest) {
        ESP_LOGW(TAG, "no integrity hash for %s", path.gateway_path().c_str());
        return result;
    }
    if (!gateway.etag().empty() && gateway.etag() != expected_hash) {
        ESP_LOGW(TAG, "manifest and upstream ETag disagree for %s", path.file.c_str());
        return result;
    }
    if (!make_cache_dirs(path)) return result;

    if (req) {
        set_preview_headers(req, path, expected_hash);
        // esp_http_server's send_chunk API always emits Transfer-Encoding:
        // chunked. Adding Content-Length here would produce ambiguous HTTP.
    }

    const std::string final_path = path.final_path();
    const std::string part_path = final_path + ".part";
    unlink(part_path.c_str());
    FILE *f = fopen(part_path.c_str(), "wb");
    if (!f) {
        ESP_LOGE(TAG, "open %s failed: errno=%d", part_path.c_str(), errno);
        return result;
    }
    char *buffer = new (std::nothrow) char[RECV_CHUNK];
    if (!buffer) {
        fclose(f);
        unlink(part_path.c_str());
        return result;
    }

    Sha256 sha;
    size_t total = 0;
    bool stream_ok = true;
    while (true) {
        bool read_ok = false;
        const size_t got = gateway.read_body(buffer, RECV_CHUNK, read_ok);
        if (!read_ok) {
            ESP_LOGW(TAG, "truncated/failed upstream body for %s", path.file.c_str());
            stream_ok = false;
            break;
        }
        if (got == 0) break;
        if (got > SIZE_MAX - total || total + got > cap) {
            ESP_LOGW(TAG, "streamed %s exceeds cap", path.file.c_str());
            stream_ok = false;
            break;
        }
        if (fwrite(buffer, 1, got, f) != got || !sha.update(buffer, got)) {
            ESP_LOGE(TAG, "cache write/hash failed for %s", part_path.c_str());
            stream_ok = false;
            break;
        }
        total += got;
        if (manifest_json) manifest_json->append(buffer, got);
        if (req) {
            result.downstream_started = true;
            if (httpd_resp_send_chunk(req, buffer, got) != ESP_OK) {
                ESP_LOGW(TAG, "preview client disconnected");
                stream_ok = false;
                break;
            }
        }
        vTaskDelay(1);
    }
    delete[] buffer;
    const bool close_ok = fclose(f) == 0;
    stream_ok = stream_ok && close_ok;

    if (stream_ok && !expected_hash.empty()) {
        const std::string actual_hash = sha.finish();
        if (actual_hash != expected_hash) {
            ESP_LOGE(TAG, "SHA-256 mismatch for %s: expected %s, got %s",
                     path.file.c_str(), expected_hash.c_str(), actual_hash.c_str());
            stream_ok = false;
        }
    }
    if (!stream_ok) {
        unlink(part_path.c_str());
        return result;
    }
    if (rename(part_path.c_str(), final_path.c_str()) != 0) {
        ESP_LOGE(TAG, "rename %s failed: errno=%d", part_path.c_str(), errno);
        unlink(part_path.c_str());
        return result;
    }

    enforce_cache_budget(final_path, path.relative_dir());
    ESP_LOGI(TAG, "cached %s (%zu bytes)", final_path.c_str(), total);
    if (req) {
        result.downstream_started = true;
        if (httpd_resp_send_chunk(req, nullptr, 0) != ESP_OK) return result;
    }
    result.ok = true;
    return result;
}

esp_err_t serve_cached(httpd_req_t *req, const PreviewPath &path,
                       const struct stat &st)
{
    FILE *f = fopen(path.final_path().c_str(), "rb");
    if (!f) return reply(req, "502 Bad Gateway", "preview cache read failed");
    set_preview_headers(req, path, cached_manifest_hash(path));

    // Fixed-length header followed by raw body writes avoids httpd's automatic
    // chunked framing while retaining Content-Length for cached artifacts.
    if (httpd_resp_send(req, nullptr, static_cast<ssize_t>(st.st_size)) != ESP_OK) {
        fclose(f);
        return ESP_FAIL;
    }

    char *buffer = new (std::nothrow) char[RECV_CHUNK];
    if (!buffer) {
        fclose(f);
        return ESP_FAIL;
    }
    size_t remaining = static_cast<size_t>(st.st_size);
    esp_err_t result = ESP_OK;
    while (remaining > 0) {
        const size_t wanted = std::min(remaining, RECV_CHUNK);
        const size_t got = fread(buffer, 1, wanted, f);
        if (got == 0) {
            result = ESP_FAIL;
            break;
        }
        // httpd_send returns the byte count, not ESP_OK. Treating a successful
        // 16 KiB write as an error truncated every cached multi-chunk artifact.
        size_t sent_total = 0;
        while (sent_total < got) {
            const ssize_t sent = httpd_send(req, buffer + sent_total, got - sent_total);
            if (sent <= 0) {
                result = ESP_FAIL;
                break;
            }
            sent_total += static_cast<size_t>(sent);
        }
        if (result != ESP_OK) break;
        remaining -= got;
        vTaskDelay(1);
    }
    delete[] buffer;
    fclose(f);
    if (result == ESP_OK && remaining == 0) {
        // esp-littlefs exposes mtime, not atime; utime maintains the access
        // timestamp used by the LRU sweep.
        utime(path.final_path().c_str(), nullptr);
    } else {
        result = ESP_FAIL;
    }
    return result;
}

}  // namespace

esp_err_t preview_proxy_handler(httpd_req_t *req)
{
    PreviewPath path;
    if (!parse_uri(req->uri, path)) {
        return reply(req, "404 Not Found", "unknown preview artifact");
    }

    struct stat st {};
    if (regular_file(path.final_path(), st)) {
        return serve_cached(req, path, st);
    }

    SemaphoreHandle_t slot = preview_slot();
    if (!slot || xSemaphoreTake(slot, 0) != pdTRUE) {
        httpd_resp_set_hdr(req, "Retry-After", "2");
        return reply(req, "429 Too Many Requests", "another preview is downloading");
    }
    SlotGuard guard{slot};

    if (wifi_sta_get_state() != StaState::Connected) {
        httpd_resp_set_hdr(req, "X-Preview-State", "offline");
        return reply(req, "503 Service Unavailable", "preview is not cached");
    }

    std::string expected_hash = cached_manifest_hash(path);
    if (path.file != "manifest.json" && expected_hash.empty()) {
        PreviewPath manifest = path;
        manifest.file = "manifest.json";
        std::string json;
        FetchResult fetched = fetch_to_cache(manifest, nullptr, {}, &json);
        if (!fetched.ok) return reply(req, "502 Bad Gateway", "preview manifest unavailable");
        expected_hash = manifest_hash(json, path.file);
        if (expected_hash.empty()) {
            return reply(req, "502 Bad Gateway", "preview hash missing from manifest");
        }
    }

    FetchResult fetched = fetch_to_cache(path, req, expected_hash, nullptr);
    if (!fetched.ok) {
        if (fetched.downstream_started) {
            // A streamed 200 cannot be changed to a 502. Closing without the
            // terminal chunk makes the transfer fail instead of looking valid.
            return ESP_FAIL;
        }
        return reply(req, "502 Bad Gateway", "preview download or verification failed");
    }
    return ESP_OK;
}

}  // namespace network
