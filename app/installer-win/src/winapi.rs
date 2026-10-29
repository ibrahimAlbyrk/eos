// What the installer needs from Windows itself: known folders, free space,
// shortcuts that carry Eos's AppUserModelID (toasts are matched by it), the
// window's rounded corners and a yes/no prompt.

use std::path::{Path, PathBuf};

use windows::core::{Interface, GUID, HSTRING, PWSTR};
use windows::Win32::Foundation::{HWND, PROPERTYKEY};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND};
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CoTaskMemFree, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_LocalAppData, FOLDERID_Programs, IShellLinkW, SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT,
};
use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONQUESTION, MB_YESNO};

// forge.config.js packagerConfig.appBundleId — the shell sets the same id (app.setAppUserModelId).
pub const APP_USER_MODEL_ID: &str = "com.ibrahimalbyrk.eos";

// System.AppUserModel.ID
const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 5,
};

fn known_folder(id: &GUID) -> Option<PathBuf> {
    unsafe {
        let raw: PWSTR = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        let path = raw.to_string().ok().map(PathBuf::from);
        CoTaskMemFree(Some(raw.0 as *const _));
        path
    }
}

pub fn local_app_data() -> Option<PathBuf> {
    known_folder(&FOLDERID_LocalAppData)
}

pub fn desktop_dir() -> Option<PathBuf> {
    known_folder(&FOLDERID_Desktop)
}

pub fn start_menu_programs() -> Option<PathBuf> {
    known_folder(&FOLDERID_Programs)
}

/// Bytes free to this user on the volume holding `path` (or its nearest existing parent), with the volume's name.
pub fn free_space(path: &Path) -> Option<(u64, String)> {
    let existing = path.ancestors().find(|p| p.exists())?;
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(&HSTRING::from(existing.as_os_str()), Some(&mut free), None, None).ok()? };
    let drive = existing.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned()).unwrap_or_default();
    Some((free, drive))
}

/// A .lnk at `lnk` that starts `target`, carrying Eos's AppUserModelID.
pub fn create_shortcut(lnk: &Path, target: &Path) -> windows::core::Result<()> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&HSTRING::from(target.as_os_str()))?;
        if let Some(dir) = target.parent() {
            link.SetWorkingDirectory(&HSTRING::from(dir.as_os_str()))?;
        }
        link.SetIconLocation(&HSTRING::from(target.as_os_str()), 0)?;
        link.SetDescription(&HSTRING::from("Eos"))?;

        let store: IPropertyStore = link.cast()?;
        // Dropping the PROPVARIANT clears it (PropVariantClear frees the string).
        let value = lpwstr_variant(APP_USER_MODEL_ID);
        store.SetValue(&PKEY_APP_USER_MODEL_ID, &value)?;
        store.Commit()?;

        let file: IPersistFile = link.cast()?;
        file.Save(&HSTRING::from(lnk.as_os_str()), true)
    }
}

// System.AppUserModel.ID wants a VT_LPWSTR, which owns a CoTaskMemAlloc'd string.
unsafe fn lpwstr_variant(text: &str) -> PROPVARIANT {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let buf = CoTaskMemAlloc(wide.len() * 2) as *mut u16;
    std::ptr::copy_nonoverlapping(wide.as_ptr(), buf, wide.len());
    PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_LPWSTR,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 { pwszVal: PWSTR(buf) },
            }),
        },
    }
}

/// Windows 11 rounds the window like its own; Windows 10 ignores the request.
pub fn round_corners(hwnd: isize) {
    let pref = DWMWCP_ROUND;
    unsafe {
        let _ = DwmSetWindowAttribute(
            HWND(hwnd as *mut _),
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const _ as *const _,
            std::mem::size_of_val(&pref) as u32,
        );
    }
}

pub fn confirm(title: &str, text: &str) -> bool {
    unsafe { MessageBoxW(None, &HSTRING::from(text), &HSTRING::from(title), MB_YESNO | MB_ICONQUESTION) == IDYES }
}
