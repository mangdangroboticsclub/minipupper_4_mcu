#pragma once

/*
 * Text spoken by the voice gateway is not text rendered by the PWA. Keep the
 * conversion free of ESP-IDF so tools/host_tests can exercise it.
 */

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Remove markdown, code, links and emoji, collapse whitespace and fit the
 * result in output_size (including the NUL). A truncated result ends at the
 * last sentence or word boundary that fits. Returns the output length. */
size_t mpx_voice_text_for_speech(const char *input, char *output, size_t output_size);


#ifdef __cplusplus
}
#endif
