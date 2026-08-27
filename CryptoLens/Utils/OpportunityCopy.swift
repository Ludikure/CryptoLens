import Foundation

/// Plain-English copy for the Opportunities screen.
///
/// A screen that needs a legend is not intuitive, so both of the things that would need one
/// are handled here rather than at each call site.
///
/// Design source: `design/trade-opportunities/COPY.md`.
///
/// WHAT THE ENDPOINT ACTUALLY EMITS — verified against the worker, because a first pass at
/// this file translated tokens from the wrong surface and every lookup missed:
///
///   `bindingConstraints` (src/trading/sizing.ts) are ALREADY readable — "max risk per trade",
///   "asset concentration", "correlated exposure". The one exception is the crash overlay,
///   emitted at sizing.ts:138 as `crash ELEVATED ×0.72` — regime word in the middle, a real
///   multiplication sign, space-separated.
///
///   `skipped[].reasons` are mostly readable too. The one that is not is the envelope list,
///   emitted at index.ts:2642 as ONE string: `analysis says stand aside: a, b, c`. Every
///   envelope token is inside that string, so it must be unpacked before anything is
///   translated — a `^`-anchored match against the whole string can never fire.
enum OpportunityCopy {

    // MARK: - Reason strings

    /// The prefix `index.ts:2642` puts in front of the comma-joined envelope list.
    private static let standAsidePrefix = "analysis says stand aside: "

    /// Envelope reasons, exact match.
    ///
    /// Deliberately short. `envelopePrecheck` returns the `auto_FLAT_active` list ONLY, so no
    /// `highBlocks`/`moderateBlocks` token can reach this screen, and the endpoint passes
    /// `economicEvents: []` so the macro reasons cannot fire either. Listing tokens that
    /// cannot arrive would suggest a coverage this screen does not have.
    private static let envelope: [String: String] = [
        "ANY_KILLED=true": "A kill condition fired",
        "macro_IMMINENT": "Big economic event within hours",
    ]

    /// Trading-layer strings that are readable but not friendly.
    private static let phrasing: [String: String] = [
        "no directional edge — structure is positive-EV on either side":
            "Both sides pay the same. No view.",
        "no cached prediction": "No fresh score yet",
        "vol model is crypto-only": "No volatility model for this market",
        "no volatility forecast": "Not enough history to forecast volatility",
        "no ATR in cached features": "No volatility reading",
        "missing price or ATR": "No price or volatility reading",
        "crash overlay closed the position": "Drawdown risk closed the position",
        "max risk per trade": "Capped by risk per trade",
        "max position notional": "Capped by position size",
        "asset concentration": "Capped by concentration in this asset",
        "correlated exposure": "Capped by correlated exposure",
        "portfolio notional": "Capped by total portfolio size",
    ]

