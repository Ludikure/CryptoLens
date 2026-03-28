import Foundation

class DerivativesService {
    private let baseURL = "https://fapi.binance.com"
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 15
        session = URLSession(configuration: config)
    }

    func fetchDerivativesData(symbol: String) async -> DerivativesData? {
        let uppercased = symbol.uppercased()

        async let premiumIndex = fetchJSON("\(baseURL)/fapi/v1/premiumIndex?symbol=\(uppercased)")
        async let fundingHistory = fetchJSONArray("\(baseURL)/fapi/v1/fundingRate?symbol=\(uppercased)&limit=10")
        async let openInterest = fetchJSON("\(baseURL)/fapi/v1/openInterest?symbol=\(uppercased)")
        async let oiHistory = fetchJSONArray("\(baseURL)/futures/data/openInterestHist?symbol=\(uppercased)&period=4h&limit=6")
        async let globalLS = fetchJSONArray("\(baseURL)/futures/data/globalLongShortAccountRatio?symbol=\(uppercased)&period=1h&limit=1")
        async let topTraderLS = fetchJSONArray("\(baseURL)/futures/data/topLongShortPositionRatio?symbol=\(uppercased)&period=1h&limit=1")
        async let takerRatio = fetchJSONArray("\(baseURL)/futures/data/takerlongshortRatio?symbol=\(uppercased)&period=1h&limit=1")

        let (pi, fh, oi, oih, gls, ttls, tr) = await (premiumIndex, fundingHistory, openInterest, oiHistory, globalLS, topTraderLS, takerRatio)

        // Premium index (required)
        guard let pi = pi,
              let lastFundingRateStr = pi["lastFundingRate"] as? String,
              let lastFundingRate = Double(lastFundingRateStr),
              let markPriceStr = pi["markPrice"] as? String,
              let markPrice = Double(markPriceStr),
              let indexPriceStr = pi["indexPrice"] as? String,
              let indexPrice = Double(indexPriceStr)
        else { return nil }

        let fundingRatePercent = lastFundingRate * 100

        // Mark/index premium
        let markIndexPremium: Double
        if indexPrice > 0 {
            markIndexPremium = ((markPrice - indexPrice) / indexPrice) * 100
        } else {
            markIndexPremium = 0
        }

        // Funding history
        var fundingEntries: [FundingEntry] = []
        if let fh = fh {
            for entry in fh {
                if let rateStr = entry["fundingRate"] as? String,
                   let rate = Double(rateStr),
                   let timeVal = entry["fundingTime"] as? Double {
                    let date = Date(timeIntervalSince1970: timeVal / 1000)
                    fundingEntries.append(FundingEntry(fundingRate: rate, fundingTime: date))
                }
            }
        }

        let avgFundingRate: Double
        if fundingEntries.isEmpty {
            avgFundingRate = lastFundingRate
        } else {
            avgFundingRate = fundingEntries.reduce(0) { $0 + $1.fundingRate } / Double(fundingEntries.count)
        }

        // Open interest (required)
        guard let oi = oi,
              let oiStr = oi["openInterest"] as? String,
              let openInterestVal = Double(oiStr)
        else { return nil }

        let openInterestUSD = openInterestVal * markPrice

        // OI change
        var oiChange4h: Double? = nil
        var oiChange24h: Double? = nil
        if let oih = oih, oih.count >= 2 {
            if let latestStr = (oih.last?["sumOpenInterest"] as? String),
               let latest = Double(latestStr),
               let firstStr = (oih.first?["sumOpenInterest"] as? String),
               let first = Double(firstStr),
               first > 0 {
                // 4h change: latest vs second to last
                if oih.count >= 2,
                   let prevStr = (oih[oih.count - 2]["sumOpenInterest"] as? String),
                   let prev = Double(prevStr),
                   prev > 0 {
                    oiChange4h = ((latest - prev) / prev) * 100
                }
                // 24h change: latest vs first (6 entries * 4h = 24h)
                if oih.count >= 6 {
                    oiChange24h = ((latest - first) / first) * 100
                }
            }
        }

        // Global L/S
        var globalLongPercent = 50.0
        var globalShortPercent = 50.0
        if let gls = gls, let first = gls.first,
           let longStr = first["longAccount"] as? String,
           let shortStr = first["shortAccount"] as? String,
           let longVal = Double(longStr),
           let shortVal = Double(shortStr) {
            globalLongPercent = longVal * 100
            globalShortPercent = shortVal * 100
        }

        // Top trader L/S
        var topTraderLongPercent = 50.0
        var topTraderShortPercent = 50.0
        if let ttls = ttls, let first = ttls.first,
           let longStr = first["longAccount"] as? String,
           let shortStr = first["shortAccount"] as? String,
           let longVal = Double(longStr),
           let shortVal = Double(shortStr) {
            topTraderLongPercent = longVal * 100
            topTraderShortPercent = shortVal * 100
        }

        // Taker buy/sell
        var takerBuySellRatio = 1.0
        var takerBuyVolume = 0.0
        var takerSellVolume = 0.0
        if let tr = tr, let first = tr.first,
           let ratioStr = first["buySellRatio"] as? String,
           let ratio = Double(ratioStr),
           let buyStr = first["buyVol"] as? String,
           let buy = Double(buyStr),
           let sellStr = first["sellVol"] as? String,
           let sell = Double(sellStr) {
            takerBuySellRatio = ratio
            takerBuyVolume = buy
            takerSellVolume = sell
        }

        return DerivativesData(
            fundingRate: lastFundingRate,
            fundingRatePercent: fundingRatePercent,
            fundingHistory: fundingEntries,
            avgFundingRate: avgFundingRate,
            markPrice: markPrice,
            indexPrice: indexPrice,
            markIndexPremium: markIndexPremium,
            openInterest: openInterestVal,
            openInterestUSD: openInterestUSD,
            oiChange4h: oiChange4h,
            oiChange24h: oiChange24h,
            globalLongPercent: globalLongPercent,
            globalShortPercent: globalShortPercent,
            topTraderLongPercent: topTraderLongPercent,
            topTraderShortPercent: topTraderShortPercent,
            takerBuySellRatio: takerBuySellRatio,
            takerBuyVolume: takerBuyVolume,
            takerSellVolume: takerSellVolume
        )
    }

    // MARK: - Network Helpers

    private func fetchJSON(_ urlString: String) async -> [String: Any]? {
        guard let url = URL(string: urlString) else { return nil }
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return try JSONSerialization.jsonObject(with: data) as? [String: Any]
        } catch {
            return nil
        }
    }

    private func fetchJSONArray(_ urlString: String) async -> [[String: Any]]? {
        guard let url = URL(string: urlString) else { return nil }
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            return try JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        } catch {
            return nil
        }
    }
}
