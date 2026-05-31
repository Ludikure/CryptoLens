import Foundation

/// Fetches the live forward track record of the dual-gate direction model from the
/// worker `/direction-accuracy` endpoint. The worker cron logs every dual-gate signal
/// (ML Win ≥ 70% AND direction model ≥ 70% confident) across the whole crypto universe
/// and grades it 24h later against the realized price — so this is an out-of-sample,
/// forward measurement of the backtest's ~94.7% claim, accumulating autonomously
/// whether or not the app is open.
enum DirectionAccuracyService {

    struct Report {
        let resolved: Int          // graded signals
        let accuracy: Double?       // overall % correct (nil until first resolution)
        let longs: Int
        let shorts: Int
        let pending: Int            // logged but not yet 24h old
        let backtestBaseline: Double
        let byConfidence: [ConfidenceBand]
        let longSide: SideStats?    // graded long signals (nil until at least one resolves)
        let shortSide: SideStats?   // graded short signals
        let recent: [Signal]
    }

    /// Accuracy of one predicted side, graded independently. Directional models can be
    /// lopsided (one side near-perfect, the other near chance) — pooling hides that.
    struct SideStats {
        let n: Int
        let accuracy: Double
    }

    struct ConfidenceBand: Identifiable {
        let band: String            // "90+", "80-90", "70-80"
        let n: Int
        let accuracy: Double
        var id: String { band }
    }

    struct Signal: Identifiable {
        let symbol: String
        let firedAt: Date
        let pUp: Double
        let predictedDir: Int       // +1 long / -1 short
        let mlWin: Double
        let fwdReturn: Double
        let correct: Bool
        var id: String { "\(symbol)-\(firedAt.timeIntervalSince1970)" }
    }

    static func fetch() async -> Report? {
        guard let url = URL(string: "\(PushService.workerURL)/direction-accuracy") else { return nil }
        await PushService.ensureAuth()
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 8
        PushService.addAuthHeaders(&request)

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
        else { return nil }

        struct Body: Decodable {
            struct Overall: Decodable { let resolved: Int?; let accuracy: Double?; let longs: Int?; let shorts: Int? }
            struct Band: Decodable { let band: String; let n: Int; let accuracy: Double? }
            struct Dir: Decodable { let predicted_dir: Int; let n: Int; let accuracy: Double? }
            struct Recent: Decodable {
                let symbol: String; let fired_at: Double; let p_up: Double
                let predicted_dir: Int; let ml_win: Double; let fwd_return: Double?; let correct: Int?
            }
            let overall: Overall
            let byConfidence: [Band]
            let byDirection: [Dir]?
            let pending: Int
            let recent: [Recent]
            let backtestBaseline: Double
        }
        guard let body = try? JSONDecoder().decode(Body.self, from: data) else { return nil }

        func side(_ dir: Int) -> SideStats? {
            guard let d = body.byDirection?.first(where: { $0.predicted_dir == dir }) else { return nil }
            return SideStats(n: d.n, accuracy: d.accuracy ?? 0)
        }

        return Report(
            resolved: body.overall.resolved ?? 0,
            accuracy: body.overall.accuracy,
            longs: body.overall.longs ?? 0,
            shorts: body.overall.shorts ?? 0,
            pending: body.pending,
            backtestBaseline: body.backtestBaseline,
            byConfidence: body.byConfidence.map {
                ConfidenceBand(band: $0.band, n: $0.n, accuracy: $0.accuracy ?? 0)
            },
            longSide: side(1),
            shortSide: side(-1),
            recent: body.recent.map {
                Signal(symbol: $0.symbol,
                       firedAt: Date(timeIntervalSince1970: $0.fired_at / 1000),
                       pUp: $0.p_up, predictedDir: $0.predicted_dir, mlWin: $0.ml_win,
                       fwdReturn: $0.fwd_return ?? 0, correct: ($0.correct ?? 0) == 1)
            }
        )
    }
}
