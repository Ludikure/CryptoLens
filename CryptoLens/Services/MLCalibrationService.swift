import Foundation

/// Fetches the live calibration of the ML *quality* model from `/ml-calibration`. The worker
/// samples predictions and grades them against realized goodR (≥1.5 ATR move in 24h, the
/// model's direction-agnostic target). This is the companion to the direction scoreboard:
/// it answers "are predicted-70% bars actually hitting ~70% in the wild, or has the model
/// drifted?" — the one thing that tells us the core gate is still honest. Builds over time.
enum MLCalibrationService {

    struct Bucket: Identifiable {
        let label: String        // "70-85", "60-70", …
        let n: Int
        let predicted: Double    // mean predicted prob in bucket, %
        let realized: Double     // realized goodR rate, %
        var id: String { label }
        var gap: Double { realized - predicted }
    }

    struct Report {
        let buckets: [Bucket]
        let resolved: Int
        let pending: Int
    }

    static func fetch() async -> Report? {
        guard let url = URL(string: "\(PushService.workerURL)/ml-calibration") else { return nil }
        await PushService.ensureAuth()
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 8
        PushService.addAuthHeaders(&request)

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
        else { return nil }

        struct Body: Decodable {
            struct B: Decodable { let bucket: String; let n: Int; let predicted: Double?; let realized: Double? }
            let buckets: [B]
            let resolved: Int
            let pending: Int
        }
        guard let body = try? JSONDecoder().decode(Body.self, from: data) else { return nil }
        let buckets = body.buckets.map {
            Bucket(label: $0.bucket, n: $0.n, predicted: $0.predicted ?? 0, realized: $0.realized ?? 0)
        }
        return Report(buckets: buckets, resolved: body.resolved, pending: body.pending)
    }
}
