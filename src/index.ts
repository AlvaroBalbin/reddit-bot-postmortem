// The loop that tied it together.
//
// This is a trimmed version of what actually ran. The original also handled
// link posts, a karma-priming subsystem, a reply-scan loop, and a daily
// shadowban check. Those are left out on purpose (see README). What remains is
// the honest core: every few minutes, check the pacing gate, claim one queued
// comment, and post it through the browser like a person would.
//
// The drafts themselves came from a separate LLM function that is not in this
// repo. Here they are just "ready" rows with a body.

import "dotenv/config";
import { openContext, newPage, assertLoggedIn, sessionWarmup } from "./browser.js";
import { log } from "./log.js";
import { checkGate, logGate } from "./pacing.js";
import {
  claimNextRow,
  markFailedOrRetry,
  markPosted,
  expireStaleComments,
} from "./supabase.js";
import { submitComment, replyToComment } from "./comment.js";

// Mutex so two ticks never drive Chromium at the same time.
let browserBusy = false;
async function withBrowser<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  if (browserBusy) {
    log.info(`${label}: browser busy, deferring`);
    return null;
  }
  browserBusy = true;
  try {
    return await fn();
  } finally {
    browserBusy = false;
  }
}

// try a reply first (engagement priority), then a plain comment.
type WorkItem = { kind: "reply" | "comment" };

async function tick(): Promise<void> {
  log.info("tick start");

  // Sweep stale queued comments BEFORE evaluating the gate, so we never post on
  // a thread past its visibility window.
  const expired = await expireStaleComments();
  if (expired > 0) log.info(`tick: expired ${expired} stale comment rows`);

  const gate = await checkGate("comment");
  logGate("comment", gate);
  if (!gate.ok) {
    log.info("tick: comment gate closed, nothing to do");
    return;
  }

  const toRun: WorkItem[] = [{ kind: "reply" }, { kind: "comment" }];

  const result = await withBrowser("tick", async () => {
    const ctx = await openContext();
    let commentBucketUsed = false; // reply OR comment per tick, not both
    try {
      const page = await newPage(ctx);
      await assertLoggedIn(page);
      await sessionWarmup(page);

      for (const item of toRun) {
        if (commentBucketUsed) continue;

        const row = await claimNextRow(item.kind);
        if (!row) {
          log.info(`no ready ${item.kind} rows`);
          continue;
        }
        log.info(`claimed ${item.kind} row`, {
          id: row.id,
          subreddit: row.subreddit,
          attempts: row.attempts,
        });

        try {
          const postedUrl =
            item.kind === "reply"
              ? await replyToComment(page, row)
              : await submitComment(page, row);
          await markPosted(row.id, postedUrl);
          log.info("row marked posted", { id: row.id, postedUrl });
          commentBucketUsed = true;
        } catch (e) {
          const msg = (e as Error).message;
          log.error(`action failed: ${msg}`, { id: row.id });
          await markFailedOrRetry(row.id, row.attempts, msg);
        }
      }
    } finally {
      await ctx.close();
    }
    return true;
  });

  if (result === null) log.info("tick: deferred (browser busy)");
  else log.info("tick end");
}

async function main() {
  const intervalMs = Number.parseInt(process.env.TICK_INTERVAL_MS || "300000", 10);
  const once = process.env.TICK_ONCE === "1";

  log.info("reddit-bot starting", {
    intervalMs,
    once,
    headless: process.env.HEADLESS !== "false",
  });

  if (once) {
    await tick();
    return;
  }

  await tick().catch((e) => log.error(`tick crashed: ${(e as Error).message}`));
  setInterval(() => {
    tick().catch((e) => log.error(`tick crashed: ${(e as Error).message}`));
  }, intervalMs);
}

main().catch((e) => {
  log.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
