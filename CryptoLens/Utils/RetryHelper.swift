import Foundation

enum RetryHelper {
    static func withRetry<T>(maxAttempts: Int = 3, backoff: [TimeInterval] = [1, 2, 4], operation: () async throws -> T) async throws -> T {
        guard maxAttempts > 0 else {
            throw CancellationError()
        }
        var lastError: Error?
        for attempt in 0..<maxAttempts {
            do {
                return try await operation()
            } catch {
                lastError = error
                if attempt < maxAttempts - 1 {
                    let delay = attempt < backoff.count ? backoff[attempt] : backoff.last ?? 1
                    try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                }
            }
        }
        throw lastError!
    }
}
