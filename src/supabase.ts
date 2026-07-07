import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import "dotenv/config";
import { withRetry } from "./lib/withRetry.js";

// The comment queue lived in a single Postgres table (reddit_post_queue) on
// Supabase. This file is the whole data layer: claim a row, mark it posted or
// failed, and the couple of read helpers pacing.ts needs. It is genuinely the
// tidiest part of the project, which is its own small lesson (see README).

export type RedditPostKind = "post" | "comment" | "reply" | "priming_comment";
export type RedditPostStatus =
  | "draft"
  | "ready"
  | "posting"
  | "posted"
  | "failed"
  | "skipped";

export type QueueRow = {
  id: string;
  kind: RedditPostKind;
  subreddit: string;
  title: string | null;
  body: string;
  link_url: string | null;
  parent_thread_url: string | null;
  status: RedditPostStatus;
  scheduled_at: string | null;
  posted_at: string | null;
  posted_url: string | null;
  attempts: number;
  last_error: string | null;
  source: string | null;
  source_id: string | null;
  notes: string | null;
  first_comment: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

let _client: SupabaseClient | null = null;

export function sb(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env. Copy .env.example to .env and fill them in.",
    );
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

// Freshness-prioritized claim.
//
// Comments and replies flip to LIFO by created_at (the freshest queued row
// fires first) because Reddit's algorithm rewards comments on hot threads
// (under ~6h old). Stale queued comments are skipped at claim time so we never
// post on a dead thread. The companion sweeper expireStaleComments() also
// marks them 'skipped' in bulk so the queue doesn't grow forever.
const STALE_COMMENT_AGE_MS = 6 * 60 * 60 * 1000; // 6h

export async function claimNextRow(
  kind: RedditPostKind,
): Promise<QueueRow | null> {
  return withRetry(async () => {
    const client = sb();
    const nowIso = new Date().toISOString();

    // Comments and replies: LIFO by created_at (newest first), age-filtered to <6h.
    const isCommentClass = kind === "comment" || kind === "reply";

    let query = client
      .from("reddit_post_queue")
      .select("*")
      .eq("kind", kind)
      .eq("status", "ready")
      .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso}`);

    if (isCommentClass) {
      const cutoffIso = new Date(Date.now() - STALE_COMMENT_AGE_MS).toISOString();
      query = query
        .gte("created_at", cutoffIso)
        .order("created_at", { ascending: false });
    } else {
      query = query
        .order("scheduled_at", { ascending: true, nullsFirst: true })
        .order("created_at", { ascending: true });
    }

    const { data, error } = await query.limit(1);

    if (error) throw error;
    if (!data || data.length === 0) return null;

    const row = data[0] as QueueRow;

    // Atomic-ish claim: only flip if still 'ready'. If two ticks raced,
    // one of them gets rowsAffected=0 and bails.
    const { data: claimed, error: claimErr } = await client
      .from("reddit_post_queue")
      .update({
        status: "posting",
        attempts: row.attempts + 1,
      })
      .eq("id", row.id)
      .eq("status", "ready")
      .select()
      .single();

    if (claimErr) throw claimErr;
    if (!claimed) return null; // someone else got it
    return claimed as QueueRow;
  }, { label: "claimNextRow" });
}

// Runs at the top of every tick. Flips comments/replies older than
// STALE_COMMENT_AGE_MS to status='skipped' so they never fire and don't bloat
// the queue. Returns the count of expired rows for logging.
export async function expireStaleComments(): Promise<number> {
  try {
    return await withRetry(
      async () => {
        const cutoffIso = new Date(Date.now() - STALE_COMMENT_AGE_MS).toISOString();
        const { data, error } = await sb()
          .from("reddit_post_queue")
          .update({
            status: "skipped",
            last_error: "stale_thread_skipped",
          })
          .eq("status", "ready")
          .in("kind", ["comment", "reply"])
          .lt("created_at", cutoffIso)
          .select("id");
        if (error) throw error;
        return data?.length ?? 0;
      },
      { label: "expireStaleComments" },
    );
  } catch (e) {
    // Sweeper is non-critical; log and move on so the tick still runs.
    console.error("[expireStaleComments]", (e as Error).message);
    return 0;
  }
}

export async function markPosted(
  id: string,
  postedUrl: string,
): Promise<void> {
  await withRetry(async () => {
    const { error } = await sb()
      .from("reddit_post_queue")
      .update({
        status: "posted",
        posted_at: new Date().toISOString(),
        posted_url: postedUrl,
        last_error: null,
      })
      .eq("id", id);
    if (error) throw error;
  }, { label: "markPosted" });
}

export async function markFailedOrRetry(
  id: string,
  attempts: number,
  err: string,
): Promise<void> {
  await withRetry(async () => {
    const giveUp = attempts >= 3;
    const { error } = await sb()
      .from("reddit_post_queue")
      .update({
        status: giveUp ? "failed" : "ready",
        last_error: err.slice(0, 1000),
      })
      .eq("id", id);
    if (error) throw error;
  }, { label: "markFailedOrRetry" });
}

// Last successful posted_at for a kind (or list of kinds sharing a pacing
// bucket). E.g. lastPostedAt(['comment','reply']) treats both as one bucket.
export async function lastPostedAt(
  kinds: RedditPostKind | RedditPostKind[],
): Promise<Date | null> {
  return withRetry(async () => {
    const arr = Array.isArray(kinds) ? kinds : [kinds];
    const { data, error } = await sb()
      .from("reddit_post_queue")
      .select("posted_at")
      .in("kind", arr)
      .eq("status", "posted")
      .not("posted_at", "is", null)
      .order("posted_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    const row = data?.[0];
    if (!row?.posted_at) return null;
    return new Date(row.posted_at as string);
  }, { label: "lastPostedAt" });
}

// Count of successful posts of a kind (or kind group) in the last 24h.
export async function postedInLast24h(
  kinds: RedditPostKind | RedditPostKind[],
): Promise<number> {
  return withRetry(async () => {
    const arr = Array.isArray(kinds) ? kinds : [kinds];
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await sb()
      .from("reddit_post_queue")
      .select("id", { count: "exact", head: true })
      .in("kind", arr)
      .eq("status", "posted")
      .gte("posted_at", since);
    if (error) throw error;
    return count ?? 0;
  }, { label: "postedInLast24h" });
}
