const LAST_CONNECTION_KEY = "mpx_last_successful_connection";

export const WELCOME_AFTER_MS = 24 * 60 * 60 * 1000;

/** Whether this browser has reached the robot recently enough to skip setup. */
export function shouldShowWelcome(now = Date.now(), storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    const lastConnectedAt = Number(target.getItem(LAST_CONNECTION_KEY));
    const elapsed = now - lastConnectedAt;
    return !Number.isFinite(lastConnectedAt) || lastConnectedAt <= 0 ||
      elapsed < 0 || elapsed >= WELCOME_AFTER_MS;
  } catch {
    // Storage can be unavailable in private browsing or restricted WebViews.
    return true;
  }
}

/** Remember an actual robot response, rather than merely opening the app. */
export function recordSuccessfulConnection(now = Date.now(), storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    target.setItem(LAST_CONNECTION_KEY, String(now));
  } catch {
    // A storage failure must not prevent the app from connecting.
  }
}
