// SPDX-License-Identifier: GPL-3.0-or-later
import SwiftUI

@main
struct VRRelayMacApp: App {
    @State private var service = RelayService.shared

    var body: some Scene {
        MenuBarExtra("VRRelay", systemImage: service.isRunning ? "play.circle.fill" : "stop.circle") {
            RelayMenu(service: service)
        }
        .menuBarExtraStyle(.menu)
    }
}
