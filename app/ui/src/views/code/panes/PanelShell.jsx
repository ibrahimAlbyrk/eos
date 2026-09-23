// PanelShell — the thin island wrapper every side-panel tab content fills. The
// shared chrome (tab bar, fullscreen, close, resize) now lives on the parent
// SidePanel, so this only provides the `--panel` surface + an optional header
// row (a viewer that still owns a sub-toolbar passes it as `title`/`actions`).
export function PanelShell({ type, title, actions, children }) {
  return (
    <div className={"panel-shell panel-shell--" + type}>
      {(title || actions) && (
        <div className="panel-shell__head">
          {title && <div className="panel-shell__title">{title}</div>}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}
