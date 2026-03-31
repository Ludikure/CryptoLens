import Foundation

/// Coinbase fallback for crypto derivatives when Binance is unavailable (no VPN).
/// Uses public Coinbase International API (no auth needed).
/// Provides: funding rate, open interest, mark price. Does NOT provide L/S ratios.
class CoinbaseService {
    private let session: URLSession
    private let intlBase = "https://api.international.coinbase.com/api/v1"
    private let advancedBase = "https://api.coinbase.com/api/v3/brokerage/market"

    // Coinbase instrument IDs for major perps
    private let instrumentIds: [String: String] = [
        "BTCUSDT": "149264167780483072",  // BTC-PERP
        "ETHUSDT": "149264164756389888",  // ETH-PERP (the first instrument)
    ]

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        session = URLSession(configuration: config)
    }

    /// Fetch derivatives data from Coinbase as Binance fallback.
    /// Returns DerivativesData with L/S ratios set to 50/50 (not available from Coinbase).
    func fetchDerivativesData(symbol: String) async -> DerivativesData? {
        let sym = symbol.uppercased()

        // Get funding rate + OI from International API
        guard let instrumentId = instrumentIds[sym] else {
            #if DEBUG
            print("[MarketScope] Coinbase: no instrument mapping for \(sym)")
            #endif
            return nil
        }

        async let fundingData = fetchFunding(instrumentId: instrumentId)
        async let instrumentData = fetchInstrument(instrumentId: instrumentId)

        let funding = await fundingData
        let instrument = await instrumentData

        guard let fundingRate = funding?.fundingRate,
              let markPrice = funding?.markPrice else {
            #if DEBUG
            print("[MarketScope] Coinbase: failed to fetch funding for \(sym)")
            #endif
            return nil
        }

        let openInterest = instrument?.openInterest ?? 0
        let oiUSD = openInterest * markPrice

        #if DEBUG
        print("[MarketScope] Coinbase derivatives: OK (funding: \(fundingRate), OI: \(openInterest) coins, mark: \(markPrice))")
        #endif

        return DerivativesData(
            fundingRate: fundingRate,
            fundingRatePercent: fundingRate * 100,
            fundingHistory: [],
            avgFundingRate: fundingRate,
            markPrice: markPrice,
            indexPrice: markPrice,  // Coinbase doesn't separate mark/index in this endpoint
            markIndexPremium: 0,
            openInterest: openInterest,
            openInterestUSD: oiUSD,
            oiChange4h: nil,
            oiChange24h: nil,
            globalLongPercent: 50,       // Not available from Coinbase
            globalShortPercent: 50,
            topTraderLongPercent: 50,
            topTraderShortPercent: 50,
            takerBuySellRatio: 1.0,
            takerBuyVolume: 0,
            takerSellVolume: 0
        )
    }

    // MARK: - Funding Rate

    private struct FundingResult {
        let fundingRate: Double
        let markPrice: Double
    }

    private func fetchFunding(instrumentId: String) async -> FundingResult? {
        guard let url = URL(string: "\(intlBase)/instruments/\(instrumentId)/funding?result_limit=1") else { return nil }
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { return nil }
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let results = json["results"] as? [[String: Any]],
                  let latest = results.first,
                  let frStr = latest["funding_rate"] as? String, let fr = Double(frStr),
                  let mpStr = latest["mark_price"] as? String, let mp = Double(mpStr)
            else { return nil }
            return FundingResult(fundingRate: fr, markPrice: mp)
        } catch { return nil }
    }

    // MARK: - Open Interest (from instruments list)

    private struct InstrumentResult {
        let openInterest: Double
    }

    private func fetchInstrument(instrumentId: String) async -> InstrumentResult? {
        guard let url = URL(string: "\(intlBase)/instruments") else { return nil }
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { return nil }
            guard let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }

            guard let match = arr.first(where: { "\($0["instrument_id"] ?? "")" == instrumentId }),
                  let oiStr = match["open_interest"] as? String, let oi = Double(oiStr)
            else { return nil }

            return InstrumentResult(openInterest: oi)
        } catch { return nil }
    }
}
