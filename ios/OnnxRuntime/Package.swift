// swift-tools-version: 5.9
// ONNX Runtime for the iPhone app, built from Microsoft's own pod archives on download.onnxruntime.ai (the build puts them
// here: onnxruntime.xcframework and objectivec/). Microsoft's GitHub repos for it (onnxruntime, onnxruntime-swift-package-manager)
// went missing in November 2026, so the Swift package that used to come from there is rebuilt the same way here.
import PackageDescription

let package = Package(
    name: "OnnxRuntime",
    platforms: [.iOS(.v16)],
    products: [.library(name: "onnxruntime", targets: ["OnnxRuntimeBindings"])],
    targets: [
        .target(
            name: "OnnxRuntimeBindings",
            dependencies: ["onnxruntime"],
            path: "objectivec",
            exclude: ["test"],
            publicHeadersPath: "include",
            cxxSettings: [.define("SPM_BUILD"), .unsafeFlags(["-std=c++17", "-fobjc-arc-exceptions"])],
            linkerSettings: [.unsafeFlags(["-ObjC"])]),
        .binaryTarget(name: "onnxruntime", path: "onnxruntime.xcframework"),
    ])
