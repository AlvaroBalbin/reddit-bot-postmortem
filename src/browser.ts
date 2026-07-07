import { chromium as vanillaChromium } from "playwright";
import { chromium as extraChromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { BrowserContext, Page } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.resolve(__dirname, "..", "state", "browser-profile");

// Stealth plugin patches the most common bot-detection vectors:
//   navigator.webdriver, chrome.runtime, navigator.plugins/languages,
//   WebGL vendor, iframe contentWindow, permissions API, user-agent platform,
//   hairline detection, media-codecs, etc. ~20 tells silenced at once.
extraChromium.use(StealthPlugin());

// Realistic UA matching modern stable Chrome on Win11.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// Randomised but plausible viewport. Most real users on Win11 are at
// these resolutions (Stat Counter top 5 desktop sizes 2025-Q4).
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
];

function pickViewport() {
  const v = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)]!;
  return v;
}

export async function openContext(): Promise<BrowserContext> {
  const headless =
    process.env.HEADLESS === undefined || process.env.HEADLESS === "true";
  const viewport = pickViewport();

  log.debug("openContext", { profile: PROFILE_DIR, headless, viewport });

  // For interactive login we keep using vanilla so we get a clean window
  // without any stealth layer interfering with the login form.
  const launcher = headless ? extraChromium : vanillaChromium;

  const ctx = await launcher.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport,
    userAgent: USER_AGENT,
    locale: "en-US",
    timezoneId: "Europe/Madrid",
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-dev-shm-usage",
      "--no-default-browser-check",
      "--no-first-run",
      "--password-store=basic",
      "--use-mock-keychain",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  return ctx;
}

export async function newPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(45_000);
  return page;
}

// Asserts the persistent profile is still logged in. We rely on cookie
// presence (token_v2 OR reddit_session) since Reddit's DOM moves frequently.
// If neither cookie is present we throw — the bot then bails this tick.
export async function assertLoggedIn(page: Page): Promise<void> {
  await page.goto("https://www.reddit.com/", { waitUntil: "domcontentloaded" });
  if (page.url().includes("/login")) {
    throw new Error("Not logged in to Reddit. Run `npm run login` once.");
  }
  const cookies = await page.context().cookies("https://www.reddit.com");
  const sessionCookieNames = new Set([
    "reddit_session",
    "token_v2",
    "session_tracker",
  ]);
  const hasSession = cookies.some(
    (c) => sessionCookieNames.has(c.name) && c.value.length > 0,
  );
  if (!hasSession) {
    throw new Error(
      "Reddit session cookies missing. Run `npm run login` once to refresh.",
    );
  }
}

// Pause between actions. Default 800-2400ms — short enough that we don't
// look catatonic, long enough not to look mechanical.
export async function jitter(min = 800, max = 2400): Promise<void> {
  const ms = Math.floor(min + Math.random() * (max - min));
  await new Promise((r) => setTimeout(r, ms));
}

// "Read" a page for a plausible amount of time. Real users spend 8-30s
// scanning a thread before commenting; we vary widely to avoid clockwork.
export async function readPause(): Promise<void> {
  const ms = 8000 + Math.random() * 22000;
  await new Promise((r) => setTimeout(r, ms));
}

// Move the mouse along a meandering Bezier-ish path to a random offset
// inside an element, then click. Real human movement is non-linear with
// micro-overshoots; we approximate via 3-5 waypoints with a random curve.
export async function humanClick(page: Page, selector: string): Promise<void> {
  const el = page.locator(selector).first();
  if ((await el.count()) === 0) throw new Error(`humanClick: not found: ${selector}`);
  const box = await el.boundingBox();
  if (!box) {
    // Fallback to plain click if we can't measure
    await el.click({ timeout: 5000 });
    return;
  }
  const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
  const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);

  const steps = 3 + Math.floor(Math.random() * 3);
  const startX = Math.random() * 1000;
  const startY = Math.random() * 600;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Ease-in-out with a small lateral wiggle
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const wiggle = Math.sin(t * Math.PI * 2) * 5 * (Math.random() - 0.5);
    const x = startX + (targetX - startX) * ease + wiggle;
    const y = startY + (targetY - startY) * ease + wiggle;
    await page.mouse.move(x, y, { steps: 1 });
    await new Promise((r) => setTimeout(r, 15 + Math.random() * 30));
  }
  await new Promise((r) => setTimeout(r, 50 + Math.random() * 200));
  await page.mouse.click(targetX, targetY);
}

// Type with variable per-char delay and occasional short "thinking" pauses
// every 20-60 chars (mimics real typing rhythm).
export async function humanType(page: Page, text: string): Promise<void> {
  let nextPauseAt = 20 + Math.floor(Math.random() * 40);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    await page.keyboard.type(ch, { delay: 0 });
    // Per-char delay distribution: mostly 30-90ms with occasional 150-300ms
    const fast = Math.random() < 0.85;
    const delay = fast
      ? 30 + Math.random() * 60
      : 150 + Math.random() * 150;
    await new Promise((r) => setTimeout(r, delay));

    if (i + 1 >= nextPauseAt && Math.random() < 0.5) {
      // Brief mid-sentence pause as if thinking
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 1200));
      nextPauseAt = i + 20 + Math.floor(Math.random() * 40);
    }
  }
}

