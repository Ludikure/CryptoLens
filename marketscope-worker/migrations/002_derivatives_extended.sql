-- Extend derivatives_history with smart money + basis data
ALTER TABLE derivatives_history ADD COLUMN top_trader_long_pct REAL;
ALTER TABLE derivatives_history ADD COLUMN taker_buy_vol REAL;
ALTER TABLE derivatives_history ADD COLUMN taker_sell_vol REAL;
ALTER TABLE derivatives_history ADD COLUMN mark_price REAL;
ALTER TABLE derivatives_history ADD COLUMN index_price REAL;
ALTER TABLE derivatives_history ADD COLUMN basis_pct REAL;
