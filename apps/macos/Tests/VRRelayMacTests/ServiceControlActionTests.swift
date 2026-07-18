// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
@testable import VRRelayMac

final class ServiceControlActionTests: XCTestCase {
    func testEveryActionUsesDirectArgumentsWithAClosedActionSet() {
        for action in ServiceControlAction.allCases {
            let arguments = action.helperArguments(
                helperPath: "/Applications/VRRelay.app/Contents/Resources/install-service.sh"
            )
            XCTAssertEqual(
                arguments,
                ["/Applications/VRRelay.app/Contents/Resources/install-service.sh", action.rawValue]
            )
        }
    }

    func testInstallerPathIsPassedWithoutShellInterpolation() {
        let arguments = ServiceControlAction.restart.helperArguments(
            helperPath: "/Users/O'Brien/VRRelay.app/install-service.sh"
        )
        XCTAssertEqual(arguments, ["/Users/O'Brien/VRRelay.app/install-service.sh", "restart"])
    }
}
