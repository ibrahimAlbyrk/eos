import { useEffect } from "react";
import { ensureTransfersLoaded, isActive, useTransfer } from "../../../state/transfersStore.js";
import { TransferCard } from "../../transfer/TransferCard.jsx";
import { useMachines } from "../../transfer/useMachines.js";
import { percentOf } from "../../transfer/text.js";
import { FailureBanner, GenericToolCard } from "./ToolDetail.jsx";

// A focused agent's send_to_machine (worker server only): the row says what went
// where, and opens to the transfer itself — the Transfer tab's own card, live, so
// a copy that outlives the call keeps moving in the chat. Registered in ./toolViews.jsx.

const failed = (t) => t.result?.isError === true;

// The tool's answer ends with "(tr-…)" — which transfer to follow.
export const transferIdOf = (text) => /\((tr-[a-z0-9]+)\)\s*$/.exec(text ?? "")?.[1] ?? null;

const names = (t) => (t.input?.paths ?? []).map((p) => String(p).replace(/\/+$/, "").split("/").pop()).join(", ");
const target = (t) => (t.input?.machine ? ` → ${t.input.machine}` : "");

function useFollowed(tool) {
  useEffect(() => { ensureTransfersLoaded(); }, []);
  return useTransfer(transferIdOf(tool.result?.text));
}

function Progress({ tool }) {
  const t = useFollowed(tool);
  if (!t || failed(tool) || !isActive(t)) return null;
  return <span className="mtl-count">{percentOf(t)}%</span>;
}

function SendDetail({ tool }) {
  const t = useFollowed(tool);
  const machines = useMachines();
  if (failed(tool)) return <div className="tool-detail"><FailureBanner tool={tool} /></div>;
  // Sent from another Mac's session, or long cleared — the answer is all there is.
  if (!t) return <GenericToolCard tool={tool} />;
  return <div className="tool-detail tx-tool"><TransferCard t={t} label={machines.label} /></div>;
}

export const TRANSFER_TOOL_VIEWS = {
  send_to_machine: {
    label: (t) => ({ verb: "Sent", file: `${names(t)}${target(t)}` }),
    runningLabel: (t) => ({ verb: "Sending", file: `${names(t)}${target(t)}` }),
    headerBadge: (t) => <Progress tool={t} />,
    expandable: (t) => failed(t) || Boolean(t.result),
    Detail: SendDetail,
  },
};
