// SPDX-License-Identifier: GPL-3.0-or-later
import SwiftUI
import WebKit
import ServiceManagement

struct DashboardHost: View {
    @Bindable var service: RelayService
    var body: some View {
        Group {
            if service.isRunning {
                WebDashboard(url: service.dashboardURL)
            } else {
                ContentUnavailableView {
                    Label("VRRelay is stopped", systemImage: "antenna.radiowaves.left.and.right.slash")
                } description: {
                    Text(service.statusMessage)
                } actions: {
                    Button("Start Relay") { service.start() }
                        .buttonStyle(.borderedProminent)
                        .disabled(service.isChangingState)
                }
            }
        }
        .toolbar {
            ToolbarItemGroup {
                Button { service.openDashboard() } label: { Label("Open in Browser", systemImage: "safari") }
                Button { service.restart() } label: { Label("Restart", systemImage: "arrow.clockwise") }
                    .disabled(!service.isRunning || service.isChangingState)
            }
        }
    }
}

struct RelayMenu: View {
    @Environment(\.openWindow) private var openWindow
    @Bindable var service: RelayService
    var body: some View {
        Text(service.statusMessage).font(.caption).foregroundStyle(.secondary)
        Divider()
        Button("Show VRRelay") { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }
        Button("Open Dashboard") { service.openDashboard() }
        Divider()
        if service.isRunning {
            Button("Restart Relay") { service.restart() }.disabled(service.isChangingState)
            Button("Stop Relay") { service.stop() }.disabled(service.isChangingState)
        } else {
            Button("Start Relay") { service.start() }.disabled(service.isChangingState)
        }
        Divider()
        SettingsLink { Text("Settings…") }
        Button("Quit VRRelay (service stays running)") { NSApp.terminate(nil) }
    }
}

struct RelaySettings: View {
    @Bindable var service: RelayService
    @AppStorage("dashboardURL") private var dashboardURL = "http://127.0.0.1:8099"
    @State private var opensAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginItemError: String?

    var body: some View {
        Form {
            Section("Service") {
                TextField("Dashboard URL", text: $dashboardURL)
                LabeledContent("Background service", value: service.statusMessage)
                Toggle("Open menu controller at login", isOn: $opensAtLogin)
                    .onChange(of: opensAtLogin) { _, enabled in configureLoginItem(enabled) }
                if let loginItemError {
                    Text(loginItemError).foregroundStyle(.red)
                }
                Text("The relay runs as a system service. Closing this app does not interrupt active streams.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Recent output") {
                ScrollView { Text(service.logText.isEmpty ? "No output yet." : service.logText).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    .frame(minHeight: 180)
            }
        }
        .formStyle(.grouped)
        .frame(width: 600, height: 430)
        .padding()
    }

    private func configureLoginItem(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            opensAtLogin = enabled
            loginItemError = nil
        } catch {
            opensAtLogin = SMAppService.mainApp.status == .enabled
            loginItemError = error.localizedDescription
        }
    }
}

struct WebDashboard: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> WKWebView { let view = WKWebView(); view.load(URLRequest(url: url)); return view }
    func updateNSView(_ view: WKWebView, context: Context) {
        if view.url != url { view.load(URLRequest(url: url)) }
    }
}
