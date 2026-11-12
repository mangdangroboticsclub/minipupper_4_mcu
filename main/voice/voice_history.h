#pragma once

#include <stddef.h>
#include <stdint.h>

#include "cJSON.h"
#include "esp_err.h"

/* Device-owned voice transcripts. These are deliberately independent of
 * ESP-Claw's private session files and of the phone's localStorage. */
namespace voice_history {

esp_err_t init();

/** Append one complete user/assistant turn. Failures are logged by the
 *  implementation and never prevent the robot from speaking. */
esp_err_t append(const char *conversation_id, const char *role,
                 const char *text, bool spoken, int64_t *timestamp = nullptr);

/** {"conversations":[...],"dropped":n}, newest first. Caller cJSON_Delete()s.
 *  Each conversation has id, title, updatedAt and a messages array. */
cJSON *list_json(int limit);

/** Delete one transcript; missing files are already clear. */
esp_err_t clear_conversation(const char *conversation_id);

/** Delete transcript files only; ESP-Claw's conversation memory is untouched. */
esp_err_t clear();

}  // namespace voice_history