// AI-tell defense (v3): em dashes (— and –) are the #1 AI-generated-comment
// flag on Reddit in 2026. Edge fn sanitizer already strips them, but this is
// belt + braces in case the fn is ever changed. Returns true if the body is
// safe to post; false if it contains a dash that would flag us.
export function isSafeToPost(body: string): { ok: true } | { ok: false; reason: string } {
  if (/—|–/.test(body)) {
    return { ok: false, reason: "em_dash_detected" };
  }
  return { ok: true };
}

// v3.1 — opportunistic upvotes. Real Reddit users upvote 10-20x more than
// they comment. The bot's previous "all comments, zero votes" pattern is
// the #1 anti-bot signal Reddit's automod scores on. This is called on
// listing pages and thread pages to upvote 0-3 random items.
//
// Old.reddit upvote selector: <div class="arrow up"> inside the thread/comment
// .midcol container. Click toggles upvote.
//
// Skips silently if no arrows found or all attempts fail.
export async function humanRandomUpvote(
  page: Page,
  opts: { min?: number; max?: number; skipChance?: number } = {},
): Promise<number> {
  const min = opts.min ?? 0;
  const max = opts.max ?? 3;
  const skipChance = opts.skipChance ?? 0.15; // 15% of the time, don't vote at all

  if (Math.random() < skipChance) return 0;

  const targetCount = min + Math.floor(Math.random() * (max - min + 1));
  if (targetCount === 0) return 0;

  // Old.reddit listing/thread arrows. Skip arrows that are already "upmod"
  // (already upvoted — would TOGGLE OFF on click).
  const arrows = page.locator('.arrow.up:not(.upmod)');
  const total = await arrows.count().catch(() => 0);
  if (total === 0) return 0;

  // Pick targetCount random indexes (without replacement, capped at total).
  const indexes = new Set<number>();
  const cap = Math.min(targetCount, total);
  while (indexes.size < cap) {
    indexes.add(Math.floor(Math.random() * total));
  }

  let upvoted = 0;
  for (const i of indexes) {
    const a = arrows.nth(i);
    try {
      await a.scrollIntoViewIfNeeded({ timeout: 3000 });
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
      await a.click({ timeout: 3000 });
      upvoted++;
      await new Promise((r) => setTimeout(r, 600 + Math.random() * 1400));
    } catch {
      // arrow detached, off-screen, etc. — skip silently
    }
  }
  if (upvoted > 0) log.debug(`humanRandomUpvote: cast ${upvoted} upvote(s)`);
  return upvoted;
}

// v3.1 — session warmup. Real users open Reddit and look at the home feed
// before navigating to a specific thread. Bot was navigating straight to
// /r/<sub>/submit or /r/<sub>/comments/ which reads as "I logged in to do
// one thing." Call this AFTER assertLoggedIn (which has already navigated
// to reddit.com) to scroll the home feed + optionally upvote one thing.
export async function sessionWarmup(page: Page): Promise<void> {
  try {
    // Already on reddit.com after assertLoggedIn. Pause to "look at" the feed.
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2500));
    // 70% of the time scroll the home feed
    if (Math.random() < 0.7) {
      await humanScroll(page);
    }
    // 50% chance to upvote one thing on home (different selectors on www.reddit
    // — try both old + new arrow conventions)
    if (Math.random() < 0.5) {
      const newArrow = page.locator('button[aria-label*="upvote" i]:not([aria-pressed="true"])').first();
      const oldArrow = page.locator('.arrow.up:not(.upmod)').first();
      const target = (await newArrow.count()) ? newArrow : (await oldArrow.count()) ? oldArrow : null;
      if (target) {
        try {
          await target.click({ timeout: 3000 });
          await new Promise((r) => setTimeout(r, 800 + Math.random() * 1500));
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // Warmup is purely cosmetic. Failure shouldn't block the actual action.
  }
}

// Scroll the page in a few small increments with pauses, the way someone
// reading would. Returns silently if we can't scroll.
export async function humanScroll(page: Page): Promise<void> {
  const passes = 2 + Math.floor(Math.random() * 4);
  for (let i = 0; i < passes; i++) {
    const delta = 200 + Math.random() * 400;
    await page.mouse.wheel(0, delta);
    await new Promise((r) => setTimeout(r, 600 + Math.random() * 1800));
  }
  // Sometimes scroll back up a bit (re-reading)
  if (Math.random() < 0.3) {
    await page.mouse.wheel(0, -(150 + Math.random() * 250));
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
  }
}
