import { ActivityStar } from "./ActivityStar.jsx";

const ROLE_LABEL = { user: "You", agent: "Agent", system: "System" };

// Whose message a reply points at: the agent's dawn-star and name for its own
// text, a plain label for everyone else.
export function ReplyWho({ role, agentName }) {
  const isAgent = role === "assistant";
  return (
    <span className="reply-who">
      {isAgent && <ActivityStar />}
      <span className="reply-who-name">{isAgent ? agentName || "Agent" : ROLE_LABEL[role] ?? "Message"}</span>
    </span>
  );
}
