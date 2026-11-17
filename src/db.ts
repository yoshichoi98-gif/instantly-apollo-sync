import type { Env } from "./env.js";

export interface Campaign {
  id: string;
  name: string;
  sequenceId: string;
}

export interface LeadRow {
  email: string;
  instantly_campaign_id: string;
  apollo_contact_id: string | null;
  apollo_sequence_id: string | null;
  state: string;
  detail: string | null;
  attempts: number;
  first_sent_at: string | null;
  enrolled_at: string | null;
  calls_stop_reason: string | null;
  calls_stopped_at: string | null;
  emails_stop_reason: string | null;
  emails_stop_interest: number | null;
  emails_stopped_at: string | null;
  bounced_at: string | null;
  updated_at: string | null;
}

export const now = () => new Date().toISOString();

export async function loadCampaigns(env: Env): Promise<Map<string, Campaign>> {
  const { results } = await env.DB.prepare(
    "SELECT instantly_campaign_id, name, apollo_sequence_id FROM campaign_map WHERE active = 1",
  ).all<any>();
  return new Map(results.map((r) => [r.instantly_campaign_id, { id: r.instantly_campaign_id, name: r.name, sequenceId: r.apollo_sequence_id }]));
}

export async function getLead(env: Env, email: string, campaignId: string): Promise<LeadRow | null> {
  return env.DB.prepare("SELECT * FROM leads WHERE email = ? AND instantly_campaign_id = ?")
    .bind(email, campaignId)
    .first<LeadRow>();
}

export async function leadsByEmail(env: Env, email: string): Promise<LeadRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM leads WHERE email = ?").bind(email).all<LeadRow>();
  return results;
}

export async function leadsByContact(env: Env, contactId: string): Promise<LeadRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM leads WHERE apollo_contact_id = ?").bind(contactId).all<LeadRow>();
  return results;
}

export async function insertLead(env: Env, email: string, c: Campaign, firstSentAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO leads (email, instantly_campaign_id, apollo_sequence_id, state, first_sent_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(email, c.id, c.sequenceId, firstSentAt, now())
    .run();
}

/** Update selected columns of one lead row. */
export async function updateLead(env: Env, row: Pick<LeadRow, "email" | "instantly_campaign_id">, fields: Partial<LeadRow>): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
  await env.DB.prepare(`UPDATE leads SET ${sets} WHERE email = ? AND instantly_campaign_id = ?`)
    .bind(...keys.map((k) => (fields as any)[k] ?? null), now(), row.email, row.instantly_campaign_id)
    .run();
}

export async function seenEmail(env: Env, id: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM seen_emails WHERE id = ?").bind(id).first());
}
export async function markEmailSeen(env: Env, id: string, email: string, kind: string): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO seen_emails (id, email, kind, at) VALUES (?, ?, ?, ?)").bind(id, email, kind, now()).run();
}
export async function seenCall(env: Env, id: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM seen_calls WHERE id = ?").bind(id).first());
}
export async function markCallSeen(env: Env, id: string, contactId: string, outcome: string): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO seen_calls (id, contact_id, outcome, at) VALUES (?, ?, ?, ?)").bind(id, contactId, outcome, now()).run();
}

export async function kvGet(env: Env, k: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first<{ v: string }>();
  return r?.v ?? null;
}
export async function kvSet(env: Env, k: string, v: string): Promise<void> {
  await env.DB.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, v).run();
}
export async function kvDel(env: Env, k: string): Promise<void> {
  await env.DB.prepare("DELETE FROM kv WHERE k = ?").bind(k).run();
}

export async function log(env: Env, level: "info" | "warn" | "error", email: string | null, msg: string): Promise<void> {
  const line = `[${level}]${email ? ` ${email}:` : ""} ${msg}`;
  if (level === "error") console.error(line);
  else console.log(line);
  await env.DB.prepare("INSERT INTO log (at, level, email, msg) VALUES (?, ?, ?, ?)").bind(now(), level, email, msg.slice(0, 1000)).run();
}

export async function pruneLog(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM log WHERE id < (SELECT MAX(id) - 5000 FROM log)").run();
}
