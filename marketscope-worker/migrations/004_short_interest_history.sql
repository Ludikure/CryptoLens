-- Daily short interest snapshots from Yahoo's defaultKeyStatistics module.
-- Captures shortPercentOfFloat (raw, 0-1 representing %) and shortRatio (days to cover).
-- One row per (symbol, date). PK enforces idempotency (INSERT OR REPLACE on re-run).
CREATE TABLE short_interest_history (
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,             -- YYYY-MM-DD UTC, fetch date
    short_pct_of_float REAL,        -- 0-1 (Yahoo raw value; multiply by 100 for %)
    days_to_cover REAL,             -- shortRatio
    PRIMARY KEY (symbol, date)
);
CREATE INDEX idx_short_lookup ON short_interest_history(symbol, date DESC);
