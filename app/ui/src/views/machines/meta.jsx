import { GridIcon } from "../../components/machines/icons.jsx";
import { isRemoteView } from "../../lib/host.js";

// A controlled computer's view has no "all machines" of its own to show — the
// overview lives in this Mac's window.
export const machinesMeta = { id: "machines", label: "Machines", Icon: GridIcon, visible: () => !isRemoteView() };
