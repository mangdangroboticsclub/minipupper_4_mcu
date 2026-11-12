#pragma once

/*
 * Device-brain voice: the gateway transcribes and speaks, ESP-Claw answers.
 * voice_glue owns the choice between this and the gateway's MCP brain.
 */

#include <stddef.h>

#include "esp_err.h"

namespace voice_brain {

/** Build setting, a running agent and an AI mode other than "off". */
bool wanted();

/** Idempotent. Starts the worker on first use and selects device brain for
 *  subsequent WebSocket hellos. ESP_ERR_INVALID_STATE when !wanted(). */
esp_err_t start();

/** Select server brain for subsequent connections and ignore late replies.
 *  The worker stays allocated so turning AI back on is cheap. */
void stop();

/** Start a fresh rolling voice/ESP-Claw session, invalidating any reply from
 *  the previous one. Requires the local voice brain to be running. */
esp_err_t new_conversation();

/** Stop audio and the current voice session immediately; next wake is fresh. */
esp_err_t end_conversation();

/** Delete both ESP-Claw context and the transcript for a voice session. */
esp_err_t clear_conversation(const char *conversation_id);

/** Copy the stable voice conversation / ESP-Claw session id. */
void conversation_id(char *out, size_t out_size);

}  // namespace voice_brain
