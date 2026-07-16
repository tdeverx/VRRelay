// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
@testable import VRRelayMac

final class ServiceControlActionTests: XCTestCase {
    func testEveryActionUsesThePackagedInstallerWithAClosedActionSet() {
        for action in ServiceControlAction.allCases {
            let command = action.privilegedCommand(helperPath: "/Applications/VRRelay.app/Contents/Resources/install-service.sh")
            XCTAssertEqual(command, "/bin/zsh '/Applications/VRRelay.app/Contents/Resources/install-service.sh' \(action.rawValue)")
        }
    }

    func testInstallerPathIsShellQuoted() {
        let command = ServiceControlAction.restart.privilegedCommand(helperPath: "/Users/O'Brien/VRRelay.app/install-service.sh")
        XCTAssertEqual(command, "/bin/zsh '/Users/O'\\''Brien/VRRelay.app/install-service.sh' restart")
    }
}
