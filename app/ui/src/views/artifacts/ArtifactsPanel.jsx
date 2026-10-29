import { useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { useSidePanelVisible } from "../../state/paneScope.js";
import { refreshArtifactCatalog, revalidateArtifactCatalog, useArtifactCatalog } from "../../state/artifactCatalogStore.js";
import { useArtifacts } from "../../state/artifactsStore.js";
import {
  AVATAR_TINTS, REL_FILTERS, accountInitial, artifactAgo, artifactRef, artifactRowLine, catalogSyncedAt,
  describeArtifact, filterArtifacts, groupByAccount,
} from "../../lib/artifacts.js";
import { findLeaf } from "../../lib/paneLayout.js";
import { shortcutLabel } from "../../lib/platform.js";
import { combo } from "../../keymap/index.js";
import { useKeybinding } from "../../keymap/useKeymap.js";
import { useClockTick } from "../../hooks/useClockTick.js";
import { PanelShell } from "../agents/panes/PanelShell.jsx";
import { AccountAvatar, ArtifactThumb, ChevronDown, GridGlyph, RefreshGlyph, SearchGlyph } from "./ArtifactParts.jsx";
import { useArtifactLinks } from "./useArtifactLinks.jsx";

// The `artifacts` side-panel tab: every artifact of every Claude sign-in,
// grouped by sign-in, searchable, narrowed to one account or to mine / shared.
// A row opens the artifact's tab; hover peeks at it to the panel's left.
export function ArtifactsPanel() {
  const ui = useUi();
  const visible = useSidePanelVisible();
  const catalog = useArtifactCatalog();
  const now = useClockTick(visible, 30_000);
  const [query, setQuery] = useState("");
  const [loginId, setLoginId] = useState(null);
  const [rel, setRel] = useState("all");
  const inputRef = useRef(null);
  const links = useArtifactLinks();

  // In a split each pane lists its own agent's artifacts as "This chat".
  const workerId = findLeaf(ui.tree, ui.paneId)?.agentId ?? ui.selectedId ?? null;
  const chatArtifacts = useArtifacts(workerId);
  const here = useMemo(() => new Set(chatArtifacts.map((a) => a.slug).filter(Boolean)), [chatArtifacts]);

  useEffect(() => { revalidateArtifactCatalog(); }, []);

  const panelOwnsKeys = visible && ui.focusedRegion === "panel" && ui.paneId === ui.focusedLeafId;
  useKeybinding({
    match: combo("mod+f"),
    priority: 10,
    when: () => panelOwnsKeys,
    run: (_ctx, e) => { e.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); },
  }, [panelOwnsKeys]);

  const { accounts, artifacts } = catalog;
  // A sign-in that went away stops narrowing the list.
  const account = loginId ? accounts.find((a) => a.loginId === loginId) ?? null : null;
  const narrowedTo = account ? loginId : null;
  const shown = filterArtifacts(artifacts, { query, loginId: narrowedTo, rel });
  const groups = groupByAccount(shown, accounts, { loginId: narrowedTo });
  const filtered = Boolean(query.trim()) || narrowedTo !== null || rel !== "all";
  const clearFilters = () => { setQuery(""); setLoginId(null); setRel("all"); };

  return (
    <PanelShell type="artifacts">
      <div className="art-list-head">
        <label className="art-search">
          <SearchGlyph />
          <input
            ref={inputRef}
            type="search"
            className="art-search__input"
            value={query}
            placeholder="Search artifacts"
            aria-label="Search artifacts"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); setQuery(""); } }}
          />
          <kbd className="art-kbd">{shortcutLabel("mod+f")}</kbd>
        </label>
        <div className="art-filters" role="toolbar" aria-label="Filter artifacts">
          {accounts.length > 1 && (
            <>
              <button type="button" className={"art-fchip" + (!narrowedTo ? " is-on" : "")} aria-pressed={!narrowedTo} onClick={() => setLoginId(null)}>
                All accounts
              </button>
              {accounts.map((a, i) => (
                <button
                  key={a.loginId}
                  type="button"
                  className={"art-fchip art-fchip--acct" + (narrowedTo === a.loginId ? " is-on" : "")}
                  aria-pressed={narrowedTo === a.loginId}
                  onClick={() => setLoginId(narrowedTo === a.loginId ? null : a.loginId)}
                >
                  <AccountAvatar account={{ label: a.label, initial: accountInitial(a), tint: i % AVATAR_TINTS }} size="sm" />
                  {a.label}
                </button>
              ))}
            </>
          )}
          <span className="art-filters__spacer" />
          <label className="art-rel">
            <select className="art-rel__select" value={rel} aria-label="Whose artifacts" onChange={(e) => setRel(e.target.value)}>
              {REL_FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            <ChevronDown />
          </label>
        </div>
      </div>

      <div className="art-list" {...links.handlers}>
        {!catalog.available ? (
          <Empty title="Artifacts list on the Mac they belong to" subtitle="A view of another computer doesn't show its Claude accounts' artifacts." />
        ) : !catalog.loaded ? (
          catalog.error
            ? <Empty title="Couldn't load artifacts" subtitle={catalog.error} action={{ label: "Retry", run: revalidateArtifactCatalog }} />
            : <div className="art-list__loading ti-shimmer">Loading artifacts…</div>
        ) : accounts.length === 0 ? (
          <Empty title="Sign in to Claude in Settings › Accounts" subtitle="Every artifact of every Claude account you sign in to shows up here." action={{ label: "Open Settings", run: () => ui.openSettings("accounts") }} />
        ) : groups.length === 0 ? (
          filtered
            ? <Empty title="Nothing found" subtitle={query.trim() ? `No artifact matches “${query.trim()}”.` : "No artifact matches these filters."} action={{ label: "Clear filters", run: clearFilters }} />
            : <Empty title="No artifacts yet" subtitle="Pages published with the Artifact tool show up here." />
        ) : (
          groups.map((g) => (
            <section key={g.account.loginId ?? "other"} className="art-group" aria-label={g.account.label}>
              <h3 className="art-group__head">
                <span className="art-group__label">{g.account.label}</span>
                <span className="art-group__count">{g.items.length}</span>
                {g.account.error && <span className="art-group__err" title={g.account.error}>{g.account.error}</span>}
                <span className="art-group__rule" />
              </h3>
              {g.items.map((a) => <ArtifactRow key={a.slug} entry={a} accounts={accounts} here={here.has(a.slug)} now={now} />)}
            </section>
          ))
        )}
        {links.layer}
      </div>

      {catalog.available && catalog.loaded && accounts.length > 0 && <Footer catalog={catalog} now={now} />}
    </PanelShell>
  );
}

