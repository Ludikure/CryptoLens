-- Devices
CREATE TABLE devices (
    device_id TEXT PRIMARY KEY,
    push_token TEXT,
    auth_token TEXT NOT NULL,
    platform TEXT DEFAULT 'ios',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Alerts (price alerts)
CREATE TABLE alerts (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    target_price REAL NOT NULL,
    condition TEXT NOT NULL CHECK (condition IN ('above', 'below')),
    note TEXT DEFAULT '',
    triggered INTEGER DEFAULT 0,
    triggered_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
);
CREATE INDEX idx_alerts_device ON alerts(device_id, triggered);

-- Watchlist
CREATE TABLE watchlist (
    device_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    crypto_threshold INTEGER DEFAULT 5,
    stock_threshold INTEGER DEFAULT 3,
    PRIMARY KEY (device_id, symbol),
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

-- ML Score History (for crossing detection + drift tracking)
CREATE TABLE score_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    daily_score INTEGER,
    four_h_score INTEGER,
    ml_probability REAL,
    bias TEXT,
    notification_sent INTEGER DEFAULT 0,
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
);
CREATE INDEX idx_scores_device_symbol ON score_history(device_id, symbol, timestamp DESC);

-- Trade Outcomes (track live performance)
CREATE TABLE trade_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    entry_price REAL NOT NULL,
    stop_loss REAL NOT NULL,
    tp1 REAL NOT NULL,
    tp2 REAL,
    ml_probability REAL,
    daily_score INTEGER,
    four_h_score INTEGER,
    conviction TEXT,
    opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME,
    outcome TEXT,
    pnl_percent REAL,
    notes TEXT,
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
);
CREATE INDEX idx_outcomes_device ON trade_outcomes(device_id, opened_at DESC);

-- Notification Log
CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    type TEXT NOT NULL,
    ml_probability REAL,
    score INTEGER,
    direction TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
);
CREATE INDEX idx_notif_device ON notifications(device_id, sent_at DESC);

-- Historical Candles (permanent archive)
CREATE TABLE candles (
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    PRIMARY KEY (symbol, interval, timestamp)
);
CREATE INDEX idx_candles_lookup ON candles(symbol, interval, timestamp DESC);

-- Derivatives History (permanent archive)
CREATE TABLE derivatives_history (
    symbol TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    funding_rate REAL,
    open_interest REAL,
    long_percent REAL,
    taker_ratio REAL,
    PRIMARY KEY (symbol, timestamp)
);
CREATE INDEX idx_deriv_lookup ON derivatives_history(symbol, timestamp DESC);
