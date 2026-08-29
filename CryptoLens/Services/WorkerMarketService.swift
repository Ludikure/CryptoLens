import Foundation

/// Thin-client per-symbol display-enrichment source. Calls the Worker `GET /market?symbol=` — one
/// call that bundles the geoblocked crypto enrichment (derivatives + positioning, spot pressure)
/// plus sentiment, fear & greed, and macro — and maps it to the iOS display models.
///
/// This is the sole source of crypto display enrichment in the thin client: derivatives +
/// positioning (Binance fapi → HTTP 451 from the phone's residential IP), spot pressure (Binance
/// spot, also geoblocked), and sentiment / fear & greed. The former on-device fetchers for these
/// have been removed — the phone never hits Binance/CoinGecko directly.
/// Stock fundamentals stay on the on-device Yahoo/Finnhub path (richer than the worker subset and
/// not geoblocked); macro stays on `/macro`. The LLM analysis itself already gets full enrichment
/// server-side inside `/full-analysis` — this `/market` call only repopulates the iOS *display*.
///
/// The worker JSON shapes (`src/enrichment.ts`) are **subsets** of the iOS `Codable` models — direct
/// decode fails (e.g. `DerivativesData` has 18 fields, the worker emits 11; `SqueezeRisk.description`
/// is omitted; `FearGreedIndex.classification` arrives as `label`). So we decode tolerant DTOs and
/// build the models via their memberwise inits, defaulting the fields the worker doesn't carry.
enum WorkerMarketService {

    struct Bundle {
        var sentiment: CoinInfo?
        var fearGreed: FearGreedIndex?
        var derivatives: DerivativesData?
        var positioning: PositioningSnapshot?
        var spotPressure: SpotPressure?
        var macro: MacroSnapshot?
        /// Finnhub-derived stock fields (2026-07-25). Not a full `StockInfo` — only the fields the
        /// app used to fetch itself with five separate /finnhub/* worker calls per refresh. The
        /// Yahoo-sourced fundamentals still come from the on-device path, which isn't worker-gated.
        var stockFinnhub: StockFinnhubFields?
    }

    /// The subset the /finnhub/* fan-out used to supply. Everything optional: the worker fills what
    /// it can and the caller keeps its previous value for anything nil, so a partial response can
    /// never blank out data the app already had.
    struct StockFinnhubFields {
        var finnhubBuy: Int?
        var finnhubHold: Int?
        var finnhubSell: Int?
        var finnhubStrongBuy: Int?
        var marketCap: Double?
        var beta: Double?
        var earningsDate: Date?
        var newsHeadlines: [String]?
        var insiderTransactions: [StockInfo.InsiderTx]?
        var insiderBuyCount6m: Int?
        var insiderSellCount6m: Int?
        var insiderNetBuying: Bool?
    }

    /// Best-effort: returns nil on any failure (callers carry forward the previous enrichment).
    /// One 401 self-heal retry, mirroring `WorkerIndicatorsService`.
    static func fetch(symbol: String) async -> Bundle? {
        await PushService.ensureAuth()
        if let b = await get(symbol: symbol, retryOn401: true) { return b }
        return nil
    }

    private static func get(symbol: String, retryOn401: Bool) async -> Bundle? {
        guard var comps = URLComponents(string: "\(PushService.workerURL)/market") else { return nil }
        comps.queryItems = [URLQueryItem(name: "symbol", value: symbol)]
        guard let url = comps.url else { return nil }

        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        PushService.addAuthHeaders(&request)

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return nil }
        if http.statusCode == 401 && retryOn401 {
            await PushService.handleAuthFailure()
            return await get(symbol: symbol, retryOn401: false)
        }
        guard (200..<300).contains(http.statusCode),
              let body = try? JSONDecoder().decode(ResponseDTO.self, from: data) else { return nil }

