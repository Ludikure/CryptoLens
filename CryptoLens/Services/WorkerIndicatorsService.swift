import Foundation

/// Thin-client indicator source. Calls the Worker `GET /indicators?symbol=` — the shared
/// indicator brain (candle fetch + `computeFullIndicators` per timeframe, all server-side) — and
/// maps the JSON to the same `IndicatorResult` the chart/table/OutcomeTracker already consume.
///
/// This is the sole indicator source for the (pure thin-client) app — the on-device indicator
/// engine has been removed. The worker is the single source of truth; there is no local fallback
/// (cron dead-man's-switch `/cron-health` covers worker uptime).
///
/// The worker JSON shape (`src/indicators-full.ts`) is *close* to iOS `IndicatorResult` but not
/// identical — it omits `id`, emits `macd` as `{histogram,crossover}` (macd/signal live in the
/// series), `vwap` as a bare number, `atr` without `suggestedSL*`, `volumeProfile` as
/// `{poc,vah,val}`, and `obv/adLine` without `current`. So we decode into tolerant DTOs and build
/// `IndicatorResult` via its memberwise init (which defaults the rest).
enum WorkerIndicatorsService {

    struct Bundle {
        let daily: IndicatorResult
        let fourH: IndicatorResult?
        let oneH: IndicatorResult?
        let livePrice: Double?
    }

    enum FetchError: LocalizedError {
        case missingURL, unauthorized, http(Int), decode, noCandles
        var errorDescription: String? {
            switch self {
            case .missingURL: return "bad URL"
            case .unauthorized: return "unauthorized"
            case .http(let c): return "HTTP \(c)"
            case .decode: return "bad response"
            case .noCandles: return "no candles"
            }
        }
    }

    static func fetch(symbol: String) async throws -> Bundle {
        await PushService.ensureAuth()
        do {
            return try await get(symbol: symbol)
        } catch FetchError.unauthorized {
            await PushService.handleAuthFailure()
            return try await get(symbol: symbol)
        }
    }

    private static func get(symbol: String) async throws -> Bundle {
        guard var comps = URLComponents(string: "\(PushService.workerURL)/indicators") else { throw FetchError.missingURL }
        comps.queryItems = [URLQueryItem(name: "symbol", value: symbol)]
        guard let url = comps.url else { throw FetchError.missingURL }

        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        PushService.addAuthHeaders(&request)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw FetchError.http(0) }
        if http.statusCode == 401 { throw FetchError.unauthorized }
        if http.statusCode == 404 { throw FetchError.noCandles }
        guard (200..<300).contains(http.statusCode) else { throw FetchError.http(http.statusCode) }

