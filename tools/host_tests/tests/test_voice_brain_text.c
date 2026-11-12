/* Agent output is markdown for a browser; the gateway needs plain prose. */
#include "test_harness.h"

#include <string.h>

#include "voice_brain_text.h"

static void check_speech(const char *input, const char *expected)
{
    char output[512];
    CHECK_EQ_INT(mpx_voice_text_for_speech(input, output, sizeof output), strlen(expected));
    CHECK_EQ_STR(output, expected);
}

TEST_CASE(voice_speech_removes_markdown_code_links_and_emoji)
{
    check_speech("# Sit down\n\n**Good.** `robot_move()` See https://example.com now 😀",
                 "Sit down. Good. See now");
}

TEST_CASE(voice_speech_flattens_lists_and_drops_tables)
{
    check_speech("- stand\n- sit\n\n| a | b |\n1. wave", "stand. sit. wave");
}

TEST_CASE(voice_speech_drops_code_blocks_and_littlefs_paths)
{
    check_speech("Before\n```c\nrobot_move();\n```\nRead /fs/agent/memory now", "Before. Read now");
    check_speech("```\nonly code\n```", "");
    check_speech("Before `unfinished code", "Before");
}

TEST_CASE(voice_speech_preserves_non_english_text)
{
    check_speech("很好 😀", "很好");
}

TEST_CASE(voice_speech_truncates_at_a_word_boundary)
{
    char output[32];
    const size_t len = mpx_voice_text_for_speech(
        "one two three four five six seven eight nine ten eleven", output, sizeof output);

    CHECK(len > 0);
    CHECK(len < sizeof output);
    CHECK_EQ_STR(output, "one two three four five six");
}

TEST_CASE(voice_speech_handles_empty_and_invalid_input)
{
    char output[8] = "dirty";
    CHECK_EQ_INT(mpx_voice_text_for_speech(NULL, output, sizeof output), 0);
    CHECK_EQ_STR(output, "");
    CHECK_EQ_INT(mpx_voice_text_for_speech("hello", NULL, 0), 0);
    CHECK_EQ_INT(mpx_voice_text_for_speech("hello", output, 0), 0);
}
