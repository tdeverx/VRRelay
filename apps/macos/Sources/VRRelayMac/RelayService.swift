// SPDX-License-Identifier: GPL-3.0-or-later
import AppKit
import Foundation
import Observation
import OSLog
import ServiceManagement

enum ServiceControlAction: String, CaseIterable {
    case start
    case restart
    case stop

    func helperArguments(helperPath: String) -> [String] { [helperPath, rawValue] }
}

enum LocalDashboardURL {
    static let fallback = URL(string: "http://127.0.0.1:8099")!

    static func resolve(listenAddress: String?) -> URL {
        guard let listenAddress, !listenAddress.isEmpty,
              var components = URLComponents(string: "http://\(listenAddress)") else {
            return fallback
        }
        if components.host == "0.0.0.0" || components.host == "::" || components.host == "[::]" {
            components.host = "127.0.0.1"
        }
        return components.url ?? fallback
    }
}

private struct RuntimeConfigurationProjection: Decodable {
    let listenAddr: String?
}

@MainActor @Observable
final class RelayService {
    static let shared = RelayService()
    private let logger = Logger(subsystem: "org.vrrelay.app", category: "relay")
    private var monitor: Timer?

    var isRunning = false
    var isChangingState = false
    var statusMessage = "Checking service…"
    var dashboardURL: URL {
        let configurationURL = FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/VRRelay/data/runtime-config.json")
        guard let data = try? Data(contentsOf: configurationURL),
              let configuration = try? JSONDecoder().decode(
                  RuntimeConfigurationProjection.self,
                  from: data
              ) else {
            return LocalDashboardURL.fallback
        }
        return LocalDashboardURL.resolve(listenAddress: configuration.listenAddr)
    }

    private init() {
        registerLoginItem()
        monitor = .scheduledTimer(withTimeInterval: 3, repeats: true) { _ in
            Task { @MainActor [weak self] in await self?.refreshStatus() }
        }
        Task {
            await refreshStatus()
            perform(.start, pendingMessage: "Starting background service…")
        }
    }

    func start() { perform(.start, pendingMessage: "Starting background service…") }
    func stop() { perform(.stop, pendingMessage: "Stopping background service…") }
    func restart() { perform(.restart, pendingMessage: "Restarting background service…") }

    func openDashboard() {
        guard !isChangingState else { return }
        Task {
            if await serviceIsHealthy() {
                isRunning = true
                statusMessage = "Background service running"
                NSWorkspace.shared.open(dashboardURL)
            } else {
                perform(.start, pendingMessage: "Starting background service…") { [dashboardURL] in
                    NSWorkspace.shared.open(dashboardURL)
                }
            }
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
        Task {
            let result = await Task.detached(priority: .userInitiated) {
                Self.runHelper(action.helperArguments(helperPath: helper.path))
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
            } else {
                isChangingState = false
                statusMessage = "Service \(action.rawValue) failed: \(result.output)"
                logger.error("User service action failed: \(result.output, privacy: .private)")
            }
        }
    }

    private func registerLoginItem() {
        guard Bundle.main.bundleURL.path.hasPrefix("/Applications/") else { return }
        let loginItem = SMAppService.mainApp
        guard loginItem.status == .notRegistered else { return }
        do {
            try loginItem.register()
        } catch {
            logger.error("Could not register login item: \(error.localizedDescription, privacy: .private)")
        }
    }

    nonisolated private static func runHelper(_ arguments: [String]) -> (status: Int32, output: String) {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = arguments
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
