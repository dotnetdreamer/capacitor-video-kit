// swift-tools-version: 5.9
import PackageDescription

// The package and its product are named by the Capacitor CLI, not by us: `npx cap sync ios` writes
// `.package(name: "CapacitorVideoKit", ...)` and `.product(name: "CapacitorVideoKit", ...)` into the
// host's generated `CapApp-SPM/Package.swift` from the name the HOST depends on the kit by - its key
// in the host's `dependencies` or `devDependencies`, or its entry in `includePlugins` - run through
// `fixName` in @capacitor/cli. The kit's own package.json `name` is never read for it. That key is
// normally the npm name, `capacitor-video-kit`, so a rename of the package is a rename of both of
// these and of the podspec; a host that installs the kit under an alias
// (`"video-kit": "npm:capacitor-video-kit@..."`) asks for a package called `VideoKit`, which this is
// not. The target's name is the Swift module's, and that is not ours to change either: a host writes
// `import CapacitorVideoKitCore` to hand background URLSession events to `PublisherSession` (see the
// README), the podspec's `module_name` repeats it so both package managers build one module, and the
// tests import it too. Renaming the target breaks every host that imports it.
let package = Package(
    name: "CapacitorVideoKit",
    platforms: [.iOS(.v16)],
    products: [
        .library(
            name: "CapacitorVideoKit",
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
            path: "ios/Sources/CapacitorVideoKitCore"),
        // Runs on an iOS Simulator only - the module imports UIKit and links Capacitor's iOS
        // frameworks: `xcodebuild test -scheme CapacitorVideoKit -destination 'platform=iOS Simulator,name=<device>'`.
        // Never shipped: the podspec's glob is `ios/Sources/**`, and a host's SwiftPM graph builds
        // no test target of a dependency.
        .testTarget(
            name: "CapacitorVideoKitCoreTests",
            dependencies: ["CapacitorVideoKitCore"],
            path: "ios/Tests/CapacitorVideoKitCoreTests")
    ]
)
