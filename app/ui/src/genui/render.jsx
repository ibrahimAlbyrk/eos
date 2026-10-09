// Markup nodes → kit components. Each element renders as
//   <Comp attrs={node.attrs} node={node}>{children}</Comp>
// where children are, by what the element holds:
//   child elements → one <GvNode node> per element (text between them as
//                    inline markdown), so a container can read each child's
//                    attrs through `child.props.node` (Tabs reads label=);
//   only text      → the text as inline markdown (node.text has it raw);
//   <Code>         → the raw code string.
// when="expr" is evaluated here (false → the element is not rendered). An
// unknown tag is skipped, with a warning in development.

import { Component as ReactComponent, memo } from "react";
import { renderMarkdown } from "../lib/markdown.js";
import { truthy } from "../../../../contracts/src/genui/expr.ts";
import { walkMarkup } from "../../../../contracts/src/genui/markup.ts";
import { KIT } from "./kit/index.js";
import { useView } from "./runtime/ViewContext.jsx";

const RAW_TAGS = new Set(["Code"]);
const warned = new Set();

function warnUnknown(name) {
  if (!import.meta.env?.DEV || warned.has(name)) return;
  warned.add(name);
  console.warn(`[genui] <${name}> is not in the kit — skipped`);
}

// Links inside go where the view's actions go (browser panel, file panel).
export function InlineMarkdown({ text, className = "gv-md" }) {
  const view = useView();
  const onClick = (e) => {
    const a = e.target?.closest?.("a[href]");
    if (a && view.open(a.getAttribute("href"))) e.preventDefault();
  };
  return <div className={className} onClick={onClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

// A text run between elements. Carries its node like GvNode does, so a
// container mapping its children can tell the two apart.
export function GvText({ node }) {
  return <InlineMarkdown text={node.text} />;
}

function childrenOf(node) {
  if (RAW_TAGS.has(node.name)) return node.text;
  if (node.children.some((c) => c.type === "element")) return renderNodes(node.children);
  return node.text ? <InlineMarkdown text={node.text} /> : undefined;
}

// One element; memoized on the node object (a reparse makes new nodes, so a
// settled element keeps its identity only while its spec does).
export const GvNode = memo(function GvNode({ node }) {
  const view = useView();
  if (node.attrs.when !== undefined && !truthy(view.evalExpr(node.attrs.when))) return null;
  const Comp = KIT[node.name];
  if (!Comp) {
    warnUnknown(node.name);
    return null;
  }
  return (
    <NodeBoundary name={node.name}>
      <Comp attrs={node.attrs} node={node}>{childrenOf(node)}</Comp>
    </NodeBoundary>
  );
});

// Whether any element anywhere in the tree is one this build's kit lacks (a
// catalog newer than the app): the view then says part of it is missing.
export function hasUnknownTags(nodes) {
  let unknown = false;
  walkMarkup(nodes ?? [], (el) => {
    if (!KIT[el.name]) unknown = true;
  });
  return unknown;
}

export function renderNodes(nodes) {
  return (nodes ?? []).map((n, i) =>
    n.type === "element"
      ? <GvNode key={`${n.name}:${n.pos?.offset ?? i}`} node={n} />
      : <GvText key={`t:${n.pos?.offset ?? i}`} node={n} />,
  );
}

// One broken component costs only itself: the rest of the view still renders.
class NodeBoundary extends ReactComponent {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.warn(`[genui] <${this.props.name}> failed to render:`, error);
  }

  render() {
    if (this.state.failed) return <div className="gv-broken">Couldn't show this part</div>;
    return this.props.children;
  }
}
