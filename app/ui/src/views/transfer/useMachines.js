import { useHosts, hostLabel } from "../../state/hostsStore.js";
import { transferMode, viewedMachine } from "../../lib/transferClient.js";

// The two sides a transfer can have, in the engine's terms ("local" = the Mac
// the user sits at). This Mac's window can pair with any Mac it controls; a
// view of another Mac pairs that Mac with the user's own.
export function useMachines() {
  const { hosts, local } = useHosts();
  const mine = transferMode() === "local";
  const me = {
    ref: "local",
    name: local?.name ?? "This Mac",
    // What the user calls it from where they are looking.
    label: mine ? "This Mac" : local?.name ?? "Your Mac",
    platform: local?.platform ?? "darwin",
    link: null,
  };
  const viewed = viewedMachine();
  const peers = hosts
    .filter((h) => mine || h.id === viewed)
    .map((h) => ({ ref: h.id, name: hostLabel(h), label: hostLabel(h), platform: h.platform, link: h.link }));
  const label = (ref) => (ref === "local" ? me.label : peers.find((p) => p.ref === ref)?.label ?? "the other Mac");
  return { local: me, peers, label };
}
