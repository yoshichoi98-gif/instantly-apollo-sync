// Slack alerts. Uses the existing "CRM Sync" bot (chat:write), posting to
// SLACK_NOTIFY_CHANNEL (a channel ID, or a user ID for a DM). Off when either is unset.
import type { Env } from "./env.js";

export async function notify(env: Env, text: string): Promise<void> {
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_NOTIFY_CHANNEL) return;
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: env.SLACK_NOTIFY_CHANNEL, text, unfurl_links: false, unfurl_media: false }),
  });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok || !d.ok) throw new Error(`slack chat.postMessage: HTTP ${res.status} ${d.error ?? ""}`.trim());
}
