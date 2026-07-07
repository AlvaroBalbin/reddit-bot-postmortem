import type { Page } from "playwright";
import { jitter, readPause, humanScroll, humanType, isSafeToPost } from "./browser.js";
import { log } from "./log.js";
import type { QueueRow } from "./supabase.js";
import { toOldRedditUrl } from "./oldreddit.js";

// Post a top-level comment via old.reddit.com (stable HTML, no shadow DOM).
// Returns the canonical permalink (or the thread URL as fallback).
//
// Note the shape of this function: most of it is choreography meant to look
// like a person reading a thread before replying. None of that choreography
// touches the comment text, which is the only thing a real reader actually
// judges. See the README.

export async function submitComment(page: Page, row: QueueRow): Promise<string> {
  if (!row.parent_thread_url) {
    throw new Error("Comment row missing parent_thread_url");
  }
  const threadUrl = toOldRedditUrl(row.parent_thread_url);
  log.info(`submitComment -> ${threadUrl}`, { id: row.id });

  await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
  await jitter(2000, 4500);

  // Real-user choreography.
  await humanScroll(page);
  await readPause();

  const ta = page.locator('form.usertext textarea[name="text"]').first();
  if ((await ta.count()) === 0) {
    throw new Error("comment: top-level reply textarea not found on thread");
  }
  await ta.click({ timeout: 8000 });
  await jitter(400, 1100);

  const body = row.body;
  const safety = isSafeToPost(body);
  if (!safety.ok) throw new Error(`comment: aborted ${safety.reason}`);
  await humanType(page, body);
  await jitter(800, 2200);

  const clicked = await tryClick(page, [
    'form.usertext button.save',
    'form.usertext input[type="submit"][value="save"]',
    'form.usertext button:has-text("save")',
  ]);
  if (!clicked) throw new Error("comment: submit button not found");

  // Wait for either the inline confirmation OR a navigation. Old reddit
  // typically reloads to show the new comment.
  await page
    .waitForSelector(`text=${body.slice(0, 30).trim()}`, { timeout: 15_000 })
    .catch(() => {
      log.warn("comment submit: didn't see body text on page; assuming OK");
    });

  // Best-effort permalink. On old reddit, the new comment has an
  // <a class="bylink"> permalink anchor.
  const permalink = await page
    .locator('a.bylink[href*="/comments/"]')
    .first()
    .getAttribute("href")
    .catch(() => null);

  const fullUrl = permalink
    ? new URL(permalink, "https://old.reddit.com").toString()
    : page.url();

  log.info(`submitComment OK -> ${fullUrl}`, { id: row.id });
  return fullUrl;
}

// Posts a reply UNDER a specific child comment (the engagement loop: someone
// replied to one of our comments, we reply back). Same old.reddit form flow,
// scoped to the target comment node.
//
// row.parent_thread_url is the Reddit thread URL.
// row.notes carries the target Reddit comment fullname (e.g. "t1_abc123") so
//   we know exactly which comment to reply under.
export async function replyToComment(page: Page, row: QueueRow): Promise<string> {
  if (!row.parent_thread_url) throw new Error("reply: missing parent_thread_url");
  const targetId = (row.notes ?? "").trim();
  if (!/^t1_[a-z0-9]+$/i.test(targetId)) {
    throw new Error(`reply: notes must be a Reddit fullname like t1_abc123, got ${targetId}`);
  }

  const threadUrl = toOldRedditUrl(row.parent_thread_url);
  log.info(`replyToComment -> ${threadUrl} under ${targetId}`, { id: row.id });

  await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
  await jitter(2000, 4500);

  // Old reddit comment nodes are <div class="thing" data-fullname="t1_xxx">.
  // Their reply trigger is <a class="reply-button">reply</a> inside the
  // .entry > .flat-list.buttons.
  const commentNode = page.locator(`.thing[data-fullname="${targetId}"]`).first();
  if ((await commentNode.count()) === 0) {
    throw new Error(`reply: target comment ${targetId} not found on thread`);
  }
  // Real-user pre-action: scroll into view + read.
  await commentNode.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await readPause();

  const replyBtn = commentNode.locator('.flat-list.buttons a.reply-button, ul.flat-list a:has-text("reply")').first();
  if ((await replyBtn.count()) === 0) {
    throw new Error(`reply: [reply] link not found under ${targetId}`);
  }
  await replyBtn.click({ timeout: 8000 });
  await jitter(400, 1100);

  // After clicking [reply], an inline form.usertext appears nested INSIDE
  // the target .thing. Scope the textarea to that subtree.
  const ta = commentNode.locator('form.usertext textarea[name="text"]').first();
  if ((await ta.count()) === 0) {
    throw new Error(`reply: composer textarea didn't appear under ${targetId}`);
  }
  await ta.click({ timeout: 8000 });

  const body = row.body;
  const safety = isSafeToPost(body);
  if (!safety.ok) throw new Error(`reply: aborted ${safety.reason}`);
  await humanType(page, body);
  await jitter(800, 2200);

  // Submit. Same selectors as top-level comment.
  const clicked = await tryClickIn(commentNode, [
    'form.usertext button.save',
    'form.usertext input[type="submit"][value="save"]',
    'form.usertext button:has-text("save")',
  ]);
  if (!clicked) throw new Error("reply: submit button not found");

  await page
    .waitForSelector(`text=${body.slice(0, 30).trim()}`, { timeout: 15_000 })
    .catch(() => {
      log.warn("reply submit: didn't see body text on page; assuming OK");
    });

  // Best-effort permalink.
  const permalink = await page
    .locator('a.bylink[href*="/comments/"]')
    .first()
    .getAttribute("href")
    .catch(() => null);

  const fullUrl = permalink
    ? new URL(permalink, "https://old.reddit.com").toString()
    : page.url();

  log.info(`replyToComment OK -> ${fullUrl}`, { id: row.id });
  return fullUrl;
}

async function tryClickIn(scope: ReturnType<Page["locator"]>, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const el = scope.locator(sel).first();
    if (await el.count()) {
      try {
        await el.click({ timeout: 5000 });
        return true;
      } catch {
        // try next
      }
    }
  }
  return false;
}

async function tryClick(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count()) {
      try {
        await el.click({ timeout: 5000 });
        return true;
      } catch {
        // try next
      }
    }
  }
  return false;
}
