// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "trueseal-e2e-swift-client",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(path: "../../../trueseal-sync-swift"),
    ],
    targets: [
        .executableTarget(
            name: "trueseal-e2e-swift-client",
            dependencies: [.product(name: "TruesealSync", package: "trueseal-sync-swift")]
        ),
    ]
)
