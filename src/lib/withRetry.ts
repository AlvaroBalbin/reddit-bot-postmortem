// Generic retry-with-exponential-backoff helper. Use around any external
// call that can transiently fail (Supabase, Reddit JSON, edge fn).
//
// Example:
//   const data = await withRetry(() => sb().from("x").select("*"));
//
// Defaults: 3 attempts, 500ms base delay, exp backoff with ±30% jitter.
// Retries on common transient transport errors and HTTP 429/5xx.
// On final failure, re-throws the last error untouched.

import { log } from "../log.js";

export type RetryOpts = {
  attempts?: number;
  baseDelayMs?: number;
  // Substrings to match in error.message OR error.code that indicate retry.
  retryOn?: string[];
  label?: string;
};

const DEFAULT_RETRY_ON = [
  "ENOTFOUND",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EPIPE",
  "fetch failed",
  "network",
  "429",
  "502",
  "503",
  "504",
];

function isTransient(err: unknown, retryOn: string[]): boolean {
  if (!(err instanceof Error)) return false;
  const haystack = `${err.message} ${(err as { code?: string }).code ?? ""}`.toLowerCase();
  return retryOn.some((needle) => haystack.includes(needle.toLowerCase()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const retryOn = opts.retryOn ?? DEFAULT_RETRY_ON;
  const label = opts.label ?? "withRetry";

  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const transient = isTransient(e, retryOn);
      if (!transient || i === attempts) {
        throw e;
      }
      const backoff = baseDelayMs * Math.pow(2, i - 1);
      const jittered = Math.floor(backoff * (0.7 + Math.random() * 0.6));
      log.warn(
        `${label}: attempt ${i}/${attempts} failed (${(e as Error).message}); retrying in ${jittered}ms`,
      );
      await sleep(jittered);
    }
  }
  // Unreachable, but TS wants a return.
  throw lastErr;
}
