// swift-tools-version: 6.0
import PackageDescription

// The ChatGPT sign-in's logic, without UIKit, so `swift test` runs it on a Mac. The app
// compiles the same sources into the SvettNative pod.
let package = Package(
    name: "ChatGPTCore",
    platforms: [.macOS(.v15), .iOS(.v18)],
    targets: [
        .target(name: "ChatGPTCore"),
        .testTarget(name: "ChatGPTCoreTests", dependencies: ["ChatGPTCore"]),
    ],
    swiftLanguageModes: [.v5]
)
