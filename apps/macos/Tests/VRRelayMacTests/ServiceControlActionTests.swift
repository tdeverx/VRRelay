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

    func testUnhealthyServiceRecoveryRestartsAnAlreadyLoadedService() {
        XCTAssertEqual(ServiceControlAction.recovery, .restart)
    }

    func testDashboardUsesExactConfiguredInterface() {
        XCTAssertEqual(
            LocalDashboardURL.resolve(listenAddress: "192.0.2.18:8099").absoluteString,
            "http://192.0.2.18:8099"
        )
    }

    func testDashboardMapsWildcardListenerToLoopback() {
        XCTAssertEqual(
            LocalDashboardURL.resolve(listenAddress: "0.0.0.0:8099").absoluteString,
            "http://127.0.0.1:8099"
        )
        XCTAssertEqual(
            LocalDashboardURL.resolve(listenAddress: "[::]:8099").absoluteString,
            "http://127.0.0.1:8099"
        )
    }

    func testDashboardFallsBackForMissingListener() {
        XCTAssertEqual(
            LocalDashboardURL.resolve(listenAddress: nil),
            LocalDashboardURL.fallback
        )
    }
}
