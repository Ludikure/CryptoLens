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

    /// Three states, in the order a trader cares about.
    private enum Verdict {
        case setup(TradeSetup)      // a risk-defined setup survived every gate
        case noEdge                 // analysis ran, produced nothing — the common case
        case notRun                 // no analysis for this bar yet

        var headline: String {
            switch self {
            case .setup(let s): return "\(s.direction) SETUP"
            case .noEdge:       return "NO ENTRY EDGE"
            case .notRun:       return "NOT ANALYSED"
            }
        }

        var accent: Color {
            switch self {
            case .setup(let s): return s.direction == "LONG" ? Theme.bullish : Theme.bearish
            case .noEdge:       return Theme.neutral
            case .notRun:       return Theme.info
            }
        }

        var glyph: String {
            switch self {
            case .setup:  return "target"
            case .noEdge: return "hand.raised"
            case .notRun: return "sparkles"
            }
        }
    }

    private var verdict: Verdict {
        if let setup = result.tradeSetups.first { return .setup(setup) }
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

            // ── The setup's actual numbers, when there is one ──
            if case .setup(let s) = verdict {
                HStack(spacing: 14) {
                    levelColumn("Entry", s.entry, Theme.info)
                    levelColumn("Stop", s.stopLoss, Theme.bearish)
                    levelColumn("TP1", s.tp1, Theme.bullish)
                    if let tp2 = s.tp2 { levelColumn("TP2", tp2, Theme.bullish) }
                }
            }

            // ── The model's one-liner ──
            if let line = bottomLine {
                Text(line)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if case .notRun = verdict {
                Text("No analysis for this bar yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            // ── Staleness, stated plainly rather than hidden ──
            if isStale, !result.claudeAnalysis.isEmpty {
                Label("Price has moved since this read", systemImage: "clock.arrow.circlepath")
                    .font(Theme.micro)
                    .foregroundStyle(Theme.caution)
            }

            Divider().padding(.vertical, 2)

            // ── Actions: read the reasoning, or get a fresh one ──
            HStack(spacing: 14) {
                if !result.claudeAnalysis.isEmpty {
                    NavigationLink {
                        AnalysisDetailScreen(result: result)
                    } label: {
                        Label("Full read", systemImage: "text.alignleft").font(Theme.micro)
                    }
                }
                // ALWAYS available, including when there is no current analysis (2026-07-31). The
                // archive button used to live inside the analysis screen, which is itself only
                // reachable via "Full read" above — so with no analysis for the current bar there
                // was no route to past analyses at all, and the only way in was to spend another
                // LLM call. Past reads are exactly what you want when the current bar has none.
                if let onShowHistory {
                    Button(action: onShowHistory) {
                        Label("History", systemImage: "clock.arrow.circlepath").font(Theme.micro)
                    }
                }
                Spacer()
                Button {
                    HapticManager.impact(.medium)
                    onRunAnalysis()
                } label: {
                    Label(result.claudeAnalysis.isEmpty ? "Analyse" : "Re-run",
                          systemImage: "sparkles").font(Theme.micro)
                }
            }
            .buttonStyle(.borderless)
        }
        .themedCard(accent: verdict.accent)
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
