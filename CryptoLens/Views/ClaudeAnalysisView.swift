import SwiftUI

struct ClaudeAnalysisView: View {
    let markdown: String
    var aiLoadingPhase: AnalysisService.AILoadingPhase = .idle
    var isStale: Bool = false
    var onRunAnalysis: (() -> Void)?

    private var isAILoading: Bool { aiLoadingPhase != .idle }

    private var phaseLabel: String {
        switch aiLoadingPhase {
        case .idle: return ""
        case .preparingPrompt: return "Preparing analysis..."
        case .waitingForResponse: return "Waiting for Claude..."
        case .parsingResponse: return "Processing response..."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Analysis", systemImage: "text.quote")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                Spacer()
                if isStale && !isAILoading && !markdown.isEmpty && !markdown.contains("not configured") {
                    Button {
                        onRunAnalysis?()
                    } label: {
                        HStack(spacing: 4) {
                            Text("Outdated")
                                .font(.caption2)
                                .fontWeight(.semibold)
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 9, weight: .bold))
                        }
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.orange.opacity(0.12), in: Capsule())
                    }
                    .buttonStyle(.borderless)
                }
            }

            if markdown.isEmpty && !isAILoading {
                VStack(spacing: 10) {
                    Image(systemName: "brain")
                        .font(.title2)
                        .foregroundStyle(.tertiary)
                    Text("No AI analysis yet")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let onRunAnalysis {
                        Button {
                            onRunAnalysis()
                        } label: {
                            Label("Run Analysis", systemImage: "sparkles")
                                .font(.subheadline)
                                .fontWeight(.semibold)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            } else if markdown.contains("not configured") {
                Text(markdown)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ZStack(alignment: .top) {
                    if !markdown.isEmpty {
                        MarkdownContentView(markdown: cleanedMarkdown)
                            .opacity(isAILoading ? 0.3 : 1.0)
                    }

                    if isAILoading {
                        VStack(spacing: 12) {
                            ProgressView()
                                .controlSize(.regular)
                            Text(phaseLabel)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            // Shimmer skeleton lines
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(0..<4, id: \.self) { i in
                                    RoundedRectangle(cornerRadius: 4)
                                        .fill(Color(.systemGray5))
                                        .frame(height: 12)
                                        .frame(maxWidth: [280, 220, 260, 180][i])
                                        .shimmer()
                                }
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, markdown.isEmpty ? 0 : 40)
                    }
                }
                .animation(.easeInOut(duration: 0.3), value: isAILoading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    /// Strip the JSON block from Claude's response so users see only the analysis.
    private var cleanedMarkdown: String {
        guard let jsonStart = markdown.range(of: "```json") else { return markdown }
        // Remove from ```json to the end (or to closing ```)
        let before = String(markdown[..<jsonStart.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        if let jsonEnd = markdown.range(of: "```", range: jsonStart.upperBound..<markdown.endIndex) {
            let after = String(markdown[jsonEnd.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            return after.isEmpty ? before : before + "\n\n" + after
        }
        return before
    }
}

/// Renders markdown by splitting into blocks and handling headers, tables, and body text.
private struct MarkdownContentView: View {
    let markdown: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .textSelection(.enabled)
    }

    private enum Block {
        case header(Int, String)   // level, text
        case table([String])       // rows including header
        case text(String)
        case confluenceSection(score: String, details: [Block])
        case collapsibleSection(title: String, summary: String, details: [Block], icon: String = "exclamationmark.triangle")
    }

    private var blocks: [Block] {
        var result = [Block]()
        var currentText = ""
        var tableRows = [String]()

        func flushText() {
            let trimmed = currentText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { result.append(.text(trimmed)) }
            currentText = ""
        }
        func flushTable() {
            if !tableRows.isEmpty { result.append(.table(tableRows)) }
            tableRows = []
        }

        for line in markdown.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("###") {
                flushText(); flushTable()
                result.append(.header(3, String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)))
            } else if trimmed.hasPrefix("##") {
                flushText(); flushTable()
                result.append(.header(2, String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)))
            } else if trimmed.hasPrefix("#") {
                flushText(); flushTable()
                result.append(.header(1, String(trimmed.dropFirst(1)).trimmingCharacters(in: .whitespaces)))
            } else if trimmed.contains("|") && trimmed.hasPrefix("|") {
                flushText()
                // Skip separator rows (---|---)
                if !trimmed.allSatisfy({ $0 == "|" || $0 == "-" || $0 == ":" || $0 == " " }) {
                    tableRows.append(trimmed)
                }
            } else {
                flushTable()
                currentText += line + "\n"
            }
        }
        flushText(); flushTable()
        return groupConfluence(result)
    }

    /// Groups confluence + conflict report sections into collapsible blocks.
    private func groupConfluence(_ blocks: [Block]) -> [Block] {
        var output = [Block]()
        var i = 0
        while i < blocks.count {
            let block = blocks[i]
            if case .header(let level, let text) = block {
                let lower = text.lowercased()

                if lower.contains("confluence") {
                    var details = [Block]()
                    // Try extracting score from the header itself first
                    var scoreText = extractScore(from: text)
                    i += 1
                    while i < blocks.count {
                        if case .header(let lvl, _) = blocks[i], lvl <= level { break }
                        // Try text blocks
                        if scoreText == "Score", case .text(let t) = blocks[i] {
                            let extracted = extractScore(from: t)
                            if extracted != "Score" { scoreText = extracted }
                        }
                        // Try table cells (score might be in a "Total" row)
                        if scoreText == "Score", case .table(let rows) = blocks[i] {
                            for row in rows {
                                let extracted = extractScore(from: row)
                                if extracted != "Score" { scoreText = extracted; break }
                            }
                        }
                        details.append(blocks[i])
                        i += 1
                    }
                    output.append(.confluenceSection(score: scoreText, details: details))

                } else if lower.contains("conflict") {
                    var details = [Block]()
                    var conflictCount = 0
                    i += 1
                    while i < blocks.count {
                        if case .header(let lvl, _) = blocks[i], lvl <= level { break }
                        // Count conflicts from tables and text
                        switch blocks[i] {
                        case .table(let rows):
                            // Use the highest number in the first column as the count
                            var maxNum = 0
                            for row in rows.dropFirst() {
                                let firstCell = row.split(separator: "|").first?
                                    .trimmingCharacters(in: .whitespaces) ?? ""
                                if let num = Int(firstCell) { maxNum = max(maxNum, num) }
                            }
                            conflictCount = max(conflictCount, maxNum > 0 ? maxNum : rows.count - 1)
                        case .text(let t):
                            for line in t.components(separatedBy: "\n") {
                                let trimmed = line.trimmingCharacters(in: .whitespaces)
                                if trimmed.hasPrefix("-") || trimmed.hasPrefix("•") {
                                    conflictCount += 1
                                }
                            }
                        default: break
                        }
                        details.append(blocks[i])
                        i += 1
                    }
                    let summary = conflictCount > 0 ? "\(conflictCount) conflict\(conflictCount == 1 ? "" : "s") found" : "No conflicts"
                    output.append(.collapsibleSection(title: "Conflict Report", summary: summary, details: details, icon: "exclamationmark.triangle"))

                } else if isCollapsibleHeader(lower) {
                    let (icon, title, summaryExtractor) = collapsibleMeta(for: lower, originalTitle: text)
                    var details = [Block]()
                    i += 1
                    while i < blocks.count {
                        if case .header(let lvl, _) = blocks[i], lvl <= level { break }
                        details.append(blocks[i])
                        i += 1
                    }
                    let summary = summaryExtractor(details)
                    output.append(.collapsibleSection(title: title, summary: summary, details: details, icon: icon))

                } else {
                    output.append(block)
                    i += 1
                }
            } else if case .text(let content) = block,
                      (content.contains("STATUS: NO VALID SETUP") || content.contains("NO VALID SETUP")) {
                // Wrap the no-valid-setup text block as a collapsible verdict
                var details = [block]
                i += 1
                // Grab following text blocks that are part of the verdict (reason, conditions, alerts)
                while i < blocks.count {
                    if case .header(_, _) = blocks[i] { break }
                    details.append(blocks[i])
                    i += 1
                }
                output.append(.collapsibleSection(title: "Verdict", summary: "No valid setup", details: details, icon: "hand.raised"))
            } else {
                output.append(block)
                i += 1
            }
        }
        return output
    }

    private func isCollapsibleHeader(_ lower: String) -> Bool {
        lower.contains("trade setup") || lower.contains("setup evaluation") ||
        lower.contains("verdict") || lower.contains("market bias") ||
        lower.contains("what would create") || lower.contains("suggested alert") ||
        lower.contains("no valid setup") || lower.contains("status")
    }

    /// Strip leading "1. ", "2. ", "3) " etc. from a title.
    private func stripOrdinal(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        // Match patterns like "1. ", "2. ", "3) ", "4 - "
        if let range = trimmed.range(of: #"^\d+[\.\)\-]\s*"#, options: .regularExpression) {
            return String(trimmed[range.upperBound...])
        }
        return trimmed
    }

    private func collapsibleMeta(for lower: String, originalTitle: String) -> (icon: String, title: String, summaryExtractor: ([Block]) -> String) {
        let cleanTitle = stripOrdinal(originalTitle)
        if lower.contains("trade setup") || lower.contains("setup evaluation") {
            let direction = lower.contains("long") ? "Long" : (lower.contains("short") ? "Short" : "")
            return (
                lower.contains("long") ? "arrow.up.right" : (lower.contains("short") ? "arrow.down.right" : "chart.line.uptrend.xyaxis"),
                cleanTitle,
                { details in
                    let allText = details.compactMap { if case .text(let t) = $0 { return t } else { return nil } }.joined()
                    if allText.lowercased().contains("no valid") || allText.lowercased().contains("disqualified") {
                        return "No valid setup"
                    }
                    return direction.isEmpty ? "Tap to view" : "\(direction) setup"
                }
            )
        }
        if lower.contains("verdict") || lower.contains("market bias") {
            return ("scalemass", cleanTitle, { _ in "Tap to view" })
        }
        if lower.contains("what would create") {
            return ("lightbulb", cleanTitle, { _ in "Conditions to watch" })
        }
        if lower.contains("suggested alert") {
            return ("bell", cleanTitle, { _ in "Levels to watch" })
        }
        if lower.contains("no valid setup") || lower.contains("status") {
            return ("hand.raised", "Verdict", { _ in "No valid setup" })
        }
        return ("doc.text", cleanTitle, { _ in "Tap to view" })
    }

    private func extractScore(from text: String) -> String {
        // Find patterns like "7/10 Bearish" or "CONFLUENCE SCORE: 5/10 Bearish"
        let pattern = #"(-?\d+)/10\s*(\w+)"#
        if let match = text.range(of: pattern, options: .regularExpression) {
            return String(text[match])
        }
        // Try just "X/10"
        let simple = #"\d+/10"#
        if let match = text.range(of: simple, options: .regularExpression) {
            return String(text[match])
        }
        return "Score"
    }

    @ViewBuilder
    private func blockView(_ block: Block) -> some View {
        switch block {
        case .header(let level, let text):
            let setupType = setupType(for: text)
            if setupType != .none {
                setupHeader(text: text, type: setupType)
            } else if isNoSetupHeader(text) {
                noSetupHeader(text: text)
            } else {
                Text(inlineMarkdown(text))
                    .font(level == 1 ? .title3 : (level == 2 ? .subheadline : .caption))
                    .fontWeight(.bold)
                    .foregroundStyle(level <= 2 ? .primary : .secondary)
                    .padding(.top, level <= 2 ? 4 : 2)
            }

        case .confluenceSection(let score, let details):
            CollapsibleBlock(title: "Confluence Score", summary: score == "Score" ? "" : score, icon: "gauge.medium") {
                ForEach(Array(details.enumerated()), id: \.offset) { _, block in
                    AnyView(blockView(block))
                }
            }

        case .collapsibleSection(let title, let summary, let details, let icon):
            CollapsibleBlock(title: title, summary: summary, icon: icon) {
                ForEach(Array(details.enumerated()), id: \.offset) { _, block in
                    AnyView(blockView(block))
                }
            }

        case .table(let rows):
            TableBlockView(rows: rows)

        case .text(let content):
            let biasT = biasType(for: content)
            if biasT != .none {
                biasCallout(text: content, type: biasT)
            } else if content.contains("STATUS: NO VALID SETUP") || content.contains("NO VALID SETUP") {
                HStack(spacing: 8) {
                    Image(systemName: "hand.raised.fill").font(.title3)
                    Text(inlineMarkdown(content)).font(.subheadline).lineSpacing(3)
                }
                .foregroundStyle(.orange)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            } else if isConfluenceScore(content) {
                Text(inlineMarkdown(content))
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .lineSpacing(3)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 8))
            } else {
                Text(inlineMarkdown(content))
                    .font(.subheadline)
                    .lineSpacing(3)
            }
        }
    }

    private enum SetupType { case long, short, none }

    private func setupType(for text: String) -> SetupType {
        let lower = text.lowercased()
        if lower.contains("long") && (lower.contains("setup") || lower.contains("scenario") || lower.contains("trade")) {
            return .long
        }
        if lower.contains("short") && (lower.contains("setup") || lower.contains("scenario") || lower.contains("trade")) {
            return .short
        }
        return .none
    }

    private func setupHeader(text: String, type: SetupType) -> some View {
        let color: Color = type == .long ? .green : .red
        let icon = type == .long ? "arrow.up.right" : "arrow.down.right"
        return HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption)
                .fontWeight(.bold)
            Text(inlineMarkdown(text))
                .font(.subheadline)
                .fontWeight(.bold)
        }
        .foregroundStyle(color)
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        .padding(.top, 6)
    }

    private func isNoSetupHeader(_ text: String) -> Bool {
        let lower = text.lowercased()
        return lower.contains("no valid setup") || lower.contains("no trade") || lower.contains("stand aside")
    }

    private func noSetupHeader(text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "hand.raised")
                .font(.caption).fontWeight(.bold)
            Text(inlineMarkdown(text))
                .font(.subheadline).fontWeight(.bold)
        }
        .foregroundStyle(.orange)
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        .padding(.top, 6)
    }

    private func biasType(for text: String) -> SetupType {
        let lower = text.lowercased()
        // Match lines like "**Bias: LONG**" or "Bias: SHORT"
        guard lower.contains("bias") else { return .none }
        let hasBiasKeyword = lower.contains("bias:") || lower.contains("bias —") || lower.contains("bias -")
        guard hasBiasKeyword else { return .none }
        if lower.contains("long") { return .long }
        if lower.contains("short") { return .short }
        return .none
    }

    private func isConfluenceScore(_ text: String) -> Bool {
        text.lowercased().contains("confluence") && text.contains("/10")
    }

    private func biasCallout(text: String, type: SetupType) -> some View {
        let color: Color = type == .long ? .green : .red
        let icon = type == .long ? "arrow.up.right.circle.fill" : "arrow.down.right.circle.fill"
        return HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.title3)
            Text(inlineMarkdown(text))
                .font(.subheadline)
                .fontWeight(.semibold)
        }
        .foregroundStyle(color)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
        .padding(.top, 4)
    }

    private func inlineMarkdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}

