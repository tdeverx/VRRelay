// SPDX-License-Identifier: GPL-3.0-or-later
import SwiftUI

struct RelayMenu: View {
    @Bindable var service: RelayService

    var body: some View {
        Text(service.statusMessage)
        Divider()
        Button("Open Dashboard") { service.openDashboard() }
            .disabled(service.isChangingState)
        Divider()
        Button("Start Relay") { service.start() }
            .disabled(service.isRunning || service.isChangingState)
        Button("Stop Relay") { service.stop() }
            .disabled(!service.isRunning || service.isChangingState)
        Button("Restart Relay") { service.restart() }
            .disabled(!service.isRunning || service.isChangingState)
        Divider()
        Button("Quit VRRelay") {
            NSApplication.shared.terminate(nil)
        }
    }
}
