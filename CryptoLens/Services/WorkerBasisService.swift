import Foundation

/// Reads the cash-and-carry monitor (`GET /basis`) — live Coinbase dated nano-futures basis vs spot.
///
/// **Why this exists at all.** Across ~20 pre-declared tests (see `docs/research/what-we-tried.md`)
/// the carry is the ONLY mechanism that survived, and it survived precisely because it needs no
/// directional forecast: the future must converge to spot at expiry by contract, so the gap closes
/// whatever price does. Everything else tested required predicting direction, which measures as a
/// coin flip at every horizon from 4 hours to 30 days.
///
/// **Why it needs monitoring rather than assuming.** The carry ranges from ~4% annualised in bear
/// regimes to 30-40%+ in leverage manias, and is NEGATIVE about 14% of the time. The hard part is
/// noticing when it pays, which is exactly what a screen can do and memory cannot.
///
/// **The caveat the card carries on its face:** only the COVERED form works — selling futures
/// against BTC already held. Buying the spot leg to run it costs ~0.40-0.60% per side at Coinbase
/// retail tiers against a ~1% basis, which consumes the entire edge. See `docs/research/funding-carry.md`.
enum WorkerBasisService {

    struct Contract: Identifiable {
        var id: String { productId }
        let productId: String
        let underlying: String
        let futuresPrice: Double
        let spotPrice: Double
        /// Raw premium of the future over spot, as a fraction (0.0107 = 1.07%).
        let basis: Double
        let daysToExpiry: Double
        /// Premium annualised by compounding — the headline rate.
        let annualized: Double
        /// Annualised AFTER the two futures legs. This is the number that decides anything;
        /// a short-dated contract can show a large gross rate and a negative net one.
        let netAnnualized: Double?
        let volume24h: Double?
        let notionalPerContract: Double
    }

    struct Snapshot {
        let contracts: [Contract]
        /// Contracts clearing the net-rate and liquidity floors, computed server-side.
        let opportunityIds: [String]
        let marginNote: String

        /// The contract worth acting on, if any: best NET rate among those the server flagged.
        var best: Contract? {
            contracts.filter { opportunityIds.contains($0.productId) }
                     .max { ($0.netAnnualized ?? -1) < ($1.netAnnualized ?? -1) }
        }
    }

    /// Best-effort. Any failure returns nil and the card hides itself rather than showing an error —
    /// this is context, and a broken context panel is worse than an absent one.
    static func fetch() async -> Snapshot? {
        await PushService.ensureAuth()
        guard let comps = URLComponents(string: "\(PushService.workerURL)/basis"),
              let url = comps.url else { return nil }

        var req = URLRequest(url: url)
        req.timeoutInterval = 12
        PushService.addAuthHeaders(&req)

        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

            let rawContracts = root["contracts"] as? [[String: Any]] ?? []
            let contracts: [Contract] = rawContracts.compactMap { c in
                guard let pid = c["productId"] as? String,
                      let und = c["underlying"] as? String,
                      let fp = c["futuresPrice"] as? Double,
                      let sp = c["spotPrice"] as? Double,
                      let basis = c["basis"] as? Double,
                      let days = c["daysToExpiry"] as? Double,
                      let ann = c["annualized"] as? Double else { return nil }
                return Contract(productId: pid, underlying: und, futuresPrice: fp, spotPrice: sp,
                                basis: basis, daysToExpiry: days, annualized: ann,
                                netAnnualized: c["netAnnualized"] as? Double,
                                volume24h: c["volume24h"] as? Double,
                                notionalPerContract: c["notionalPerContract"] as? Double ?? 0)
            }
            guard !contracts.isEmpty else { return nil }

            let opps = (root["opportunities"] as? [[String: Any]] ?? [])
                .compactMap { $0["productId"] as? String }
            return Snapshot(contracts: contracts, opportunityIds: opps,
                            marginNote: root["marginNote"] as? String ?? "")
        } catch {
            return nil
        }
    }
}
