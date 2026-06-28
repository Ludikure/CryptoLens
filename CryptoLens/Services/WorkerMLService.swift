import Foundation

/// Fetches ML probability + features from the Cloudflare Worker `/ml-predict` endpoint.
/// The worker is the single source of truth for displayed ML; notifications (worker cron)
/// and in-app display stay in sync feature-for-feature.
///
/// Cache semantics: worker returns the latest cron-cached prediction (TTL 5 min, written
/// every minute for any symbol in any device's watchlist). A 404 means no cron has run
/// for this symbol yet — the UI shows "—" and retries on the next refresh.
enum WorkerMLService {

    struct BigMove: Decodable {
        let prob: Double         // calibrated P(>= 4 ATR move in 24h)
        let bucket: String       // "HIGH" / "ELEVATED" / "NORMAL"
        let multiple: Double     // prob ÷ base rate (the "1.7x normal" the UI shows)
    }

    struct Prediction {
        let probability: Double              // 24h@1.5 ATR — trade-quality gate
        let probabilityH72: Double?          // 72h@2.5 ATR — runner-hold persistence
        let bigMove: BigMove?                // tail head: outsized-move risk (crypto-only)
        let timestamp: Date
        let isCrypto: Bool
        // Phase 1/2 additive heads (crypto-only; nil otherwise). See PLAN_OUTCOMES.md.
        let probabilityMeta: Double?         // P(triple-barrier win | metaDirection)
        let q75: Double?                     // predicted q75 of fwdMaxFavR (ATR) → adaptive TP2
        let confident: Bool?                 // conformal abstention gate
        let metaDirection: Int?              // +1/-1/0 the meta head was conditioned on
        let pUp: Double?                     // direction model: calibrated P(up in 24h)
    }

    enum FetchError: Error {
        case missingURL
        case notFound
        case unauthorized
        case http(Int)
        case decode
    }

    /// Fetch the latest cached probability for `symbol`. Throws `.notFound` if the worker
    /// has no cached prediction yet (caller falls back to local).
    static func predict(symbol: String) async throws -> Prediction {
        // /ml-predict is auth-gated. ensureAuth() obtains a token if we have none.
        await PushService.ensureAuth()
        do {
            return try await fetchPrediction(symbol: symbol)
        } catch FetchError.unauthorized {
            // Stale/orphaned token (e.g. keychain survived a reinstall but the device row is
            // gone → the worker 401s). Clear it, rotate to a fresh deviceId, re-register, and
            // retry once so the ML score self-heals instead of staying blank forever.
            await PushService.handleAuthFailure()
            return try await fetchPrediction(symbol: symbol)
        }
    }

    private static func fetchPrediction(symbol: String) async throws -> Prediction {
        guard var components = URLComponents(string: "\(PushService.workerURL)/ml-predict") else {
            throw FetchError.missingURL
        }
        components.queryItems = [URLQueryItem(name: "symbol", value: symbol)]
        guard let url = components.url else { throw FetchError.missingURL }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 5
        PushService.addAuthHeaders(&request)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw FetchError.http(0) }
        if http.statusCode == 404 { throw FetchError.notFound }
        if http.statusCode == 401 { throw FetchError.unauthorized }
        guard (200..<300).contains(http.statusCode) else { throw FetchError.http(http.statusCode) }

        struct Body: Decodable {
            let probability: Double
            let probabilityH72: Double?
            let bigMove: BigMove?
            let timestamp: TimeInterval
            let isCrypto: Bool
            let probabilityMeta: Double?
            let q75: Double?
            let confident: Bool?
            let metaDirection: Int?
            let pUp: Double?
        }
        guard let body = try? JSONDecoder().decode(Body.self, from: data) else {
            throw FetchError.decode
        }
        return Prediction(
            probability: body.probability,
            probabilityH72: body.probabilityH72,
            bigMove: body.bigMove,
            timestamp: Date(timeIntervalSince1970: body.timestamp / 1000),
            isCrypto: body.isCrypto,
            probabilityMeta: body.probabilityMeta,
            q75: body.q75,
            confident: body.confident,
            metaDirection: body.metaDirection,
            pUp: body.pUp
        )
    }
}
