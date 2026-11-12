/* Voice turns belong to the robot, not to whichever phone happened to be
 * open. One small JSONL file per conversation makes browser imports and live
 * reconnects possible without depending on ESP-Claw's private log format. */
#include "voice_history.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <dirent.h>
#include <pthread.h>
#include <string>
#include <sys/stat.h>
#include <vector>

#include "esp_log.h"

namespace {

const char *TAG = "voice_history";
constexpr char kDirectory[] = "/fs/voice";
constexpr int kDefaultLimit = 16;
/* Only the tail of a transcript is ever sent. Reading a whole 64 KiB file for
 * 60 turns pinned the httpd task long enough that the socket reaper closed
 * phone connections still waiting in the accept backlog. */
constexpr long kTailBytes = 12 * 1024;
constexpr int kMaxMessages = 200;
constexpr long kMaxFileBytes = 64 * 1024;
pthread_mutex_t s_lock = PTHREAD_MUTEX_INITIALIZER;

struct Lock {
	Lock() { pthread_mutex_lock(&s_lock); }
	~Lock() { pthread_mutex_unlock(&s_lock); }
};

bool valid_id(const char *id)
{
	if (!id || strncmp(id, "voice-", 6) != 0 || strlen(id) != 14) return false;
	for (size_t i = 6; i < 14; ++i) {
		const char c = id[i];
		if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
	}
	return true;
}

void path_for(const char *id, char *out, size_t out_size)
{
	snprintf(out, out_size, "%s/%s.jsonl", kDirectory, id);
}

int64_t now_ms()
{
	struct timespec ts = {};
	if (clock_gettime(CLOCK_REALTIME, &ts) != 0) return 0;
	return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

struct Entry {
	std::string id;
	int64_t updated_at;
};

std::vector<Entry> entries()
{
	std::vector<Entry> out;
	DIR *dir = opendir(kDirectory);
	if (!dir) return out;
	while (dirent *entry = readdir(dir)) {
		const size_t len = strlen(entry->d_name);
		if (len != 20 || strcmp(entry->d_name + 14, ".jsonl") != 0) continue;
		char id[15];
		memcpy(id, entry->d_name, 14);
		id[14] = '\0';
		if (!valid_id(id)) continue;
		char path[48];
		path_for(id, path, sizeof(path));
		struct stat st = {};
		const int64_t updated = stat(path, &st) == 0 ? (int64_t)st.st_mtime * 1000 : 0;
		out.push_back({id, updated});
	}
	closedir(dir);
	std::sort(out.begin(), out.end(), [](const Entry &a, const Entry &b) {
		return a.updated_at > b.updated_at;
	});
	return out;
}

void prune()
{
	const std::vector<Entry> all = entries();
	for (size_t i = kDefaultLimit; i < all.size(); ++i) {
		char path[48];
		path_for(all[i].id.c_str(), path, sizeof(path));
		if (remove(path) == 0) ESP_LOGI(TAG, "pruned old voice transcript %s", all[i].id.c_str());
	}
}

/* A turn can carry a 4 KB agent reply, but an 8 KB stack buffer overflows the
 * esp_http_server task (and the voice worker, whose stack is 8 KB) and smashes
 * the heap next to it -- the TLSF walk in the next flash read is only where
 * that corruption surfaces. Grow on the heap instead. */
constexpr size_t kMaxLineBytes = 8192;

/* Returns false at EOF with nothing read, or for an overlong line, which is
 * consumed and dropped whole so the format stays line-per-message. */
bool read_line(FILE *file, std::string &line)
{
	line.clear();
	bool too_long = false;
	int c;
	while ((c = fgetc(file)) != EOF) {
		if (c == '\n') break;
		if (line.size() < kMaxLineBytes) {
			line.push_back((char)c);
		} else {
			too_long = true;
		}
	}
	if (c == EOF && line.empty()) return false;
	return !too_long;
}

long st_size_or_zero(FILE *file)
{
	const long here = ftell(file);
	if (here < 0 || fseek(file, 0, SEEK_END) != 0) return 0;
	const long size = ftell(file);
	(void)fseek(file, here, SEEK_SET);
	return size > 0 ? size : 0;
}

void trim_if_needed(const char *path)
{
	struct stat st = {};
	if (stat(path, &st) != 0 || st.st_size <= kMaxFileBytes) return;
	FILE *file = fopen(path, "r");
	if (!file) return;
	std::vector<std::string> lines;
	std::string line;
	while (read_line(file, line)) {
		/* read_line() consumes the newline; put it back for the rewritten file. */
		line.push_back('\n');
		lines.push_back(line);
	}
	fclose(file);
	if (lines.size() <= kMaxMessages) return;
	const size_t first = lines.size() - kMaxMessages;
	char temporary[52];
	snprintf(temporary, sizeof(temporary), "%s.tmp", path);
	file = fopen(temporary, "w");
	if (!file) return;
	for (size_t i = first; i < lines.size(); ++i) fputs(lines[i].c_str(), file);
	if (fclose(file) == 0 && rename(temporary, path) == 0) {
		ESP_LOGI(TAG, "trimmed voice transcript to %d turns", kMaxMessages);
	} else {
		remove(temporary);
	}
}

void short_title(const char *text, char out[61])
{
	size_t len = strlen(text);
	if (len > 60) len = 60;
	memcpy(out, text, len);
	out[len] = '\0';
	while (len > 0 && (((unsigned char)out[len] & 0xc0U) == 0x80U)) out[--len] = '\0';
	if (len > 0 && (unsigned char)out[len - 1] >= 0xc0U) out[--len] = '\0';
}

}  // namespace

namespace voice_history {

esp_err_t init()
{
	if (mkdir(kDirectory, 0775) != 0) {
		struct stat st = {};
		if (stat(kDirectory, &st) != 0 || !S_ISDIR(st.st_mode)) {
			ESP_LOGW(TAG, "cannot create %s; voice history is unavailable", kDirectory);
			return ESP_FAIL;
		}
	}
	return ESP_OK;
}

esp_err_t append(const char *conversation_id, const char *role,
                 const char *text, bool spoken, int64_t *timestamp)
{
	const int64_t ts = now_ms();
	if (timestamp) *timestamp = ts;
	if (!valid_id(conversation_id) || !role || !text ||
	    (strcmp(role, "user") != 0 && strcmp(role, "assistant") != 0)) {
		return ESP_ERR_INVALID_ARG;
	}
	Lock lock;
	if (init() != ESP_OK) return ESP_FAIL;
	char path[48];
	path_for(conversation_id, path, sizeof(path));
	struct stat before = {};
	const bool is_new = stat(path, &before) != 0;
	FILE *file = fopen(path, "a");
	if (!file) {
		ESP_LOGW(TAG, "cannot append voice transcript %s", path);
		return ESP_FAIL;
	}
	cJSON *message = cJSON_CreateObject();
	if (!message) {
		fclose(file);
		return ESP_ERR_NO_MEM;
	}
	cJSON_AddNumberToObject(message, "ts", (double)ts);
	cJSON_AddStringToObject(message, "role", role);
	cJSON_AddStringToObject(message, "text", text);
	cJSON_AddBoolToObject(message, "spoken", spoken);
	char *json = cJSON_PrintUnformatted(message);
	cJSON_Delete(message);
	if (!json) {
		fclose(file);
		return ESP_ERR_NO_MEM;
	}
	const bool wrote = fputs(json, file) >= 0 && fputc('\n', file) != EOF;
	const bool ok = wrote && fclose(file) == 0;
	if (!wrote) (void)fclose(file);
	cJSON_free(json);
	if (!ok) {
		ESP_LOGW(TAG, "voice transcript write failed: %s", path);
		return ESP_FAIL;
	}
	trim_if_needed(path);
	if (is_new) prune();
	return ESP_OK;
}

cJSON *list_json(int limit)
{
	if (limit <= 0 || limit > 50) limit = kDefaultLimit;
	/* A transcript holds up to 200 turns, and 16 of them parsed at once is more
	 * cJSON than the internal heap can take while Wi-Fi and LVGL are running.
	 * Send the tail of each conversation and stop at a total budget. */
	constexpr int kListMessagesPerConversation = 60;
	constexpr int kListMessagesTotal = 300;
	int budget = kListMessagesTotal;
	bool truncated = false;
	Lock lock;
	cJSON *root = cJSON_CreateObject();
	cJSON *conversations = cJSON_CreateArray();
	if (!root || !conversations) {
		cJSON_Delete(root);
		cJSON_Delete(conversations);
		return nullptr;
	}
	cJSON_AddItemToObject(root, "conversations", conversations);
	const std::vector<Entry> all = entries();
	const size_t count = std::min(all.size(), (size_t)limit);
	cJSON_AddNumberToObject(root, "dropped", all.size() > count ? all.size() - count : 0);
	for (size_t i = 0; i < count; ++i) {
		char path[48];
		path_for(all[i].id.c_str(), path, sizeof(path));
		FILE *file = fopen(path, "r");
		if (!file) continue;
		/* Parse only the tail: 60 turns is far less than 12 KiB, and the
		 * partial first line is skipped below. */
		const long file_size = (long)st_size_or_zero(file);
		if (file_size > kTailBytes) {
			(void)fseek(file, -kTailBytes, SEEK_END);
		}
		cJSON *conversation = cJSON_CreateObject();
		cJSON *messages = cJSON_CreateArray();
		if (!conversation || !messages) {
			cJSON_Delete(conversation);
			cJSON_Delete(messages);
			fclose(file);
			continue;
		}
		cJSON_AddStringToObject(conversation, "id", all[i].id.c_str());
		cJSON_AddItemToObject(conversation, "messages", messages);
		char title[61] = "Voice conversation";
		int64_t updated_at = all[i].updated_at;
		std::string line;
		if (file_size > kTailBytes) {
			/* Whatever precedes the seek point is a partial line. */
			(void)read_line(file, line);
		}
		while (read_line(file, line)) {
			if (budget <= 0) {
				truncated = true;
				break;
			}
			cJSON *message = cJSON_Parse(line.c_str());
			if (!message) continue;
			cJSON *role = cJSON_GetObjectItem(message, "role");
			cJSON *text = cJSON_GetObjectItem(message, "text");
			if (cJSON_IsString(role) && cJSON_IsString(text)) {
				cJSON_AddItemToArray(messages, message);
				--budget;
				if (cJSON_GetArraySize(messages) > kListMessagesPerConversation) {
					cJSON_DeleteItemFromArray(messages, 0);
					truncated = true;
				}
				cJSON *ts = cJSON_GetObjectItem(message, "ts");
				if (cJSON_IsNumber(ts)) updated_at = ts->valuedouble;
				if (strcmp(title, "Voice conversation") == 0 &&
				    strcmp(role->valuestring, "user") == 0) {
					short_title(text->valuestring, title);
				}
			} else {
				cJSON_Delete(message);
			}
		}
		fclose(file);
		cJSON_AddStringToObject(conversation, "title", title);
		cJSON_AddNumberToObject(conversation, "updatedAt", (double)updated_at);
		cJSON_AddItemToArray(conversations, conversation);
	}
	if (truncated) cJSON_AddBoolToObject(root, "truncated", true);
	return root;
}

esp_err_t clear_conversation(const char *conversation_id)
{
	if (!valid_id(conversation_id)) return ESP_ERR_INVALID_ARG;
	char path[48];
	path_for(conversation_id, path, sizeof(path));
	Lock lock;
	struct stat st = {};
	if (stat(path, &st) != 0) return ESP_OK;
	return remove(path) == 0 ? ESP_OK : ESP_FAIL;
}

esp_err_t clear()
{
	Lock lock;
	esp_err_t result = ESP_OK;
	for (const Entry &entry : entries()) {
		char path[48];
		path_for(entry.id.c_str(), path, sizeof(path));
		if (remove(path) != 0) result = ESP_FAIL;
	}
	return result;
}

}  // namespace voice_history
