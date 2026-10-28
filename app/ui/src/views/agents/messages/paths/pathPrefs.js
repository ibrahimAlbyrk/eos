import { useSettingOr } from "../../../../state/settings.jsx";

// Settings › Code › Files & links, with the registry defaults.
export function usePathPrefs() {
  return {
    clickOpens: useSettingOr("paths.clickOpens", "panel"),
    editor: useSettingOr("paths.editor", ""),
    plainText: useSettingOr("paths.plainText", true) !== false,
    shorten: useSettingOr("paths.shorten", true) !== false,
    peek: useSettingOr("paths.peek", false) === true,
  };
}
