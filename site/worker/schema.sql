-- PDF Editor statistics: one row per day and counted value. Nothing personal.
CREATE TABLE IF NOT EXISTS daily (
  day   TEXT    NOT NULL,           -- YYYY-MM-DD (UTC)
  kind  TEXT    NOT NULL,           -- visit, page, source, country, lang, device, browser, event, tool, size
  value TEXT    NOT NULL,           -- e.g. "/fr/", "google", "FR", "pdf_opened"
  n     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, value)
) WITHOUT ROWID;

-- Pro: the publisher's settings (prices, plans, switches), one JSON value per key.
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
) WITHOUT ROWID;

-- Pro: licences given for free by the publisher (codes PDFE-XXXX-XXXX-XXXX).
CREATE TABLE IF NOT EXISTS grants (
  code        TEXT PRIMARY KEY,
  note        TEXT NOT NULL DEFAULT '',     -- the publisher's own reminder (who it is for)
  plan        TEXT NOT NULL,                -- yearly, lifetime...
  until       INTEGER,                      -- end of the licence (ms), NULL = no end
  max_devices INTEGER NOT NULL DEFAULT 1,
  created     INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- the computers a free licence is active on (a random identifier made by the browser, never personal)
CREATE TABLE IF NOT EXISTS grant_devices (
  code     TEXT NOT NULL,
  instance TEXT NOT NULL,
  device   TEXT NOT NULL,
  name     TEXT NOT NULL DEFAULT '',
  created  INTEGER NOT NULL,
  PRIMARY KEY (code, instance)
) WITHOUT ROWID;
