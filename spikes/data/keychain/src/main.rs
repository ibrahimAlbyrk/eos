//! Spike 9: reading a generic-password item through Security.framework from a
//! binary that did not create it.
//!
//! Works only on a throwaway keychain FILE made for the test (never the login
//! keychain) and with user interaction switched off for this process, so a
//! read that would have raised the "wants to use your confidential
//! information" dialog fails with errSecInteractionNotAllowed (-25308) instead
//! of showing anything.
//!
//!   keychain-probe read <keychain file> <password> <service> <account>
//!   keychain-probe add  <keychain file> <password> <service> <account>
//!   keychain-probe dp-add <service> <account>     data-protection keychain (needs entitlements)

#[cfg(target_os = "macos")]
fn main() {
    use std::time::Instant;

    use security_framework::{
        os::macos::keychain::SecKeychain,
        passwords::{delete_generic_password_options, set_generic_password_options},
        passwords_options::PasswordOptions,
    };
    use serde_json::json;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize| args.get(i).map(String::as_str).unwrap_or("");
    // No dialogs from this process, whatever happens: without the lock, refuse to go on.
    let Ok(_no_dialogs) = SecKeychain::disable_user_interaction() else {
        println!("{}", json!({ "error": "could not switch user interaction off; nothing was read" }));
        return;
    };

    let out = match arg(0) {
        "read" | "add" => {
            let open = SecKeychain::open(arg(1)).and_then(|mut kc| kc.unlock(Some(arg(2))).map(|()| kc));
            match open {
                Err(e) => json!({ "step": "open", "code": e.code(), "message": e.message() }),
                Ok(kc) if arg(0) == "add" => {
                    match kc.set_generic_password(arg(3), arg(4), b"dummy value written by the probe") {
                        Ok(()) => json!({ "added": true }),
                        Err(e) => json!({ "step": "add", "code": e.code(), "message": e.message() }),
                    }
                }
                Ok(kc) => {
                    let mut times = Vec::new();
                    let mut last = json!(null);
                    for _ in 0..20 {
                        let t = Instant::now();
                        last = match kc.find_generic_password(arg(3), arg(4)) {
                            // The length only: the value itself is never printed.
                            Ok((password, _item)) => json!({ "read": true, "bytes": password.len() }),
                            Err(e) => json!({ "read": false, "code": e.code(), "message": e.message() }),
                        };
                        times.push(t.elapsed().as_secs_f64() * 1000.0);
                    }
                    times.sort_by(|a, b| a.total_cmp(b));
                    json!({ "result": last, "medianMs": (times[times.len() / 2] * 1000.0).round() / 1000.0, "maxMs": (times[times.len() - 1] * 100.0).round() / 100.0 })
                }
            }
        }
        "dp-add" => {
            let mut opts = PasswordOptions::new_generic_password(arg(1), arg(2));
            opts.use_protected_keychain();
            match set_generic_password_options(b"dummy", opts) {
                Ok(()) => {
                    let mut opts = PasswordOptions::new_generic_password(arg(1), arg(2));
                    opts.use_protected_keychain();
                    let _ = delete_generic_password_options(opts);
                    json!({ "dataProtectionKeychain": "added and removed" })
                }
                Err(e) => json!({ "dataProtectionKeychain": "refused", "code": e.code(), "message": e.message() }),
            }
        }
        _ => {
            json!({ "usage": "keychain-probe read|add <keychain> <password> <service> <account> | dp-add <service> <account>" })
        }
    };
    println!("{out}");
}

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("macOS only");
}
