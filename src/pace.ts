import type { Meter, Pace, PaceStatus } from "./types";

/** Below this share of the window elapsed, a projection is mostly noise... */
const EARLY_FRACTION = 0.1;
/** ...unless this much is already used, which is worth flagging anyway. */
const EARLY_MIN_PERCENT = 10;

function band(projected: number): PaceStatus {
  if (projected < 50) return "well-below";
  if (projected < 90) return "below";
  if (projected <= 110) return "on";
  if (projected <= 150) return "above";
  return "well-above";
}

/**
 * Linear projection: assumes usage keeps the average rate it has had since
 * the window started. Returns undefined when the window isn't known.
 */
export function computePace(m: Meter, now = new Date()): Pace | undefined {
  if (m.percent == null) return undefined;
  if (m.percent >= 100) return { status: "reached" };
  if (!m.resetsAt || !m.windowStart) return undefined;

  const start = m.windowStart.getTime();
  const duration = m.resetsAt.getTime() - start;
  const elapsed = now.getTime() - start;
  if (duration <= 0 || elapsed <= 0 || elapsed >= duration) return undefined;

  const fraction = elapsed / duration;
  if (fraction < EARLY_FRACTION && m.percent < EARLY_MIN_PERCENT) return { status: "early" };

  const projectedPercent = m.percent / fraction;
  const status = band(projectedPercent);
  const pace: Pace = { status, projectedPercent: Math.round(projectedPercent) };
  if ((status === "above" || status === "well-above") && m.percent > 0) {
    const msToFull = ((100 - m.percent) / m.percent) * elapsed;
    pace.fullAt = new Date(now.getTime() + msToFull);
  }
  return pace;
}
