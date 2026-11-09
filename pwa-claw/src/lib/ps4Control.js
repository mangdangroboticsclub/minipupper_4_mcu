export const PS4_DEADZONE = 0.18;
export const PS4_YAW_MAX = 30;
export const PS4_PITCH_MAX = 20;

/** Firmware joy yaw is positive left; a rightward stick must turn right. */
export function ps4TurnRate(nx) {
  const a = Math.abs(nx);
  if (a < PS4_DEADZONE) return 0;
  const t = Math.sign(nx) * Math.min(1, 0.1 + 0.9 * (a - PS4_DEADZONE) / (1 - PS4_DEADZONE));
  return -(+t.toFixed(3));
}

/** Match the firmware power response; it has no `powered` field. */
export function ps4PowerSucceeded(response, action) {
  return response?.ok === true
    && response.resting === false
    && response.holding === (action === "hold");
}

/** Analog Pose mode: right = yaw right, up = nose up. */
export function ps4PoseAngles(nx, ny) {
  const m = Math.hypot(nx, ny);
  const k = m > 0 ? Math.max(0, Math.min(1, (m - PS4_DEADZONE) / (1 - PS4_DEADZONE))) / m : 0;
  return {
    yaw: Math.round(nx * k * PS4_YAW_MAX) || 0,
    pitch: Math.round(-ny * k * PS4_PITCH_MAX) || 0,
  };
}
