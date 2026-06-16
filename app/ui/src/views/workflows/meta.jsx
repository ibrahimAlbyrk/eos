export function WorkflowsTabIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2.5" width="4.5" height="4.5" rx="1.2" />
      <rect x="9.5" y="9" width="4.5" height="4.5" rx="1.2" />
      <path d="M6.5 4.75H10a1.5 1.5 0 0 1 1.5 1.5V9" />
    </svg>
  );
}

export const workflowsMeta = { id: "workflows", label: "Workflows", Icon: WorkflowsTabIcon };
