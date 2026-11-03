/*
 * SPDX-FileCopyrightText: 2026 MangDang
 * SPDX-License-Identifier: Apache-2.0
 *
 * See display_glue.h. Ported from the display parts of mpv2-claw's main.c.
 *
 * The network line is polled once a second rather than fed from the Wi-Fi
 * event handlers. mpv2-claw's note on this: cap_display_face_set_network()
 * takes the LVGL lock and writes an LVGL object, and the Wi-Fi event task
 * is not somewhere to wait on a lock the LVGL task may be holding while it
 * pushes a frame. A one-second poll from our own low-priority task costs
 * nothing and keeps wifi_sta.cc untouched.
 */

#include "display/display_glue.h"

#include <cstdio>
#include <cstring>
#include <string>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "freertos/idf_additions.h"
#include "sdkconfig.h"

#include "display/cap_display.h"
#include "display/display_assets.h"
#include "network/wifi_ap.h"
#include "network/wifi_sta.h"
#include "pi/pi_link.h"
#include "robot/mpx_robot.h"
#include "robot/driver_board.h"

static const char *TAG = "display_glue";

namespace {

constexpr const char *ANIM_DIR = "/fs/display";
constexpr TickType_t  NET_POLL = pdMS_TO_TICKS(1000);

enum class Kind : uint8_t { MasterOn, MasterOff, PiIp };

struct Event {
    Kind kind;
    char ip[16];
};

QueueHandle_t s_events;

/* The alive eyes' IMU feed (cap_display_face.c). Runs on the LVGL task ~30
 * times a second: imu_read is a cached copy under a short mutex, and the
 * gait name a table lookup. "Busy" = the robot is making its own bumps -- a
 * continuous gait, or the Pi driving it -- so a footfall is not mistaken for
 * someone picking it up. */
bool face_motion(cap_display_motion_t *out)
{
    mpx_robot_imu_t imu;

    if (!mpx_robot_ready()) {
        return false;
    }
    mpx_robot_imu_read(&imu);
    out->ax = imu.ax; out->ay = imu.ay; out->az = imu.az;
    out->gx = imu.gx; out->gy = imu.gy; out->gz = imu.gz;
    out->ok = imu.ax != 0.0f || imu.ay != 0.0f || imu.az != 0.0f;
    out->busy = mpx_robot_pi_in_control() ||
                mpx_robot_gait_is_continuous(mpx_robot_current_gait_name());
    out->move = mpx_robot_playing_move(&out->move_seq);   /* the move's own face */
    return true;
}

void post(Kind kind, const char *ip)
{
    Event ev = { kind, { 0 } };
    if (ip) {
        std::snprintf(ev.ip, sizeof(ev.ip), "%s", ip);
    }
    if (s_events) {
        (void)xQueueSend(s_events, &ev, 0);
    }
}

void on_pi_ip(const char *ip)
{
    post(Kind::PiIp, ip);
}

void poll_network()
{
    static bool last_connected = false;
    static std::string last_ip;
    static bool first = true;

    const bool connected = network::wifi_sta_get_state() == network::StaState::Connected;
    const std::string ip = connected ? network::wifi_sta_get_ip() : std::string();
    if (!first && connected == last_connected && ip == last_ip) {
        return;
    }
    first = false;
    last_connected = connected;
    last_ip = ip;
    cap_display_face_set_network(connected, network::wifi_ap_get_ssid(), ip.c_str());
}

void events_task(void *)
{
    Event ev;
    for (;;) {
        if (xQueueReceive(s_events, &ev, NET_POLL) == pdTRUE) {
            switch (ev.kind) {
            case Kind::MasterOn:
                ESP_LOGW(TAG, "Raspberry Pi (ROS) in control: app and skills cannot move the robot");
                cap_display_set_ros_mode(true);
                break;
            case Kind::MasterOff:
                ESP_LOGW(TAG, "Raspberry Pi released the robot: back to normal");
                cap_display_set_ros_mode(false);
                break;
            case Kind::PiIp:
                cap_display_face_set_pi(ev.ip);
                break;
            }
        }
        poll_network();
    }
}

}  // namespace

