import XCTest
import CoreGraphics
@testable import MarketScope

/// The pinch decomposition is the one gesture path with no UI-test coverage — XCUIElement.pinch
/// only spreads fingers vertically, so a real horizontal (widen-bars) pinch is never synthesized
/// on the simulator. These tests drive PinchAxisTracker with synthetic finger tracks so the
/// decomposition is verified deterministically instead of by hand-reasoning.
final class PinchAxisTrackerTests: XCTestCase {

    /// Cumulative product of the per-step scales for one axis.
    private func run(_ track: [(CGPoint, CGPoint)], axis: KeyPath<(t: CGFloat, p: CGFloat), CGFloat>) -> CGFloat {
        var tr = PinchAxisTracker(track[0].0, track[0].1)
        var product: CGFloat = 1
        for i in 1..<track.count { product *= tr.update(track[i].0, track[i].1)[keyPath: axis] }
        return product
    }

    func testHorizontalSpreadZoomsTimeNotPrice() {
        // Fingers side-by-side, spreading apart horizontally, y fixed. This is "make bars wider".
        var track: [(CGPoint, CGPoint)] = []
        for i in 0...10 {
            let half = 40 + CGFloat(i) * 12   // separation grows 80 → 320
            track.append((CGPoint(x: 195 - half, y: 300), CGPoint(x: 195 + half, y: 300)))
        }
        let timeProduct = run(track, axis: \.t)
        let priceProduct = run(track, axis: \.p)
        XCTAssertGreaterThan(timeProduct, 1.5, "horizontal spread must zoom TIME (bars wider), got \(timeProduct)")
        XCTAssertEqual(priceProduct, 1, accuracy: 0.001, "horizontal spread must NOT zoom price, got \(priceProduct)")
    }

    func testHorizontalPinchInZoomsTimeOut() {
        // Fingers coming together horizontally → time factor < 1 (more bars visible).
        var track: [(CGPoint, CGPoint)] = []
        for i in 0...10 {
            let half = 320 - CGFloat(i) * 26   // separation shrinks 640 → 120
            track.append((CGPoint(x: 195 - half, y: 300), CGPoint(x: 195 + half, y: 300)))
        }
        let timeProduct = run(track, axis: \.t)
        XCTAssertLessThan(timeProduct, 0.8, "horizontal pinch-in must zoom time OUT (factor < 1), got \(timeProduct)")
    }

    func testVerticalSpreadZoomsPriceNotTime() {
        // Fingers stacked, spreading apart vertically → price only.
        var track: [(CGPoint, CGPoint)] = []
        for i in 0...10 {
            let half = 40 + CGFloat(i) * 12
            track.append((CGPoint(x: 195, y: 300 - half), CGPoint(x: 195, y: 300 + half)))
        }
        XCTAssertGreaterThan(run(track, axis: \.p), 1.5, "vertical spread must zoom PRICE")
        XCTAssertEqual(run(track, axis: \.t), 1, accuracy: 0.001, "vertical spread must NOT zoom time")
    }

    func testDiagonalSpreadZoomsBoth() {
        // A clearly diagonal spread engages both axes.
        var track: [(CGPoint, CGPoint)] = []
        for i in 0...10 {
            let h = 40 + CGFloat(i) * 12
            track.append((CGPoint(x: 195 - h, y: 300 - h), CGPoint(x: 195 + h, y: 300 + h)))
        }
        XCTAssertGreaterThan(run(track, axis: \.t), 1.3, "diagonal must zoom time")
        XCTAssertGreaterThan(run(track, axis: \.p), 1.3, "diagonal must zoom price")
    }

    func testSmallWobbleDoesNotActivateEitherAxis() {
        // Sub-activation jitter on both axes → no scaling at all (hysteresis).
        var track: [(CGPoint, CGPoint)] = [(CGPoint(x: 150, y: 300), CGPoint(x: 240, y: 300))]
        for i in 0...6 {
            let j = CGFloat(i % 2) * 4   // ±4pt wobble, well under the 15pt activation
            track.append((CGPoint(x: 150 - j, y: 300 + j), CGPoint(x: 240 + j, y: 300 - j)))
        }
        XCTAssertEqual(run(track, axis: \.t), 1, accuracy: 0.001, "wobble must not zoom time")
        XCTAssertEqual(run(track, axis: \.p), 1, accuracy: 0.001, "wobble must not zoom price")
    }
}
