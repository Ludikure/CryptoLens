-- A/B querying on trade_outcomes filters by (device_id, prompt_version) — there's no
-- composite index for that today, so /outcomes?prompt_version=… falls back to scanning
-- all rows for the device (the existing idx_outcomes_model is (device_id, symbol,
-- model_version) and SQLite can't use it for a prompt_version-only filter).
--
-- Add `IF NOT EXISTS` so re-running the migration is a no-op; the column itself was
-- introduced via an out-of-band ALTER and is assumed to exist in every deployed D1.
CREATE INDEX IF NOT EXISTS idx_outcomes_prompt
    ON trade_outcomes(device_id, prompt_version);
