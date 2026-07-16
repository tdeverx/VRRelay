// SPDX-License-Identifier: GPL-3.0-or-later
import AppKit
import Foundation
import Observation
import OSLog

enum ServiceControlAction: String, CaseIterable {
    case start
    case restart
    case stop

    private static let label = "system/org.vrrelay.service"
    private static let plist = "'/Library/LaunchDaemons/org.vrrelay.service.plist'"

    var privilegedCommand: String {
        switch self {
        case .start:
            return "/bin/launchctl print \(Self.label) >/dev/null 2>&1 || /bin/launchctl bootstrap system \(Self.plist); /bin/launchctl enable \(Self.label); /bin/launchctl kickstart -k \(Self.label)"
        case .restart:
            return "/bin/launchctl kickstart -k \(Self.label)"
        case .stop:
            return "/bin/launchctl bootout \(Self.label)"
        }
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

    func openDashboard() { NSWorkspace.shared.open(dashboardURL) }

    func refreshStatus() async {
        guard !isChangingState else { return }
        do {
            let (_, response) = try await URLSession.shared.data(from: dashboardURL.appending(path: "api/v1/health"))
            isRunning = (response as? HTTPURLResponse)?.statusCode == 200
            statusMessage = isRunning ? "Background service running" : "Service unavailable"
        } catch {
            isRunning = false
            statusMessage = "Background service unavailable"
        }
    }

    private func perform(_ action: ServiceControlAction, pendingMessage: String) {
        guard !isChangingState else { return }
        isChangingState = true
        statusMessage = pendingMessage
        Task {
            let result = await Task.detached(priority: .userInitiated) {
                Self.runPrivileged(action.privilegedCommand)
            }.value
            isChangingState = false
            if result.status == 0 {
                try? await Task.sleep(for: .seconds(1))
                await refreshStatus()
            } else if result.output.contains("(-128)") || result.output.localizedCaseInsensitiveContains("cancel") {
                statusMessage = "Administrator approval was cancelled"
            } else {
                statusMessage = "Service \(action.rawValue) failed: \(result.output)"
                logger.error("System service action failed: \(result.output, privacy: .public)")
            }
        }
    }

    nonisolated private static func runPrivileged(_ command: String) -> (status: Int32, output: String) {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", "do shell script \"\(command.replacingOccurrences(of: "\\\"", with: "\\\\\\\""))\" with administrator privileges"]
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
