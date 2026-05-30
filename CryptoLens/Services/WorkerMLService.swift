import Foundation

/// Fetches ML probability + features from the Cloudflare Worker `/ml-predict` endpoint.
/// Worker is the canonical live-serving implementation (see Phase 2 parity work);
/// callers should prefer this over the local `MLScoring.predict()` path so notifications
/// (which also run on worker cron) and in-app display stay in sync feature-for-feature.
///
/// Cache semantics: worker returns the latest cron-cached prediction (TTL 5 min, written
/// every minute for any symbol in any device's watchlist). A 404 means no cron has run
/// for this symbol yet — caller should fall back to local prediction for that bar and
/// retry on the next refresh.
enum WorkerMLService {

    struct Prediction {
        let probability: Double              // 24h@1.5 ATR — trade-quality gate
        let probabilityH72: Double?          // 72h@2.5 ATR — runner-hold persistence
        let timestamp: Date
        let isCrypto: Bool
        // Phase 1/2 additive heads (crypto-only; nil otherwise). See PLAN_OUTCOMES.md.
        let probabilityMeta: Double?         // P(triple-barrier win | metaDirection)
        let q75: Double?                     // predicted q75 of fwdMaxFavR (ATR) → adaptive TP2
        let confident: Bool?                 // conformal abstention gate
        let metaDirection: Int?              // +1/-1/0 the meta head was conditioned on
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
        // Ensure we hold a worker auth token before fetching — /ml-predict is
        // auth-gated, and unlike the AI/macro/alerts paths this one previously skipped
        // ensureAuth(), so on a fresh launch (or after a transient /register blip) the
        // ML fetch went out unauthenticated → 403 → blank ML score. ensureAuth() is a
        // no-op once a token exists and re-registers if it doesn't.
        await PushService.ensureAuth()

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
            let timestamp: TimeInterval
            let isCrypto: Bool
            let probabilityMeta: Double?
            let q75: Double?
            let confident: Bool?
            let metaDirection: Int?
        }
        guard let body = try? JSONDecoder().decode(Body.self, from: data) else {
            throw FetchError.decode
        }
        return Prediction(
            probability: body.probability,
            probabilityH72: body.probabilityH72,
            timestamp: Date(timeIntervalSince1970: body.timestamp / 1000),
            isCrypto: body.isCrypto,
            probabilityMeta: body.probabilityMeta,
            q75: body.q75,
            confident: body.confident,
            metaDirection: body.metaDirection
        )
    }
}
