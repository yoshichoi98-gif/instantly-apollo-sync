// Instantly API v2. Docs: https://developer.instantly.ai/api-reference
import type { Env } from "./env.js";
import { requestJson, sleep } from "./http.js";

const BASE = "https://api.instantly.ai/api/v2";

function headers(env: Env) {
  return { Authorization: `Bearer ${env.INSTANTLY_API_KEY}`, "Content-Type": "application/json" };
}

export interface InstantlyEmail {
  id: string;
  ue_type: number | null; // 1 sent from campaign, 2 received, 3 sent (manual), 4 scheduled
  campaign_id: string | null;
  lead: string | null;
  step: string | null;
  subject: string | null;
  eaccount: string | null;
  is_auto_reply: number | null;
  content_preview: string | null;
  timestamp_created: string;
  timestamp_email: string | null;
}

/**
 * All emails (sent + received, every campaign) created at or after `since`, oldest first.
 * /emails is rate limited to 20 requests/minute, so pages are spaced out.
 */
export async function listEmailsSince(env: Env, since: string, maxPages = 10): Promise<InstantlyEmail[]> {
  const out: InstantlyEmail[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({
      min_timestamp_created: since,
      sort_order: "asc",
      limit: "100",
      mode: "emode_all",
    });
    if (startingAfter) q.set("starting_after", startingAfter);
    const d = await requestJson(`${BASE}/emails?${q}`, { headers: headers(env) }, "instantly /emails");
    const items: InstantlyEmail[] = d.items ?? [];
    out.push(...items);
    // next_starting_after comes back even on the last page, so stop on a short page.
    if (items.length < 100 || !d.next_starting_after) break;
    startingAfter = d.next_starting_after;
    await sleep(3500);
  }
  return out;
}

export interface InstantlyLead {
  id: string;
  email: string;
  campaign: string | null;
  status: number; // 1 active, 2 paused, 3 completed, -1 bounced, -2 unsubscribed, -3 skipped
  lt_interest_status: number | null;
  email_reply_count: number | null;
}

/** Leads in one campaign, limited to the given emails (≤100 per call). */
export async function getLeads(env: Env, campaignId: string, emails: string[]): Promise<InstantlyLead[]> {
  const out: InstantlyLead[] = [];
  for (let i = 0; i < emails.length; i += 100) {
    const d = await requestJson(
      `${BASE}/leads/list`,
      {
        method: "POST",
        headers: headers(env),
        body: JSON.stringify({ campaign: campaignId, contacts: emails.slice(i, i + 100), limit: 100 }),
      },
      "instantly /leads/list",
    );
    out.push(...(d.items ?? []));
  }
  return out;
}

/**
 * Set a lead's interest status in a campaign. Verified 2026-11-05: any of
 * 1 / 2 / -1 / -2 moves the lead to status 3 (Completed), which stops its emails.
 * Runs as a background job on Instantly's side (HTTP 202).
 */
export async function setInterest(env: Env, email: string, campaignId: string, value: number): Promise<void> {
  await requestJson(
    `${BASE}/leads/update-interest-status`,
    {
      method: "POST",
      headers: headers(env),
      body: JSON.stringify({ lead_email: email, campaign_id: campaignId, interest_value: value }),
    },
    "instantly /leads/update-interest-status",
  );
}

export const INTEREST_LABEL: Record<number, string> = {
  0: "Out of Office",
  1: "Interested",
  2: "Meeting Booked",
  3: "Meeting Completed",
  4: "Won",
  [-1]: "Not Interested",
  [-2]: "Wrong Person",
  [-3]: "Lost",
  [-4]: "No Show",
};
