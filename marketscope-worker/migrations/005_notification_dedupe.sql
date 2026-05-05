-- Atomic dedupe gate for ML notifications. Replaces the KV `notif:<pushToken>:<symbol>`
-- cooldown which raced when concurrent cron passes overlapped (KV is eventually consistent;
-- two parallel reads both saw "no prior fire" and both wrote, producing duplicate APNs).
--
-- Each row claims a (push_token, symbol) cooldown until `expires_at` (ms epoch). Claim is
-- taken via `INSERT ... ON CONFLICT(push_token, symbol) DO UPDATE SET expires_at = ?
-- WHERE expires_at < ?`. D1 serializes writes through the primary region, so only one
-- concurrent caller's UPDATE actually changes a row — `meta.changes` discriminates winner
-- from loser. Keyed by push_token (not device_id) for the same reason as the prior KV
-- cooldown: rotated device_id rows pointing at the same physical phone share a claim.
CREATE TABLE notif_claims (
    push_token TEXT NOT NULL,
    symbol TEXT NOT NULL,
    expires_at INTEGER NOT NULL,    -- ms epoch when claim expires (cooldown ends)
    PRIMARY KEY (push_token, symbol)
);
CREATE INDEX idx_notif_claims_expires ON notif_claims(expires_at);
