import XCTest

/// End-to-end verification of the fully-native chart gesture recognizer with REAL synthesized
/// touches on the simulator. Each gesture is asserted by pixel-diffing the webview before/after:
/// gestures that must move the chart require a large diff; the dead vertical body-drag requires
/// a small one. This is the harness the JS-only Playwright checks could never provide — it
/// exercises WebChartView's ChartGestureRecognizer, the zone routing, and the JS bridge together.
final class ChartGesturesUITests: XCTestCase {

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = true   // gather ALL gesture diffs per run
        app = XCUIApplication()
        app.launch()
    }

    func testChartGestures() throws {
        // ── Navigate to the Chart tab ──
        let chartTab = app.buttons["Chart"].firstMatch
        XCTAssertTrue(chartTab.waitForExistence(timeout: 20), "Chart tab button not found")
        chartTab.tap()

        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 30), "chart webview did not appear")

        // Wait for candles to render (worker data fetch + first paint).
        sleep(10)
        let base = shot(web, name: "0-loaded")
        // Sanity: the chart must actually be painted (candles = many non-background pixels).
        XCTAssertGreaterThan(colorfulness(base), 0.02, "chart appears blank — no data rendered?")

        // ── 1. One-finger horizontal drag on the BODY must pan ──
        // Body point: upper-left region of the main pane (clear of axis strips and dividers).
        let a = web.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.25))
        let b = web.coordinate(withNormalizedOffset: CGVector(dx: 0.20, dy: 0.25))
        a.press(forDuration: 0.05, thenDragTo: b, withVelocity: .default, thenHoldForDuration: 0.1)
        logBadge("after-hpan")
        sleep(2)   // let the momentum glide settle
        let afterPan = shot(web, name: "1-after-hpan")
        let panDiff = diff(base, afterPan)
        NSLog("GESTURE-TEST pan diff = %.4f", panDiff)
        XCTAssertGreaterThan(panDiff, 0.05, "horizontal body drag did NOT pan the chart")

        // ── 2. Pinch on the body must zoom (bars wider) ──
        // XCUIElement.pinch centers on the element; the main pane spans the top ~55-60% with the
        // default RSI+MACD panels, so pinch a child rect biased to the upper half via the
        // element itself (center ~0.5 is still inside the main pane).
        let prePinch = shot(web, name: "2-pre-pinch")
        web.pinch(withScale: 2.2, velocity: 2.0)
        logBadge("after-pinch-out")
        sleep(1)
        let afterPinch = shot(web, name: "3-after-pinch")
        let pinchDiff = diff(prePinch, afterPinch)
        NSLog("GESTURE-TEST pinch-out diff = %.4f", pinchDiff)
        XCTAssertGreaterThan(pinchDiff, 0.05, "pinch-out did NOT zoom the chart")

        // Pinch back in (zoom out) must also work.
        let prePinchIn = afterPinch
        web.pinch(withScale: 0.4, velocity: -2.0)
        sleep(1)
        let afterPinchIn = shot(web, name: "4-after-pinch-in")
        let pinchInDiff = diff(prePinchIn, afterPinchIn)
        NSLog("GESTURE-TEST pinch-in diff = %.4f", pinchInDiff)
        XCTAssertGreaterThan(pinchInDiff, 0.05, "pinch-in did NOT zoom the chart back out")

        // ── 3. Vertical drag on the body must do (almost) nothing ──
        let preDead = shot(web, name: "5-pre-deadvert")
        let v1 = web.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.15))
        let v2 = web.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.45))
        v1.press(forDuration: 0.05, thenDragTo: v2, withVelocity: .default, thenHoldForDuration: 0.1)
        sleep(1)
        let afterDead = shot(web, name: "6-after-deadvert")
        let deadDiff = diff(preDead, afterDead)
        NSLog("GESTURE-TEST dead-vertical diff = %.4f", deadDiff)
        XCTAssertLessThan(deadDiff, 0.04, "vertical body drag CHANGED the chart (should be a no-op)")

        // ── 4. Price-axis vertical drag must stretch the price scale ──
        let preAxis = shot(web, name: "7-pre-priceaxis")
        let p1 = web.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.15))
        let p2 = web.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.45))
        p1.press(forDuration: 0.05, thenDragTo: p2, withVelocity: .default, thenHoldForDuration: 0.1)
        sleep(1)
        let afterAxis = shot(web, name: "8-after-priceaxis")
        let axisDiff = diff(preAxis, afterAxis)
        NSLog("GESTURE-TEST price-axis diff = %.4f", axisDiff)
        XCTAssertGreaterThan(axisDiff, 0.03, "price-axis drag did NOT stretch the price scale")

        // ── 5. Time-axis horizontal drag must stretch bar spacing ──
        // (Also the only simulator-drivable time-zoom: XCUIElement.pinch spreads vertically.)
        let preTime = shot(web, name: "9-pre-timeaxis")
        let t1 = web.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.985))
        let t2 = web.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.985))
        t1.press(forDuration: 0.05, thenDragTo: t2, withVelocity: .default, thenHoldForDuration: 0.1)
        sleep(1)
        let afterTime = shot(web, name: "10-after-timeaxis")
        let timeDiff = diff(preTime, afterTime)
        NSLog("GESTURE-TEST time-axis diff = %.4f", timeDiff)
        XCTAssertGreaterThan(timeDiff, 0.04, "time-axis drag did NOT stretch bar spacing")
    }

    /// The chart page renders a #gdbg badge with the recognizer's last event (DEBUG builds).
    /// WebKit exposes DOM text to accessibility — read it back so failures name the routed mode.
    private func logBadge(_ tag: String) {
        let texts = app.webViews.firstMatch.staticTexts.allElementsBoundByIndex.prefix(8)
        let labels = texts.map { $0.label }.filter { !$0.isEmpty }
        NSLog("GESTURE-TEST badge[%@]: %@", tag, labels.joined(separator: " | "))
    }

    // MARK: - Pixel helpers

    /// Screenshot the element, attach it to the test log, return the image.
    private func shot(_ el: XCUIElement, name: String) -> CGImage? {
        let image = el.screenshot().image
        let att = XCTAttachment(image: image)
        att.name = name
        att.lifetime = .keepAlways
        add(att)
        return image.cgImage
    }

    /// Fraction of sampled pixels that differ materially between two images (0…1).
    private func diff(_ a: CGImage?, _ b: CGImage?) -> Double {
        guard let pa = pixels(a), let pb = pixels(b), pa.count == pb.count, !pa.isEmpty else { return 1 }
        var changed = 0
        for i in stride(from: 0, to: pa.count, by: 4) {
            let d = abs(Int(pa[i]) - Int(pb[i])) + abs(Int(pa[i + 1]) - Int(pb[i + 1])) + abs(Int(pa[i + 2]) - Int(pb[i + 2]))
            if d > 30 { changed += 1 }
        }
        return Double(changed) / Double(pa.count / 4)
    }

    /// Fraction of sampled pixels that are not near-background (any channel spread) — a blank
    /// chart is uniform; candles/grid/axis text give variance.
    private func colorfulness(_ img: CGImage?) -> Double {
        guard let px = pixels(img), !px.isEmpty else { return 0 }
        var lively = 0
        for i in stride(from: 0, to: px.count, by: 4) {
            let mx = max(px[i], px[i + 1], px[i + 2]), mn = min(px[i], px[i + 1], px[i + 2])
            if mx - mn > 25 { lively += 1 }   // colored (green/red candles, blue EMA…)
        }
        return Double(lively) / Double(px.count / 4)
    }

    /// Downsample to a fixed grid so device scale / minor AA differences don't dominate.
    private func pixels(_ img: CGImage?) -> [UInt8]? {
        guard let img else { return nil }
        let w = 160, h = 240
        var buf = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8,
                                  bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.interpolationQuality = .low
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        return buf
    }
}