/// Generic collapsible section used for all collapsible blocks.
private struct CollapsibleBlock<Content: View>: View {
    let title: String
    let summary: String
    var icon: String = "exclamationmark.triangle"
    @ViewBuilder let content: () -> Content
    @State private var expanded = false

    private var summaryColor: Color {
        let lower = summary.lowercased()
        if lower.contains("bullish") || lower.contains("bull") { return .green }
        if lower.contains("bearish") || lower.contains("bear") { return .red }
        if lower.contains("no conflicts") { return .green }
        if lower.contains("no valid") || lower.contains("conflict") { return .orange }
        if lower.contains("long") { return .green }
        if lower.contains("short") { return .red }
        return .secondary
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.caption)
                Text(title)
                    .font(.subheadline)
                    .fontWeight(.bold)
                if !summary.isEmpty {
                    Text("· \(summary)")
                        .font(.caption)
                        .foregroundStyle(summaryColor)
                }
                Spacer()
                Text(expanded ? "Hide" : "Details")
                    .font(.caption2)
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.caption2)
            }
            .foregroundStyle(.secondary)
            .padding(.vertical, 8)
            .padding(.horizontal, 10)
            .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
            .onTapGesture {
                withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
            }

            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    content()
                }
                .padding(.top, 8)
                .transition(.opacity)
            }
        }
    }
}