        guard let body = try? JSONDecoder().decode(ResponseDTO.self, from: data) else { throw FetchError.decode }
        // The worker drops the in-progress bar, so each TF's `price` is the last CLOSED close
        // (stale for the live header). `livePrice` is a separate live-ticker fetch (matches
        // TradingView) — apply it as the displayed current price across all TFs. Indicator math
        // (RSI/EMA/levels) stays on closed bars; only the "current price" scalar is overridden.
        let live = body.livePrice
        // Feed each coarse TF the finer TF's closed bars so its forming-bar wick is REAL, not the
        // open/live approximation: Daily forms from 4H bars, 4H forms from 1H bars. (1H is the finest
        // fetched, so its forming bar keeps the approximation.)
        let fourHBars = body.fourH?.decodedCandles
        let oneHBars = body.oneH?.decodedCandles
        return Bundle(
            daily: body.daily.toIndicatorResult(priceOverride: live, subCandles: fourHBars),
            fourH: body.fourH?.toIndicatorResult(priceOverride: live, subCandles: oneHBars),
            oneH: body.oneH?.toIndicatorResult(priceOverride: live),
            livePrice: live
        )
    }

    // MARK: - DTOs (worker JSON → IndicatorResult)

    private struct ResponseDTO: Decodable {
        let symbol: String
        let isCrypto: Bool
        let livePrice: Double?
        let daily: TFDTO
        let fourH: TFDTO?
        let oneH: TFDTO?
    }

    private struct MACDDTO: Decodable { let histogram: Double?; let crossover: String? }
    private struct BBDTO: Decodable { let upper: Double?; let middle: Double?; let lower: Double?; let percentB: Double?; let bandwidth: Double?; let squeeze: Bool? }
    private struct ATRDTO: Decodable { let atr: Double?; let atrPercent: Double? }
    private struct VPDTO: Decodable { let poc: Double; let vah: Double; let val: Double }
    private struct TrendDTO: Decodable { let trend: String }
    private struct CandleDTO: Decodable {
        let time: Double; let open: Double; let high: Double; let low: Double; let close: Double; let volume: Double
        func toCandle() -> Candle {
            Candle(time: Date(timeIntervalSince1970: time / 1000), open: open, high: high, low: low, close: close, volume: volume)
        }
    }

    /// One timeframe of the worker response. Nested types whose keys already match iOS structs
    /// (stochRSI/adx/fibonacci/supportResistance/candlePatterns/marketStructure) decode straight
    /// into those `Codable` types; the rest go through bridging DTOs above.
    private struct TFDTO: Decodable {
        let timeframe: String
        let label: String
        let price: Double
        let rsi: Double?
        let stochRSI: StochRSIResult?
        let macd: MACDDTO?
        let adx: ADXResult?
        let bollingerBands: BBDTO?
        let atr: ATRDTO?
        let ema20: Double?
        let ema50: Double?
        let ema200: Double?
        let vwap: Double?
        let fibonacci: FibResult?
        let supportResistance: SRResult?
        let candlePatterns: [PatternResult]?
        let volumeRatio: Double?
        let divergence: String?
        let bias: String?
        let bullPercent: Double?
        let biasScore: Int?
        let marketStructure: MarketStructureResult?
        let volScalar: Double?
        let volumeProfile: VPDTO?
        let obv: TrendDTO?
        let adLine: TrendDTO?
        let atrPercentile: Double?
        let atrPercentileLabel: String?
        let candles: [CandleDTO]?
        let rsiSeries: [Double]?
        let stochKSeries: [Double]?
        let stochDSeries: [Double]?
        let macdHistSeries: [Double]?
        let macdLineSeries: [Double]?
        let macdSignalSeries: [Double]?
        let adxSeries: [Double]?
        let plusDISeries: [Double]?
        let minusDISeries: [Double]?
        let volumeRatioSeries: [Double]?
        let ema20Series: [Double]?
        let ema50Series: [Double]?
        let ema200Series: [Double]?

        /// Finer-timeframe closed bars, for reconstructing this TF's forming-bar wick (see below).
        var decodedCandles: [Candle] { (candles ?? []).map { $0.toCandle() } }

        func toIndicatorResult(priceOverride: Double? = nil, subCandles: [Candle]? = nil) -> IndicatorResult {
            // Use the live ticker price for the "current price" scalar + price-relative display
            // (VWAP distance, ATR stop suggestions). Falls back to the closed-bar close.
            let px = (priceOverride.map { $0 > 0 ? $0 : price }) ?? price
            let macdLine = macdLineSeries ?? []
            let macdSig = macdSignalSeries ?? []
            let macdResult: MACDResult? = macd.map {
                MACDResult(macd: (macdLine.last ?? 0).rounded(toPlaces: 6),
                           signal: (macdSig.last ?? 0).rounded(toPlaces: 6),
                           histogram: $0.histogram ?? 0,
                           crossover: $0.crossover)
            }

            let bbResult: BollingerResult? = bollingerBands.flatMap { b in
                guard let pb = b.percentB else { return nil }
                return BollingerResult(upper: b.upper ?? 0, middle: b.middle ?? 0, lower: b.lower ?? 0,
                                       percentB: pb, bandwidth: b.bandwidth ?? 0, squeeze: b.squeeze ?? false)
            }

            let atrResult: ATRResult? = atr.flatMap { a in
                guard let av = a.atr else { return nil }
                return ATRResult(atr: av, atrPercent: a.atrPercent ?? 0,
                                 suggestedSLLong: (px - 1.5 * av).rounded(toPlaces: 2),
                                 suggestedSLShort: (px + 1.5 * av).rounded(toPlaces: 2))
            }

            let vwapResult: VWAPResult? = vwap.map { v in
                VWAPResult(vwap: v.rounded(toPlaces: 2),
                           priceVsVwap: px > v ? "above" : "below",
                           distancePercent: (v == 0 ? 0 : ((px - v) / v) * 100).rounded(toPlaces: 2))
            }

            let obvResult: OBVResult? = obv.map { OBVResult(current: 0, trend: $0.trend, divergence: nil) }
            let adResult: ADLineResult? = adLine.map { ADLineResult(current: 0, trend: $0.trend) }

            // Forming bar (TradingView-style): the worker serves CLOSED bars only (indicator
            // parity), so without this the newest 4H chart bar is up to 4h stale and each
            // timeframe "ends" at a different price. Synthesize the in-progress bar: open = last
            // close, close = live. Indicator math is untouched — computed server-side on closed bars.
            //
            // The wick: open+live ALONE misses any spike/dip WITHIN the forming bar — e.g. a 4H bar
            // that ran to 64.2k then fell back would draw as a clean wickless body while the 1H chart
            // plainly shows the spike. So reconstruct the real high/low (and volume) from the finer
            // timeframe's CLOSED bars falling in this bucket (1H→4H, 4H→Daily); each carries the true
            // intrabar extremes. Falls back to the open/live approximation when no sub-bars are given
            // (the 1H forming bar — finest TF fetched — keeps the approximation; a 1h window is minor).
            var chartCandles = (candles ?? []).map { $0.toCandle() }
            var forming: Candle? = nil
            if let live = priceOverride, live > 0, let last = chartCandles.last {
                let interval: TimeInterval = timeframe == "1d" ? 86_400 : timeframe == "4h" ? 14_400 : 3_600
                let bucketStart = floor(Date().timeIntervalSince1970 / interval) * interval
                let t = max(bucketStart, last.time.timeIntervalSince1970 + interval)
                // Window off the forming bar's actual open time `t` (derived from the last CLOSED
                // bar), not a UTC-floored bucket — so it aligns for crypto (UTC) AND stocks (the
                // worker's 4H bars are ET-session-aggregated).
                let subInBucket = (subCandles ?? []).filter {
                    let ts = $0.time.timeIntervalSince1970
                    return ts >= t && ts < t + interval
                }
                let hi = ([last.close, live] + subInBucket.map { $0.high }).max() ?? Swift.max(last.close, live)
                let lo = ([last.close, live] + subInBucket.map { $0.low }).min() ?? Swift.min(last.close, live)
                let vol = subInBucket.reduce(0) { $0 + $1.volume }
                let bar = Candle(time: Date(timeIntervalSince1970: t),
                                 open: last.close, high: hi, low: lo, close: live, volume: vol)
                chartCandles.append(bar)
                forming = bar
            }

            var result = IndicatorResult(
                timeframe: timeframe,
                label: label,
                price: px,
                rsi: rsi,
                stochRSI: stochRSI,
                macd: macdResult,
                adx: adx,
                bollingerBands: bbResult,
                atr: atrResult,
                ema20: ema20,
                ema50: ema50,
                ema200: ema200,
                sma50: nil,
                sma200: nil,
                vwap: vwapResult,
                fibonacci: fibonacci,
                supportResistance: supportResistance ?? SRResult(supports: [], resistances: []),
                candlePatterns: candlePatterns ?? [],
                volumeRatio: volumeRatio,
                divergence: divergence,
                bias: bias ?? "Neutral",
                bullPercent: bullPercent ?? 50,
                obv: obvResult,
                adLine: adResult,
                candles: chartCandles,
                inProgressCandle: forming,
                rsiSeries: rsiSeries ?? [],
                stochKSeries: stochKSeries ?? [],
                stochDSeries: stochDSeries ?? [],
                macdHistSeries: macdHistSeries ?? [],
                macdLineSeries: macdLine,
                macdSignalSeries: macdSig,
                adxSeries: adxSeries ?? [],
                plusDISeries: plusDISeries ?? [],
                minusDISeries: minusDISeries ?? [],
                volumeRatioSeries: volumeRatioSeries ?? [],
                ema20Series: ema20Series ?? [],
                ema50Series: ema50Series ?? [],
                ema200Series: ema200Series ?? [],
                atrPercentile: atrPercentile,
                atrPercentileLabel: atrPercentileLabel,
                momentumOverride: nil,
                biasScore: biasScore ?? 0,
                marketStructure: marketStructure,
                volScalar: volScalar
            )
            // volumeProfile is a `var` set post-init on IndicatorResult; mirror that here.
            if let vp = volumeProfile {
                result.volumeProfile = VolumeProfileResult(poc: vp.poc, valueAreaHigh: vp.vah, valueAreaLow: vp.val)
            }
            return result
        }
    }
}