function ArtifactRow({ entry, accounts, here, now }) {
  const info = describeArtifact(entry.slug, entry, {}, accounts);
  const refKey = `${info.slug}|${info.loginId}|${info.url}|${info.version}|${info.title}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const artRef = useMemo(() => artifactRef(info), [refKey]);
  return (
    <a
      className="art-row"
      href={info.url}
      target="_blank"
      rel="noopener noreferrer"
      data-art-slug={info.slug}
      data-title={info.title}
      data-login-id={info.loginId ?? undefined}
    >
      <ArtifactThumb info={info} artRef={artRef} className="art-row__thumb" />
      <span className="art-row__text">
        <span className="art-row__title">{info.title}</span>
        <span className="art-row__meta">{artifactRowLine(info)}</span>
      </span>
      {here && <span className="art-row__here">This chat</span>}
      <span className="art-row__ago">{artifactAgo(info.updatedAt, now)}</span>
    </a>
  );
}

function Footer({ catalog, now }) {
  const { accounts, refreshing } = catalog;
  const failing = accounts.some((a) => a.error);
  const synced = catalogSyncedAt(accounts);
  const tone = refreshing ? "loading" : failing ? "warn" : "live";
  const text = [
    `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`,
    refreshing ? "syncing…" : synced != null ? `synced ${artifactAgo(synced, now)}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className="art-list-foot">
      <span className={`art-dot art-dot--${tone}`} aria-hidden="true" />
      <span className="art-list-foot__text">{text}</span>
      <button
        type="button"
        className={"art-refresh" + (refreshing ? " is-spinning" : "")}
        aria-label="Refresh artifacts"
        title="Refresh"
        disabled={refreshing}
        onClick={() => void refreshArtifactCatalog()}
      >
        <RefreshGlyph />
      </button>
    </div>
  );
}

function Empty({ title, subtitle, action }) {
  return (
    <div className="empty-state art-list__empty">
      <span className="empty-state__icon"><GridGlyph size={22} /></span>
      <span className="empty-state__title">{title}</span>
      {subtitle && <span className="empty-state__subtitle">{subtitle}</span>}
      {action && <button type="button" className="empty-state__action" onClick={action.run}>{action.label}</button>}
    </div>
  );
}
