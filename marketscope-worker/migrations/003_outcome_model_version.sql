-- Add model_version to trade_outcomes for filtering by ML model version
ALTER TABLE trade_outcomes ADD COLUMN model_version INTEGER;
CREATE INDEX idx_outcomes_model ON trade_outcomes(device_id, symbol, model_version);