    private static let mlFloor = try! NSRegularExpression(
        pattern: #"^ML_WIN_(\d+)%_below_live_floor_(\d+)%$"#)
    private static let mlUnder = try! NSRegularExpression(
        pattern: #"^ML_WIN_(\d+)%?<(\d+)"#)
    private static let crashCut = try! NSRegularExpression(
    // NB: raw string — the multiplication sign must be LITERAL. `\u{00D7}` is not
    // interpolated inside #"..."# and reaches NSRegularExpression as text, which throws.
        pattern: #"^crash\s+[A-Za-z]+\s+[×x]([0-9.]+)$"#)
    private static let volBars = try! NSRegularExpression(
        pattern: #"^need (\d+) 1h bars.*got (\d+)$"#)
    /// `generator.ts:buildSide` — "LONG: non-positive expected value (-0.082R)". The most common
    /// reason on the whole screen, since it is what a refused LONG head produces on every asset.
    private static let sideEv = try! NSRegularExpression(
        pattern: #"^(LONG|SHORT): non-positive expected value \(([-0-9.]+)R\)$"#)
    /// `generator.ts:buildSide` — "LONG: stop inside the noise band (P=52%)".
    private static let noiseStop = try! NSRegularExpression(
        pattern: #"^(LONG|SHORT): stop inside the noise band \(P=(\d+)%\)$"#)

    /// Translate one reason string.
    ///
    /// Unrecognised input degrades to a de-snaked sentence rather than leaking a raw token —
    /// the envelope's reason list has grown repeatedly, and a screen that only handles today's
    /// set will leak tomorrow's.
    static func plain(_ raw: String) -> String {
        let token = raw.trimmingCharacters(in: .whitespaces)
        if let hit = envelope[token] ?? phrasing[token] { return hit }

        let range = NSRange(token.startIndex..., in: token)

        if let m = mlFloor.firstMatch(in: token, range: range), let g = groups(m, in: token), g.count == 2 {
            return "Move likelihood too low — \(g[0])%, needs \(g[1])%"
        }
        if let m = mlUnder.firstMatch(in: token, range: range), let g = groups(m, in: token), g.count == 2 {
            return "Move likelihood \(g[0])%, under \(g[1])%"
        }
        if let m = crashCut.firstMatch(in: token, range: range), let g = groups(m, in: token),
           let mult = Double(g[0]), mult < 1 {
            return "Size cut to \(Int((mult * 100).rounded()))% for drawdown risk"
        }
        if let m = volBars.firstMatch(in: token, range: range), let g = groups(m, in: token), g.count == 2 {
            return "Not enough history — \(g[1]) hourly bars of \(g[0])"
        }
        if let m = sideEv.firstMatch(in: token, range: range), let g = groups(m, in: token),
           g.count == 2, let r = Double(g[1]) {
            return "\(g[0].capitalized) pays \(String(format: "%+.2f", r))R after the fee"
        }
        if let m = noiseStop.firstMatch(in: token, range: range), let g = groups(m, in: token), g.count == 2 {
            return "\(g[0].capitalized) stop sits inside the noise — volatility alone reaches it \(g[1])% of the time"
        }

        return humanise(token)
    }

    /// Translate a `skipped[].reasons` array, unpacking the stand-aside list if present.
    ///
    /// This is the entry point views should call. `plain` alone is not enough: the envelope
    /// list arrives as a single prefixed, comma-joined string.
    static func plainList(_ reasons: [String]) -> [String] {
        reasons.flatMap { raw -> [String] in
            guard raw.hasPrefix(standAsidePrefix) else { return [plain(raw)] }
            return String(raw.dropFirst(standAsidePrefix.count))
                .components(separatedBy: ", ")
                .filter { !$0.isEmpty }
                .map(plain)
        }
    }

    private static func groups(_ m: NSTextCheckingResult, in s: String) -> [String]? {
        guard m.numberOfRanges > 1 else { return nil }
        var out: [String] = []
        for i in 1..<m.numberOfRanges {
            guard let r = Range(m.range(at: i), in: s) else { continue }
            out.append(String(s[r]))
        }
        return out.isEmpty ? nil : out
    }

    /// Last-resort readability for an unrecognised token.
    private static func humanise(_ token: String) -> String {
        let words = token
            .replacingOccurrences(of: "=true", with: "")
            .split(whereSeparator: { $0 == "_" || $0 == "-" })
            .map(String.init)
        guard let first = words.first, !first.isEmpty else { return token }
        let rest = words.dropFirst().map { $0.lowercased() }
        return ([first.prefix(1).uppercased() + first.dropFirst().lowercased()] + rest)
            .joined(separator: " ")
    }

    // MARK: - R in money

    /// One R in account currency — what a stopped-out trade costs.
    ///
    /// Reads the same defaults `PositionSizer` uses (registered in `CryptoLensApp.swift`), so
    /// the scanner and the size calculator cannot disagree. NOTE the key is `accountSize`;
    /// `ContentView.loadCostContext` read `account_size` and silently got 0.
    static func oneR(accountSize: Double? = nil, riskPercent: Double? = nil) -> Double {
        let account = accountSize ?? UserDefaults.standard.double(forKey: "accountSize")
        // NOTE callers on the scanner pass the worker's `structure.maxRiskPerTrade` here, because
        // that is the percentage the rows were actually sized at. Reading the local default made
        // every dollar figure disagree with the "Risk if stopped" line on the same card.
        let risk = riskPercent ?? UserDefaults.standard.double(forKey: "riskPercent")
        guard account > 0, risk > 0 else { return 0 }
        return account * risk / 100.0
    }

    /// "about +$41 a trade" — what an expected-R value is worth per trade, on average.
    ///
    /// Returns nil when account settings are missing, so the caller shows bare R rather than
    /// a fabricated figure.
    ///
    /// IMPORTANT: a mean, not a typical outcome. At this system's ~10% hit rate the shape is
    /// "lose 1R most times, occasionally win 5R". The screen states that shape once, above
    /// the rows, so the average is never read alone.
    static func money(forR r: Double, accountSize: Double? = nil, riskPercent: Double? = nil) -> String? {
        let unit = oneR(accountSize: accountSize, riskPercent: riskPercent)
        guard unit > 0 else { return nil }
        let dollars = r * unit
        return "about \(dollars >= 0 ? "+" : "−")$\(Int(abs(dollars).rounded())) a trade"
    }

    // MARK: - Mood conditioning (corrected spec §6)

    /// The market's mood, using the app's OWN Fear & Greed encoding.
    ///
    /// Bands are taken from `index.ts:3735` (`fearGreedZone`: <=20 / <=40 / <=60 / <=80 / >80)
    /// rather than invented here, so the screen and the model read the same index the same way.
    enum Mood: String {
        case fear, neutral, greed

        static func from(_ index: Double?) -> Mood? {
            guard let v = index, v.isFinite, v > 0 else { return nil }
            if v <= 40 { return .fear }
            if v <= 60 { return .neutral }
            return .greed
        }

        var label: String {
            switch self {
            case .fear: return "Fear"
            case .neutral: return "Neutral"
            case .greed: return "Greed"
            }
        }

        /// Measured SHORT net R per opportunity in this mood — **at ML >= 0.55, not in general**.
        ///
        /// A5 in the spec corrections: these were published as unconditional short expectancy when
        /// they are conditioned on the ML floor. Anything rendering them must say so, and every
        /// caller below does.
        var shortNetR: Double {
            switch self {
            case .fear: return 0.0616
            case .neutral: return 0.1437
            case .greed: return -0.0467
            }
        }

        /// The one mood where the measured short edge is NEGATIVE. §6: do not present it as
        /// available here — which the screen honours by refusing to let the answer line call a
        /// short "clearing the floor" without saying this in the same breath.
        var shortEdgeAbsent: Bool { self == .greed }

        /// One sentence, always carrying the ML condition the numbers were measured under.
        var sentence: String {
            let r = String(format: "%+.2fR", shortNetR)
            switch self {
            case .greed:
                return "Greed \u{2014} the one mood where the short edge measured NEGATIVE "
                     + "(\(r) per trade, at move likelihood 55%+)."
            case .neutral:
                return "Neutral \u{2014} the mood where the short edge measured strongest "
                     + "(\(r) per trade, at move likelihood 55%+)."
            case .fear:
                return "Fear \u{2014} the short edge measured \(r) per trade here, "
                     + "at move likelihood 55%+."
            }
        }
    }

    // MARK: - Non-independence (corrected spec §21)

    /// Row count corrected for horizon overlap.
    ///
    /// A 72h hold sampled every 4h means ~18 rows share one outcome, so a raw count overstates
    /// confidence roughly 18-fold. Non-independence has nearly produced a published finding four
    /// separate times in this project; a count on a surface must never appear without this.
    static func effectiveN(rows: Int, holdHours: Double, barHours: Double = 4) -> Int {
        guard rows > 0, holdHours > 0, barHours > 0 else { return rows }
        return max(1, Int((Double(rows) / (holdHours / barHours)).rounded()))
    }

    /// "184 similar bars (~10 independent)". Never the raw count alone.
    static func countWithEffectiveN(rows: Int, holdHours: Double, barHours: Double = 4,
                                    noun: String = "similar bars") -> String {
        "\(rows) \(noun) (~\(effectiveN(rows: rows, holdHours: holdHours, barHours: barHours)) independent)"
    }

    // MARK: - Regime status (corrected spec §2E)

    /// Every claim on this screen except the LONG stop width rests on ONE window \u{2014} 2020-2026
    /// crypto, an equal-weight basket down 83%, SHORT the better side before any gate. §2E makes
    /// labelling that in the UI a rule rather than a footnote, so the string is defined once here
    /// and the screen has no way to show an expectancy without it.
    static let regimeStatus = "PROVISIONAL \u{2014} single-window evidence"
    static let regimeExplanation =
        "Measured in one window: a crypto bear where shorts were the better side before any rule "
        + "was applied. Ranking survived that window; profit did not. Only the long stop width has "
        + "been checked across both a bear and a bull."

    /// "1R is $560 at your 2% risk" — the anchor that makes every other R on screen readable.
    static func rAnchor(accountSize: Double? = nil, riskPercent: Double? = nil) -> String? {
        let unit = oneR(accountSize: accountSize, riskPercent: riskPercent)
        let risk = riskPercent ?? UserDefaults.standard.double(forKey: "riskPercent")
        guard unit > 0, risk > 0 else { return nil }
        let pct = risk == risk.rounded() ? String(Int(risk)) : String(format: "%.1f", risk)
        return "1R is $\(Int(unit.rounded())) at your \(pct)% risk"
    }
}
