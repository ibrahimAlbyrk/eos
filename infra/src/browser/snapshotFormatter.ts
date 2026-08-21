// AX tree → indented, ref-annotated text (BrowserSnapshotResponse.snapshot).
// Pure: input is the raw Accessibility.getFullAXTree node array, output is the
// text plus the `@eN` → backendDOMNodeId ref list the adapter folds into the
// tab's ref map. Token cost is the whole point: an agent must understand the
// page from this without a screenshot, and a dump of the whole tree has
// failed — ignored/generic nodes are collapsed, interactiveOnly (the default)
// keeps only actionable nodes, headings and named landmarks. Never outerHTML.

export interface AXNodeLike {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

export interface FormatOptions {
  interactiveOnly: boolean;
  depth?: number;
  // Scope to the subtree rooted at this DOM node (selector already resolved).
  rootBackendNodeId?: number;
  // First ref index to mint (per-tab counter continues across snapshots so a
  // ref string is never recycled within a tab's life).
  refStart: number;
}

export interface FormatResult {
  text: string;
  refs: Array<[string, number]>; // ["@eN", backendDOMNodeId]
  nextRefIndex: number;
}

// Roles an agent can act on — these always render and always get a ref.
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "textarea", "checkbox", "radio",
  "combobox", "listbox", "option", "menuitem", "menuitemcheckbox",
  "menuitemradio", "tab", "switch", "slider", "spinbutton", "popupbutton",
  "togglebutton", "disclosuretriangle",
]);

// Structure worth keeping for orientation even in interactiveOnly mode (when
// named): the agent needs to know WHERE the controls live.
const LANDMARK_ROLES = new Set([
  "navigation", "banner", "main", "contentinfo", "complementary", "form",
  "region", "search", "dialog", "alertdialog", "article", "list", "table",
  "tablist", "menu", "menubar", "radiogroup", "group",
]);

// Never rendered, children promoted in their place.
const SKIP_ROLES = new Set([
  "generic", "genericcontainer", "none", "presentation", "inlinetextbox",
  "linebreak", "ignored", "rootwebarea",
]);

const STATE_PROPS = new Set(["checked", "disabled", "expanded", "pressed", "selected", "invalid", "required"]);

const NAME_MAX = 100;
const VALUE_MAX = 60;

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function roleOf(node: AXNodeLike): string {
  return str(node.role?.value).toLowerCase();
}

// Non-default states only. invalid="false" and checked=false are defaults —
// silence is the signal that everything is normal.
export function statesOf(node: AXNodeLike): string[] {
  const out: string[] = [];
  for (const p of node.properties ?? []) {
    const name = p.name.toLowerCase();
    if (!STATE_PROPS.has(name)) continue;
    const v = p.value?.value;
    if (name === "checked" || name === "pressed") {
      if (v === true || v === "true" || v === "mixed") out.push(v === "mixed" ? `${name}=mixed` : name);
    } else if (name === "expanded") {
      out.push(v === true || v === "true" ? "expanded" : "collapsed");
    } else if (name === "invalid") {
      if (v && v !== "false") out.push("invalid");
    } else if (v === true || v === "true") {
      out.push(name);
    }
  }
  return out;
}

function isFocusable(node: AXNodeLike): boolean {
  return (node.properties ?? []).some((p) => p.name.toLowerCase() === "focusable" && p.value?.value === true);
}

function headingLevel(node: AXNodeLike): string {
  const p = (node.properties ?? []).find((x) => x.name.toLowerCase() === "level");
  return p?.value?.value != null ? ` [level=${p.value.value}]` : "";
}

export function formatAXTree(nodes: AXNodeLike[], opts: FormatOptions): FormatResult {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = opts.rootBackendNodeId != null
    ? nodes.find((n) => n.backendDOMNodeId === opts.rootBackendNodeId)
    : nodes.find((n) => roleOf(n) === "rootwebarea") ?? nodes[0];
  const lines: string[] = [];
  const refs: Array<[string, number]> = [];
  let refIndex = opts.refStart;

  const emit = (node: AXNodeLike, indent: number): string | null => {
    const role = roleOf(node);
    const name = truncate(str(node.name?.value), NAME_MAX);
    const interactive = INTERACTIVE_ROLES.has(role);

    if (role === "statictext") {
      if (opts.interactiveOnly || !name) return null;
      return `${"  ".repeat(indent)}text ${JSON.stringify(name)}`;
    }
    if (role === "heading") {
      if (!name) return null;
      return `${"  ".repeat(indent)}heading ${JSON.stringify(name)}${headingLevel(node)}`;
    }
    if (!interactive) {
      const landmark = LANDMARK_ROLES.has(role) && name;
      const informative = !opts.interactiveOnly && name && role !== "";
      if (!landmark && !informative) return null;
      return `${"  ".repeat(indent)}${role} ${JSON.stringify(name)}`;
    }

    let line = `${"  ".repeat(indent)}${role}${name ? ` ${JSON.stringify(name)}` : ""}`;
    if (node.backendDOMNodeId != null && (interactive || isFocusable(node))) {
      refIndex += 1;
      const ref = `@e${refIndex}`;
      refs.push([ref, node.backendDOMNodeId]);
      line += ` ${ref}`;
    }
    const states = statesOf(node);
    if (states.length) line += ` [${states.join(" ")}]`;
    const value = truncate(str(node.value?.value), VALUE_MAX);
    if (value) line += ` = ${JSON.stringify(value)}`;
    return line;
  };

  const walk = (node: AXNodeLike | undefined, indent: number, depthLeft: number): void => {
    if (!node) return;
    const role = roleOf(node);
    const skip = node.ignored || SKIP_ROLES.has(role);
    let childIndent = indent;
    let childDepth = depthLeft;
    if (!skip) {
      // emit() mints refs as a side effect — roll them back when the depth
      // limit prunes this node (a ref absent from the text must not exist).
      const refMark = refs.length;
      const idxMark = refIndex;
      const line = emit(node, indent);
      if (line != null) {
        if (depthLeft <= 0) {
          refs.length = refMark;
          refIndex = idxMark;
          return;
        }
        lines.push(line);
        childIndent = indent + 1;
        childDepth = depthLeft - 1;
      }
    }
    for (const id of node.childIds ?? []) walk(byId.get(id), childIndent, childDepth);
  };

  walk(root, 0, opts.depth != null ? opts.depth : Number.POSITIVE_INFINITY);
  return { text: lines.join("\n"), refs, nextRefIndex: refIndex };
}
