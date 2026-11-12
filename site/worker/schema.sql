-- PDF Editor statistics: one row per day and counted value. Nothing personal.
CREATE TABLE IF NOT EXISTS daily (
  day   TEXT    NOT NULL,           -- YYYY-MM-DD (UTC)
  kind  TEXT    NOT NULL,           -- visit, page, source, country, lang, device, browser, event, tool, size
  value TEXT    NOT NULL,           -- e.g. "/fr/", "google", "FR", "pdf_opened"
  n     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, value)
) WITHOUT ROWID;
