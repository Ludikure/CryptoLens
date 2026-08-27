import SwiftUI

/// The scanner — Phase 1 of the corrected redesign spec (§42).
///
/// It replaces the question the app used to open with. "What about this symbol?" is a question you
/// can only ask once you have already decided to trade something; "is there anything worth doing
/// right now?" is the one that actually precedes a decision. So this screen is not symbol-scoped and
/// deliberately has no symbol switcher.
///
/// THREE THINGS DECIDE ITS SHAPE, and each is a correction to something that went wrong before.
///
/// 1. **Most days the honest answer is "nothing."** `rankCandidates` drops non-positive EV outright
///    and the code comment says the system "must be comfortable returning an empty list". A scanner
///    whose empty state reads as failure trains the user to distrust the gates, so the quiet day is
///    the PRIMARY state here and is designed as a result — an answer with a denominator above it and
///    the closest miss below it — never as an absence.
///
/// 2. **Every caveat that applies to all rows equally is stated ONCE, above them.** A first pass put
///    the honesty layer inside each card and it became the dominant visual mass, burying the answer
///    it was meant to qualify.
///
/// 3. **One colour law, so the screen needs no legend.** Blue is something you could start, green is
///    money that already exists (open positions only), orange is a hazard that changes what you would
///    do, grey is unranked or unmodelled. **Green never appears on a proposal.**
///
/// Design source: `design/trade-opportunities/` · governing spec: `docs/redesign-spec-corrections.md`.
struct OpportunitiesView: View {
    @EnvironmentObject var service: AnalysisService
    @EnvironmentObject var favorites: FavoritesStore

    /// Switch the app to a symbol and show its detail. The scanner's one bridge into the rest of
    /// the app — passed in rather than owned so this view stays free of navigation state.
    var onOpenSymbol: (String) -> Void = { _ in }

    @State private var book: WorkerOpportunitiesService.Book?
    @State private var openPositions: [TrackedSetup] = []
    @State private var loaded = false
    @State private var showStopped = false
    @State private var detail: WorkerOpportunitiesService.Opportunity?

    // MARK: - Derived

    private var floorR: Double { book?.floorR ?? 0.05 }
    private var ranked: [WorkerOpportunitiesService.Opportunity] { book?.ranked ?? [] }
    private var mood: OpportunityCopy.Mood? { .from(book?.fearGreed) }

    private var scanned: Int {
        book?.scanned ?? ((book?.opportunities.count ?? 0) + (book?.skipped.count ?? 0))
    }

    /// Assets the pipeline SCORED but cannot rank — a refused long head, or two sides too close to
    /// separate. Distinct from the ones it never got to score, which are counted in the margin line.
    private var notRanked: [(asset: String, line: String)] {
        var out = (book?.noView ?? []).map {
            (asset: $0.asset, line: "Both sides land inside \(rText(floorR, decimals: 2)) of each other. No view.")
        }
        for s in book?.skipped ?? [] where isScoredButUnrankable(s) {
            out.append((asset: s.asset,
                        line: OpportunityCopy.plainList(s.reasons).joined(separator: ". ") + "."))
        }
        return out
    }

    /// A skip that came from the PAYOFF (both sides priced, neither pays) rather than from a missing
    /// input or the analysis gate. Only these belong under a header claiming a model was applied.
    private func isScoredButUnrankable(_ s: WorkerOpportunitiesService.Skipped) -> Bool {
        s.reasons.contains { $0.contains("non-positive expected value") }
    }

    private var stoppedBeforeScoring: [WorkerOpportunitiesService.Skipped] {
        (book?.skipped ?? []).filter { !isScoredButUnrankable($0) }
    }

    var body: some View {
        List {
            Section {
                dateline
                answer
                frame
                rows
                if !ranked.isEmpty { bookTotal }
                marginLine
                drawdownGauge
                notRankedSection
                openSection
                footer
            }
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
        }
        .listStyle(.plain)
        .background(Color(.systemGroupedBackground))
        .scrollContentBackground(.hidden)
        .navigationTitle("Opportunities")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { if !loaded { await load() } }
        .sheet(isPresented: $showStopped) {
            StoppedBeforeScoringSheet(rows: stoppedBeforeScoring)
        }
        .sheet(item: $detail) { opp in
            TradeCardView(opportunity: opp, book: book,
                          onOpenSymbol: { sym in detail = nil; onOpenSymbol(sym) })
        }
    }

