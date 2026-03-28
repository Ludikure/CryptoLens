import Foundation

class DerivativesService {
    private let session: URLSession
    private let binanceURL = "https://fapi.binance.com"
    private let bybitURL = "https://api.bybit.com"

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        session = URLSession(configuration: config)
    }

    func fetchDerivativesData(symbol: String) async -> DerivativesData? {
        let sym = symbol.uppercased()

        // Try Binance first, fall back to Bybit if geo-blocked
        if let data = await fetchFromBinance(symbol: sym) {
            return data
        }
        print("[MarketScope] Binance Futures unavailable, trying Bybit...")
        return await fetchFromBybit(symbol: sym)
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
            oiHistory: parseBinanceOIHistory(oih, markPrice: mp),
            globalLS: parseBinanceLS(gls),
            topTraderLS: parseBinanceLS(ttls),
            takerData: parseBinanceTaker(tr)
        )
    }

    // MARK: - Bybit Fallback

    private func fetchFromBybit(symbol: String) async -> DerivativesData? {
        // Bybit v5 API — all data from tickers + separate endpoints
        async let ticker = fetchJSON("\(bybitURL)/v5/market/tickers?category=linear&symbol=\(symbol)")
        async let oiHistory = fetchJSON("\(bybitURL)/v5/market/open-interest?category=linear&symbol=\(symbol)&intervalTime=4h&limit=6")
        async let lsRatio = fetchJSON("\(bybitURL)/v5/market/account-ratio?category=linear&symbol=\(symbol)&period=1h&limit=1")

        let (tickerResp, oiResp, lsResp) = await (ticker, oiHistory, lsRatio)

        // Parse ticker
        guard let tickerResp = tickerResp,
              let result = tickerResp["result"] as? [String: Any],
              let list = result["list"] as? [[String: Any]],
              let t = list.first,
              let frStr = t["fundingRate"] as? String, let fr = Double(frStr),
              let mpStr = t["markPrice"] as? String, let mp = Double(mpStr),
              let ipStr = t["indexPrice"] as? String, let ip = Double(ipStr),
              let oiStr = t["openInterest"] as? String, let oiVal = Double(oiStr)
        else { return nil }

        // OI history
        var oiChange4h: Double? = nil
        var oiChange24h: Double? = nil
        if let oiResp = oiResp,
           let oiResult = oiResp["result"] as? [String: Any],
           let oiList = oiResult["list"] as? [[String: Any]], oiList.count >= 2 {
            // Bybit returns newest first
            if let latestStr = oiList.first?["openInterest"] as? String, let latest = Double(latestStr),
               let prevStr = oiList[1]["openInterest"] as? String, let prev = Double(prevStr), prev > 0 {
                oiChange4h = ((latest - prev) / prev) * 100
            }
            if oiList.count >= 6,
               let latestStr = oiList.first?["openInterest"] as? String, let latest = Double(latestStr),
               let oldStr = oiList[5]["openInterest"] as? String, let old = Double(oldStr), old > 0 {
                oiChange24h = ((latest - old) / old) * 100
            }
        }

        // L/S ratio
        var longPct = 50.0, shortPct = 50.0
        if let lsResp = lsResp,
           let lsResult = lsResp["result"] as? [String: Any],
           let lsList = lsResult["list"] as? [[String: Any]],
           let ls = lsList.first,
           let buyStr = ls["buyRatio"] as? String, let buy = Double(buyStr),
           let sellStr = ls["sellRatio"] as? String, let sell = Double(sellStr) {
            longPct = buy * 100
            shortPct = sell * 100
        }

        let premium = ip > 0 ? ((mp - ip) / ip) * 100 : 0

        return DerivativesData(
            fundingRate: fr,
            fundingRatePercent: fr * 100,
            fundingHistory: [],
            avgFundingRate: fr,
            markPrice: mp,
            indexPrice: ip,
            markIndexPremium: premium,
            openInterest: oiVal,
            openInterestUSD: oiVal * mp,
            oiChange4h: oiChange4h,
            oiChange24h: oiChange24h,
            globalLongPercent: longPct,
            globalShortPercent: shortPct,
            topTraderLongPercent: 50, // Bybit doesn't expose top trader ratio
            topTraderShortPercent: 50,
            takerBuySellRatio: 1.0, // Not available in basic Bybit API
            takerBuyVolume: 0,
            takerSellVolume: 0
        )
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

    private func parseBinanceOIHistory(_ oih: [[String: Any]]?, markPrice: Double) -> (change4h: Double?, change24h: Double?) {
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
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return try JSONSerialization.jsonObject(with: data) as? [String: Any]
        } catch { return nil }
    }

    private func fetchJSONArray(_ urlString: String) async -> [[String: Any]]? {
        guard let url = URL(string: urlString) else { return nil }
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return try JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        } catch { return nil }
    }
}
