import Foundation

/// All indicator values extracted at one bar, used by the optimizer's scoring function.
struct ScoringSnapshot: Codable {
    let timestamp: Date
    let price: Double
    let timeframe: String       // "1d", "4h"
    let isCrypto: Bool

    // EMA state
    let ema20: Double?
    let ema50: Double?
    let ema200: Double?
    let emaCrossCount: Int      // 0-3: how many EMAs is price above
    let ema20Rising: Bool       // EMA20 now > EMA20 5 bars ago
    let stackBullish: Bool      // 20 > 50 > 200
    let stackBearish: Bool      // 20 < 50 < 200

    // Market structure
    let structureBullish: Bool  // HH/HL pattern
    let structureBearish: Bool  // LL/LH pattern

    // ADX
    let adxValue: Double
    let adxBullish: Bool        // +DI > -DI

    // Momentum
    let rsi: Double?
    let macdHistogram: Double
    let macdCrossover: String?  // "bullish", "bearish", nil
    let macdHistAboveDeadZone: Bool
    let stochK: Double?
    let stochCrossover: String? // "bullish", "bearish", nil

    // Confirmation
    let aboveVwap: Bool
    let divergence: String?     // "bullish", "bearish", nil

    // Momentum override inputs
    let last3Green: Bool
    let last3Red: Bool
    let last3VolIncreasing: Bool
    let currentRSI: Double?

    // Cross-asset (daily crypto only)
    let crossAssetSignal: Int   // -2 to +2

    // Volatility
    let volScalar: Double

    // Volume confirmation (stock-only)
    let obvRising: Bool
    let adLineAccumulation: Bool

    // Derivatives signals (crypto only, Layer 6)
    let derivativesCombinedSignal: Int  // -3 to +3
    let fundingSignal: Int              // -1, 0, +1
    let oiSignal: Int                   // -1, 0, +1
    let takerSignal: Int                // -1, 0, +1
    let crowdingSignal: Int             // -1, 0, +1

    // Macro context (matched by date from daily VIX/DXY candles)
    let vix: Double?
    let dxyPrice: Double?
    let dxyAboveEma20: Bool?

    // Forward prices for evaluation
    let priceAfter4H: Double?
    let priceAfter24H: Double?
    let forwardHigh24H: Double?
    let forwardLow24H: Double?
}

// MARK: - Snapshot Cache

enum SnapshotCache {
    private static var cacheDir: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("snapshot_cache", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func save(_ snapshots: [ScoringSnapshot], symbol: String, timeframe: String) {
        let key = "\(symbol)_\(timeframe)"
        let url = cacheDir.appendingPathComponent("\(key).json")
        guard let data = try? JSONEncoder().encode(snapshots) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func load(symbol: String, timeframe: String) -> [ScoringSnapshot]? {
        let key = "\(symbol)_\(timeframe)"
        let url = cacheDir.appendingPathComponent("\(key).json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode([ScoringSnapshot].self, from: data)
    }

    static func exists(symbol: String, timeframe: String) -> Bool {
        let key = "\(symbol)_\(timeframe)"
        let url = cacheDir.appendingPathComponent("\(key).json")
        return FileManager.default.fileExists(atPath: url.path)
    }

    static func clearAll() {
        try? FileManager.default.removeItem(at: cacheDir)
    }
}
