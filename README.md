# Instantly ↔ Apollo Outbound Sync

Keeps our email tool (Instantly) and our calling tool (Apollo) working as one outbound campaign. When someone gets a cold email, they're queued for calls. When a call or an email reply settles things, the other channel stops.

## Why I built it

We ran cold email in Instantly and cold calls in Apollo. Neither knew what the other was doing. Reps called people who had already replied by email, and emails kept going to people who had booked a meeting on the phone. Lining the two up by hand every day didn't scale.

## What it does

| When | It does |
|---|---|
| Someone gets their first email in a campaign | Finds them in Apollo and adds them to that campaign's call sequence (a calls-only cadence) |
| Any email is sent | Adds a note to their Apollo record (sender, subject, preview) |
| They reply, unsubscribe or show interest by email | Ends their call sequence |
| Their email bounces | Adds a note and sends a Slack alert; the calls continue |
| A call is logged as Meeting Booked, Interested, Not Interested or Wrong Person | Updates their status in Instantly, which stops the emails |

Any other call outcome (no answer, voicemail, busy) leaves both channels running.

## How it works

A Cloudflare Worker runs every 15 minutes, reads new emails and lead statuses from Instantly and new call outcomes from Apollo, and applies the rules above. Which campaign feeds which call sequence, and which call outcome means what, live in two small database tables (`campaign_map`, `outcome_map`) that can be changed without redeploying.

## Engineering decisions

- **Polling over webhooks.** Instantly's webhooks need a more expensive plan. Polling stays inside its 20 requests per minute limit and works on the plan we had.
- **Config in the database.** Routing lives in D1 tables, so adding a campaign is a single SQL insert rather than a code change.
- **Verified against the real APIs.** A self-test runs the full cycle on a throwaway contact (find, enroll, note, finish, delete). Undocumented behavior, such as which status values actually stop Instantly's emails and which filter names Apollo silently ignores, was confirmed by hand and noted in the code.
- **Operable without a terminal.** A token-protected `/status` page shows who's enrolled and what failed, and `/retry` reprocesses one person after a fix.

## Stack

TypeScript, Cloudflare Workers (cron + D1), Instantly API v2, Apollo API, Slack.

## Layout

- `src/index.ts`: cron entry and the `/status`, `/run` and `/retry` routes
- `src/sync.ts`: the rules above
- `src/instantly.ts`, `src/apollo.ts`, `src/slack.ts`: API clients
- `src/db.ts`, `schema.sql`, `seed.sql`: state and routing tables

## Running it

`npm install`, create the D1 database and apply `schema.sql` and `seed.sql`, set `INSTANTLY_API_KEY`, `APOLLO_API_KEY` and `ADMIN_TOKEN` with `npx wrangler secret put`, then `npx wrangler deploy`.

---

Built at Alleviate Health. Company names, people, IDs and URLs in this public copy are placeholders.
