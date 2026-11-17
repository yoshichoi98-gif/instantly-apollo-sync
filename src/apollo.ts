// Apollo REST (master key).
import type { Env } from "./env.js";
import { requestJson } from "./http.js";

const BASE = "https://api.apollo.io/api/v1";

function headers(env: Env) {
  return { "x-api-key": env.APOLLO_API_KEY, "Content-Type": "application/json", Accept: "application/json" };
}

function post(env: Env, path: string, body: unknown, label: string) {
  return requestJson(`${BASE}${path}`, { method: "POST", headers: headers(env), body: JSON.stringify(body) }, label);
}

/** Find the Apollo contact whose email (primary or any listed) matches exactly. */
export async function findContactByEmail(env: Env, email: string): Promise<{ id: string; name: string } | null> {
  const d = await post(env, "/contacts/search", { q_keywords: email, per_page: 10 }, "apollo contacts/search");
  const want = email.toLowerCase();
  for (const c of d.contacts ?? []) {
    const emails = [c.email, ...((c.contact_emails ?? []).map((e: any) => e.email))]
      .filter(Boolean)
      .map((e: string) => e.toLowerCase());
    if (emails.includes(want)) return { id: c.id, name: c.name ?? "" };
  }
  return null;
}

export type EnrollResult = { ok: true } | { ok: false; reason: string };

/**
 * Add one contact to a calls-only sequence. Contacts already active in another
 * Apollo sequence are NOT added (Apollo skips them and we flag it), so nobody gets
 * two cadences at once. Email-related checks are relaxed because these sequences
 * never send email, and job-change is allowed so recent role-changers aren't skipped.
 */
export async function enroll(env: Env, sequenceId: string, contactId: string): Promise<EnrollResult> {
  const d = await post(
    env,
    `/emailer_campaigns/${sequenceId}/add_contact_ids`,
    {
      emailer_campaign_id: sequenceId,
      contact_ids: [contactId],
      send_email_from_email_account_id: env.APOLLO_SEND_ACCOUNT_ID,
      sequence_active_in_other_campaigns: false,
      sequence_finished_in_other_campaigns: true,
      sequence_unverified_email: true,
      sequence_no_email: true,
      sequence_job_change: true,
      sequence_same_company_in_same_campaign: true,
    },
    "apollo add_contact_ids",
  );

  const skipped = d.skipped_contact_ids;
  if (skipped) {
    if (Array.isArray(skipped) && skipped.includes(contactId)) {
      return { ok: false, reason: describeSkip(d, contactId) };
    }
    if (!Array.isArray(skipped) && typeof skipped === "object" && contactId in skipped) {
      return { ok: false, reason: String((skipped as any)[contactId]) + describeSkip(d, contactId, true) };
    }
  }
  const enrolled = (d.contacts ?? []).some((c: any) => c.id === contactId);
  return enrolled ? { ok: true } : { ok: false, reason: `not in response: ${JSON.stringify(d).slice(0, 300)}` };
}

function describeSkip(d: any, contactId: string, suffixOnly = false): string {
  const det = d.skipped_contact_details;
  let extra = "";
  if (det) {
    const mine = Array.isArray(det) ? det.find((x: any) => x?.contact_id === contactId || x?.id === contactId) : det[contactId];
    if (mine) extra = JSON.stringify(mine).slice(0, 200);
  }
  if (suffixOnly) return extra ? ` (${extra})` : "";
  return extra || "skipped by Apollo";
}

/** Mark a contact finished in a sequence (stops remaining call tasks). */
export async function markFinished(env: Env, sequenceId: string, contactId: string): Promise<void> {
  await post(
    env,
    "/emailer_campaigns/remove_or_stop_contact_ids",
    { emailer_campaign_ids: [sequenceId], contact_ids: [contactId], mode: "mark_as_finished" },
    "apollo remove_or_stop_contact_ids",
  );
}

/** Plain-text note on a contact (Apollo shows HTML tags literally, so never send HTML). */
export async function addNote(env: Env, contactId: string, content: string): Promise<void> {
  await post(env, "/notes", { contact_id: contactId, content }, "apollo notes");
}

export interface ApolloCall {
  id: string;
  contact_id: string | null;
  phone_call_outcome_id: string | null;
  start_time: string | null;
}

/**
 * Yoshi's calls with one of the given outcomes, dated between min and max
 * (YYYY-MM-DD, Apollo's workspace time zone). `phone_call_outcome_ids` is the filter
 * that works (verified 2026-11-05); other param names are silently ignored.
 */
export async function callsWithOutcomes(env: Env, outcomeIds: string[], min: string, max: string): Promise<ApolloCall[]> {
  const out: ApolloCall[] = [];
  for (let page = 1; page <= 10; page++) {
    const d = await post(
      env,
      "/phone_calls/search",
      {
        date_range: { min, max },
        user_ids: [env.APOLLO_USER_ID],
        phone_call_outcome_ids: outcomeIds,
        per_page: 100,
        page,
      },
      "apollo phone_calls/search",
    );
    const calls: ApolloCall[] = d.phone_calls ?? [];
    out.push(...calls);
    if (calls.length < 100) break;
  }
  return out;
}
