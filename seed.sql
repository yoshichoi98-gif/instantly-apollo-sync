-- Routing: example Instantly campaigns and their Apollo calls-only sequences.
INSERT OR REPLACE INTO campaign_map (instantly_campaign_id, name, apollo_sequence_id, active) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Example Campaign A',    '000000000000000000000005', 1),
  ('00000000-0000-0000-0000-000000000002', 'Example Campaign B',    '000000000000000000000006', 1),
  ('00000000-0000-0000-0000-000000000003', 'Example Campaign C',    '000000000000000000000007', 1),
  ('00000000-0000-0000-0000-000000000004', 'Example Campaign D',    '000000000000000000000008', 1);

-- Call outcomes that stop the emails. Everything else (No Answer, Voicemail, Busy, ...)
-- leaves the emails running.
INSERT OR REPLACE INTO outcome_map (apollo_outcome_id, label, instantly_interest) VALUES
  ('000000000000000000000009', 'Meeting Booked',      2),
  ('000000000000000000000010', 'Interested',          1),
  ('000000000000000000000011', 'Not Interested',     -1),
  ('000000000000000000000014', 'Wrong Person',       -2),
  ('000000000000000000000015', 'Do Not Call',        -2);

-- Only look at Instantly emails from now on.
INSERT OR IGNORE INTO kv (k, v) VALUES ('emails_cursor', '2026-11-05T00:00:00.000Z');
