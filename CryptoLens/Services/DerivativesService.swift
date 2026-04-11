import Foundation

class DerivativesService {
    private let session: URLSession
    private let binanceURL = "https://fapi.binance.com"
    private let coinbase = CoinbaseService()

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        session = URLSession(configuration: config)
    }

    func fetchDerivativesData(symbol: String) async -> DerivativesData? {
        let sym = symbol.uppercased()

        // Tier 1: Direct Binance Futures (works with VPN or non-US)
        let binanceData = await fetchFromBinance(symbol: sym)
        if let data = binanceData {
            #if DEBUG
            print("[MarketScope] Binance derivatives: OK (L/S: \(data.globalLongPercent)/\(data.globalShortPercent))")
            #endif
            return data
        }

        // Tier 2: Coinbase International (US-native, funding + OI, no L/S)
        #if DEBUG
        print("[MarketScope] Binance blocked, trying Coinbase...")
        #endif
        if let cbData = await coinbase.fetchDerivativesData(symbol: sym) {
            return cbData
        }

        // Tier 3: CoinGecko aggregated (last resort)
        #if DEBUG
        print("[MarketScope] Coinbase failed, trying CoinGecko...")
        #endif
        return await fetchFromCoinGecko(symbol: sym)
    }

    // MARK: - Binance Futures

    private func fetchFromBinance(symbol: String) async -> DerivativesData? {
        async let premiumIndex = fetchJSON("\(binanceURL)/fapi/v1/premiumIndex?symbol=\(symbol)")
        async let fundingHistory = fetchJSONArray("\(binanceURL)/fapi/v1/fundingRate?symbol=\(symbol)&limit=10")
        async let openInterest = fetchJSON("\(binanceURL)/fapi/v1/openInterest?symbol=\(symbol)")
        async let oiHistory = fetchJSONArray("\(binanceURL)/futures/data/openInterestHist?symbol=\(symbol)&period=4h&limit=6")
        async let globalLS = fetchJSONArray("\(binanceURL)/futures/data/globalLongShortAccountRatio?symbol=\(symbol)&period=1h&limit=1")
        async let topTraderLS = fetchJSONArray("\(binanceURL)/futures/data/topLongShortPositionRatio?symbol=\(symbol)&period=1h&limit=1")
        async let takerRatio = fetchJSONArray("\(binanceURL)/futures/data/takerlongshortRatio?symbol=\(symbol)&period=1h&limit=1")

        let (pi, fh, oi, oih, gls, ttls, tr) = await (premiumIndex, fundingHistory, openInterest, oiHistory, globalLS, topTraderLS, takerRatio)

        guard let pi = pi,
              let frStr = pi["lastFundingRate"] as? String, let fr = Double(frStr),
              let mpStr = pi["markPrice"] as? String, let mp = Double(mpStr),
              let ipStr = pi["indexPrice"] as? String, let ip = Double(ipStr)
        else { return nil }

        guard let oi = oi,
              let oiStr = oi["openInterest"] as? String, let oiVal = Double(oiStr)
        else { return nil }

        return buildResult(
            fundingRate: fr, markPrice: mp, indexPrice: ip, openInterest: oiVal,
            fundingHistory: parseBinanceFundingHistory(fh),
            oiHistory: parseBinanceOIHistory(oih),
            globalLS: parseBinanceLS(gls),
            topTraderLS: parseBinanceLS(ttls),
            takerData: parseBinanceTaker(tr)
        )
    }

    // MARK: - CoinGecko Fallback (works from US)

    private func fetchFromCoinGecko(symbol: String) async -> DerivativesData? {
        // CoinGecko derivatives endpoint — aggregates from Binance Futures
        guard let url = URL(string: "https://api.coingecko.com/api/v3/derivatives?include_tickers=unexpired") else { return nil }
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                #if DEBUG
                print("[MarketScope] CoinGecko derivatives: HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
                #endif
                return nil
            }
            guard let array = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }

            // Find the BTCUSDT perpetual on Binance Futures
            let ticker = symbol.replacingOccurrences(of: "USDT", with: "").uppercased() + "USDT"
            guard let match = array.first(where: {
                ($0["symbol"] as? String)?.uppercased() == ticker &&
                ($0["market"] as? String)?.lowercased().contains("binance") == true &&
                ($0["contract_type"] as? String) == "perpetual"
            }) else {
                #if DEBUG
                print("[MarketScope] CoinGecko: no match for \(ticker)")
                #endif
                return nil
            }

            let price = match["price"] as? Double ?? 0
            let indexPrice = match["index"] as? Double ?? price
            let fundingRate = match["funding_rate"] as? Double ?? 0
            let openInterestUSD = match["open_interest"] as? Double ?? 0
            let openInterest = price > 0 ? openInterestUSD / price : 0

            let premium = indexPrice > 0 ? ((price - indexPrice) / indexPrice) * 100 : 0

            #if DEBUG
            print("[MarketScope] CoinGecko derivatives: OK (funding: \(fundingRate), OI: $\(Int(openInterestUSD)))")
            #endif

            return DerivativesData(
                fundingRate: fundingRate / 100, // CoinGecko returns as percentage
                fundingRatePercent: fundingRate,
                fundingHistory: [],
                avgFundingRate: fundingRate / 100,
                markPrice: price,
                indexPrice: indexPrice,
                markIndexPremium: premium,
                openInterest: openInterest,
                openInterestUSD: openInterestUSD,
                oiChange4h: nil,
                oiChange24h: nil,
                globalLongPercent: 50, // Not available from CoinGecko
                globalShortPercent: 50,
                topTraderLongPercent: 50,
                topTraderShortPercent: 50,
                takerBuySellRatio: 1.0,
                takerBuyVolume: 0,
                takerSellVolume: 0
            )
        } catch {
            #if DEBUG
            print("[MarketScope] CoinGecko derivatives error: \(error.localizedDescription)")
            #endif
            return nil
        }
    }

    // MARK: - Binance Parsers

    private func parseBinanceFundingHistory(_ fh: [[String: Any]]?) -> [FundingEntry] {
        guard let fh = fh else { return [] }
        return fh.compactMap { entry in
            guard let rateStr = entry["fundingRate"] as? String, let rate = Double(rateStr),
                  let time = entry["fundingTime"] as? Double
            else { return nil }
            return FundingEntry(fundingRate: rate, fundingTime: Date(timeIntervalSince1970: time / 1000))
        }
    }

    private func parseBinanceOIHistory(_ oih: [[String: Any]]?) -> (change4h: Double?, change24h: Double?) {
        guard let oih = oih, oih.count >= 2 else { return (nil, nil) }
        var change4h: Double? = nil
        var change24h: Double? = nil
        if let latestStr = oih.last?["sumOpenInterest"] as? String, let latest = Double(latestStr),
           let prevStr = oih[oih.count - 2]["sumOpenInterest"] as? String, let prev = Double(prevStr), prev > 0 {
            change4h = ((latest - prev) / prev) * 100
        }
        if oih.count >= 6,
           let latestStr = oih.last?["sumOpenInterest"] as? String, let latest = Double(latestStr),
           let firstStr = oih.first?["sumOpenInterest"] as? String, let first = Double(firstStr), first > 0 {
            change24h = ((latest - first) / first) * 100
        }
        return (change4h, change24h)
    }

    private func parseBinanceLS(_ data: [[String: Any]]?) -> (long: Double, short: Double) {
        guard let data = data, let first = data.first,
              let longStr = first["longAccount"] as? String, let l = Double(longStr),
              let shortStr = first["shortAccount"] as? String, let s = Double(shortStr)
        else { return (50, 50) }
        return (l * 100, s * 100)
    }

    private func parseBinanceTaker(_ data: [[String: Any]]?) -> (ratio: Double, buy: Double, sell: Double) {
        guard let data = data, let first = data.first,
              let ratioStr = first["buySellRatio"] as? String, let ratio = Double(ratioStr),
              let buyStr = first["buyVol"] as? String, let buy = Double(buyStr),
              let sellStr = first["sellVol"] as? String, let sell = Double(sellStr)
        else { return (1.0, 0, 0) }
        return (ratio, buy, sell)
    }

    // MARK: - Builder

    private func buildResult(fundingRate: Double, markPrice: Double, indexPrice: Double, openInterest: Double,
                             fundingHistory: [FundingEntry], oiHistory: (change4h: Double?, change24h: Double?),
                             globalLS: (long: Double, short: Double), topTraderLS: (long: Double, short: Double),
                             takerData: (ratio: Double, buy: Double, sell: Double)) -> DerivativesData {
        let premium = indexPrice > 0 ? ((markPrice - indexPrice) / indexPrice) * 100 : 0
        let avgFR = fundingHistory.isEmpty ? fundingRate : fundingHistory.reduce(0) { $0 + $1.fundingRate } / Double(fundingHistory.count)

        return DerivativesData(
            fundingRate: fundingRate,
            fundingRatePercent: fundingRate * 100,
            fundingHistory: fundingHistory,
            avgFundingRate: avgFR,
            markPrice: markPrice,
            indexPrice: indexPrice,
            markIndexPremium: premium,
            openInterest: openInterest,
            openInterestUSD: openInterest * markPrice,
            oiChange4h: oiHistory.change4h,
            oiChange24h: oiHistory.change24h,
            globalLongPercent: globalLS.long,
            globalShortPercent: globalLS.short,
            topTraderLongPercent: topTraderLS.long,
            topTraderShortPercent: topTraderLS.short,
            takerBuySellRatio: takerData.ratio,
            takerBuyVolume: takerData.buy,
            takerSellVolume: takerData.sell
        )
    }

    // MARK: - Network

    private func fetchJSON(_ urlString: String) async -> [String: Any]? {
        guard let url = URL(string: urlString) else { return nil }
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse else { return nil }
            guard http.statusCode == 200 else {
                #if DEBUG
                print("[MarketScope] HTTP \(http.statusCode) for \(url.host ?? "")\(url.path)")
                #endif
                return nil
            }
            return try JSONSerialization.jsonObject(with: data) as? [String: Any]
        } catch {
            #if DEBUG
            print("[MarketScope] Network error for \(url.host ?? ""): \(error.localizedDescription)")
            #endif
            return nil
        }
    }

    private func fetchJSONArray(_ urlString: String) async -> [[String: Any]]? {
        guard let url = URL(string: urlString) else { return nil }
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse else { return nil }
            guard http.statusCode == 200 else {
                #if DEBUG
                print("[MarketScope] HTTP \(http.statusCode) for \(url.host ?? "")\(url.path)")
                #endif
                return nil
            }
            return try JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        } catch {
            #if DEBUG
            print("[MarketScope] Network error for \(url.host ?? ""): \(error.localizedDescription)")
            #endif
            return nil
        }
    }
}