    // MARK: - 1 · Dateline
    //
    // Supplies the denominator, so the answer below never has to carry it.

    private var dateline: some View {
        Text(datelineText)
            .font(Theme.micro)
            .tracking(0.7)
            .foregroundStyle(.secondary)
            .padding(.top, 4)
    }

    private var datelineText: String {
        guard let at = book?.at else { return loaded ? "NO SCAN" : "SCANNING…" }
        let d = Date(timeIntervalSince1970: at / 1000)
        let f = DateFormatter()
        f.dateFormat = "EEE d MMM"
        let t = DateFormatter()
        t.dateFormat = "HH:mm"
        return "\(f.string(from: d).uppercased()) · \(t.string(from: d)) · \(scanned) SCANNED"
    }

    // MARK: - 2 · Answer
    //
    // Never a verdict — always a threshold statement with its threshold printed inside it, so the
    // sentence teaches the rule while it answers the question. The first word carries the load.

    private var answer: some View {
        Text(answerText)
            .font(Theme.answer)
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 10)
    }

    private var answerText: String {
        guard loaded else { return "Scanning…" }
        guard book != nil else { return "The scan did not come back." }
        let n = ranked.count
        guard n > 0 else { return "Nothing clears the \(rText(floorR, decimals: 2)) floor." }

        let words = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"]
        let count = n < words.count ? words[n] : "\(n)"
        let sides = Set(ranked.map(\.direction))
        let noun: String
        if sides == ["SHORT"] { noun = n == 1 ? "short" : "shorts" }
        else if sides == ["LONG"] { noun = n == 1 ? "long" : "longs" }
        else { noun = n == 1 ? "setup" : "setups" }

        let base = "\(count) \(noun) clear\(n == 1 ? "s" : "") the \(rText(floorR, decimals: 2)) floor"
        // §6: in GREED the measured short edge is NEGATIVE, and the spec's instruction is not to
        // present it as available. Stated in the ANSWER rather than on each card, because it is a
        // property of the mood, identical on every row — the same reason the frame exists.
        if sides.contains("SHORT"), mood?.shortEdgeAbsent == true {
            return base + " — but not in this mood."
        }
        return base + "."
    }

    // MARK: - 3 · Frame
    //
    // Properties of the STRUCTURE. Identical on every row, therefore stated once and never again
    // inside one. This is the move that stops the honesty layer becoming the dominant mass.

    @ViewBuilder
    private var frame: some View {
        if loaded, book != nil {
            VStack(alignment: .leading, spacing: 5) {
                if let m = mood {
                    Text(m.sentence)
                        .foregroundStyle(m.shortEdgeAbsent ? Theme.caution : Color.secondary)
                }
                Text(structureLine)
                Text(shapeLine)
            }
            .font(Theme.frame)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 12)
        }
    }

    private var structureLine: String {
        var parts: [String] = []
        // NAME THE TRADE. Every row here is one fixed structure, and it is NOT the one the AI read
        // proposes for the same symbol — that one stops at 4 ATR on a long and 2 on a short. Two
        // geometries in one product is a real hazard: take this entry with that stop and the risk
        // is wrong by a factor of four. The corrected spec's §9 forbids reconciling them by moving
        // either lever alone, so until the joint test settles it, the app states which is which.
        if let st = book?.structure {
            parts.append("Each row is a \(trimmed(st.stopAtrMultiple)) ATR stop at "
                         + "\(trimmed(st.targetR))R, held up to \(Int(st.holdingHorizonHours))h.")
        }
        if let rt = book?.structure?.roundTripPercent {
            parts.append("Net of the \(trimmed(rt))% round trip.")
        }
        parts.append("Floor \(rText(floorR, decimals: 2)).")
        if let anchor = OpportunityCopy.rAnchor() { parts.append(anchor + ".") }
        return parts.joined(separator: " ")
    }

    /// The shape that produces the average. Without it a "+$41 a trade" row reads as a wage rather
    /// than as the mean of "lose 1R most times, occasionally win 5R".
    private var shapeLine: String {
        let p = ranked.compactMap { $0.branches?.target }.sorted()
        let hit = p.isEmpty ? book?.model?.baseWinRate?.short : p[p.count / 2]
        var s = ""
        if let h = hit, h > 0 {
            s += "About 1 in \(Int((1 / h).rounded())) reach target; most stop out. "
        }
        return s + "Ranking is measured; profit is not."
    }

    // MARK: - 4 · Rows
    //
    // Five numbers. A blue stripe means a proposal you could start — never green, because a
    // proposal is not money.

    @ViewBuilder
    private var rows: some View {
        if !ranked.isEmpty {
            VStack(spacing: 8) {
                ForEach(ranked) { opp in
                    Button { detail = opp } label: { row(opp) }
                        .buttonStyle(.plain)
                }
            }
            .padding(.top, 14)
        }
    }

    private func row(_ o: WorkerOpportunitiesService.Opportunity) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Text(ticker(o.asset)).font(.footnote.weight(.semibold))
                Text(o.direction)
                    .themedPill(o.direction == "LONG" ? Theme.bullish : Theme.bearish)
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 1) {
                    Text(rText(o.expectedValueR))
                        .font(Theme.mono).fontWeight(.medium)
                        .foregroundStyle(Theme.info)
                    if let money = OpportunityCopy.money(forR: o.expectedValueR) {
                        Text(money).font(Theme.frame).foregroundStyle(.tertiary)
                    }
                }
            }

            (Text(Formatters.formatPrice(o.entry)).foregroundStyle(.primary)
             + Text("  →  ").foregroundStyle(.tertiary)
             + Text(Formatters.formatPrice(o.target)).foregroundStyle(.secondary)
             + Text("  ·  ").foregroundStyle(.tertiary)
             + Text("stop \(Formatters.formatPrice(o.stop)), \(String(format: "%.1f", o.stopDistancePercent))%")
                .foregroundStyle(.secondary))
                .font(Theme.mono)

            // Line 3 exists ONLY when something changed the size or the price for THIS row. A
            // caveat that applies to every row belongs in the frame, not here.
            if o.crashMultiplier < 1, let cut = sizeCutLine(o) {
                Text(cut).font(Theme.frame).foregroundStyle(Theme.caution)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let clash = contradictsAnalysis(o) {
                Text(clash).font(Theme.frame).foregroundStyle(Theme.caution)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .themedCard(accent: Theme.info)
        .contentShape(Rectangle())
    }

    /// The 2026-08-25 failure, caught at the row instead of prevented by deletion.
    ///
    /// That day the book proposed an ADA SHORT on the same screen where the analysis showed an ADA
    /// LONG SETUP, and the fix was to delete the book's trade cards outright: two unverified
    /// opinions that disagree are strictly worse than one. Bringing them back needs the
    /// reconciliation that was missing, and there are now two halves of it — `/opportunities` runs
    /// the REAL envelope precheck per symbol and drops anything the analysis would auto-FLAT, and
    /// the two live on different screens rather than side by side.
    ///
    /// Neither closes the last gap: the envelope can pass a bar while the model's own directional
    /// read goes the other way. So when it does, the row says so rather than letting the user find
    /// out one tap later. This is row-specific, which is why it earns a line inside the card when a
    /// universal caveat would not.
    private func contradictsAnalysis(_ o: WorkerOpportunitiesService.Opportunity) -> String? {
        guard let setup = service.cachedResults[o.asset]?.tradeSetups.first,
              setup.direction != o.direction else { return nil }
        return "Your last AI read on \(ticker(o.asset)) called it \(setup.direction). "
             + "They disagree — neither is verified."
    }

    private func sizeCutLine(_ o: WorkerOpportunitiesService.Opportunity) -> String? {
        let pct = Int((o.crashMultiplier * 100).rounded())
        guard let reading = book?.crashReadings?.first(where: { $0.asset == o.asset }),
              let base = book?.crashModel?.baseRate else {
            return "Size cut to \(pct)% for drawdown risk."
        }
        let over = Int(((reading.probability - base) * 100).rounded())
        return "Size cut to \(pct)% — drawdown risk \(Int((reading.probability * 100).rounded()))%, "
             + "\(over) points above a normal day."
    }

    // MARK: - 5 · Book total
    //
    // The best number in the payload, and nothing has ever displayed it. Five correlated crypto
    // positions are not five bets — crypto ρ̄ measured 0.62, which makes them about 1.5.

    @ViewBuilder
    private var bookTotal: some View {
        if let t = book?.totals, t.positions > 0 {
            Text("If you took all \(t.positions): about \(trimmed(t.effectiveBets)) independent "
                 + "bets, not \(t.positions) — these move together.")
                .font(Theme.frame).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)
        }
    }

    // MARK: - 6 · Margin line
    //
    // The cheapest teaching device on the screen: it is where you learn what the floor FEELS like.
    // "Nothing qualifies" and "the best one missed by a cent" are different messages.

    @ViewBuilder
    private var marginLine: some View {
        if loaded, book != nil {
            Button { showStopped = true } label: {
                HStack(alignment: .top, spacing: 6) {
                    Text(marginText)
                        .font(Theme.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.right")
                        .font(.caption2).foregroundStyle(.tertiary).padding(.top, 3)
                }
            }
            .buttonStyle(.plain)
            .disabled(stoppedBeforeScoring.isEmpty)
            .padding(.top, 13)
        }
    }

    private var marginText: String {
        var s = ""
        if let n = book?.nearMiss {
            s = "Closest miss: \(ticker(n.asset)) \(n.direction.lowercased()) at "
              + "\(rText(n.expectedValueR, decimals: 2)), under the floor."
        }
        let stopped = stoppedBeforeScoring.count
        if stopped > 0 {
            s += s.isEmpty ? "\(stopped) stopped before scoring"
                           : " \(stopped) more stopped before scoring"
        }
        return s.isEmpty ? "Every asset scanned was scored." : s
    }

    // MARK: - 7 · Drawdown gauge
    //
    // A PERMANENT slot with a reading that always changes, so it cannot become wallpaper. There is
    // no all-clear and no green here: the gauge sat silent through five 20-28% falls, so a quiet
    // reading is a documented property, not a safe signal. It gets a full-width hairline rather
    // than a leading stripe — deliberately a different geometry to a proposal.

    @ViewBuilder
    private var drawdownGauge: some View {
        if let readings = book?.crashReadings, !readings.isEmpty, let base = book?.crashModel?.baseRate {
            let warned = readings.filter { r in book?.crashWarnings?.contains { $0.asset == r.asset } ?? false }
            let shown = warned.isEmpty
                ? Array(readings.sorted { $0.probability > $1.probability }.prefix(1))
                : warned.sorted { $0.probability > $1.probability }

            VStack(alignment: .leading, spacing: 3) {
                Rectangle().fill(Theme.caution.opacity(0.35)).frame(height: 0.5)
                    .padding(.bottom, 9)

                (shown.reduce(Text("DRAWDOWN GAUGE").foregroundStyle(.secondary)) { acc, r in
                    acc + Text("  ·  ").foregroundStyle(.tertiary)
                        + Text("\(warned.isEmpty ? "highest " : "")\(ticker(r.asset)) "
                               + "\(Int((r.probability * 100).rounded()))%")
                            .foregroundStyle(Theme.caution)
                 } + Text("  ·  ").foregroundStyle(.tertiary)
                   + Text("a normal day is \(Int((base * 100).rounded()))%").foregroundStyle(.secondary))
                    .font(Theme.micro)
                    .fixedSize(horizontal: false, vertical: true)

                Text(warned.isEmpty
                     ? "Nothing elevated — which is a reading, not an all-clear."
                     : "Sizes reduced on \(warned.count == 1 ? "it" : "both").")
                    .font(Theme.frame).foregroundStyle(.secondary)

                // A HIGH reading gets the model's OWN sentence, verbatim. `crash.ts` writes it and
                // deliberately builds the episodic caveat into it, because a user who sees this fire
                // twice and then sit silent through a 25% drawdown would reasonably conclude it was
                // broken. Paraphrasing it would drop the half that prevents that.
                if let high = book?.crashWarnings?.first(where: { $0.isHigh }) {
                    Text(high.message)
                        .font(Theme.frame).foregroundStyle(Theme.caution)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 4)
                }
            }
            .padding(.top, 15)
        }
    }

    // MARK: - 8 · Not ranked
    //
    // No card, no stripe, no columns. The SHAPE says "categorically not a candidate" before a word
    // is read, which no amount of text could do as quickly.

    @ViewBuilder
    private var notRankedSection: some View {
        if !notRanked.isEmpty {
            VStack(alignment: .leading, spacing: 9) {
                Text("Not ranked — no model exists")
                    .font(Theme.micro).tracking(0.7).foregroundStyle(.secondary)
                ForEach(notRanked, id: \.asset) { item in
                    HStack(alignment: .top, spacing: 9) {
                        Text(ticker(item.asset))
                            .font(Theme.micro).foregroundStyle(.secondary)
                            .frame(width: 42, alignment: .leading)
                        Text(item.line)
                            .font(Theme.frame).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if let long = book?.model?.baseWinRate?.long {
                    Text("A long carries no ranking because its model failed its own bar, so its "
                         + "odds are the \(pctText(long)) base rate every long shares.")
                        .font(Theme.frame).foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.top, 17)
        }
    }

    // MARK: - 9 · Open
    //
    // No stripe: you are already in these, they are not proposals. The ONLY green on the screen,
    // and only ever on money that exists.

    @ViewBuilder
    private var openSection: some View {
        if !openPositions.isEmpty {
            VStack(alignment: .leading, spacing: 9) {
                Text("Open").font(Theme.micro).tracking(0.7).foregroundStyle(.secondary)
                ForEach(openPositions) { t in openRow(t) }
            }
            .padding(.top, 17)
        }
    }

    private func openRow(_ t: TrackedSetup) -> some View {
        let risk = t.setup.risk
        let nowR = currentR(t)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(ticker(t.symbol)).font(.footnote.weight(.semibold))
                Text(t.setup.direction)
                    .themedPill(t.setup.direction == "LONG" ? Theme.bullish : Theme.bearish)
                Spacer(minLength: 4)
                if let r = nowR {
                    Text(rText(r, decimals: 1))
                        .font(Theme.mono).fontWeight(.medium)
                        .foregroundStyle(Theme.forChange(r))
                }
            }
            if risk > 0 {
                Text(excursionLine(t, risk: risk))
                    .font(Theme.frame).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .themedCard()
    }

    private func excursionLine(_ t: TrackedSetup, risk: Double) -> String {
        var parts = ["best \(String(format: "%+.1f", t.outcome.maxFavorable / risk))",
                     "worst \(String(format: "%+.1f", -abs(t.outcome.maxAdverse) / risk))"]
        parts.append(t.outcome.breakevenActivated
                     ? "stop at break-even, so this one can no longer lose"
                     : "stop not yet at break-even")
        return parts.joined(separator: " · ")
    }

    /// Unrealised R, but ONLY from a price fresh enough to mean it.
    ///
    /// A stale cached price would render as a live P&L, which is the one number on this screen a
    /// user would act on immediately. Absent is better than wrong, so this returns nil rather than
    /// reaching for the last thing it saw.
    private func currentR(_ t: TrackedSetup) -> Double? {
        let risk = t.setup.risk
        guard risk > 0 else { return nil }
        var price: Double?
        if let cached = service.cachedResults[t.symbol],
           Date().timeIntervalSince(cached.timestamp) < 1800, cached.daily.price > 0 {
            price = cached.daily.price
        } else if let o = book?.opportunities.first(where: { $0.asset == t.symbol }), o.entry > 0 {
            price = o.entry
        }
        guard let p = price else { return nil }
        let move = t.setup.direction == "LONG" ? p - t.setup.entry : t.setup.entry - p
        return move / risk
    }

    // MARK: - 10 · Footer

    @ViewBuilder
    private var footer: some View {
        if loaded, book != nil {
            VStack(alignment: .leading, spacing: 5) {
                Rectangle().fill(Color.primary.opacity(0.06)).frame(height: 0.5)
                    .padding(.bottom, 10)
                HStack(alignment: .firstTextBaseline) {
                    if let fg = book?.fearGreed {
                        Text("Fear & Greed \(Int(fg.rounded())) · neutral is 50")
                            .font(Theme.frame).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Text(OpportunityCopy.regimeStatus)
                        .font(Theme.frame).foregroundStyle(.tertiary)
                }
                Text(OpportunityCopy.regimeExplanation)
                    .font(Theme.frame).foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("The drawdown gauge sat silent through five 20–28% falls.")
                    .font(Theme.frame).foregroundStyle(.tertiary)
            }
            .padding(.top, 18)
            .padding(.bottom, 24)
        }
    }

    // MARK: - Data

    private func load() async {
        #if DEBUG
        // Renders the populated state without waiting for a good day. See `demoBook()`.
        //   -opportunitiesDemo 1      the ranked list
        //   -opportunitiesDemo card   the list with the trade card open
        if let demo = UserDefaults.standard.string(forKey: "opportunitiesDemo"), !demo.isEmpty {
            book = WorkerOpportunitiesService.demoBook()
            openPositions = await OutcomeTracker.openPositionsAsync()
            loaded = true
            if demo == "card" { detail = ranked.first }
            return
        }
        #endif

        // The book is scoped to the user's own watchlist and sized against their real equity, so
        // every number is the number for THIS account rather than a generic illustration.
        let syms = Array(favorites.orderedFavorites.prefix(12))
        // NB `accountSize`, not `account_size` — the old call site used the second, which does not
        // exist, so every scan was sized against the worker's 25,000 default.
        let equity = OpportunityCopy.oneR() > 0
            ? UserDefaults.standard.double(forKey: "accountSize") : 0
        // The same key `FeeDragCard` edits, so the two cannot disagree about what a trade costs.
        let fee = UserDefaults.standard.object(forKey: "feeRoundTripPercent") as? Double
        async let fetched = WorkerOpportunitiesService.fetch(symbols: syms,
                                                            equity: equity > 0 ? equity : 28000,
                                                            feePercent: fee)
        async let positions = OutcomeTracker.openPositionsAsync()
        book = await fetched
        openPositions = await positions
        loaded = true
    }

    // MARK: - Formatting

    private func ticker(_ symbol: String) -> String {
        symbol.hasSuffix("USDT") ? String(symbol.dropLast(4)) : symbol
    }

    private func rText(_ r: Double, decimals: Int = 3) -> String {
        String(format: "%+.\(decimals)fR", r)
    }

    private func pctText(_ p: Double) -> String { String(format: "%.1f%%", p * 100) }

    private func trimmed(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(format: "%.2f", v)
            .replacingOccurrences(of: #"0+$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\.$"#, with: "", options: .regularExpression)
    }
}

/// What the margin line's count is made of. One tap away, never on the main surface — these are
/// assets the pipeline never got to price, and putting them inline would give a list of absences
/// the same weight as the answer.
private struct StoppedBeforeScoringSheet: View {
    let rows: [WorkerOpportunitiesService.Skipped]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("These never reached a price. Most are the analysis gate — the same guards "
                         + "the AI read applies, so the two halves of the app cannot contradict "
                         + "each other.")
                        .font(Theme.caption).foregroundStyle(.secondary)
                }
                ForEach(rows, id: \.asset) { r in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(r.asset.hasSuffix("USDT") ? String(r.asset.dropLast(4)) : r.asset)
                            .font(.footnote.weight(.semibold))
                        ForEach(OpportunityCopy.plainList(r.reasons), id: \.self) { reason in
                            Text("· " + reason).font(Theme.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
            .navigationTitle("Stopped before scoring")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
