# reddit-bot

A while back I built a bot that used an LLM to write and post comments on Reddit from a personal account. I wanted to see whether it could pass as real engagement. It could not. This is the honest writeup and a cleaned-up slice of the code.

## Disclaimer

This was a personal curiosity experiment using a Reddit bot on a personal account. I am not running it anymore. I do not recommend doing this, and this repo is not meant to help anyone spam Reddit or evade detection.

The parts that would turn it into a usable spam tool are deliberately left out (target subreddit lists, account setup and warming, the model that actually wrote the comments, and the growth-tracking plumbing it was wired to). What is left is the client-side machinery and an honest account of why the whole thing failed.

## The story

I got curious whether an LLM-powered bot could hold up as real Reddit engagement. Not in a clever way. In the obvious way: point a model at a thread, have it write something relevant, post it from a logged-in account, repeat. If that worked, it would say something a bit depressing about the internet. If it did not work, I wanted to understand why.

So I built a basic bot on a personal account. A background loop found threads, an LLM drafted a comment for each, the drafts went into a queue, and a headless browser posted them a few at a time while trying to behave like a person who was actually reading. It posted comments across a handful of subreddits over a couple of weeks.

Reddit caught it fast. Between shadow-removals, comments that never got a single view, and the account quietly losing reach, the platform side of this was clearly not fooled for long.

People caught it faster. That was the part I underestimated. A real person reading a thread can feel when a comment is slightly off, and they feel it in about one second, well before they could tell you why. The bot's comments were grammatical, on-topic, and polite, and that was exactly the problem. They read like a very agreeable stranger who had skimmed the thread and had no actual stake in it.

A few comments got a couple of upvotes. None of it meant anything. An upvote from someone half-scrolling past is not a relationship, not trust, and not a reader who will remember you existed thirty seconds later. The numbers moved a little and nothing real happened behind them.

The conclusion is boring and I believe it: it does not really work, and it is not worth doing.

## Some of the actual comments

These are real comments the bot posted. I am including them because they make the failure concrete in a way that a description does not.

> reading other people's code taught me more than writing my own for the first three years. clone something, follow a single feature through the call stack, that's it.

*r/programming. 8 upvotes, 666 views. This is roughly the best case: a defensible generic opinion that a lot of people already agree with, so it collects a few lazy upvotes and changes nobody's mind.*

> rooting for you. the days that feel like nothing later turn out to be the foundation. keep going.

*r/GetMotivated. 6 upvotes, 1.8k views. Fortune-cookie encouragement. It is not wrong, it is just nobody. There is no person behind it.*

> the part where you said 'the longer this kind of information is withheld, the more painful and devastating it becomes' is a crucial insight. it's often the silence that does the most damage, not the truth itself.
>
> consider how you would want to hear it if the roles were reversed. approaching her openly, but gently, could provide her with a chance to confront the situation before it festers.

*r/relationship_advice. 1 upvote, 1 view, and locked. This is the tell in one screenshot. The therapy-speak cadence, the "crucial insight" throat-clearing, quoting the poster back to themselves, and it landed on exactly the kind of sensitive thread where a slightly-off comment gets noticed and shut down immediately.*

The forced all-lowercase was me trying to make it look casual. In practice it just made three unrelated comments across three unrelated subreddits sound like the same person, which is its own tell.

Screenshots are in [docs/screenshots/](docs/screenshots/).

## What I learned

I am framing this as why it failed, not as a to-do list for making it work. I do not think there is a version of this worth building.

