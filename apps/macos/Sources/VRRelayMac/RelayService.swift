// SPDX-License-Identifier: GPL-3.0-or-later
import AppKit
import Foundation
import Observation
import OSLog

enum ServiceControlAction: String, CaseIterable {
    case start
    case restart
    case stop

    func privilegedCommand(helperPath: String) -> String {
        "/bin/zsh \(Self.shellQuote(helperPath)) \(rawValue)"
    }

    private static func shellQuote(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}

@MainActor @Observable
final class RelayService {
    static let shared = RelayService()
    private let logger = Logger(subsystem: "org.vrrelay.app", category: "relay")
    private var monitor: Timer?

    var isRunning = false
    var isChangingState = false
    var statusMessage = "Checking service…"
    let dashboardURL = URL(string: "http://127.0.0.1:8099")!

    private init() {
        monitor = .scheduledTimer(withTimeInterval: 3, repeats: true) { _ in
            Task { @MainActor [weak self] in await self?.refreshStatus() }
        }
        Task { await refreshStatus() }
    }

    func start() { perform(.start, pendingMessage: "Starting background service…") }
    func stop() { perform(.stop, pendingMessage: "Stopping background service…") }
    func restart() { perform(.restart, pendingMessage: "Restarting background service…") }

    func openDashboard() {
        if isRunning {
            NSWorkspace.shared.open(dashboardURL)
            return
        }
        perform(.start, pendingMessage: "Starting background service…") { [dashboardURL] in
            NSWorkspace.shared.open(dashboardURL)
        }
    }

    func refreshStatus() async {
        guard !isChangingState else { return }
        isRunning = await serviceIsHealthy()
        statusMessage = isRunning ? "Background service running" : "Background service unavailable"
    }

    private func serviceIsHealthy() async -> Bool {
        var request = URLRequest(url: dashboardURL.appending(path: "api/v1/health"))
        request.timeoutInterval = 2
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    private func waitForHealthyService() async -> Bool {
        for attempt in 0..<30 {
            if await serviceIsHealthy() { return true }
            if attempt < 29 { try? await Task.sleep(for: .seconds(1)) }
        }
        return false
    }

    private func perform(
        _ action: ServiceControlAction,
        pendingMessage: String,
        whenReady: (@MainActor () -> Void)? = nil
    ) {
        guard !isChangingState else { return }
        guard let helper = Bundle.main.url(forResource: "install-service", withExtension: "sh") else {
            statusMessage = "VRRelay.app is missing its service installer"
            return
        }
        isChangingState = true
        statusMessage = pendingMessage
        let command = action.privilegedCommand(helperPath: helper.path)
        Task {
            let result = await Task.detached(priority: .userInitiated) {
                Self.runPrivileged(command)
            }.value
            if result.status == 0 {
                if action == .stop {
                    isChangingState = false
                    await refreshStatus()
                } else if await waitForHealthyService() {
                    isRunning = true
                    isChangingState = false
                    statusMessage = "Background service running"
                    whenReady?()
                } else {
                    isRunning = false
                    isChangingState = false
                    statusMessage = "Background service did not become available"
                }
            } else if result.output.contains("(-128)") || result.output.localizedCaseInsensitiveContains("cancel") {
                isChangingState = false
                statusMessage = "Administrator approval was cancelled"
            } else {
                isChangingState = false
                statusMessage = "Service \(action.rawValue) failed: \(result.output)"
                logger.error("System service action failed: \(result.output, privacy: .public)")
            }
        }
    }

    nonisolated private static func runPrivileged(_ command: String) -> (status: Int32, output: String) {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        let appleScriptCommand = command
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        process.arguments = ["-e", "do shell script \"\(appleScriptCommand)\" with administrator privileges"]
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return (1, error.localizedDescription)
        }
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "Unknown launchctl error"
        return (process.terminationStatus, output)
    }
}
