// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::sync::{
  Arc,
  atomic::{AtomicBool, Ordering},
};

use cef::*;
use tauri_runtime::UserEvent;

use crate::runtime::{Message, RuntimeContext};

/// Runs one callback CEF makes into the app. A panic would unwind into CEF's C code, which
/// aborts the app: it is caught, logged, and CEF gets `fallback`.
fn guarded<T>(what: &str, fallback: T, f: impl FnOnce() -> T) -> T {
  std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_else(|_| {
    log::error!("the browser process handler panicked in {what}; answered without it");
    fallback
  })
}

wrap_browser_process_handler! {
  pub(crate) struct TauriCefBrowserProcessHandler<T: UserEvent> {
    context: RuntimeContext<T>,
    context_initialized: Arc<AtomicBool>,
    deep_link_schemes: Vec<String>,
    // The `Cef::cef_api_version` override, if set.
    api_version: Option<i32>,
  }

  impl BrowserProcessHandler {
    fn on_context_initialized(&self) {
      guarded("on_context_initialized", (), || {
        self.context_initialized.store(true, Ordering::SeqCst);
        self.context.wake_event_loop();
      })
    }

    fn on_schedule_message_pump_work(&self, delay_ms: i64) {
      guarded("on_schedule_message_pump_work", (), || {
        self.context.cef_pump.on_schedule_message_pump_work(delay_ms);
        self.context.wake_event_loop();
      })
    }

    fn on_before_child_process_launch(&self, command_line: Option<&mut CommandLine>) {
      guarded("on_before_child_process_launch", (), || {
        // Pass an overridden CEF API version to the child on its command line.
        // See `API_VERSION_SWITCH`.
        if let Some(command_line) = command_line
          && let Some(version) = self.api_version
        {
          command_line.append_switch_with_value(
            Some(&CefString::from(crate::runtime::API_VERSION_SWITCH)),
            Some(&CefString::from(version.to_string().as_str())),
          );
        }
      })
    }

    fn on_already_running_app_relaunch(
      &self,
      command_line: Option<&mut CommandLine>,
      _current_directory: Option<&CefString>,
    ) -> std::os::raw::c_int {
      guarded("on_already_running_app_relaunch", 1, || {
        let Some(command_line) = command_line else {
          return 0;
        };
        let mut list = CefStringList::new();
        command_line.arguments(Some(&mut list));
        let args: Vec<String> = list.into_iter().collect();
        if let Some(first_arg) = args.first()
          && let Ok(url) = url::Url::parse(first_arg)
        {
          let scheme = url.scheme().to_string();
          if self.deep_link_schemes.iter().any(|s| s == &scheme) {
            let _ = self.context.send_message(Message::Opened(vec![url]));
            return 1;
          }
        }
        // TODO: add event
        1
      })
    }
  }
}
