// old.reddit.com adapter.
//
// Modern Reddit's DOM (www.reddit.com) uses <shreddit-*> web components
// with shadow DOM, the Lexical text editor, and ever-shifting selectors.
// old.reddit.com renders the same content (and accepts the same actions)
// using stable, pre-2017 HTML: real <textarea>, <button>, <form>. Cookies
// are shared (same .reddit.com domain), so the login session works for both.
//
// We do every action against old.reddit.com and let new Reddit users see
// the result through their preferred UI.

const NEW_HOSTS = ["www.reddit.com", "reddit.com", "new.reddit.com"];

export function toOldRedditUrl(url: string): string {
  try {
    const u = new URL(url);
    if (NEW_HOSTS.includes(u.hostname)) {
      u.hostname = "old.reddit.com";
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function oldSubmitUrl(subreddit: string): string {
  return `https://old.reddit.com/r/${encodeURIComponent(subreddit)}/submit`;
}

export function oldSubListing(subreddit: string, path: string): string {
  // path examples: '/new/', '/hot/', '/search/?q=...&restrict_sr=1&sort=new'
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `https://old.reddit.com/r/${encodeURIComponent(subreddit)}${cleanPath}`;
}
