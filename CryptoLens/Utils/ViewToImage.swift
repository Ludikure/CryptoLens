import SwiftUI

/// Renders an AnalysisSnapshotView as a UIImage for sharing.
/// The share button in AnalysisView.swift needs to be updated to call this
/// and present a UIActivityViewController with the resulting image.
@MainActor
func renderAnalysisImage(result: AnalysisResult) -> UIImage? {
    let view = AnalysisSnapshotView(result: result)
    let renderer = ImageRenderer(content: view)
    renderer.scale = 3.0 // @3x for crisp output
    return renderer.uiImage
}

@MainActor
func renderAnalysisPDF(result: AnalysisResult) -> Data? {
    guard let image = renderAnalysisImage(result: result) else { return nil }
    let pageRect = CGRect(x: 0, y: 0, width: image.size.width, height: image.size.height)
    let renderer = UIGraphicsPDFRenderer(bounds: pageRect)
    return renderer.pdfData { context in
        context.beginPage()
        image.draw(in: pageRect)
    }
}
