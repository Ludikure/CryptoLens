import Foundation

struct Candle: Identifiable, Codable {
    let id: UUID
    let time: Date
    let open: Double
    let high: Double
    let low: Double
    let close: Double
    let volume: Double

    init(time: Date, open: Double, high: Double, low: Double, close: Double, volume: Double) {
        self.id = UUID()
        self.time = time
        self.open = open
        self.high = high
        self.low = low
        self.close = close
        self.volume = volume
    }
}
