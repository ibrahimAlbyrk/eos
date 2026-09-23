export function AgentsTabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="4" r="1.8" />
      <circle cx="3.5" cy="12" r="1.8" />
      <circle cx="12.5" cy="12" r="1.8" />
      <path d="M7.1 5.6 4.4 10.4M8.9 5.6l2.7 4.8" />
    </svg>
  );
}

export const agentsMeta = { id: "agents", label: "Agents", Icon: AgentsTabIcon };