        return Bundle(
            sentiment: body.sentiment?.toModel(),
            fearGreed: body.fearGreed?.toModel(),
            derivatives: body.derivatives?.toModel(),
            positioning: body.positioning?.toModel(),
            spotPressure: body.spotPressure?.toModel(),
            macro: body.macro?.toModel(),
            stockFinnhub: body.stockInfo?.toFields()
        )
    }

    // MARK: - DTOs (worker /market JSON → iOS display models)

    private struct ResponseDTO: Decodable {
        let derivatives: DerivDTO?
        let positioning: PosDTO?
        let spotPressure: SpotDTO?
        let sentiment: SentimentDTO?
        let fearGreed: FearGreedDTO?
        let macro: MacroDTO?
        let stockInfo: StockInfoDTO?
    }

    /// Mirrors the worker's `StockInfo` for the Finnhub-derived fields only. Unknown keys are
    /// ignored by JSONDecoder, so the worker can keep adding fields without breaking older builds.
    private struct StockInfoDTO: Decodable {
        let finnhubBuy: Int?
        let finnhubHold: Int?
        let finnhubSell: Int?
        let finnhubStrongBuy: Int?
        let marketCap: Double?
        let beta: Double?
        let earningsDate: Double?          // ms epoch
        let newsHeadlines: [String]?
        let insiderTransactions: [InsiderDTO]?
        let insiderBuyCount6m: Int?
        let insiderSellCount6m: Int?
        let insiderNetBuying: Bool?

        func toFields() -> StockFinnhubFields {
            StockFinnhubFields(
                finnhubBuy: finnhubBuy,
                finnhubHold: finnhubHold,
                finnhubSell: finnhubSell,
                finnhubStrongBuy: finnhubStrongBuy,
                marketCap: marketCap,
                beta: beta,
                earningsDate: earningsDate.map { Date(timeIntervalSince1970: $0 / 1000) },
                newsHeadlines: newsHeadlines,
                insiderTransactions: insiderTransactions?.map {
                    StockInfo.InsiderTx(name: $0.name ?? "", date: Date(timeIntervalSince1970: ($0.date ?? 0) / 1000),
                                        shares: Int($0.shares ?? 0), value: $0.value ?? 0, isBuy: $0.isBuy ?? false)
                },
                insiderBuyCount6m: insiderBuyCount6m,
                insiderSellCount6m: insiderSellCount6m,
                insiderNetBuying: insiderNetBuying
            )
        }
    }

    private struct InsiderDTO: Decodable {
        let name: String?; let date: Double?; let shares: Double?; let value: Double?; let isBuy: Bool?
    }

    /// Worker emits 11 of `DerivativesData`'s 18 fields; mark price / index / OI base / funding
    /// history / taker-sell are unavailable from the enrichment bundle → defaulted (the analysis
    /// uses the server-side full derivatives; this is display-only).
    private struct DerivDTO: Decodable {
        let fundingRatePercent: Double?
        let avgFundingRate: Double?
        let openInterestUSD: Double?
        let oiChange4h: Double?
        let oiChange24h: Double?
        let globalLongPercent: Double?
        let globalShortPercent: Double?
        let topTraderLongPercent: Double?
        let topTraderShortPercent: Double?
        let takerBuySellRatio: Double?
        let takerBuyVolume: Double?

        func toModel() -> DerivativesData {
            let frPct = fundingRatePercent ?? 0
            return DerivativesData(
                fundingRate: frPct / 100,
                fundingRatePercent: frPct,
                fundingHistory: [],
                avgFundingRate: avgFundingRate ?? (frPct / 100),
                markPrice: 0,
                indexPrice: 0,
                markIndexPremium: 0,
                openInterest: 0,
                openInterestUSD: openInterestUSD ?? 0,
                oiChange4h: oiChange4h,
                oiChange24h: oiChange24h,
                globalLongPercent: globalLongPercent ?? 50,
                globalShortPercent: globalShortPercent ?? 50,
                topTraderLongPercent: topTraderLongPercent ?? 50,
                topTraderShortPercent: topTraderShortPercent ?? 50,
                takerBuySellRatio: takerBuySellRatio ?? 1,
                takerBuyVolume: takerBuyVolume ?? 0,
                takerSellVolume: 0
            )
        }
    }

    private struct PosDTO: Decodable {
        let crowding: String?
        let fundingSentiment: String?
        let oiTrend: String?
        let smartMoneyBias: String?
        let takerPressure: String?
        let squeezeRisk: SqueezeDTO?
        let signals: [SignalDTO]?

        func toModel() -> PositioningSnapshot {
            PositioningSnapshot(
                crowding: CrowdingState(rawValue: crowding ?? "Balanced") ?? .balanced,
                fundingSentiment: fundingSentiment ?? "Neutral",
                oiTrend: OITrend(rawValue: oiTrend ?? "Stable") ?? .stable,
                smartMoneyBias: smartMoneyBias ?? "Neutral",
                takerPressure: takerPressure ?? "Balanced",
                squeezeRisk: squeezeRisk?.toModel() ?? SqueezeRisk(level: "NONE", direction: "", description: ""),
                signals: (signals ?? []).map { $0.toModel() }
            )
        }
    }

    private struct SqueezeDTO: Decodable {
        let level: String?
        let direction: String?
        func toModel() -> SqueezeRisk { SqueezeRisk(level: level ?? "NONE", direction: direction ?? "", description: "") }
    }

    private struct SignalDTO: Decodable {
        let strength: String?
        let message: String?
        func toModel() -> PositioningSignal { PositioningSignal(strength: strength ?? "", message: message ?? "") }
    }

    private struct SpotDTO: Decodable {
        let takerBuyRatio: Double?
        let takerBuyLabel: String?
        let cvd24h: Double?
        let cvdTrend: String?
        let bookRatio: Double?
        let bookLabel: String?
        func toModel() -> SpotPressure {
            SpotPressure(takerBuyRatio: takerBuyRatio ?? 0.5,
                         takerBuyLabel: takerBuyLabel ?? "Neutral",
                         cvd24h: cvd24h ?? 0,
                         cvdTrend: cvdTrend ?? "Flat",
                         bookRatio: bookRatio,
                         bookLabel: bookLabel)
        }
    }

    /// Worker sentiment is the 4 fields the prompt prints; the rest of `CoinInfo` (price/ath/caps)
    /// isn't carried — defaulted (display reads the percentage-change fields).
    private struct SentimentDTO: Decodable {
        let athChangePercentage: Double?
        let priceChangePercentage24h: Double?
        let priceChangePercentage7d: Double?
        let priceChangePercentage30d: Double?
        func toModel() -> CoinInfo {
            CoinInfo(currentPrice: 0, ath: 0,
                     athChangePercentage: athChangePercentage ?? 0,
                     athDate: "", marketCap: 0, totalVolume: 0,
                     priceChange24h: nil,
                     priceChangePercentage24h: priceChangePercentage24h,
                     priceChangePercentage7d: priceChangePercentage7d,
                     priceChangePercentage14d: nil,
                     priceChangePercentage30d: priceChangePercentage30d,
                     high24h: 0, low24h: 0)
        }
    }

    private struct FearGreedDTO: Decodable {
        let value: Int?
        let label: String?
        func toModel() -> FearGreedIndex { FearGreedIndex(value: value ?? 50, classification: label ?? "Neutral") }
    }

    private struct MacroDTO: Decodable {
        let vix: Double?
        let treasury10Y: Double?
        let treasury2Y: Double?
        let yieldSpread: Double?
        let fedFundsRate: Double?
        let usdIndex: Double?
        let macroRegime: String?
        func toModel() -> MacroSnapshot {
            MacroSnapshot(vix: vix, vixDate: nil, treasury10Y: treasury10Y, treasury2Y: treasury2Y,
                          yieldSpread: yieldSpread, fedFundsRate: fedFundsRate, usdIndex: usdIndex,
                          macroRegime: macroRegime, timestamp: Date())
        }
    }
}
