import { useNavigationIfAny } from "../../../state/navigation.jsx";
import { word } from "../routines/tableWords.js";

// Asks and questions of Agents chats are not items (D12): one line with
// their count and the way to Agents.
export function AgentsWaitingLine({ count }) {
  const navigation = useNavigationIfAny();
  if (!(count > 0)) return null;
  const chats = count === 1 ? "One chat in Agents is" : `${word(count)} chats in Agents are`;
  return (
    <p className="eos-needs-agents">
      {chats} waiting for you.
      {navigation && <> <button type="button" className="eos-link" onClick={() => navigation.setActiveView("agents")}>Open Agents</button></>}
    </p>
  );
}
