//! Sets a profile's proxy script at run time (Chromium's `proxy` preference). The script
//! is the local-network guard (`eos_bridge::lan_guard`); it changes when the user asks a
//! view for a page on the local network, and when the system's proxy settings change.

use std::sync::mpsc;
use std::time::Duration;

use tauri_runtime_cef::WebviewCefExt;
use tauri_runtime_cef::cef::{
    CefString, ImplBrowser, ImplBrowserHost, ImplDictionaryValue, ImplPreferenceManager, ImplValue,
    dictionary_value_create, value_create,
};

fn set(browser: &tauri_runtime_cef::cef::Browser, script_url: &str) -> Result<(), String> {
    let context = browser.host().and_then(|host| host.request_context()).ok_or("the view has no request context")?;
    let dictionary = dictionary_value_create().ok_or("no dictionary value")?;
    dictionary.set_string(Some(&CefString::from("mode")), Some(&CefString::from("pac_script")));
    dictionary.set_string(Some(&CefString::from("pac_url")), Some(&CefString::from(script_url)));
    let mut dictionary = dictionary;
    let value = value_create().ok_or("no value")?;
    value.set_dictionary(Some(&mut dictionary));
    let mut value = value;
    // CEF refuses the call without a writable error string.
    let mut error = CefString::from("");
    if context.set_preference(Some(&CefString::from("proxy")), Some(&mut value), Some(&mut error)) == 1 {
        Ok(())
    } else {
        Err(format!("the proxy preference was refused: {error}"))
    }
}

/// Applies the script to the profile of `webview` and waits until Chromium has taken it.
/// Not on the main thread: the preference is written there.
pub(crate) fn apply(webview: &tauri::Webview, script_url: String) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    webview.with_cef_webview(move |w| drop(tx.send(set(&w.browser(), &script_url)))).map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "the main thread did not answer".to_string())?
}
