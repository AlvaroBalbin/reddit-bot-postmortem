import { lastPostedAt, postedInLast24h, type RedditPostKind } from "./supabase.js";
import { log } from "./log.js";

// "Pacing buckets" = which kinds share a cap + cooldown. v3:
//   post     → just 'post'
//   comment  → 'comment' + 'reply'  (engagement loop replies count too)
//   priming  → 'priming_comment'
// Used so the engagement-loop reply doesn't cheat past the comment cap.
export type PacingBucket = "post" | "comment" | "priming";

const BUCKET_KINDS: Record<PacingBucket, RedditPostKind[]> = {
  post: ["post"],
  comment: ["comment", "reply"],
  priming: ["priming_comment"],
};

// v3 (2026-05-03): clustered activity windows + lower caps + longer cooldowns.
// Goal is "real human" not "max throughput on a fresh account."
//
// Two windows per day, Europe/Madrid:
//   12:30–14:30   lunch
//   19:00–22:00   evening
//
// Outside the windows: gates closed (`outside_posting_hours`).
// Within a window: pacing gates apply normally — at most ~2 actions per
// window in practice given the cooldowns + 3/day cap.

type GateResult =
  | { ok: true }
  | { ok: false; reason: string; retryAfterMs?: number };

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function jitterMs(baseMs: number, pct = 0.5): number {
  // Larger jitter than v2 (50% vs 20%) so cooldowns don't read clockwork.
  const delta = baseMs * pct * (Math.random() * 2 - 1);
  return Math.max(0, Math.floor(baseMs + delta));
}

const COOLDOWNS: Record<PacingBucket, () => number> = {
  // v3 defaults: longer + more variance (±50% jitter).
  post: () => jitterMs(envInt("COOLDOWN_POST_MIN", 360) * 60_000),
  comment: () => jitterMs(envInt("COOLDOWN_COMMENT_MIN", 60) * 60_000),
  priming: () => jitterMs(envInt("COOLDOWN_PRIMING_MIN", 90) * 60_000),
};

const DAILY_CAPS: Record<PacingBucket, () => number> = {
  // v3: drop comments 8→3, priming 6→2. Posts unchanged at 2.
  post: () => envInt("DAILY_CAP_POST", 2),
  comment: () => envInt("DAILY_CAP_COMMENT", 3),
  priming: () => envInt("DAILY_CAP_PRIMING", 2),
};

// Two windows. Format: [startHour, startMin, endHour, endMin] in Europe/Madrid.
type Window = { startMin: number; endMin: number };
const WINDOWS: Window[] = [
  { startMin: 12 * 60 + 30, endMin: 14 * 60 + 30 },  // lunch 12:30–14:30
  { startMin: 19 * 60,      endMin: 22 * 60      },  // evening 19:00–22:00
];

function madridMinuteOfDay(now: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  );
  const h = Number.parseInt(parts.hour ?? "0", 10);
  const m = Number.parseInt(parts.minute ?? "0", 10);
  return h * 60 + m;
}

function withinAnyWindow(now?: Date): boolean {
  const minute = madridMinuteOfDay(now);
  return WINDOWS.some((w) => minute >= w.startMin && minute < w.endMin);
}

function currentWindowLabel(now?: Date): string {
  const minute = madridMinuteOfDay(now);
  if (minute >= WINDOWS[0]!.startMin && minute < WINDOWS[0]!.endMin) return "lunch";
  if (minute >= WINDOWS[1]!.startMin && minute < WINDOWS[1]!.endMin) return "evening";
  return "outside";
}

export async function checkGate(bucket: PacingBucket): Promise<GateResult> {
  if (!withinAnyWindow()) {
    return { ok: false, reason: "outside_posting_hours" };
  }

  const kinds = BUCKET_KINDS[bucket];
  const cap = DAILY_CAPS[bucket]();
  const todayCount = await postedInLast24h(kinds);
  if (todayCount >= cap) {
    return { ok: false, reason: `daily_cap_${bucket}_${todayCount}/${cap}` };
  }

  const last = await lastPostedAt(kinds);
  if (last) {
    const cooldownMs = COOLDOWNS[bucket]();
    const elapsed = Date.now() - last.getTime();
    if (elapsed < cooldownMs) {
      const wait = cooldownMs - elapsed;
      return {
        ok: false,
        reason: `cooldown_${bucket}_${Math.round(wait / 60000)}m_left`,
        retryAfterMs: wait,
      };
    }
  }

  return { ok: true };
}

export function logGate(bucket: PacingBucket, gate: GateResult): void {
  const win = currentWindowLabel();
  if (gate.ok) {
    log.info(`gate ${bucket} OPEN [${win}]`);
  } else {
    log.info(`gate ${bucket} closed [${win}]: ${gate.reason}`);
  }
}