void display_glue::start_face()
{
    if (cap_display_service_start() != ESP_OK) {
        return;                       /* compiled out, or the panel did not answer */
    }
    cap_display_face_set_motion_source(face_motion);
    const esp_err_t err = cap_display_face_start();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "face not started: %s", esp_err_to_name(err));
    }
    /* The queue exists from here so the Pi link (started next, before the
     * network) can post from its first frame; the task that drains it
     * starts with the network (start_events). Posts queue up meanwhile. */
    s_events = xQueueCreate(8, sizeof(Event));
#if CONFIG_APP_PI_LINK_ENABLE
    pi_link::set_ip_observer(on_pi_ip);
    pi_link::set_video_sink(cap_display_show_jpeg);   /* the Pi's camera picture */
#endif
}

/* A message screen: a coloured title bar, then one line per item (a red or
 * amber dot in front, long lines wrap), a grey footer. The face comes back
 * after hold_ms. */
static void draw_message(const char *title, bool fault, const char *const *lines,
                         const uint8_t *sev, int n, const char *foot, uint32_t hold_ms)
{
    if (!cap_display_available()) {
        return;
    }
    const int W = cap_display_draw_width(), H = cap_display_draw_height();
    if (W <= 0 || H <= 0) {
        return;
    }
    const uint32_t RED = 0xFF5050, AMBER = 0xFFB020, WHITE = 0xF0F0F0, GREY = 0x9AA0A8;
    cap_display_draw_fill(0x000000);
    cap_display_draw_rect(0, 0, W, 38, fault ? 0x5A0000 : 0x4A3000, 0, 0);
    cap_display_draw_text(10, 4, title, WHITE, 28, -1, W - 20);
    int y = 46;
    for (int i = 0; i < n && y < H - 30; i++) {
        /* the 14 px font fits ~42 characters in 300 px; a line wraps to as many rows as it needs */
        const int rows = 1 + (int)std::strlen(lines[i]) / 40;
        cap_display_draw_rect(10, y + 5, 6, 6, sev[i] >= 2 ? RED : AMBER, -1, 0);
        cap_display_draw_text(22, y, lines[i], sev[i] >= 2 ? WHITE : 0xFFE0A0, 14, -1, W - 30);
        y += rows * 17 + 6;
    }
    if (foot && foot[0]) {
        cap_display_draw_text(10, H - 20, foot, GREY, 14, -1, W - 20);
    }
    if (cap_display_draw_show(hold_ms) != ESP_OK) {
        ESP_LOGW(TAG, "message not shown: %s", title);
    }
}

void display_glue::show_boot_check()
{
    const db_boot_check_t *c = driver_board_boot_check_result();
    if (!c || !c->ran || c->count == 0) {
        return;
    }
    const char *lines[DB_BOOT_MAX_LINES];
    for (int i = 0; i < c->count; i++) {
        lines[i] = c->line[i];
    }
    char foot[48];
    std::snprintf(foot, sizeof foot, c->more ? "+%d more - see the serial log" : "%d/4 servo boards answer",
                  c->more ? c->more : c->boards);
    draw_message(c->worst >= 2 ? "SERVO PROBLEM" : "SERVO WARNING", c->worst >= 2,
                 lines, c->sev, c->count, foot, 30000);
}

