import SwiftUI

/// The app's conclusion, first thing on the landing screen.
///
/// WHY THIS EXISTS. The system's whole output is an answer to "is there an edge right now, and what
/// do I do?" — and until 2026-07-25 that answer lived three taps away, below two other cards, inside
/// a ~300-word markdown blob on a separate tab. When the envelope sat auto-FLAT for a week you had
/// to go read prose to find that out. This card puts the verdict where the eye lands, and pushes the
/// full reasoning only if you ask for it.
///
/// It deliberately reports only what the app actually knows. Nothing is inferred beyond the parsed
/// setup, the ML probability, and the Bottom Line the model already wrote — the same discipline the
/// prompt itself follows.
struct VerdictCard: View {
    let result: AnalysisResult
    let isStale: Bool
    let onRunAnalysis: () -> Void
    /// Opens the per-symbol analysis archive. Passed in rather than owned so the sheet is presented
    /// by the tab, above the List — a sheet attached to a row inside a List can be dismissed by the
    /// row recycling underneath it.
    var onShowHistory: (() -> Void)? = nil

    /// Drives the push explicitly instead of embedding a NavigationLink in the row. Inside a List, a
    /// NavigationLink in the row's content turns the WHOLE ROW into the link, which then competes
    /// with the sibling buttons for every touch — the other half of "the buttons aren't responsive".
    @State private var showFullRead = false

    /// Four states, in the order a trader cares about.
    ///
    /// `waiting` was added 2026-08-25 after a screen showed "LONG SETUP" in green with an entry of
    /// $0.2140 while price was $0.2210 — and the model's own text underneath said "this is a chase,
    /// wait for a pullback to $0.2140". The card and the prose agreed; the HEADLINE did not, because
    /// it rendered a conditional pullback entry exactly like an actionable one. A setup you cannot
    /// take yet must not look like a setup you should take now.
    private enum Verdict {
        case setup(TradeSetup)           // entry is reachable now
        case waiting(TradeSetup, Double) // valid setup, price not there yet (setup, live price)
        case noEdge                      // analysis ran, produced nothing — the common case
        case notRun                      // no analysis for this bar yet

        var headline: String {
            switch self {
            case .setup(let s):   return "\(s.direction) SETUP"
            case .waiting(let s, _): return "WAIT FOR \(s.direction) ENTRY"
            case .noEdge:         return "NO ENTRY EDGE"
            case .notRun:         return "NOT ANALYSED"
            }
        }

        /// The setup behind either active state, for the levels table.
        var tradeSetup: TradeSetup? {
            switch self {
            case .setup(let s), .waiting(let s, _): return s
            default: return nil
            }
        }

        var accent: Color {
            switch self {
            case .setup(let s): return s.direction == "LONG" ? Theme.bullish : Theme.bearish
            // Deliberately NOT the direction colour: a green card reads as "go", and the whole
            // point of this state is that you should not act yet.
            case .waiting:      return Theme.caution
            case .noEdge:       return Theme.neutral
            case .notRun:       return Theme.info
            }
        }

        var glyph: String {
            switch self {
            case .setup:   return "target"
            case .waiting: return "hourglass"      // not a target — nothing to aim at yet
            case .noEdge:  return "hand.raised"
            case .notRun: return "sparkles"
            }
        }
    }

    private var verdict: Verdict {
        if let setup = result.tradeSetups.first {
            // Is the entry reachable from here? A LONG entry BELOW live price is a pullback the
            // market has not offered yet; a SHORT entry ABOVE it is the same in reverse. The 0.15%
            // band keeps an at-the-money entry from flickering between states on every tick.
            let live = result.daily.price
            guard live > 0, setup.entry > 0 else { return .setup(setup) }
            let gapPct = (live - setup.entry) / setup.entry * 100
            let unreachable = setup.direction == "LONG" ? gapPct > 0.15 : gapPct < -0.15
            return unreachable ? .waiting(setup, live) : .setup(setup)
        }
        return result.claudeAnalysis.isEmpty ? .notRun : .noEdge
    }