- **LLM cadence is easier to spot than I expected.** There is a smoothness to model-written text, a lack of friction, that reads as off even when every individual sentence is fine. I could feel it in my own bot's output and I still could not fully write it out.
- **Reddit users are very good at detecting comments that feel slightly off.** They do not need proof. The vibe is enough, and the vibe is usually right. You are not fighting a classifier, you are fighting thousands of people with good instincts and nothing better to do.
- **A new or low-karma account has basically no trust.** Same words from a real regular land completely differently. Most of what makes a comment credible is the person and the history attached to it, and a fresh account has neither.
- **Upvotes are not the same thing as trust.** A comment can pick up a couple of upvotes from people half-reading and mean absolutely nothing. I kept having to remind myself that the number was not the thing I actually wanted.
- **A comment can look like it worked for a moment and still mean nothing.** The gap between "this got engagement" and "this earned anything" turned out to be the entire point.
- **The only thing that really survives on Reddit is showing up with a real point of view.** The stuff that lands is specific, a little rough, and attached to someone who actually cares about the topic. That is the one thing a bot cannot fake, because it is the one thing that is not a text-generation problem.
- **The effort-to-payoff ratio is terrible.** I put real engineering into pacing, browser behavior, and looking human. The payoff was a handful of meaningless upvotes and an account that got caught. If I had spent the same hours just participating, I would have come out ahead.
- **The better version of this is just participating honestly.** That is not a moral I went looking for. It is the conclusion the experiment kept pushing me toward until I stopped arguing with it.

## What is in this repo

This is a curated slice, not the full thing I ran. It is here as a technical and reflective record of a failed side project, not as something to deploy.

Included, because it is the interesting engineering and it is where the failure lived:

- `src/browser.ts` - the persistent Chromium context plus the "act like a human" layer: variable-speed typing, meandering mouse paths, scroll-and-reread, randomized think-pauses, and a stealth plugin to silence the common automation tells.
- `src/pacing.ts` - the rate discipline. Per-action cooldowns, daily caps, clustered activity windows, and heavy jitter so nothing looked clockwork.
- `src/comment.ts` - the actual posting, done against old.reddit.com because its plain HTML is far more stable to drive than the modern shadow-DOM UI.
- `src/supabase.ts` - the queue and the little state machine (draft, ready, posting, posted, failed, skipped) with an atomic-ish row claim so two ticks never double-post.
- `src/index.ts` - the loop that ties it together: check the gate, claim a row, post it like a person, record the result.
- `src/oldreddit.ts`, `src/log.ts`, `src/lib/withRetry.ts` - small supporting pieces.

Deliberately left out, because it adds nothing to the story and everything to the misuse:

- The LLM that actually drafted the comments. It ran as a separate server-side function and it is where any "make this sound human" work would have lived. Publishing that is exactly what I do not want to do.
- Target subreddit lists and the thread-discovery targeting.
- Anything about account creation, warming, rotation, or proxies. There was none of that worth sharing and I am not going to write a guide to it.
- The growth-tracking and attribution plumbing this was originally wired to.

## The code, honestly

A few notes on why it was fragile and why it got caught, since that is the actual lesson and it is visible in the code.

**All the human-emulation is cosmetic.** `browser.ts` types at a human speed, jitters between actions, and moves the mouse on a curve. None of that changes what gets posted. It makes the mechanics of posting look human while doing nothing about the thing people actually judge, which is the content. I spent most of my effort on the half that did not matter.

**The pacing was tuned around getting caught, which tells you something.** The comments in `pacing.ts` talk about caps and cooldowns and "looking human, not maxing throughput." That is a lot of care spent staying under a threshold. If a project's main engineering problem is not being detected, that is usually a sign the project should not exist.

**old.reddit.com was the load-bearing hack.** The whole thing leaned on the old interface because it is stable and easy to automate. It works, and it is also a good example of how the effort goes into the wrong place. Stable selectors do not make a comment worth reading.

**The queue is the cleanest part and it is beside the point.** The `supabase.ts` state machine is honestly fine engineering. It reliably delivered comments nobody wanted. Good plumbing attached to a bad idea is still a bad idea.

The code is here to be read, not run. There is no included path from cloning this to spamming anything, and that is on purpose.

## Why I would not do it again

Not mainly because it is against the rules, though it is. Because it does not work, and the version that does work is not a bot. The experiment answered its own question. Reddit is hard to fake, and even when something technically posts and picks up a couple of upvotes, that does not mean it earned anything. The honest version of showing up is cheaper, and it is the only version that lasts.

## License

MIT. See [LICENSE](LICENSE).
