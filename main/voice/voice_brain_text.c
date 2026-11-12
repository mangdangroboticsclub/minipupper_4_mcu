#include "voice_brain_text.h"

#include <ctype.h>
#include <stdbool.h>
#include <string.h>

typedef struct {
	char *data;
	size_t size;
	size_t len;
	bool truncated;
	bool pending_space;
	bool pending_break;
} speech_out;

static bool sentence_end(char c)
{
	return c == '.' || c == '!' || c == '?' || c == ':' || c == ';';
}

static void put_byte(speech_out *out, char c)
{
	if (out->len + 1 >= out->size) {
		out->truncated = true;
		return;
	}
	out->data[out->len++] = c;
}

static void begin_word(speech_out *out)
{
	if (out->len == 0 || out->data[out->len - 1] == ' ') {
		out->pending_space = false;
		out->pending_break = false;
		return;
	}
	if (out->pending_break && !sentence_end(out->data[out->len - 1])) {
		put_byte(out, '.');
	}
	if (out->pending_space || out->pending_break) {
		put_byte(out, ' ');
	}
	out->pending_space = false;
	out->pending_break = false;
}

static void finish_truncation(speech_out *out)
{
	if (!out->truncated || out->len == 0) {
		return;
	}
	/* Prefer a complete sentence; a long single sentence falls back to the
	 * last complete word. Do not search the first quarter: an abbreviation at
	 * the beginning would otherwise reduce the whole reply to two words. */
	const size_t floor = out->len / 4;
	size_t cut = 0;
	for (size_t i = out->len; i > floor; --i) {
		if (sentence_end(out->data[i - 1])) {
			cut = i;
			break;
		}
		if (cut == 0 && out->data[i - 1] == ' ') {
			cut = i - 1;
		}
	}
	if (cut == 0) {
		cut = out->len;
		/* Never leave half of a UTF-8 code point at the cut. */
		size_t sequence = cut;
		while (sequence > 0 &&
		       (((unsigned char)out->data[sequence - 1] & 0xc0U) == 0x80U)) {
			--sequence;
		}
		if (sequence < cut && sequence > 0) {
			const unsigned char lead = (unsigned char)out->data[sequence - 1];
			size_t expected = 1;
			if ((lead & 0xe0U) == 0xc0U) expected = 2;
			if ((lead & 0xf0U) == 0xe0U) expected = 3;
			if ((lead & 0xf8U) == 0xf0U) expected = 4;
			if (cut - (sequence - 1) < expected) {
				cut = sequence - 1;
			}
		} else if (cut > 0 && (unsigned char)out->data[cut - 1] >= 0xc0U) {
			--cut;
		}
	}
	while (cut > 0 && out->data[cut - 1] == ' ') {
		--cut;
	}
	out->len = cut;
}

size_t mpx_voice_text_for_speech(const char *input, char *output, size_t output_size)
{
	if (!output || output_size == 0) {
		return 0;
	}
	output[0] = '\0';
	if (!input) {
		return 0;
	}

	speech_out out = {.data = output, .size = output_size};
	bool fence = false;
	bool inline_code = false;
	bool skip_line = false;
	bool skip_token = false;
	bool line_start = true;
	const unsigned char *p = (const unsigned char *)input;

	while (*p && !out.truncated) {
		if (p[0] == '`' && p[1] == '`' && p[2] == '`') {
			fence = !fence;
			inline_code = false;
			p += 3;
			continue;
		}
		if (*p == '\n' || *p == '\r') {
			if (fence) {
				++p;
				continue;
			}
			skip_line = false;
			skip_token = false;
			line_start = true;
			out.pending_break = out.len > 0;
			out.pending_space = false;
			++p;
			continue;
		}
		if (fence || skip_line) {
			++p;
			continue;
		}
		if (skip_token) {
			if (isspace(*p)) {
				skip_token = false;
				out.pending_space = out.len > 0;
			}
			++p;
			continue;
		}
		if (*p == '`') {
			inline_code = !inline_code;
			++p;
			continue;
		}
		if (inline_code) {
			++p;
			continue;
		}
		if (line_start) {
			/* Markdown block markers introduce speech, they are not speech.
			 * A table row is dropped altogether. */
			while (*p == ' ' || *p == '\t') {
				++p;
			}
			if (*p == '|') {
				skip_line = true;
				++p;
				continue;
			}
			if (*p == '#' || *p == '-' || *p == '+' || *p == '>' || *p == '*') {
				while (*p == '#' || *p == '-' || *p == '+' || *p == '>' || *p == '*' ||
				       *p == ' ' || *p == '\t') {
					++p;
				}
			} else if (isdigit(*p)) {
				const unsigned char *number = p;
				while (isdigit(*p)) {
					++p;
				}
				if (*p == '.' || *p == ')') {
					++p;
					while (*p == ' ' || *p == '\t') {
						++p;
					}
				} else {
					p = number;
				}
			}
			line_start = false;
			if (!*p) {
				break;
			}
			if (*p == '\n' || *p == '\r') {
				continue;
			}
		}
		if (isspace(*p)) {
			out.pending_space = out.len > 0;
			++p;
			continue;
		}
		/* Links and LittleFS paths are useful on screen and meaningless when
		 * read aloud. Token starts only: "see https://..." loses the URL, not
		 * the word before it. */
		if ((out.len == 0 || out.pending_space || out.pending_break) &&
		    (strncmp((const char *)p, "http://", 7) == 0 ||
		     strncmp((const char *)p, "https://", 8) == 0 ||
		     strncmp((const char *)p, "www.", 4) == 0 ||
		     strncmp((const char *)p, "/fs/", 4) == 0)) {
			skip_token = true;
			++p;
			continue;
		}
		/* Four-byte UTF-8 is predominantly emoji. Keep three-byte scripts so
		 * non-English replies survive; drop emoji variation and joiner marks. */
		if (*p >= 0xf0U) {
			++p;
			while ((*p & 0xc0U) == 0x80U) {
				++p;
			}
			continue;
		}
		if ((p[0] == 0xefU && p[1] == 0xb8U && p[2] == 0x8fU) ||
		    (p[0] == 0xe2U && p[1] == 0x80U && p[2] == 0x8dU)) {
			p += 3;
			continue;
		}
		if (*p == '*' || *p == '_' || *p == '#' || *p == '>') {
			++p;
			continue;
		}
		begin_word(&out);
		if (!out.truncated) {
			put_byte(&out, (char)*p);
		}
		++p;
	}
	while (out.len > 0 && out.data[out.len - 1] == ' ') {
		--out.len;
	}
	out.data[out.len] = '\0';
	finish_truncation(&out);
	out.data[out.len] = '\0';
	return out.len;
}

