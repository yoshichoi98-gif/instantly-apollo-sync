// One sync pass. Runs every 15 minutes from cron, or on demand via /run.
//
// 1. Instantly sent an email in a mapped campaign  -> first time for that person:
//    find them in Apollo and add them to the campaign's calls-only sequence.
//    Every send also leaves a plain-text note on the Apollo contact.
// 2. They replied (not an auto-reply), unsubscribed, or were marked with an interest
//    status in Instantly -> mark them finished in the Apollo call sequence.
//    A bounce only adds a note: the email is dead but the phone may still work.
// 3. Yoshi logs a stopping call outcome in Apollo (Meeting Booked, Not Interested, ...)
//    -> set the matching interest status in Instantly (completes the lead, so the
//    emails stop) and mark them finished in the Apollo call sequence.

import type { Env } from "./env.js";
import * as apollo from "./apollo.js";
import * as instantly from "./instantly.js";
import { notify } from "./slack.js";
import {
  type Campaign,
  type LeadRow,
  getLead,
  insertLead,
  kvDel,
  kvGet,
  kvSet,
  leadsByContact,
  leadsByEmail,
  loadCampaigns,
  log,
  markCallSeen,
  markEmailSeen,
  now,
  pruneLog,
  seenCall,
  seenEmail,
  updateLead,
} from "./db.js";

export interface Summary {
  emails_seen: number;
  first_sends: number;
  enrolled: number;
  enroll_problems: number;
  notes: number;
  calls_stopped: number;
  emails_stopped: number;
  errors: number;
  skipped_locked?: boolean;
}

const MAX_FAST_RETRIES = 8; // ~2 hours of 15-minute runs
const OVERLAP_MS = 30 * 60 * 1000;
const LOCK_MS = 12 * 60 * 1000;

export async function runSync(env: Env): Promise<Summary> {
  const s: Summary = { emails_seen: 0, first_sends: 0, enrolled: 0, enroll_problems: 0, notes: 0, calls_stopped: 0, emails_stopped: 0, errors: 0 };

  // Simple lock so a manual /run can't overlap the cron and double-enroll.
  const lock = await kvGet(env, "lock");
  if (lock && Date.now() - Date.parse(lock) < LOCK_MS) return { ...s, skipped_locked: true };
  await kvSet(env, "lock", now());

  try {
    const campaigns = await loadCampaigns(env);
    await step(env, s, "emails", () => processEmails(env, campaigns, s));
    await step(env, s, "retries", () => retryPending(env, campaigns, s));
    await step(env, s, "lead statuses", () => checkLeadStatuses(env, campaigns, s));
    await step(env, s, "call outcomes", () => processCalls(env, campaigns, s));
    await pruneLog(env);
    await kvSet(env, "last_run", JSON.stringify({ at: now(), summary: s }));
  } finally {
    await kvDel(env, "lock");
  }
  return s;
}

async function step(env: Env, s: Summary, name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    s.errors++;
    await log(env, "error", null, `${name} step failed: ${msg(err)}`);
  }
}

// ---------------------------------------------------------------- 1. emails

async function processEmails(env: Env, campaigns: Map<string, Campaign>, s: Summary) {
  const cursor = (await kvGet(env, "emails_cursor")) ?? now();
  const since = new Date(Date.parse(cursor) - OVERLAP_MS).toISOString();
  const emails = await instantly.listEmailsSince(env, since);

  let maxTs = cursor;
  for (const e of emails) {
    if (e.timestamp_created > maxTs) maxTs = e.timestamp_created;
    if (await seenEmail(env, e.id)) continue;
    s.emails_seen++;
    const lead = (e.lead ?? "").trim().toLowerCase();
    let kind = "other";
    try {
      if (lead && e.ue_type === 1 && e.campaign_id && campaigns.has(e.campaign_id)) {
        kind = "sent";
        await onSent(env, e, lead, campaigns.get(e.campaign_id)!, s);
      } else if (lead && e.ue_type === 2 && !e.is_auto_reply) {
        kind = "reply";
        await onReply(env, e, lead, s);
      }
    } catch (err) {
      s.errors++;
      await log(env, "error", lead || null, `handling ${kind} email ${e.id}: ${msg(err)}`);
    }
    await markEmailSeen(env, e.id, lead, kind);
  }
  await kvSet(env, "emails_cursor", maxTs);
}

async function onSent(env: Env, e: instantly.InstantlyEmail, lead: string, c: Campaign, s: Summary) {
  let row = await getLead(env, lead, c.id);
  if (!row) {
    await insertLead(env, lead, c, e.timestamp_email ?? e.timestamp_created);
    s.first_sends++;
    row = (await getLead(env, lead, c.id))!;
    await tryEnroll(env, row, c, s);
    row = (await getLead(env, lead, c.id))!;
  }
  if (row.apollo_contact_id) {
    const lines = [
      `Instantly email sent (${c.name})`,
      `From: ${e.eaccount ?? "?"}`,
      `Subject: ${e.subject ?? ""}`,
    ];
    if (e.content_preview) lines.push("", e.content_preview.trim());
    try {
      await apollo.addNote(env, row.apollo_contact_id, lines.join("\n"));
      s.notes++;
    } catch (err) {
      await log(env, "warn", lead, `note failed: ${msg(err)}`);
    }
  }
}

