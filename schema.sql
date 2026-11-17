-- Instantly campaign -> Apollo calls-only sequence. Edit rows to add/change routing
-- without redeploying. active = 0 pauses syncing for that campaign.
CREATE TABLE IF NOT EXISTS campaign_map (
  instantly_campaign_id TEXT PRIMARY KEY,
  name                  TEXT,
  apollo_sequence_id    TEXT NOT NULL,
  active                INTEGER NOT NULL DEFAULT 1
);

-- Apollo call disposition -> what to do. Any call logged with one of these outcomes
-- stops the person's Instantly emails (sets this interest status, which completes the
-- lead) and marks them finished in the Apollo call sequence.
-- Instantly interest values: 1 Interested, 2 Meeting Booked, -1 Not Interested, -2 Wrong Person.
CREATE TABLE IF NOT EXISTS outcome_map (
  apollo_outcome_id  TEXT PRIMARY KEY,
  label              TEXT NOT NULL,
  instantly_interest INTEGER NOT NULL
);

-- One row per person per Instantly campaign.
-- state: pending | enrolled | no_apollo_contact | enroll_skipped | error
-- *_stop_reason is the decision (set first); *_stopped_at is set once the API call
-- succeeded, so a failed stop is retried on the next run.
CREATE TABLE IF NOT EXISTS leads (
  email                 TEXT NOT NULL,
  instantly_campaign_id TEXT NOT NULL,
  apollo_contact_id     TEXT,
  apollo_sequence_id    TEXT,
  state                 TEXT NOT NULL,
  detail                TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  first_sent_at         TEXT,
  enrolled_at           TEXT,
  calls_stop_reason     TEXT,
  calls_stopped_at      TEXT,
  emails_stop_reason    TEXT,
  emails_stop_interest  INTEGER,
  emails_stopped_at     TEXT,
  bounced_at            TEXT,
  updated_at            TEXT,
  PRIMARY KEY (email, instantly_campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_leads_contact ON leads (apollo_contact_id);
CREATE INDEX IF NOT EXISTS idx_leads_state ON leads (state);

-- Idempotency: Instantly email ids and Apollo call ids already handled.
CREATE TABLE IF NOT EXISTS seen_emails (id TEXT PRIMARY KEY, email TEXT, kind TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS seen_calls  (id TEXT PRIMARY KEY, contact_id TEXT, outcome TEXT, at TEXT);

-- Cursors and run bookkeeping.
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);

-- What the sync did, newest last. Shown on /status.
CREATE TABLE IF NOT EXISTS log (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  at    TEXT NOT NULL,
  level TEXT NOT NULL,
  email TEXT,
  msg   TEXT NOT NULL
);
