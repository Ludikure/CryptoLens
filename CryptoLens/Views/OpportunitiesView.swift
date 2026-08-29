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
    @State private var showMethod = false
    @State private var detail: WorkerOpportunitiesService.Opportunity?

    // MARK: - Derived

    private var floorR: Double { book?.floorR ?? 0.05 }
    private var mood: OpportunityCopy.Mood? { .from(book?.fearGreed) }

    /// Risk-per-trade the worker actually sized these rows at, as a percentage.
    ///
    /// Not the local default: the two disagreed, and the card printed both. A user on 1% saw
    /// "1R is $280" beside "Risk if stopped 2.00% of the account" for the same event.
    private var sizedRiskPercent: Double? {
        book?.structure?.maxRiskPerTrade.map { $0 * 100 }
    }

    /// What a stop actually costs on THIS row, in account currency.
    ///
    /// `maxRiskPerTrade` is a CAP, and `sizePosition` lands under it whenever the crash overlay,
    /// the notional cap, concentration or correlation binds — 1.44% against a 0.02 cap on a
    /// crash-cut row. Using the cap overstated every dollar figure by up to 2x on exactly the rows
    /// the drawdown model flags as most dangerous. `riskFraction` is the realised number and was
    /// already being rendered, in percent, on the same card.
    private func oneR(_ o: WorkerOpportunitiesService.Opportunity) -> Double? {
        guard let equity = book?.equity, equity > 0, o.riskFraction > 0 else { return nil }
        return equity * o.riskFraction
    }

    private func moneyPerTrade(_ o: WorkerOpportunitiesService.Opportunity) -> String? {
        guard let unit = oneR(o) else { return nil }
        let d = o.expectedValueR * unit
        return "\(d >= 0 ? "+" : "−")$\(Int(abs(d).rounded()))"
    }

    /// A row the MOOD cancels. §6 measured the short edge NEGATIVE in greed (−0.05R at ML ≥ 0.55)
    /// and says plainly: do not present it as available.
    ///
    /// It was being presented as available anyway — a blue-striped card with an entry, a stop, a
    /// target and "about +$29 a trade", carrying three lines of caveat underneath saying it was not
    /// a trade. That is the 2026-08-25 lesson rebuilt in a new place: a setup you should not take
    /// must not LOOK like one, because shape is read before text. Cancelled rows drop to the grey
    /// unranked treatment, which is the colour law's way of saying "not a candidate".
    private func moodCancels(_ o: WorkerOpportunitiesService.Opportunity) -> Bool {
        o.direction == "SHORT" && mood?.shortEdgeAbsent == true
    }

    /// Rows that are genuinely actionable. This is what the cards render.
    private var ranked: [WorkerOpportunitiesService.Opportunity] {
        (book?.ranked ?? []).filter { !moodCancels($0) }
    }

    /// Rows that cleared the floor and were then cancelled by the mood. Shown, never as an offer.
    private var cancelled: [WorkerOpportunitiesService.Opportunity] {
        (book?.ranked ?? []).filter { moodCancels($0) }
    }

    private var scanned: Int {
        book?.scanned ?? ((book?.opportunities.count ?? 0) + (book?.skipped.count ?? 0))
    }

    /// Assets the pipeline SCORED but cannot rank — a refused long head, or two sides too close to
    /// separate. Distinct from the ones it never got to score, which are counted in the margin line.
    private var notRanked: [(asset: String, line: String)] {
        var out = (book?.noView ?? []).map {
            (asset: $0.asset,
             line: "Long and short come out too close to call, so there is no view to act on.")
        }
        out += cancelled.map { o in
            let worth = moneyPerTrade(o).map { "worth \($0) a trade" } ?? "made the cut"
            return (asset: o.asset,
                    line: "Made the cut on the numbers (\(worth)), but the mood cancels it — the "
                        + "one condition where this side has historically lost money.")
        }
        for s in book?.skipped ?? [] where isScoredButUnrankable(s) {
            let lines = OpportunityCopy.plainList(s.reasons)
            // Both sides losing is ONE finding, not two sentences that repeat each other verbatim:
            // "A long loses money here once fees are paid. A short loses money here once fees are
            // paid." is how it read.
            let bothLose = lines.count == 2 && lines.allSatisfy { $0.contains("loses money") }
            out.append((asset: s.asset,
                        line: bothLose ? "Neither side makes money here once fees are paid."
                                       : lines.joined(separator: ". ") + "."))
        }
        return out
    }

    /// A skip that came from the PAYOFF (both sides priced, neither pays) rather than from a missing
    /// input or the analysis gate. Only these belong under a header claiming a model was applied.
    private func isScoredButUnrankable(_ s: WorkerOpportunitiesService.Skipped) -> Bool {
        s.reasons.contains { $0.contains("non-positive expected value") }
    }

    private var stoppedBeforeScoring: [WorkerOpportunitiesService.Skipped] {
        // `rejected` is folded in, because a portfolio-zeroed candidate belongs in a list the user
        // can reach. It was in neither `opportunities` nor `skipped`, counted in the SCANNED
        // denominator, and listed nowhere — so the asset with the worst drawdown reading (a 0.00
        // crash multiplier above p=0.5001) vanished under the sentence "Every asset scanned was
        // scored."
        (book?.skipped ?? []).filter { !isScoredButUnrankable($0) }
        + (book?.rejected ?? []).map {
            WorkerOpportunitiesService.Skipped(asset: $0.asset, reasons: $0.reasons)
        }
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
        return "\(f.string(from: d).uppercased()) · \(t.string(from: d))"
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

    /// The answer, in words a person uses.
    ///
    /// It used to read "Nothing to do. One short cleared the +0.05R floor, and greed cancels it." —
    /// which names an internal constant (`MIN_DISPLAY_EV_R`) and a unit from the research layer in
    /// the one sentence whose job is to answer the question. The user's response was that they did
    /// not know what the objective was or what the numbers meant. Thresholds, R, ATR, fees and hit
    /// rates all moved into "How I judge these", one tap down.
    /// The headline must AGREE with the grades under it.
    ///
    /// It read "Two trades worth taking" above two rows that both said QUALIFIED and carried
    /// warnings — the headline asserting a confidence the rows immediately walked back, which is
    /// its own kind of confusing. It now reads the best grade actually present, so the top line
    /// and the cards can never disagree.
    private var answerText: String {
        guard loaded else { return "Checking…" }
        guard book != nil else { return "Couldn't check right now." }
        let n = ranked.count
        guard n > 0 else { return "Nothing worth trading." }
        let best = ranked.map { grade($0).level }
        if best.contains(.validated) {
            return n == 1 ? "One trade worth taking." : "\(spelled(n)) trades worth taking."
        }
        if best.contains(.qualified) {
            return n == 1 ? "One trade, with caveats." : "\(spelled(n)) trades, all with caveats."
        }
        // Everything on screen rests on a model that failed its own bar. Say so at the top.
        return n == 1 ? "One candidate — but nothing well supported."
                      : "\(spelled(n)) candidates — but nothing well supported."
    }

    private func spelled(_ n: Int) -> String {
        let w = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"]
        return n < w.count ? w[n] : "\(n)"
    }

    /// One sentence of WHY, under the answer. Never a threshold, never a unit.
    private var reasonText: String? {
        guard loaded, book != nil else { return nil }
        let checked = "I checked \(scanned) \(scanned == 1 ? "coin" : "coins")."
        if !ranked.isEmpty { return checked + " The rest didn't make the cut." }

        if let c = cancelled.first, let m = mood {
            let more = cancelled.count > 1 ? " (and \(cancelled.count - 1) more)" : ""
            return checked + " \(ticker(c.asset))'s \(c.direction.lowercased()) setup made the cut on "
                 + "the numbers\(more), but the market is in \(m.label.lowercased()) — the one mood "
                 + "where this side has historically lost money."
        }
        if let nm = book?.nearMiss {
            return checked + " The closest was \(ticker(nm.asset)), a little under the bar."
        }
        return checked + " Nothing came close."
    }


    // MARK: - 3 · Frame
    //
    // Properties of the STRUCTURE. Identical on every row, therefore stated once and never again
    // inside one. This is the move that stops the honesty layer becoming the dominant mass.

    @ViewBuilder
    private var frame: some View {
        if loaded, book != nil {
            VStack(alignment: .leading, spacing: 6) {
                if let r = reasonText {
                    Text(r).fixedSize(horizontal: false, vertical: true)
                }
                // COLLAPSED BY DEFAULT. Every number that needs a definition lives in here: the
                // bar, the unit, the fee, the payoff shape, the regime caveat. On the surface they
                // read as unexplained jargon — "+0.05R floor", "1 ATR stop at 5R", "1 in 13 reach
                // target" — and a user looking at them said they could not tell what the screen was
                // even measuring. None of it is removed; it stops being the first thing you meet.
                DisclosureGroup(isExpanded: $showMethod) {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(methodLines, id: \.self) { line in
                            Text(line).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.top, 6)
                } label: {
                    Text("How I judge these")
                        .font(Theme.micro).foregroundStyle(.secondary)
                }
                .tint(.secondary)
            }
            .font(Theme.frame)
            .foregroundStyle(.secondary)
            .padding(.top, 12)
        }
    }

    /// The method, in sentences. Money first, because R is a unit this app invented for itself.
    private var methodLines: [String] {
        var out: [String] = []
        let unit = typicalR
        let bar = unit.map { "$\(Int((floorR * $0).rounded()))" }

        out.append("This screen asks one question: is anything worth trading right now? Most days "
                   + "the answer is no, and that is the screen working, not failing.")

        if let bar, let unit {
            out.append("To make the cut, a setup has to be worth about \(bar) per trade on AVERAGE "
                       + "after costs. That is a deliberately low bar — it only has to beat doing "
                       + "nothing. A typical trade here risks about $\(Int(unit.rounded())).")
        }
        if let rt = book?.structure?.roundTripPercent {
            // The SHARE is the number that matters and it was missing. \(trimmed(rt))% sounds
            // negligible; against the edge it is about half, on every row. Stated here once
            // because it is true of every row — putting it on the cards made all of them warn and
            // told the user nothing about which was better.
            var line = "Costs are already taken out: \(trimmed(rt))% in fees for the round trip."
            let shares = ranked.compactMap { o -> Double? in
                guard let f = o.feeBurdenR, let g = o.grossExpectedValueR, g > 0 else { return nil }
                return f / g
            }.sorted()
            if let mid = shares.isEmpty ? nil : shares[shares.count / 2] {
                line += " That is about \(Int((mid * 100).rounded()))% of the edge — fees are the "
                      + "single largest cost here, and a row only mentions them when its own share "
                      + "is unusually high."
            }
            out.append(line)
        }
        if let st = book?.structure {
            let hit = ranked.compactMap { $0.branches?.target }.sorted()
            let p = hit.isEmpty ? book?.model?.baseWinRate?.short : hit[hit.count / 2]
            var line = "Each one risks a set amount and aims for \(trimmed(st.targetR))× that, "
                     + "held up to \(Int(st.holdingHorizonHours)) hours."
            if let p, p > 0 {
                line += " Only about 1 in \(Int((1 / p).rounded())) reach the target — most stop "
                      + "out. The average is what makes it worth doing, never any single trade."
            }
            out.append(line)
        }
        out.append("The ranking is measured. The profit is not: it was tested in one market period, "
                   + "a crypto bear where shorts were the better side before any rule was applied.")
        return out
    }

    /// What a typical trade risks, in money — the anchor everything else is quoted against.
    private var typicalR: Double? {
        guard let equity = book?.equity, equity > 0,
              let cap = book?.structure?.maxRiskPerTrade, cap > 0 else { return nil }
        return equity * cap
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

    /// The grade for a row, from the book's per-side ship verdicts. See `OpportunityCopy.grade`.
    private func grade(_ o: WorkerOpportunitiesService.Opportunity)
        -> OpportunityCopy.Grade {
        let head = o.direction.uppercased() == "LONG" ? book?.model?.heads?.long
                                                      : book?.model?.heads?.short
        var feeShare: Double? = nil
        if let fee = o.feeBurdenR, let gross = o.grossExpectedValueR, gross > 0 {
            feeShare = fee / gross
        }
        return OpportunityCopy.grade(direction: o.direction,
                                     headShippable: head?.shippable,
                                     feeShare: feeShare,
                                     sizeCut: o.crashMultiplier < 1,
                                     moodLabel: mood?.label)
    }

    /// Grey for UNPROVEN is deliberate and follows the colour law: grey is the unmodelled state,
    /// and "the head adds nothing over stale data" is not a hazard, it is an absence of knowledge.
    /// Caution is reserved for a row that IS modelled and carries a live warning.
    private func gradeColor(_ l: OpportunityCopy.Support) -> Color {
        switch l {
        case .validated: return Theme.info
        case .qualified: return Theme.caution
        case .unproven:  return Theme.neutral
        }
    }

    /// "~+$29 average — but 92% of these lose the full stop." Both halves come from the row.
    private func realityLine(_ o: WorkerOpportunitiesService.Opportunity) -> String? {
        guard let money = moneyPerTrade(o) else { return nil }
        let lose = Int(((1 - o.winProbability) * 100).rounded())
        guard lose > 0, lose < 100 else { return "\(money) average per trade" }
        return "\(money) average — but \(lose)% of these lose the full stop"
    }

    private func row(_ o: WorkerOpportunitiesService.Opportunity) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Text(ticker(o.asset)).font(.footnote.weight(.semibold))
                Text(o.direction)
                    .themedPill(o.direction == "LONG" ? Theme.bullish : Theme.bearish)
                Spacer(minLength: 4)
                // THE GRADE LEADS, not the money.
                //
                // Money led here until 2026-08-28, on the reasoning that dollars beat a unit the
                // app invented for itself. Both were wrong for the same reason: a per-row FIGURE
                // — in any unit — says the model ranks these, and it does not. Its own caveat is
                // "median of zero, mostly nothing, occasionally a large hit" at a 7.6% hit rate.
                // What genuinely separates rows is whether the head behind this DIRECTION passed
                // its ship test, so that is what the row leads with.
                Text(grade(o).level.headline)
                    .themedPill(gradeColor(grade(o).level))
            }

            (Text(Formatters.formatPrice(o.entry)).foregroundStyle(.primary)
             + Text("  →  ").foregroundStyle(.tertiary)
             + Text(Formatters.formatPrice(o.target)).foregroundStyle(.secondary)
             + Text("  ·  ").foregroundStyle(.tertiary)
             + Text("stop \(Formatters.formatPrice(o.stop)), \(String(format: "%.1f", o.stopDistancePercent))%")
                .foregroundStyle(.secondary))
                .font(Theme.mono)

            // The facts BEHIND the grade, each one shown so the label can be checked rather than
            // trusted. A grade whose inputs are hidden is a score wearing a word.
            VStack(alignment: .leading, spacing: 3) {
                ForEach(grade(o).facts) { f in
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text(f.ok ? "✓" : "!")
                            .font(Theme.frame)
                            .foregroundStyle(f.ok ? Theme.info : Theme.caution)
                        Text(f.text).font(Theme.frame)
                            .foregroundStyle(f.ok ? .secondary : Theme.caution)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            // The money, demoted and carrying the thing that makes it honest. An average of +$29
            // reads as "a small win each time"; it is a rare large winner paying for a long run of
            // full losses, and the row has to say so or the average lies.
            if let line = realityLine(o) {
                Text(line).font(Theme.frame).foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Line exists ONLY when something changed the price for THIS row. A caveat that
            // applies to every row belongs in the frame, not here. (The size cut is now a graded
            // fact above, so it is no longer repeated here.)
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
        // Only on a row you could actually take. When the mood has already cancelled it, "they
        // disagree — neither is verified" hands the user an arbitration to perform between two
        // things that are both declining, which is worse than saying nothing.
        guard !moodCancels(o),
              let setup = service.cachedResults[o.asset]?.tradeSetups.first,
              setup.direction != o.direction else { return nil }
        return "Your last AI read on \(ticker(o.asset)) called it \(setup.direction). "
             + "They disagree — neither is verified."
    }

    /// Why the size was cut, without claiming the gauge is alarmed when it is not.
    ///
    /// The sizing curve and the warning fire at DIFFERENT thresholds by design (`crash.ts`): sizing
    /// steps down above 0.30 because that is what T8 validated, while a warning needs 0.08 over the
    /// 41% base rate, because at 0.30 nearly every symbol clears it on an ordinary day and six
    /// alerts reading 41/41/43/41/50/39% is "today is normal" dressed as an alarm.
    ///
    /// So a cut with no warning is the COMMON case, and the first live run hit it: BTC read 39%
    /// against a 41% base and the line said "-2 points above a normal day" — a negative number
    /// inside the word "above", asserting an elevation that was not there. Below the warning margin
    /// the line now states the reading against the base and names the curve as the cause.
    private func sizeCutLine(_ o: WorkerOpportunitiesService.Opportunity) -> String? {
        let pct = Int((o.crashMultiplier * 100).rounded())
        guard let reading = book?.crashReadings?.first(where: { $0.asset == o.asset }),
              let base = book?.crashModel?.baseRate else {
            return "Size cut to \(pct)% for drawdown risk."
        }
        let read = Int((reading.probability * 100).rounded())
        let normal = Int((base * 100).rounded())
        let over = read - normal
        if over >= 8 {
            return "Size cut to \(pct)% — drawdown risk \(read)%, \(over) points above a normal day."
        }
        return "Size cut to \(pct)% — drawdown risk reads \(read)% against a normal day's "
             + "\(normal)%. Sizing steps down earlier than the gauge warns."
    }

    // MARK: - 5 · Book total
    //
    // The best number in the payload, and nothing has ever displayed it. Five correlated crypto
    // positions are not five bets — crypto ρ̄ measured 0.62, which makes them about 1.5.

    @ViewBuilder
    private var bookTotal: some View {
        // Two positions minimum, or the sentence is about correlation between a thing and itself:
        // the first live run rendered "about 1 independent bets, not 1 — these move together."
        // `totals` is computed over ALL accepted candidates, including the sub-floor ones the
        // endpoint filters out and re-serves as `nearMiss`, and before any mood cancellation. So it
        // said "if you took all 3" over two cards. Only claim it when it describes what is drawn.
        if let t = book?.totals, t.positions > 1, t.positions == ranked.count {
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
        let stopped = stoppedBeforeScoring.count
        guard stopped > 0 else { return "Everything I checked got a price." }
        return "\(stopped) couldn't be priced — see why"
    }

    // MARK: - 7 · Drawdown gauge
    //
    // A PERMANENT slot with a reading that always changes, so it cannot become wallpaper. There is
    // no all-clear and no green here: the gauge sat silent through five 20-28% falls, so a quiet
    // reading is a documented property, not a safe signal. It gets a full-width hairline rather
    // than a leading stripe — deliberately a different geometry to a proposal.

    @ViewBuilder
    private var drawdownGauge: some View {
        // The HIGH warning is rendered inside this block, so gating the whole gauge on a field
        // introduced in the same deploy meant that during the install-before-redeploy window — which
        // every worker change in this project treats as a separate step — a HIGH crash warning
        // rendered NOWHERE, after `DrawdownRiskCard` was deleted for keying on a field the old box
        // already served. Fall back to the warnings when the readings are absent.
        let fallbackReadings = (book?.crashWarnings ?? []).map {
            WorkerOpportunitiesService.CrashReading(asset: $0.asset, probability: $0.probability)
        }
        if let base = book?.crashModel?.baseRate,
           case let readings = (book?.crashReadings?.isEmpty == false
                                ? book!.crashReadings! : fallbackReadings),
           !readings.isEmpty {
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
                Text("Not ranked")
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
                // Only when a long is actually among the rows — it rendered under an all-SHORT list,
                // explaining a case that was not on screen.
                if let long = book?.model?.baseWinRate?.long,
                   notRanked.contains(where: { $0.line.contains("Long") }) {
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
                    // A signed zero is not a small loss. `%+.1f` renders -0.04 as "-0.0R" in the
                    // bearish colour, which is the one number on this screen a user reads as P&L.
                    let flat = abs(r) < 0.05
                    Text(flat ? "flat" : rText(r, decimals: 1))
                        .font(Theme.mono).fontWeight(.medium)
                        .foregroundStyle(flat ? Color.secondary : Theme.forChange(r))
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
        let best = t.outcome.maxFavorable / risk, worst = abs(t.outcome.maxAdverse) / risk
        // A position the cron has not yet walked has no excursion, and "best +0.0 · worst −0.0"
        // dresses that absence up as a measurement.
        guard best >= 0.05 || worst >= 0.05 else {
            return t.outcome.breakevenActivated
                ? "no movement yet · stop at break-even"
                : "no movement yet — opened \(ageText(t.timestamp))"
        }
        var parts = ["best \(String(format: "%+.1f", best))",
                     "worst \(String(format: "%+.1f", -worst))"]
        // NOT "can no longer lose". A break-even exit still pays the round trip, which this same
        // screen prices at 0.171% — larger than the whole per-trade edge at a 2% stop — and it
        // assumes the stop fills at its price, which a gap does not guarantee.
        parts.append(t.outcome.breakevenActivated
                     ? "stop at break-even — worst case is now roughly the fees"
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
        } else if let at = book?.at, let o = book?.opportunities.first(where: { $0.asset == t.symbol }),
                  o.entry > 0,
                  Date().timeIntervalSince1970 - at / 1000 < 1800 {
            // Same 30-minute guard as the branch above. Without it this reached for the scan-time
            // close on a book fetched once per appearance, so leaving the app open through a move
            // rendered a confident unrealised R — in green or red — against an hours-old price.
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
        let risk = UserDefaults.standard.object(forKey: "riskPercent") as? Double
        async let fetched = WorkerOpportunitiesService.fetch(symbols: syms,
                                                            equity: equity > 0 ? equity : 28000,
                                                            feePercent: fee, riskPercent: risk)
        // PULL THE SNAPSHOT, don't just read it. `openPositionsAsync` reads a cached file whose only
        // writer is `refresh()`, and Scan is now the LAUNCH tab — so a user who opens the app and
        // stays here got one refresh at launch and none after, including on pull-to-refresh. A
        // position that stopped out stayed under "Open" indefinitely with a live-looking R, in the
        // one section whose whole claim is that it shows money that exists.
        async let refreshed: Void = OutcomeTracker.refresh()
        // The book lands FIRST and unblocks the screen. Awaiting the tracked-setups refresh before
        // assigning it meant a stalled `/tracked-setups` held the landing screen on "SCANNING…" for
        // its whole timeout with the book already in memory.
        book = await fetched
        loaded = true
        await refreshed
        openPositions = await OutcomeTracker.openPositionsAsync()
    }

    // MARK: - Formatting

    private func ageText(_ d: Date) -> String {
        let m = Int(Date().timeIntervalSince(d) / 60)
        if m < 60 { return "\(max(1, m))m ago" }
        let h = m / 60
        return h < 24 ? "\(h)h ago" : "\(h / 24)d ago"
    }

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
