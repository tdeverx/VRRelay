// SPDX-License-Identifier: GPL-3.0-or-later
import SwiftUI

@MainActor
final class VRRelayApplicationDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let service = RelayService.shared
        if service.terminationAllowed { return .terminateNow }
        service.quit()
        return .terminateCancel
    }
}

@main
struct VRRelayMacApp: App {
    @NSApplicationDelegateAdaptor(VRRelayApplicationDelegate.self) private var appDelegate
    @State private var service = RelayService.shared

    var body: some Scene {
        MenuBarExtra("VRRelay", systemImage: service.isRunning ? "play.circle.fill" : "stop.circle") {
            RelayMenu(service: service)
        }
        .menuBarExtraStyle(.menu)
    }
}
