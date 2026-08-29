-- A/B querying on trade_outcomes filters by (device_id, prompt_version) — there's no
-- composite index for that today, so /outcomes?prompt_version=… falls back to scanning
-- all rows for the device (the existing idx_outcomes_model is (device_id, symbol,
-- model_version) and SQLite can't use it for a prompt_version-only filter).
--
-- Add `IF NOT EXISTS` so re-running the migration is a no-op; the column itself was
-- introduced via an out-of-band ALTER and is assumed to exist in every deployed D1.
--
-- 2026-07-24: the ALTER below was added HERE rather than in 007_schema_drift.sql because
-- migrations apply in filename order — indexing prompt_version before anything created it made a
-- fresh bootstrap fail with `no such column: prompt_version` (verified by replaying the whole
-- directory into an empty database). Every deployed D1 already has the column, so on those this
-- statement fails with `duplicate column name` and should be skipped; see the header of
-- 007_schema_drift.sql for the full run-order note. There is no migration runner — nothing
-- re-applies this automatically.
ALTER TABLE trade_outcomes ADD COLUMN prompt_version TEXT;
CREATE INDEX IF NOT EXISTS idx_outcomes_prompt
    ON trade_outcomes(device_id, prompt_version);
