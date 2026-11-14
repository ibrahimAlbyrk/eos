//! Maps the CEF framework at launch.
//!
//! The runtime `dlopen()`s the framework after start. For a library loaded that way macOS
//! writes all 12 MB of its relocated constant data in every process; for one the executable
//! names in a load command the pages stay clean. Measured: 12–17 MB per process, about 70 MB
//! for the app (`DEVELOPMENT.md`, "Memory"). The load command is weak, so the program still
//! starts outside a bundle and falls back to the runtime's `dlopen`.

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    // Told by `cef-dll-sys`: the folder that holds the framework this build compiles against.
    let Ok(dir) = std::env::var("DEP_CEF_DLL_WRAPPER_CEF_DIR") else {
        println!("cargo::warning=no CEF folder from cef-dll-sys: the framework will be loaded with dlopen");
        return;
    };
    println!("cargo::rustc-link-search=framework={dir}");
    println!("cargo::rustc-link-arg-bins=-Wl,-weak_framework,Chromium Embedded Framework");
}
