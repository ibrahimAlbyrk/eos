// Tag colors for the Code view's pane groups. Muted to sit beside the one app
// accent (the first entry IS the accent); stored by id so the hues can be retuned
// without migrating saved workspaces.
export const GROUP_COLORS = [
  { id: "blue", hex: "#6ea4e8" },
  { id: "teal", hex: "#5cb8c4" },
  { id: "green", hex: "#6fae86" },
  { id: "amber", hex: "#c9a163" },
  { id: "orange", hex: "#d9895b" },
  { id: "red", hex: "#c47f79" },
  { id: "pink", hex: "#d48bb8" },
  { id: "violet", hex: "#a98ce8" },
];

export const groupColorHex = (id) => (GROUP_COLORS.find((c) => c.id === id) ?? GROUP_COLORS[0]).hex;

// The first color no existing group uses, else cycle by count.
export function nextGroupColor(usedIds) {
  const free = GROUP_COLORS.find((c) => !usedIds.includes(c.id));
  return (free ?? GROUP_COLORS[usedIds.length % GROUP_COLORS.length]).id;
}
