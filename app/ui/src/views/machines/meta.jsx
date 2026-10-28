import { GridIcon } from "../../components/machines/icons.jsx";
import { isRemoteView } from "../../lib/host.js";
import { hasFeature } from "../../state/featuresStore.js";

// A controlled computer's view has no "all machines" of its own to show — the
// overview lives in this Mac's window. Nor does a computer that can't pair.
export const machinesMeta = { id: "machines", label: "Machines", Icon: GridIcon, visible: () => !isRemoteView() && hasFeature("remote") };
