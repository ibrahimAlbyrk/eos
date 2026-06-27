// Shared canvas geometry — the SAME constants drive the node CSS layout (row
// heights via inline styles) and the SVG edge anchor math, so a wire always lands
// on the handle it points at. Change a constant here and both follow.

export const NODE_W = 184;
export const HEADER_H = 34;
export const PORT_H = 24;

// Absolute surface coordinate of a node's port handle. `side` is "out" (right
// edge) or "in" (left edge); `index` is the port's row position.
export function portAnchor(node, side, index) {
  const x = side === "out" ? node.ui.x + NODE_W : node.ui.x;
  const y = node.ui.y + HEADER_H + index * PORT_H + PORT_H / 2;
  return { x, y };
}
