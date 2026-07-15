// SPDX-License-Identifier: GPL-3.0-or-later
import SwiftUI

@main
struct VRRelayMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var service = RelayService.shared

    var body: some Scene {
        WindowGroup("VRRelay", id: "main") {
            DashboardHost(service: service)
                .frame(minWidth: 760, minHeight: 540)
        }
        .defaultSize(width: 1040, height: 700)

        MenuBarExtra("VRRelay", systemImage: service.isRunning ? "play.circle.fill" : "stop.circle") {
            RelayMenu(service: service)
        }

        Settings {
            RelaySettings(service: service)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
