// Instantly <-> Apollo sync. Instantly sends the emails; Apollo runs the calls.
//   cron */15        runSync()
//   GET /status?token=…              HTML status page (who's enrolled, who needs attention, recent activity)
//   GET /run?token=…                 run a sync pass now, returns the summary
//   GET /retry?token=…&email=…       re-try enrolling one person (after fixing them in Apollo)

import type { Env } from "./env.js";
import { runSync } from "./sync.js";
import { kvGet } from "./db.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, service: "instantly-apollo-sync" });

    const t = url.searchParams.get("token");
    if (!t || !env.ADMIN_TOKEN || t !== env.ADMIN_TOKEN) return new Response("forbidden", { status: 403 });

    try {
      if (url.pathname === "/run") return json(await runSync(env));
      if (url.pathname === "/retry") {
        const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
        if (!email) return json({ error: "email= required" }, 400);
        const r = await env.DB.prepare(
          "UPDATE leads SET attempts = 0, state = 'pending', detail = 'manual retry', updated_at = ? WHERE email = ? AND state != 'enrolled'",
        )
          .bind(new Date().toISOString(), email)
          .run();
        return json({ reset: r.meta.changes, next: "picked up on the next run (or call /run)" });
      }
      if (url.pathname === "/status") return html(await statusPage(env));
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    return new Response("not found", { status: 404 });
  },

  // Awaited directly, NOT ctx.waitUntil: waitUntil work only gets 30 s after the
  // handler returns, a cron run gets 15 min (lesson from apollo-ashby-sync).
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try {
      await runSync(env);
    } catch (err) {
      console.error(`run failed: ${err instanceof Error ? err.message : err}`);
    }
  },
} satisfies ExportedHandler<Env>;

async function statusPage(env: Env): Promise<string> {
  const last = await kvGet(env, "last_run");
  const { results: counts } = await env.DB.prepare(
    `SELECT m.name AS campaign, l.state, COUNT(*) AS n,
            SUM(l.calls_stopped_at IS NOT NULL) AS calls_stopped, SUM(l.emails_stopped_at IS NOT NULL) AS emails_stopped
     FROM leads l LEFT JOIN campaign_map m ON m.instantly_campaign_id = l.instantly_campaign_id
     GROUP BY m.name, l.state ORDER BY m.name, l.state`,
  ).all<any>();
  const { results: attention } = await env.DB.prepare(
    `SELECT l.email, m.name AS campaign, l.state, l.detail, l.first_sent_at
     FROM leads l LEFT JOIN campaign_map m ON m.instantly_campaign_id = l.instantly_campaign_id
     WHERE l.state IN ('no_apollo_contact', 'enroll_skipped', 'error')
        OR (l.calls_stop_reason IS NOT NULL AND l.calls_stopped_at IS NULL AND l.state = 'enrolled')
        OR (l.emails_stop_reason IS NOT NULL AND l.emails_stopped_at IS NULL)
     ORDER BY l.first_sent_at DESC LIMIT 200`,
  ).all<any>();
  const { results: recent } = await env.DB.prepare("SELECT at, level, email, msg FROM log ORDER BY id DESC LIMIT 100").all<any>();

  const lastRun = last ? JSON.parse(last) : null;
  const table = (rows: any[], cols: string[]) =>
    rows.length
      ? `<table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>${rows
          .map((r) => `<tr class="${esc(r.level ?? "")}">${cols.map((c) => `<td>${esc(r[c] ?? "")}</td>`).join("")}</tr>`)
          .join("")}</table>`
      : `<p class="muted">None.</p>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Instantly ↔ Apollo sync</title>
<style>
 :root{--bg:#fff;--fg:#1a1a1a;--muted:#6b6b6b;--line:#e5e5e5;--warn:#fff7e0;--err:#fde8e8}
 @media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--muted:#999;--line:#333;--warn:#3a3218;--err:#3d1f1f}}
 body{font:14px/1.45 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:24px 16px;max-width:1100px}
 h1{font-size:20px} h2{font-size:16px;margin-top:28px} .muted{color:var(--muted)}
 table{border-collapse:collapse;width:100%;font-size:13px} th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
 tr.warn td{background:var(--warn)} tr.error td{background:var(--err)}
 .wrap{overflow-x:auto}
</style></head><body>
<h1>Instantly ↔ Apollo sync</h1>
<p class="muted">Runs every 15 minutes. Last run: ${esc(lastRun ? `${lastRun.at} · ${JSON.stringify(lastRun.summary)}` : "never")}</p>
<h2>People by campaign</h2><div class="wrap">${table(counts, ["campaign", "state", "n", "calls_stopped", "emails_stopped"])}</div>
<h2>Needs attention</h2>
<p class="muted">no_apollo_contact = the email isn't on any Apollo contact (add or fix it in Apollo, then use /retry). enroll_skipped = Apollo refused, usually because they're active in another sequence.</p>
<div class="wrap">${table(attention, ["email", "campaign", "state", "detail", "first_sent_at"])}</div>
<h2>Recent activity</h2><div class="wrap">${table(recent, ["at", "level", "email", "msg"])}</div>
</body></html>`;
}

function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
function html(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

