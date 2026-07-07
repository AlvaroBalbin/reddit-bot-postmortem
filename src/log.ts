// Tiny log helper. pm2 captures stdout/stderr already, so we just prefix
// with a UTC timestamp + level so the log file is greppable.

type Level = "info" | "warn" | "error" | "debug";

function fmt(level: Level, msg: string, extra?: unknown): string {
  const ts = new Date().toISOString();
  const tail = extra === undefined ? "" : " " + JSON.stringify(extra);
  return `[${ts}] [${level}] ${msg}${tail}`;
}

export const log = {
  info: (msg: string, extra?: unknown) => console.log(fmt("info", msg, extra)),
  warn: (msg: string, extra?: unknown) => console.warn(fmt("warn", msg, extra)),
  error: (msg: string, extra?: unknown) => console.error(fmt("error", msg, extra)),
  debug: (msg: string, extra?: unknown) => {
    if (process.env.DEBUG) console.log(fmt("debug", msg, extra));
  },
};
