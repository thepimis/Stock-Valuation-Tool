CREATE TABLE IF NOT EXISTS company_history_cache (
  ticker TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_company_history_expires_at
  ON company_history_cache(expires_at);

CREATE TABLE IF NOT EXISTS company_metrics (
  ticker TEXT NOT NULL,
  period_end TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('annual', 'quarterly', 'ttm')),
  metric TEXT NOT NULL,
  value REAL,
  revenue REAL,
  net_income REAL,
  free_cash_flow REAL,
  margin_percentage REAL,
  growth_percentage REAL,
  roic_percentage REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ticker, period_end, frequency, metric)
);

CREATE INDEX IF NOT EXISTS idx_company_metrics_lookup
  ON company_metrics(ticker, metric, frequency, period_end);
