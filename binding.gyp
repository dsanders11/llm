{
  "targets": [
    {
      "target_name": "apple_intelligence",
      "conditions": [
        ["OS=='mac'", {
          "sources": [
            "native/apple-intelligence/src/addon.mm",
            "native/apple-intelligence/src/SwiftBridge.m"
          ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")",
            "native/apple-intelligence/include",
            "native/apple-intelligence/build_swift"
          ],
          "dependencies": [
            "<!(node -p \"require('node-addon-api').gyp\")"
          ],
          "libraries": [
            "<(PRODUCT_DIR)/libSwiftCode.a"
          ],
          "cflags!": ["-fno-exceptions"],
          "cflags_cc!": ["-fno-exceptions"],
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "SWIFT_OBJC_BRIDGING_HEADER": "native/apple-intelligence/include/SwiftBridge.h",
            "SWIFT_VERSION": "6.0",
            "SWIFT_OBJC_INTERFACE_HEADER_NAME": "apple_intelligence-Swift.h",
            "MACOSX_DEPLOYMENT_TARGET": "26.0",
            "OTHER_CFLAGS": ["-ObjC++", "-fobjc-arc"],
            "OTHER_LDFLAGS": [
              "-Wl,-rpath,@loader_path",
              "-Wl,-install_name,@rpath/libSwiftCode.a"
            ],
            "HEADER_SEARCH_PATHS": [
              "$(SRCROOT)/native/apple-intelligence/include",
              "$(CONFIGURATION_BUILD_DIR)",
              "$(SRCROOT)/build/Release",
              "$(SRCROOT)/native/apple-intelligence/build_swift"
            ]
          },
          "actions": [
            {
              "action_name": "build_swift",
              "inputs": ["native/apple-intelligence/src/SwiftCode.swift"],
              "outputs": [
                "native/apple-intelligence/build_swift/libSwiftCode.a",
                "native/apple-intelligence/build_swift/apple_intelligence-Swift.h"
              ],
              "action": [
                "sh", "-c",
                "mkdir -p native/apple-intelligence/build_swift && swiftc native/apple-intelligence/src/SwiftCode.swift -sdk `xcrun --show-sdk-path` -emit-objc-header-path ./native/apple-intelligence/build_swift/apple_intelligence-Swift.h -emit-library -o ./native/apple-intelligence/build_swift/libSwiftCode.a -emit-module -module-name apple_intelligence -module-link-name SwiftCode -target arm64-apple-macos26.0"
              ]
            },
            {
              "action_name": "copy_swift_lib",
              "inputs": ["<(module_root_dir)/native/apple-intelligence/build_swift/libSwiftCode.a"],
              "outputs": ["<(PRODUCT_DIR)/libSwiftCode.a"],
              "action": [
                "sh", "-c",
                "cp -f <(module_root_dir)/native/apple-intelligence/build_swift/libSwiftCode.a <(PRODUCT_DIR)/libSwiftCode.a && install_name_tool -id @rpath/libSwiftCode.a <(PRODUCT_DIR)/libSwiftCode.a"
              ]
            }
          ]
        }],
        ["OS!='mac'", {
          "type": "none"
        }]
      ]
    }
  ]
}
