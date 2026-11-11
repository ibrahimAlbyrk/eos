// Raw AppKit for what Tauri has no API for: z-order of child views, the window number.
use std::ffi::c_void;

#[link(name = "objc", kind = "dylib")]
unsafe extern "C" {
  fn sel_registerName(name: *const std::ffi::c_char) -> *const c_void;
  fn objc_msgSend();
}

pub fn window_number(ns_window: *mut c_void) -> isize {
  unsafe {
    let f: unsafe extern "C" fn(*mut c_void, *const c_void) -> isize = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    f(ns_window, sel_registerName(c"windowNumber".as_ptr()))
  }
}

/// Re-adding a subview above its siblings changes z-order without a reload. Main thread only.
pub fn bring_view_to_front(view: *mut c_void) {
  unsafe {
    if view.is_null() {
      return;
    }
    let get: unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    let sup = get(view, sel_registerName(c"superview".as_ptr()));
    if sup.is_null() {
      return;
    }
    // [superview addSubview:view positioned:NSWindowAbove relativeTo:nil]
    let add: unsafe extern "C" fn(*mut c_void, *const c_void, *mut c_void, isize, *mut c_void) =
      std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
    add(sup, sel_registerName(c"addSubview:positioned:relativeTo:".as_ptr()), view, 1, std::ptr::null_mut());
  }
}
