export function menuVisibility({ activeMenu, menuDismissed }) {
  return {
    showMenu: activeMenu === "slash" && !menuDismissed,
    showFileMenu: activeMenu === "file" && !menuDismissed,
  };
}

export function escapeMenu() {
  return { keepText: true, dismissed: true };
}

export function menuDismissedOnQueryChange() {
  return false;
}
