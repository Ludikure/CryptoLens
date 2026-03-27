import SwiftUI

struct ClaudeAnalysisView: View {
    let markdown: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Analysis", systemImage: "text.quote")
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)

            if markdown.isEmpty {
                Text("Pull down to run Claude analysis")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
            } else if markdown.contains("not configured") {
                Text(markdown)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                MarkdownContentView(markdown: cleanedMarkdown)
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
        return result
    }

    @ViewBuilder
    private func blockView(_ block: Block) -> some View {
        switch block {
        case .header(let level, let text):
            let setupType = setupType(for: text)
            if setupType != .none {
                setupHeader(text: text, type: setupType)
            } else {
                Text(inlineMarkdown(text))
                    .font(level == 1 ? .title3 : (level == 2 ? .subheadline : .caption))
                    .fontWeight(.bold)
                    .foregroundStyle(level <= 2 ? .primary : .secondary)
                    .padding(.top, level <= 2 ? 4 : 2)
            }

        case .table(let rows):
            TableBlockView(rows: rows)

        case .text(let content):
            let biasType = biasType(for: content)
            if biasType != .none {
                biasCallout(text: content, type: biasType)
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

/// Renders a markdown table as a grid with trade-level coloring.
private struct TableBlockView: View {
    let rows: [String]

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

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { idx, row in
                let cols = cells(from: row)
                let accent = idx > 0 ? rowAccent(cols.first ?? "") : nil
                HStack(spacing: 0) {
                    ForEach(Array(cols.enumerated()), id: \.offset) { cIdx, cell in
                        Text(cell)
                            .font(.caption)
                            .fontWeight(idx == 0 || cIdx == 0 ? .bold : .regular)
                            .foregroundStyle(cIdx == 0 && accent != nil ? accent!.color : (idx == 0 ? .primary : .primary))
                            .frame(maxWidth: .infinity, alignment: cIdx == 0 ? .leading : .trailing)
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
