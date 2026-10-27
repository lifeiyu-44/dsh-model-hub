CREATE TABLE IF NOT EXISTS channels (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  config        TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS accounts (
  id                   TEXT PRIMARY KEY,
  channel_id           TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  credential_ref       TEXT,
  enabled              INTEGER NOT NULL DEFAULT 1,
  is_current           INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  last_ok_at           INTEGER,
  created_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  request_id       TEXT PRIMARY KEY,
  session_id       TEXT,
  channel_id       TEXT NOT NULL,
  account_id       TEXT,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_read       INTEGER NOT NULL DEFAULT 0,
  cache_write      INTEGER NOT NULL DEFAULT 0,
  first_token_ms   INTEGER,
  upstream_head_ms INTEGER,
  duration_ms      INTEGER,
  decode_tps       REAL,
  status_code      INTEGER,
  error            TEXT,
  is_streaming     INTEGER NOT NULL DEFAULT 0,
  estimated        INTEGER NOT NULL DEFAULT 0,
  cost_units       REAL NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_channel ON requests(channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS daily_rollups (
  date          TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  model         TEXT NOT NULL,
  account_id    TEXT NOT NULL DEFAULT '',
  req_count     INTEGER NOT NULL DEFAULT 0,
  ok_count      INTEGER NOT NULL DEFAULT 0,
  tokens        INTEGER NOT NULL DEFAULT 0,
  cost_units    REAL NOT NULL DEFAULT 0,
  avg_ttft_ms   INTEGER NOT NULL DEFAULT 0,
  ttft_n        INTEGER NOT NULL DEFAULT 0,
  avg_tps       REAL NOT NULL DEFAULT 0,
  tps_n         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, channel_id, model, account_id)
);