/* ── Temperature watch ─────────────────────────────────────────────────── */
namespace {

constexpr float    FIRST_MINUTE_C = 60.0f;   /* from cold: over this in the first minute = faulty */
constexpr float    TOO_HOT_C      = 80.0f;   /* any time after that                              */
constexpr float    TOO_HOT_CLEAR  = 75.0f;   /* below this the "too hot" warning is re-armed     */
constexpr int64_t  FIRST_MINUTE_US = 60LL * 1000 * 1000;
constexpr uint32_t REPEAT_MS      = 60000;   /* repeat "too hot" this often while it stays hot   */

const char *const LEG[4]  = { "FR", "FL", "RR", "RL" };
const char *const PART[3] = { "hip", "thigh", "calf" };

void temp_watch_task(void *)
{
    const int64_t t0 = esp_timer_get_time();
    uint8_t  over[13] = { 0 };          /* readings in a row over the limit                  */
    bool     faulty[13] = { false };    /* first-minute warning already given                */
    bool     hot[13] = { false };       /* "too hot" active (until it is below TOO_HOT_CLEAR) */
    int64_t  hot_shown[13] = { 0 };
    static char text[6][96];

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        driver_board_refresh_stale(1500);          /* only when nothing else is talking to the boards */
        const int64_t now = esp_timer_get_time();
        const bool first_minute = now - t0 < FIRST_MINUTE_US;
        const char *lines[6];
        uint8_t sev[6];
        int n = 0;
        bool new_fault = false, new_hot = false;

        for (int id = 1; id <= 12; id++) {
            float c;
            uint32_t age;
            if (!driver_board_checked_temperature(id, &c, &age) || age > 3000 || c <= -30.0f || c >= 150.0f) {
                over[id] = 0;                       /* no fresh reading, or a broken sensor (the boot check says so) */
                continue;
            }
            const char *leg = LEG[(id - 1) / 3], *part = PART[(id - 1) % 3];
            if (first_minute) {
                over[id] = c > FIRST_MINUTE_C ? over[id] + 1 : 0;
                if (over[id] >= 2 && !faulty[id]) {
                    faulty[id] = true;
                    new_fault = true;
                    ESP_LOGW(TAG, "servo %d (%s %s) %.0f C in the first minute after power-on - faulty", id, leg, part, c);
                    if (n < 6) {
                        std::snprintf(text[n], sizeof text[n], "Servo %d (%s %s): %.0f C in the first minute - faulty",
                                      id, leg, part, c);
                        sev[n] = 2; lines[n] = text[n]; n++;
                    }
                }
                continue;
            }
            if (c < TOO_HOT_CLEAR) {
                hot[id] = false;
            }
            over[id] = c > TOO_HOT_C ? over[id] + 1 : 0;
            if (over[id] >= 2 && (!hot[id] || (now - hot_shown[id]) / 1000 >= REPEAT_MS)) {
                hot[id] = true;
                hot_shown[id] = now;
                new_hot = true;
                ESP_LOGW(TAG, "servo %d (%s %s) %.0f C - temperature too high", id, leg, part, c);
                if (n < 6) {
                    std::snprintf(text[n], sizeof text[n], "Servo %d (%s %s): %.0f C", id, leg, part, c);
                    sev[n] = 2; lines[n] = text[n]; n++;
                }
            }
        }
        if (new_hot) {
            draw_message("TEMPERATURE TOO HIGH", true, lines, sev, n, "let it cool down", 15000);
        } else if (new_fault) {
            draw_message("SERVO FAULTY", true, lines, sev, n, "over 60 C within a minute of power-on", 30000);
        }
    }
}

}  // namespace

void display_glue::start_temp_watch()
{
    /* Internal-RAM stack: the SPI transfers it makes go through DMA. */
    if (xTaskCreate(temp_watch_task, "temp_watch", 4096, nullptr, 2, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "temperature watch did not start");
    }
}

void display_glue::start_animations()
{
    cap_display_anim_set_dir(ANIM_DIR);
    (void)display::deploy_builtin_gifs(ANIM_DIR);
    if (cap_display_available() && cap_display_anim_restore() == ESP_OK) {
        ESP_LOGI(TAG, "animation restore queued");
    }
}

void display_glue::start_events()
{
    if (!cap_display_available() || !s_events) {
        return;
    }
    // PSRAM stack: it only reads cached network state and takes the LVGL lock.
    if (xTaskCreateWithCaps(events_task, "disp_events", 4096, nullptr, 3, nullptr,
                            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS) {
        ESP_LOGE(TAG, "display event task did not start");
    }
}

void display_glue::on_master_changed(bool active)
{
    post(active ? Kind::MasterOn : Kind::MasterOff, nullptr);
}
