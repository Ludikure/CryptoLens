import Foundation

/// Runs `/full-analysis` on a **background** `URLSession` so the request survives the app being
/// backgrounded or suspended mid-call. The server LLM call (Claude + extended thinking) takes
/// ~30-90s; with the default `URLSession.shared` a screen-lock backgrounds the app and iOS
/// suspends the in-flight task within seconds, failing the analysis. A background session is
/// owned by the system `nsurlsessiond` daemon, not the app process — the request keeps running
/// while the app is suspended, and the delegate fires when the app is resumed.
///
/// We bridge the delegate callbacks back to `async/await` via a continuation. App *suspension*
/// freezes the process (it does not kill it), so the awaiting `runFullAnalysis` frame — including
/// its locally-computed indicators — is intact on resume, and the existing assembly path just
/// continues. The only unrecoverable case is the OS *terminating* the suspended app before the
/// user returns (rare for a ~90s window); there the completion is delivered to a fresh process
/// with no continuation and is dropped (the next user-initiated run recomputes).
///
/// Background sessions only support upload/download tasks, so the JSON body is written to a temp
/// file and sent via `uploadTask(with:fromFile:)`; the response body arrives through the
/// `URLSessionDataDelegate` methods.
final class BackgroundAnalysisService: NSObject {
    static let shared = BackgroundAnalysisService()

    private static let sessionIdentifier = "com.ludikure.CryptoLens.analysis"

    /// Per-task state, keyed by `URLSessionTask.taskIdentifier`.
    private final class Pending {
        let continuation: CheckedContinuation<WorkerFullAnalysisService.Result, Error>
        let bodyFileURL: URL
        var status: Int = 0
        var data = Data()
        init(_ c: CheckedContinuation<WorkerFullAnalysisService.Result, Error>, _ f: URL) {
            continuation = c; bodyFileURL = f
        }
    }

    private let lock = NSLock()
    private var pending: [Int: Pending] = [:]

    /// Set by the AppDelegate when iOS relaunches the app to deliver background-session events;
    /// invoked once all events have been handled.
    private var systemCompletionHandler: (() -> Void)?

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        config.sessionSendsLaunchEvents = true      // relaunch the app on completion if terminated
        config.isDiscretionary = false              // run ASAP, not at the system's convenience
        config.timeoutIntervalForRequest = 120      // matches the server extended-thinking budget
        config.timeoutIntervalForResource = 180     // hard ceiling for the whole transfer
        config.waitsForConnectivity = true
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1       // serialize delegate callbacks → map is simple
        return URLSession(configuration: config, delegate: self, delegateQueue: queue)
    }()

    /// Call once at launch so the background session is reconstructed and any tasks that
    /// completed while the app was terminated are drained.
    func activate() { _ = session }

    /// Stored by `AppDelegate.application(_:handleEventsForBackgroundURLSession:completionHandler:)`.
    func setSystemCompletionHandler(_ handler: @escaping () -> Void, forIdentifier identifier: String) {
        guard identifier == Self.sessionIdentifier else { return }
        lock.lock(); systemCompletionHandler = handler; lock.unlock()
        _ = session   // ensure the session exists so its delegate drains the events
    }

    // MARK: - Public API (mirrors WorkerFullAnalysisService.analyze)

    func analyze(symbol: String, provider: String = "claude", modelID: String = "") async throws -> WorkerFullAnalysisService.Result {
        await PushService.ensureAuth()
        do {
            return try await run(symbol: symbol, provider: provider, modelID: modelID)
        } catch WorkerFullAnalysisService.FetchError.unauthorized {
            await PushService.handleAuthFailure()
            return try await run(symbol: symbol, provider: provider, modelID: modelID)
        }
    }

    private func run(symbol: String, provider: String, modelID: String) async throws -> WorkerFullAnalysisService.Result {
        guard let url = WorkerFullAnalysisService.endpointURL else {
            throw WorkerFullAnalysisService.FetchError.missingURL
        }
        let bodyDict = await WorkerFullAnalysisService.buildBody(symbol: symbol, provider: provider, modelID: modelID)
        let bodyData = try JSONSerialization.data(withJSONObject: bodyDict)

        // Background upload tasks require a file body (httpBody is ignored).
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("analysis-\(UUID().uuidString).json")
        try bodyData.write(to: fileURL)

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        PushService.addAuthHeaders(&request)

        return try await withCheckedThrowingContinuation { continuation in
            let task = session.uploadTask(with: request, fromFile: fileURL)
            lock.lock()
            pending[task.taskIdentifier] = Pending(continuation, fileURL)
            lock.unlock()
            task.resume()
        }
    }

    // MARK: - Resolution

    private func finish(taskID: Int, with result: Swift.Result<WorkerFullAnalysisService.Result, Error>) {
        lock.lock()
        let entry = pending.removeValue(forKey: taskID)
        lock.unlock()
        guard let entry = entry else { return }   // terminated-relaunch case: no awaiter, drop it
        try? FileManager.default.removeItem(at: entry.bodyFileURL)
        switch result {
        case .success(let r): entry.continuation.resume(returning: r)
        case .failure(let e): entry.continuation.resume(throwing: e)
        }
    }
}

extension BackgroundAnalysisService: URLSessionDataDelegate {
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        lock.lock(); pending[dataTask.taskIdentifier]?.status = status; lock.unlock()
        completionHandler(.allow)   // continue to receive the response body
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock(); pending[dataTask.taskIdentifier]?.data.append(data); lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            finish(taskID: task.taskIdentifier, with: .failure(error))
            return
        }
        lock.lock()
        let status = pending[task.taskIdentifier]?.status ?? 0
        let data = pending[task.taskIdentifier]?.data ?? Data()
        lock.unlock()
        do {
            let r = try WorkerFullAnalysisService.parse(status: status, data: data)
            finish(taskID: task.taskIdentifier, with: .success(r))
        } catch {
            finish(taskID: task.taskIdentifier, with: .failure(error))
        }
    }

    /// All enqueued background events for this session have been delivered — tell the system we
    /// are done so it can re-suspend the app (relaunch case).
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.lock(); let handler = systemCompletionHandler; systemCompletionHandler = nil; lock.unlock()
        DispatchQueue.main.async { handler?() }
    }
}
