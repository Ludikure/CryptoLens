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
            // Sign in words, not in R. "Long pays -0.10R after the fee" reads as a unit the user
            // never agreed to; "a long loses money here after fees" reads as the finding it is.
            return r < 0
                ? "A \(g[0].lowercased()) loses money here once fees are paid"
                : "A \(g[0].lowercased()) barely breaks even here after fees"
        }
        if let m = noiseStop.firstMatch(in: token, range: range), let g = groups(m, in: token), g.count == 2 {
            return "The stop for a \(g[0].lowercased()) sits inside the noise — normal swings alone "
                 + "hit it \(g[1])% of the time"
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

    // MARK: - Support grade

    /// How well SUPPORTED a row is, built ONLY from measured binary facts.
    ///
    /// Written 2026-08-28 after the user said three times that the screen was confusing, most
    /// precisely as: *"I don't understand what is a good trading opportunity from bad one."*
    /// The first two attempts rewrote copy. This one changes what is claimed.
    ///
    /// The screen had been ranking rows by net expected R and printing a dollar figure, which
    /// implies the model can order candidates by quality. It measurably cannot: the book's own
    /// caveat says the edge is *"+0.109R gross with a median of zero — mostly nothing,
    /// occasionally a large hit"*, profitable in 1 of 5 rising-market periods, at a 7.6% base hit
    /// rate. The difference between a +0.05R row and a +0.09R row is inside that noise.
    ///
    /// What DOES differ between rows, and is measured:
    ///   1. whether the excursion head for THIS DIRECTION passed its ship criteria — today the
    ///      short head passes all five and the long head fails three of five, which is the largest
    ///      quality gap in the book and was not on screen at all;
    ///   2. what share of the gross edge the round trip eats (52% on a typical row);
    ///   3. whether the crash overlay has cut the size.
    ///
    /// Deliberately NOT a score. §15 of the corrected spec deleted the weighted 0-100 precisely
    /// because summing incommensurable things invents precision. A grade whose every input is a
    /// named binary fact, each shown next to it, does not reintroduce that — the user can see
    /// exactly which facts produced the label and disagree with any one of them.
    enum Support {
        /// The head for this direction FAILED its own ship test. Not "bad" — UNKNOWN.
        case unproven
        /// Head passed, but at least one named caveat applies.
        case qualified
        /// Head passed and no caveat fired.
        case validated

        var headline: String {
            switch self {
            case .validated: return "WELL SUPPORTED"
            case .qualified: return "QUALIFIED"
            case .unproven:  return "UNPROVEN"
            }
        }
    }

    /// One named fact behind the grade. `ok == false` is what demotes the level.
    struct Fact: Identifiable {
        let text: String
        let ok: Bool
        var id: String { text }
    }

    struct Grade {
        let level: Support
        let facts: [Fact]
    }

    /// Above this share of gross, the round trip is unusual for this structure rather than the
    /// ~50% it costs on a typical row, and is worth saying on the row itself.
    static let feeWarnShare = 0.65

    /// `headShippable` is `model.heads.{long|short}.shippable` for the row's direction — nil when
    /// the worker did not send it (an older box), which is treated as unknown rather than as pass.
    /// `feeShare` is feeBurdenR / grossExpectedValueR. `sizeCut` is true when the crash overlay
    /// reduced the position.
    static func grade(direction: String,
                      headShippable: Bool?,
                      feeShare: Double?,
                      sizeCut: Bool,
                      moodLabel: String?) -> Grade {
        var facts: [Fact] = []
        let side = direction.uppercased() == "LONG" ? "longs" : "shorts"

        switch headShippable {
        case .some(true):
            facts.append(Fact(text: "The \(side) model passed all 5 of its ship tests", ok: true))
        case .some(false):
            // The model's own reason, compressed. Quoting the full string on a row would bury it.
            facts.append(Fact(text: "The \(side) model FAILED its own ship test — it adds nothing "
                                  + "over 30-bar-old data", ok: false))
        case .none:
            facts.append(Fact(text: "This box did not report whether the \(side) model is validated",
                              ok: false))
        }

        // Fee is a FRAME fact, not a row fact, and putting it on the row was a mistake caught by
        // screenshotting the result: at a 0.171% round trip against a 1-2.5% stop it lands near
        // half the gross on EVERY row, so it fired as a warning on all of them, told the user
        // nothing about which row was better, and dragged every row to the same grade — the exact
        // complaint this change exists to fix. The typical share is stated once above the rows.
        // It earns a row only when it is unusual for this book, which `feeWarnShare` defines.
        if let f = feeShare, f.isFinite, f > feeWarnShare {
            facts.append(Fact(text: "Fees take \(Int((f * 100).rounded()))% of the edge — "
                                  + "unusually high, this stop is tight", ok: false))
        }

        facts.append(sizeCut
            ? Fact(text: "Crash risk elevated — size cut", ok: false)
            : Fact(text: "Crash risk normal", ok: true))

        if let m = moodLabel, direction.uppercased() == "SHORT" {
            // Measured per §6: FEAR +0.0616, NEUTRAL +0.1437, GREED −0.0467 at ML ≥ 0.55. Greed
            // rows never reach here — they are cancelled upstream — so this can only be good news,
            // and it says which of the two remaining moods it is rather than implying all are equal.
            facts.append(Fact(text: "Market mood is \(m.lowercased()), where shorts have paid",
                              ok: true))
        }

        let level: Support
        if headShippable != true            { level = .unproven }
        else if facts.contains(where: { !$0.ok }) { level = .qualified }
        else                                 { level = .validated }
        return Grade(level: level, facts: facts)
    }
}
