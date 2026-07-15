// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "VRRelayMac",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "VRRelayMac", targets: ["VRRelayMac"])],
    targets: [
        .executableTarget(name: "VRRelayMac", path: "Sources/VRRelayMac"),
        .testTarget(name: "VRRelayMacTests", dependencies: ["VRRelayMac"])
    ]
)
