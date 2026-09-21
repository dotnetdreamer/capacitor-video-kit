// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CapacitorVideoKitCore",
    platforms: [.iOS(.v16)],
    products: [
        .library(
            name: "CapacitorVideoKitCore",
            targets: ["CapacitorVideoKitCore"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        // Both plugin classes live in one target; Capacitor registers each @objc class separately.
        .target(
            name: "CapacitorVideoKitCore",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/CapacitorVideoKitCore")
    ]
)
