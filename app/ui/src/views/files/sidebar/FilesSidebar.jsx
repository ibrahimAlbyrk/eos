import { TabBar } from "../../../components/TabBar.jsx";
import { SettingsFooter } from "../../../components/SettingsFooter.jsx";
import { ExplorerToolbar } from "./ExplorerToolbar.jsx";
import { ExplorerSearch } from "./ExplorerSearch.jsx";
import { FileTree } from "../tree/FileTree.jsx";

// The Files sidebar IS the tree (mirrors how CodeSidebar is the agent tree).
// Hosts the shared TabBar at the top, then the toolbar/search/tree, filling the
// full sidebar height with the tree scrolling.
export function FilesSidebar({ variant = "full" }) {
  const body = (
    <>
      <TabBar variant={variant} />
      <ExplorerToolbar />
      <ExplorerSearch />
      <FileTree />
    </>
  );

  if (variant === "popup") return body;

  return (
    <div className="side-island side-island--files">
      {body}
      <SettingsFooter />
    </div>
  );
}
