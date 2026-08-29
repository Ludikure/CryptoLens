import Foundation

/// Reads the policy/macro headlines the worker collects (`GET /news`) — the SAME rows that get
/// attached to the analysis prompt, from the same `fetchRecentNews` call.
///
/// Why the app shows these at all: the analysis only *mentions* a headline when it plausibly
/// explains the current tape, and it is explicitly forbidden from reaching for one otherwise
/// (post-hoc "X rose because Y" narration is the trap — catalyst proximity was measured against
/// 986 Fed releases and does NOT predict the next 24h move; see docs/research/news-catalyst-test.md).
/// That is right for the analysis and useless for answering "what is going on in the world",
/// because on a quiet day the model correctly says nothing and the feature looks broken.
///
/// So this card separates the two: what the model was TOLD (always visible here) from what the
/// model CONCLUDED (the analysis). Context, never a signal — the view says so on its face.
enum WorkerNewsService {

    struct Headline: Identifiable {
        let id = UUID()
        let source: String       // "Federal Reserve" / "CoinDesk"
        let isPrimary: Bool      // government / regulator — ranked first, marked "official"
        let ageHours: Int
        let title: String
    }

    struct Feed {
        let headlines: [Headline]
        /// A PRIMARY-source release inside the last ~12h. The analysis uses this to reframe a
        /// chase-FLAT as an entry-timing call rather than "the move is over".
        let catalystActive: Bool
        let latestPrimaryAgeH: Int?
    }

    private struct PromptView: Decodable {
        let headlines: [String]?
        let catalystActive: Bool?
        let latestPrimaryAgeH: Int?
    }
    private struct Response: Decodable { let promptView: PromptView? }

    /// The worker pre-formats each line as `[Source, official, 3h ago] Title`. Parsed back into
    /// fields here so the card can style provenance and age rather than printing the raw string.
    private static func parse(_ line: String) -> Headline {
        guard line.hasPrefix("["), let close = line.firstIndex(of: "]") else {
            return Headline(source: "", isPrimary: false, ageHours: 0, title: line)
        }
        let meta = String(line[line.index(after: line.startIndex)..<close])
        let title = String(line[line.index(after: close)...]).trimmingCharacters(in: .whitespaces)
        let parts = meta.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        let source = parts.first ?? ""
        let isPrimary = parts.contains("official")
        let age = parts.last.flatMap { Int($0.replacingOccurrences(of: "h ago", with: "").trimmingCharacters(in: .whitespaces)) } ?? 0
        return Headline(source: source, isPrimary: isPrimary, ageHours: age, title: title)
    }

    /// Best-effort: any failure returns nil and the card simply doesn't render. Headlines are
    /// context, so they must never surface an error or block anything.
    static func fetch(isCrypto: Bool) async -> Feed? {
        await PushService.ensureAuth()
        guard var comps = URLComponents(string: "\(PushService.workerURL)/news") else { return nil }
        comps.queryItems = [URLQueryItem(name: "market", value: isCrypto ? "crypto" : "stock")]
        guard let url = comps.url else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 8
        PushService.addAuthHeaders(&req)
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            let decoded = try JSONDecoder().decode(Response.self, from: data)
            guard let pv = decoded.promptView, let lines = pv.headlines, !lines.isEmpty else { return nil }
            return Feed(headlines: lines.map(parse),
                        catalystActive: pv.catalystActive ?? false,
                        latestPrimaryAgeH: pv.latestPrimaryAgeH)
        } catch {
            return nil
        }
    }
}
