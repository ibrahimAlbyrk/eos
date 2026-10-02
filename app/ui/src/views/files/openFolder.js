import { explorer } from "../../state/explorerStore.js";

// Open the Files tab rooted at `path`. The explorer root is shared and only
// seeds once, so it is set here rather than passed as panel data; the toolbar's
// folder picker leads back to the project. Re-opening the current root keeps
// its expanded folders.
export function openFolder(ui, path) {
  if (explorer.getState().root !== path) explorer.setRoot(path);
  ui.openPanel("files");
}
