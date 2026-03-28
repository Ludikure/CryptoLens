import Foundation

enum Tooltips {
    // Technical Indicators
    static let rsi = "Measures momentum (0-100). Below 30 = oversold (may bounce). Above 70 = overbought (may pull back). In strong trends, RSI can stay extreme."
    static let stochRSI = "More sensitive RSI. Below 20 = oversold, above 80 = overbought. K/D crossovers signal momentum shifts."
    static let macd = "Relationship between two moving averages. Positive histogram = bullish momentum. Crossovers signal trend changes."
    static let adx = "Trend strength (not direction). Below 20 = no trend. Above 25 = trending. Above 40 = strong trend. +DI/-DI shows direction."
    static let bollingerBands = "%B shows where price sits in the bands. Above 1.0 = extended up, below 0 = extended down. Squeeze (narrow bands) precedes big moves."
    static let atr = "How much price typically moves per candle. Used for stops (1.5x ATR) and targets. Tells you what the market CAN do."
    static let ema = "Smoothed price average. 20 (short), 50 (medium), 200 (long-term). Stacked 20>50>200 = bullish. Reverse = bearish."
    static let vwap = "Average price weighted by volume. Above = buyers in control. Below = sellers. Institutional benchmark."
    static let fibonacci = "Key retracement levels between swing high/low. 61.8% is the 'golden ratio' — most significant bounce/stall level."
    static let supportResistance = "Support = buying floor. Resistance = selling ceiling. Based on swing highs/lows. More tests = weaker level."
    static let candlePatterns = "Candle shapes signaling reversals. Hammer at support = bullish. Shooting star at resistance = bearish. Need volume confirmation."
    static let divergence = "Price vs RSI disagreement. Bullish: price lower low, RSI higher low. Bearish: price higher high, RSI lower high. Warning, not entry."
    static let volume = "Shares/contracts traded. Confirms moves — breakout with volume holds better. Volume precedes price."

    // Crypto Derivatives
    static let fundingRate = "Fee between longs/shorts every 8h. Positive = longs pay (crowded long). Negative = shorts pay. Extremes precede reversals."
    static let openInterest = "Outstanding futures contracts. OI up + price up = conviction. OI up + price down = shorts piling in. OI down = positions closing."
    static let longShortRatio = "% of accounts long vs short. >60% on one side = contrarian signal. Extreme crowding precedes squeezes."
    static let topTraderRatio = "How large traders are positioned vs retail. When whales diverge from crowd = smart money signal."
    static let takerVolume = "Aggressive buy vs sell orders. >1.0 = real buying demand. <1.0 = real selling pressure."
    static let squeezeRisk = "Crowded side + extreme funding + building OI = cascading liquidations. Highest R:R trades."

    // Stock Sentiment
    static let putCallRatio = "Put/call options volume. >1.0 = bearish sentiment (contrarian buy). <0.7 = complacent (potential top)."
    static let shortInterest = "% of shares sold short. >10% = elevated. >20% = squeeze candidate. Days to cover >5 = shorts trapped."
    static let vix = "S&P 500 fear gauge. <15 = complacent. 15-25 = normal. 25-35 = elevated. >35 = extreme fear (often marks bottoms)."
    static let fiftyTwoWeekRange = "Where price sits in its annual range. Near high = strong but extended. Near low = weak but potentially oversold."
    static let earningsDate = "Next earnings report. Can gap 5-20%. Avoid holding through unless thesis accounts for it. Within 2 weeks = high risk."

    // Enhanced Fundamentals
    static let analystTargets = "Wall Street analyst consensus target. Below target = institutional upside. Near/above = limited upside. 20+ analysts = high coverage. Use as context, not signal."
    static let earningsHistory = "Quarterly beat/miss trend. Consecutive beats raise expectations. Approaching earnings within 2 weeks = elevated risk. Surprise % matters — 1% is noise, 15% is significant."
    static let revenueGrowth = "YoY revenue/earnings growth. >20% + pullback = dip buy opportunity. Accelerating = strongest signal. Decelerating = often precedes selloffs."
    static let sectorComparison = "Performance vs sector ETF. Outperforming = institutional preference, dips bought faster. Underperforming = something wrong, rallies get sold."
    static let insiderTransactions = "Executive buy/sell activity. Insiders buy for one reason — conviction. Cluster buying (3+ in 30 days) is the strongest fundamental buy signal."

    // Trade Setup
    static let riskReward = "Risk vs reward. 1:2 = risk $1 to make $2. Minimum 1:2 means you can be wrong half the time and still profit."
    static let stopLoss = "Exit price for losing trades. Place at structural levels where your thesis is invalid — not arbitrary distances."
    static let conviction = "Signal alignment. HIGH = multiple indicators agree. MODERATE = some alignment. LOW = speculative."
    static let regime = "Market state. TRENDING = consistent direction. RANGING = bouncing between levels. TRANSITIONING = breaking out or exhausting."
}
