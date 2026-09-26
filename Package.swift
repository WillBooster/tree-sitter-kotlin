// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "TreeSitterKotlin",
    products: [
        .library(name: "TreeSitterKotlin", targets: ["TreeSitterKotlin"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ChimeHQ/SwiftTreeSitter", from: "0.8.0"),
    ],
    targets: [
        .target(
            name: "TreeSitterKotlin",
            dependencies: [],
            path: ".",
            sources: [
                "src/parser.c",
                "src/scanner.c",
            ],
            resources: [
                .copy("queries")
            ],
            publicHeadersPath: "bindings/swift",
            cSettings: [.headerSearchPath("src")]
        ),
        .testTarget(
            name: "TreeSitterKotlinTests",
            dependencies: [
                "SwiftTreeSitter",
                "TreeSitterKotlin",
            ],
            path: "bindings/swift/TreeSitterKotlinTests"
        )
    ],
    cLanguageStandard: .c11
)
