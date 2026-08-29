-- Consolidates the schema that was added OUT-OF-BAND (via `wrangler d1 execute`) and never
-- captured in a migration file. Before this, a fresh D1 built from migrations/*.sql alone was
-- broken: the cron's derivatives INSERT names four large_* columns that didn't exist, POST
-- /outcomes writes trade_outcomes.prompt_version, and 006 indexes a prompt_version column that
-- nothing created. Recorded in CLAUDE.md as "Schema drift" — this closes it.
--
-- ⚠️ RUN ORDER / IDEMPOTENCY. There is NO migration runner: the box (server/*.ts) never applies
-- these, and nothing auto-executes them. They are applied by hand and this file exists so a fresh
-- bootstrap is correct and so the real schema is reviewable in git.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, so on an ALREADY-DEPLOYED database every ALTER below
-- fails with `duplicate column name: …`. That is EXPECTED and harmless — the columns are already
-- there, which is the whole point. Apply this file ONLY to a fresh database; on an existing one,
-- either skip it or run statements individually and ignore the duplicate-column errors.
-- (002_derivatives_extended.sql has the same property; this is the established pattern here.)

-- 1) Whale/large-trade flow on derivatives_history. Added out-of-band when the collector started
--    archiving futures aggTrades above WHALE_NOTIONAL_USD. Written every ~3.5h per symbol by the
--    cron; NOT among the 111 model features (display + whale-trap context only — the features
--    themselves were tested and rejected, see docs/research/rejected-hypotheses.md).
ALTER TABLE derivatives_history ADD COLUMN large_buy_vol REAL;
ALTER TABLE derivatives_history ADD COLUMN large_sell_vol REAL;
ALTER TABLE derivatives_history ADD COLUMN large_buy_count INTEGER;
ALTER TABLE derivatives_history ADD COLUMN large_sell_count INTEGER;

-- 2) trade_outcomes.prompt_version is the third drift item, but its ALTER lives in
--    006_outcome_indexes.sql, NOT here: migrations apply in filename order and 006 indexes that
--    column, so creating it in 007 left a fresh bootstrap failing at 006. See the note there.

-- 3) pending_setups is deliberately NOT created here. It was the third drift item, but it was also
--    a pure duplicate of tracked_setups rows — written only so the cron's entry-zone-touch push
--    could find them — and it was RETIRED in the same change that added this file (2026-07-24). The
--    entry-zone notification now reads tracked_setups (kind='setup', state='pending') directly and
--    nothing reads or writes pending_setups any more. Deployed databases still carry the table and
--    its old rows; they are unread, and can be dropped by hand once you're happy nothing regressed:
--        DROP TABLE pending_setups;
