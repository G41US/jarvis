// swift-tools-version: 5.9
// JarvisCore: the parts of the iPhone app that are plain arithmetic (face matching, the "Hey Jarvis" pipeline, the
// speech detector, zip/docx writing). No Apple frameworks, so `swift test` runs them on Linux too, against the same
// recorded traces the Android versions are checked with (tests/face, tests/wake).
import PackageDescription

let package = Package(
    name: "JarvisCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "JarvisCore", targets: ["JarvisCore"])],
    targets: [
        .target(name: "JarvisCore"),
        .testTarget(name: "JarvisCoreTests", dependencies: ["JarvisCore"]),
    ]
)
