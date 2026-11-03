#pragma once

#include "esp_err.h"

/*
 * What the rest of the firmware tells the screen.
 *
 * mpv2-claw does this in main.c: the IMU feed for the alive eyes, the
 * network line under them, the Raspberry Pi's address and its "ROS" badge.
 * Here it is one small module so main.cc stays a boot sequence.
 */
namespace display_glue {

/** Panel + LVGL + face. Call after robot::init() (the eyes read the IMU)
 *  and before anything slow, so the face is the first thing on the panel.
 *  Safe with the display compiled out. */
void start_face();

/** After LittleFS is mounted: built-in GIFs into <fs>/display, then bring
 *  back a looping animation chosen before the reboot. */
void start_animations();

/** The event task: Wi-Fi line under the eyes (polled), Pi address, ROS
 *  badge. Call after Wi-Fi is up; registers the Pi link observers itself. */
void start_events();

/** If the boot check (driver_board_boot_check, run in robot::init) found a
 *  problem: which board / servo, on the screen for 30 s, then the face comes
 *  back. Nothing is shown when all is well. Call after start_face(). */
void show_boot_check();

/** Temperature watch, in the background, warnings on the screen only (the
 *  servos are not stopped):
 *    first minute after boot: a servo over 60 C  -> "faulty" (it heated up
 *                             that fast from cold)
 *    after that, always:      a servo over 80 C  -> "temperature too high",
 *                             again every minute while it stays over 75 C
 *  Only temperatures from replies that pass the full check count, and only
 *  two readings in a row (1 s apart) raise a warning. Call after start_face(). */
void start_temp_watch();

/** From robot::set_master_observer -- runs on the Pi link task, so it only
 *  posts an event. */
void on_master_changed(bool active);

}  // namespace display_glue