private struct TableBlockView: View {
    let rows: [String]

    private func inlineCell(_ text: String) -> AttributedString {
        let cleaned = text.replacingOccurrences(of: "**", with: "")
        return (try? AttributedString(markdown: cleaned, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(cleaned)
    }

    private func cells(from row: String) -> [String] {
        row.split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    private func rowAccent(_ firstCell: String) -> (color: Color, bg: Color)? {
        let lower = firstCell.lowercased()
        if lower.contains("entry") { return (.accentColor, .accentColor.opacity(0.08)) }
        if lower.contains("stop") || lower == "sl" { return (.red, .red.opacity(0.08)) }
        if lower.contains("tp") || lower.contains("take profit") || lower.contains("target") {
            return (.green, .green.opacity(0.08))
        }
        return nil
    }

    /// Detect if first column is narrow (numbers, short labels like "#", "Level")
    private var firstColIsNarrow: Bool {
        guard let headerCols = rows.first.map({ cells(from: $0) }), let first = headerCols.first else { return false }
        return first.count <= 5 // "#", "1", "Level" etc.
    }

    /// Detect if last column is narrow (short labels like "R:R", "Score")
    private var lastColIsNarrow: Bool {
        guard let headerCols = rows.first.map({ cells(from: $0) }), let last = headerCols.last else { return false }
        return last.count <= 8
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { idx, row in
                let cols = cells(from: row)
                let accent = idx > 0 ? rowAccent(cols.first ?? "") : nil
                let colCount = cols.count
                HStack(spacing: 0) {
                    ForEach(Array(cols.enumerated()), id: \.offset) { cIdx, cell in
                        let isFirst = cIdx == 0
                        let isLast = cIdx == colCount - 1
                        let narrow = (isFirst && firstColIsNarrow) || (isLast && lastColIsNarrow && colCount > 2)
                        Text(inlineCell(cell))
                            .font(.caption)
                            .fontWeight(idx == 0 || isFirst ? .bold : .regular)
                            .foregroundStyle(isFirst && accent != nil ? accent!.color : .primary)
                            .frame(maxWidth: narrow ? 50 : .infinity, alignment: isFirst ? .leading : (isLast ? .trailing : .leading))
                            .padding(.vertical, 4)
                            .padding(.horizontal, 6)
                    }
                }
                .background(
                    idx == 0 ? Color(.systemGray5) :
                    accent?.bg ?? (idx % 2 == 0 ? Color(.systemGray6) : .clear)
                )
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(.systemGray4), lineWidth: 0.5))
    }
}