async function onReply(env: Env, e: instantly.InstantlyEmail, lead: string, s: Summary) {
  const rows = await leadsByEmail(env, lead);
  for (const row of rows) {
    if (row.calls_stop_reason) continue;
    await stopCalls(env, row, "replied by email", s);
    if (row.apollo_contact_id && e.content_preview) {
      try {
        await apollo.addNote(env, row.apollo_contact_id, `Replied to an Instantly email:\n\n${e.content_preview.trim()}`);
        s.notes++;
      } catch (err) {
        await log(env, "warn", lead, `reply note failed: ${msg(err)}`);
      }
    }
  }
}

export async function tryEnroll(env: Env, row: LeadRow, c: Campaign, s: Summary) {
  if (row.calls_stop_reason) {
    await updateLead(env, row, { state: "enroll_skipped", detail: `not enrolled: ${row.calls_stop_reason} before enrollment` });
    return;
  }
  const attempts = row.attempts + 1;
  try {
    let contactId = row.apollo_contact_id;
    if (!contactId) {
      const found = await apollo.findContactByEmail(env, row.email);
      if (!found) {
        await updateLead(env, row, { state: "no_apollo_contact", detail: "no Apollo contact has this email", attempts });
        if (attempts === 1) {
          s.enroll_problems++;
          await log(env, "warn", row.email, `no Apollo contact with this email; not enrolled in calls (${c.name})`);
        }
        return;
      }
      contactId = found.id;
      await updateLead(env, row, { apollo_contact_id: contactId });
    }
    const res = await apollo.enroll(env, c.sequenceId, contactId);
    if (res.ok) {
      await updateLead(env, row, { state: "enrolled", detail: null, enrolled_at: now(), attempts });
      s.enrolled++;
      await log(env, "info", row.email, `added to Apollo calls sequence (${c.name})`);
    } else {
      await updateLead(env, row, { state: "enroll_skipped", detail: res.reason, attempts });
      s.enroll_problems++;
      await log(env, "warn", row.email, `Apollo did not enroll them (${c.name}): ${res.reason}`);
    }
  } catch (err) {
    await updateLead(env, row, { state: "error", detail: msg(err), attempts });
    s.errors++;
    await log(env, "error", row.email, `enroll failed (${c.name}): ${msg(err)}`);
  }
}

// ---------------------------------------------------------------- retries

async function retryPending(env: Env, campaigns: Map<string, Campaign>, s: Summary) {
  // Enrollment: fast retries for ~2 hours, then every 6 hours for 3 days after the
  // first email (in case the contact gets added to Apollo later).
  const { results: toEnroll } = await env.DB.prepare(
    `SELECT * FROM leads
     WHERE state IN ('pending', 'error', 'no_apollo_contact') AND calls_stop_reason IS NULL
       AND (attempts < ?1
            OR (updated_at < ?2 AND first_sent_at > ?3))`,
  )
    .bind(MAX_FAST_RETRIES, new Date(Date.now() - 6 * 3600e3).toISOString(), new Date(Date.now() - 3 * 86400e3).toISOString())
    .all<LeadRow>();
  for (const row of toEnroll) {
    const c = campaigns.get(row.instantly_campaign_id);
    if (c) await tryEnroll(env, row, c, s);
  }

  // Stops that were decided but whose API call failed last time.
  const { results: callStops } = await env.DB.prepare(
    "SELECT * FROM leads WHERE calls_stop_reason IS NOT NULL AND calls_stopped_at IS NULL AND state = 'enrolled'",
  ).all<LeadRow>();
  for (const row of callStops) await stopCalls(env, row, row.calls_stop_reason!, s);

  const { results: emailStops } = await env.DB.prepare(
    "SELECT * FROM leads WHERE emails_stop_reason IS NOT NULL AND emails_stopped_at IS NULL",
  ).all<LeadRow>();
  for (const row of emailStops) await stopEmails(env, row, row.emails_stop_reason!, row.emails_stop_interest!, s);
}

// ---------------------------------------------------------------- 2. lead statuses

