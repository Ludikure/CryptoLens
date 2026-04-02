import SwiftUI

struct ClaudeAnalysisView: View {
    let markdown: String
    var aiLoadingPhase: AnalysisService.AILoadingPhase = .idle
    var isStale: Bool = false
    var analysisTimestamp: Date?
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
                if let ts = analysisTimestamp, !isAILoading, !markdown.isEmpty, !markdown.contains("not configured") {
                    Button {
                        onRunAnalysis?()
                    } label: {
                        HStack(spacing: 4) {
                            Text(ts, style: .relative)
                                .font(.caption2)
                                .fontWeight(.semibold)
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 9, weight: .bold))
                        }
                        .foregroundStyle(isStale ? .orange : .secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background((isStale ? Color.orange : Color.secondary).opacity(0.12), in: Capsule())
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
                            Text("Run Analysis")
                                .font(.subheadline)
                                .fontWeight(.semibold)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .center)
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

/// Renders markdown with clean section headers, tables, and styled callouts. No collapsible blocks.
private struct MarkdownContentView: View {
    let markdown: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .textSelection(.enabled)
    }

    private enum Block {
        case header(Int, String)
        case table([String])
        case text(String)
        case divider
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

            if trimmed == "---" || trimmed == "***" {
                flushText(); flushTable()
                result.append(.divider)
            } else if trimmed.hasPrefix("###") {
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
                if !trimmed.allSatisfy({ $0 == "|" || $0 == "-" || $0 == ":" || $0 == " " }) {
                    tableRows.append(trimmed)
                }
            } else {
                flushTable()
                currentText += line + "\n"
            }
        }
        flushText(); flushTable()
        return result
    }

    @ViewBuilder
    private func blockView(_ block: Block) -> some View {
        switch block {
        case .divider:
            Divider().padding(.vertical, 4)

        case .header(let level, let text):
            sectionHeader(text: text, level: level)

        case .table(let rows):
            TableBlockView(rows: rows)

        case .text(let content):
            let biasT = biasType(for: content)
            if biasT != .none {
                biasCallout(text: content, type: biasT)
            } else {
                Text(inlineMarkdown(content))
                    .font(.subheadline)
                    .lineSpacing(4)
            }
        }
    }

    // MARK: - Section Headers

    @ViewBuilder
    private func sectionHeader(text: String, level: Int) -> some View {
        let lower = text.lowercased()

        if lower.contains("long") && (lower.contains("setup") || lower.contains("trade")) {
            // Long setup header
            taggedHeader(text: text, icon: "arrow.up.right", color: .green)
        } else if lower.contains("short") && (lower.contains("setup") || lower.contains("trade")) {
            // Short setup header
            taggedHeader(text: text, icon: "arrow.down.right", color: .red)
        } else if lower.contains("no valid") || lower.contains("no trade") || lower.contains("stand aside") {
            taggedHeader(text: text, icon: "hand.raised", color: .orange)
        } else if level <= 2 {
            // Major section header with accent bar
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color.accentColor)
                    .frame(width: 3, height: 16)
                Text(inlineMarkdown(text))
                    .font(level == 1 ? .subheadline : .subheadline)
                    .fontWeight(.bold)
            }
            .padding(.top, 8)
        } else {
            Text(inlineMarkdown(text))
                .font(.caption)
                .fontWeight(.bold)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
        }
    }

    private func taggedHeader(text: String, icon: String, color: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption).fontWeight(.bold)
            Text(inlineMarkdown(text))
                .font(.subheadline).fontWeight(.bold)
        }
        .foregroundStyle(color)
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        .padding(.top, 6)
    }

    // MARK: - Bias Callout

    private enum BiasType { case long, short, none }

    private func biasType(for text: String) -> BiasType {
        let lower = text.lowercased()
        guard lower.contains("bias") else { return .none }
        guard lower.contains("bias:") || lower.contains("bias —") || lower.contains("bias -") else { return .none }
        if lower.contains("long") { return .long }
        if lower.contains("short") { return .short }
        return .none
    }

    private func biasCallout(text: String, type: BiasType) -> some View {
        let color: Color = type == .long ? .green : .red
        let icon = type == .long ? "arrow.up.right.circle.fill" : "arrow.down.right.circle.fill"
        return HStack(spacing: 8) {
            Image(systemName: icon).font(.title3)
            Text(inlineMarkdown(text)).font(.subheadline).fontWeight(.semibold)
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
