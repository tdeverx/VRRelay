// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
@testable import VRRelayMac

final class ServiceControlActionTests: XCTestCase {
    func testEveryActionTargetsThePackagedSystemService() {
        for action in ServiceControlAction.allCases {
            XCTAssertTrue(action.privilegedCommand.contains("system/org.vrrelay.service"))
            XCTAssertFalse(action.privilegedCommand.contains("gui/"))
            XCTAssertFalse(action.privilegedCommand.contains("Library/LaunchAgents"))
        }
    }

    func testStartBootstrapsTheInstalledLaunchDaemonWhenNeeded() {
        let command = ServiceControlAction.start.privilegedCommand
        XCTAssertTrue(command.contains("launchctl bootstrap system '/Library/LaunchDaemons/org.vrrelay.service.plist'"))
        XCTAssertTrue(command.contains("launchctl kickstart -k system/org.vrrelay.service"))
    }

    func testStopDoesNotDeleteTheInstalledService() {
        let command = ServiceControlAction.stop.privilegedCommand
        XCTAssertEqual(command, "/bin/launchctl bootout system/org.vrrelay.service")
        XCTAssertFalse(command.contains("rm "))
    }
}