async function checkLeadStatuses(env: Env, campaigns: Map<string, Campaign>, s: Summary) {
  for (const c of campaigns.values()) {
    // Everyone not yet seen bouncing (enrolled or not, so every bounce gets a Slack alert),
    // plus enrolled people whose calls are still running (for the stop checks below).
    const { results: rows } = await env.DB.prepare(
      "SELECT * FROM leads WHERE instantly_campaign_id = ? AND (bounced_at IS NULL OR (state = 'enrolled' AND calls_stop_reason IS NULL))",
    )
      .bind(c.id)
      .all<LeadRow>();
    if (!rows.length) continue;
    const byEmail = new Map(rows.map((r) => [r.email, r]));
    const leads = await instantly.getLeads(env, c.id, [...byEmail.keys()]);
    for (const l of leads) {
      const row = byEmail.get((l.email ?? "").toLowerCase());
      if (!row) continue;

      if (l.status === -1 && !row.bounced_at) {
        await updateLead(env, row, { bounced_at: now() });
        await log(env, "info", row.email, `email bounced in Instantly; calls continue (${c.name})`);
        if (row.apollo_contact_id) {
          await apollo
            .addNote(env, row.apollo_contact_id, "Instantly: email bounced, so no more emails will go out. The calls continue.")
            .then(() => s.notes++)
            .catch((err) => log(env, "warn", row.email, `bounce note failed: ${msg(err)}`));
        }
        const calls = row.state === "enrolled" ? "Their Apollo calls continue." : `They're not in the Apollo call sequence (${row.state}).`;
        const link = row.apollo_contact_id ? `\nApollo: https://app.apollo.io/#/contacts/${row.apollo_contact_id}` : "";
        await notify(env, `:warning: Email bounced: ${row.email} (Instantly campaign: ${c.name}). Instantly won't email them again. ${calls}${link}`)
          .then(() => log(env, "info", row.email, "bounce alert sent to Slack"))
          .catch((err) => {
            s.errors++;
            return log(env, "error", row.email, `bounce Slack alert failed: ${msg(err)}`);
          });
      }
      if (row.state !== "enrolled" || row.calls_stop_reason) continue;

      let reason: string | null = null;
      if (l.status === -2) reason = "unsubscribed in Instantly";
      else if ((l.email_reply_count ?? 0) > 0) reason = "replied by email";
      else if (l.lt_interest_status !== null && l.lt_interest_status !== undefined && l.lt_interest_status !== 0)
        reason = `marked ${instantly.INTEREST_LABEL[l.lt_interest_status] ?? `status ${l.lt_interest_status}`} in Instantly`;
      if (reason) await stopCalls(env, row, reason, s);
    }
  }
}

// ---------------------------------------------------------------- 3. call outcomes

async function processCalls(env: Env, campaigns: Map<string, Campaign>, s: Summary) {
  const { results: outcomes } = await env.DB.prepare("SELECT * FROM outcome_map").all<any>();
  if (!outcomes.length) return;
  const byId = new Map(outcomes.map((o) => [o.apollo_outcome_id, o]));

  // Apollo buckets call dates in the workspace time zone (Pacific).
  const max = pacificDate(new Date());
  const min = pacificDate(new Date(Date.now() - 3 * 86400e3));
  const calls = await apollo.callsWithOutcomes(env, [...byId.keys()], min, max);

  for (const call of calls) {
    if (!call.contact_id || !call.phone_call_outcome_id) continue;
    if (await seenCall(env, call.id)) continue;
    const rows = await leadsByContact(env, call.contact_id);
    if (!rows.length) continue; // not someone this sync manages
    const o = byId.get(call.phone_call_outcome_id);
    if (!o) continue;
    for (const row of rows) {
      if (!campaigns.has(row.instantly_campaign_id)) continue;
      const reason = `call outcome: ${o.label}`;
      if (!row.emails_stop_reason) await stopEmails(env, row, reason, o.instantly_interest, s);
      if (!row.calls_stop_reason && row.state === "enrolled") await stopCalls(env, row, reason, s);
    }
    await markCallSeen(env, call.id, call.contact_id, o.label);
  }
}

// ---------------------------------------------------------------- stop helpers

export async function stopCalls(env: Env, row: LeadRow, reason: string, s: Summary) {
  if (!row.calls_stop_reason) await updateLead(env, row, { calls_stop_reason: reason });
  if (row.state !== "enrolled" || !row.apollo_contact_id || !row.apollo_sequence_id) return; // enrollment will be skipped instead
  try {
    await apollo.markFinished(env, row.apollo_sequence_id, row.apollo_contact_id);
    await updateLead(env, row, { calls_stopped_at: now() });
    s.calls_stopped++;
    await log(env, "info", row.email, `Apollo calls stopped: ${reason}`);
  } catch (err) {
    s.errors++;
    await log(env, "error", row.email, `could not stop Apollo calls (${reason}): ${msg(err)}`);
  }
}

async function stopEmails(env: Env, row: LeadRow, reason: string, interest: number, s: Summary) {
  if (!row.emails_stop_reason) await updateLead(env, row, { emails_stop_reason: reason, emails_stop_interest: interest });
  try {
    await instantly.setInterest(env, row.email, row.instantly_campaign_id, interest);
    await updateLead(env, row, { emails_stopped_at: now() });
    s.emails_stopped++;
    await log(env, "info", row.email, `Instantly emails stopped: ${reason}`);
  } catch (err) {
    s.errors++;
    await log(env, "error", row.email, `could not stop Instantly emails (${reason}): ${msg(err)}`);
  }
}

// ---------------------------------------------------------------- utils

export function pacificDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