    /// The model's own one-liner. Pulled from the `## Bottom Line` section it is instructed to keep
    /// under ~35 words, so it fits here by construction rather than by truncation.
    private var bottomLine: String? {
        let md = result.claudeAnalysis
        guard let range = md.range(of: "## Bottom Line", options: .caseInsensitive) else { return nil }
        let after = md[range.upperBound...]
        // Up to the next section header, or the end.
        let body = after.range(of: "\n## ").map { String(after[..<$0.lowerBound]) } ?? String(after)
        let cleaned = body
            .replacingOccurrences(of: "**", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned
    }

    private var mlPercent: Int? {
        result.daily.mlWinProbability.map { Int(($0 * 100).rounded()) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // ── Headline row: the verdict, plus the one number that qualifies it ──
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: verdict.glyph)
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(verdict.accent)
                Text(verdict.headline)
                    .font(.subheadline.weight(.heavy))
                    .foregroundStyle(verdict.accent)
                Spacer(minLength: 8)
                if let ml = mlPercent {
                    // ML_WIN is direction-agnostic move likelihood, NOT confidence in a direction —
                    // labelled "move" so the card can't be misread as a directional score.
                    Text("move \(ml)%")
                        .font(Theme.micro)
                        .foregroundStyle(ml >= 70 ? Theme.bullish : Theme.neutral)
                        .accessibilityLabel("Move likelihood \(ml) percent in 24 hours")
                }
            }

            // Says plainly why nothing is actionable yet. Without this the levels table looks
            // like an instruction, which is exactly how "LONG SETUP / entry 0.2140" read while
            // price sat at 0.2210.
            if case .waiting(let s, let live) = verdict {
                Text("Price is \(Formatters.formatPrice(live)) — this setup only starts at \(Formatters.formatPrice(s.entry)). "
                     + "Nothing to do until it gets there.")
                    .font(.caption)
                    .foregroundStyle(Theme.caution)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // ── The setup's actual numbers, when there is one ──
            if let s = verdict.tradeSetup {
                HStack(spacing: 14) {
                    levelColumn("Entry", s.entry, Theme.info)
                    levelColumn("Stop", s.stopLoss, Theme.bearish)
                    levelColumn("TP1", s.tp1, Theme.bullish)
                    if let tp2 = s.tp2 { levelColumn("TP2", tp2, Theme.bullish) }
                }
            }

            // ── The model's one-liner ──
            // The TEXT itself opens the full read, not just the small button below it. It's the
            // largest target on the card and the thing you're already looking at, so tapping what
            // you're reading to read more is the obvious gesture — the button stays for
            // discoverability. `.plain` keeps it looking like prose rather than a link, and
            // contentShape makes the whole wrapped block tappable, not just the glyphs.
            if let line = bottomLine {
                Button { showFullRead = true } label: {
                    Text(line)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the full analysis")
            } else if case .notRun = verdict {
                Text("No analysis for this bar yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            // ── Staleness, stated plainly rather than hidden ──
            // Triangle, not a clock: the History button below uses the clock glyph, and two clock
            // icons a few points apart read as one control overlapping another.
            if isStale, !result.claudeAnalysis.isEmpty {
                Label("Price has moved since this read", systemImage: "exclamationmark.triangle")
                    .font(Theme.micro)
                    .foregroundStyle(Theme.caution)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider().padding(.vertical, 2)

            // ── Actions: read the reasoning, or get a fresh one ──
            // Each label is fixed-size and single-line so the row can never squeeze them into one
            // another — with three actions present (Full read / History / Re-run) the previous
            // free-sizing HStack let them collide at larger Dynamic Type sizes.
            HStack(spacing: 16) {
                if !result.claudeAnalysis.isEmpty {
                    Button { showFullRead = true } label: {
                        Label("Full read", systemImage: "text.alignleft")
                            .font(Theme.micro).lineLimit(1).fixedSize()
                    }
                }
                // ALWAYS available, including when there is no current analysis (2026-07-31). The
                // archive button used to live inside the analysis screen, which is itself only
                // reachable via "Full read" above — so with no analysis for the current bar there
                // was no route to past analyses at all, and the only way in was to spend another
                // LLM call. Past reads are exactly what you want when the current bar has none.
                if let onShowHistory {
                    Button(action: onShowHistory) {
                        Label("History", systemImage: "clock.arrow.circlepath")
                            .font(Theme.micro).lineLimit(1).fixedSize()
                    }
                }
                Spacer(minLength: 8)
                Button {
                    HapticManager.impact(.medium)
                    onRunAnalysis()
                } label: {
                    Label(result.claudeAnalysis.isEmpty ? "Analyse" : "Re-run", systemImage: "sparkles")
                        .font(Theme.micro).lineLimit(1).fixedSize()
                }
            }
            .buttonStyle(.borderless)
        }
        .themedCard(accent: verdict.accent)
        // Measure the card by its real content height. Without this a List row containing wrapping
        // text can under-measure once the Bottom Line appears, letting the row below (the data /
        // analysis timestamp bar) draw over the action row.
        .fixedSize(horizontal: false, vertical: true)
        .navigationDestination(isPresented: $showFullRead) {
            AnalysisDetailScreen(result: result)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Verdict: \(verdict.headline)")
    }

    private func levelColumn(_ label: String, _ value: Double, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(Theme.micro)
                .foregroundStyle(.tertiary)
            Text(Formatters.formatPrice(value))
                .font(Theme.mono)
                .foregroundStyle(color)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The full AI read, pushed from the verdict card rather than owning a tab of its own — you land on
/// the answer and drill into the reasoning, instead of the reasoning being a peer destination.
struct AnalysisDetailScreen: View {
    let result: AnalysisResult
    @EnvironmentObject var service: AnalysisService
    @State private var showHistory = false

    var body: some View {
        AITabContent(showHistory: $showHistory)
            .navigationTitle("Full read")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showHistory) {
                AnalysisHistoryView(symbol: result.symbol, currentPrice: result.daily.price)
            }
    }
}
