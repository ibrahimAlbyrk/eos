import { laterInboxItem } from "../../../state/eos/inboxStore.js";
import { openLocation } from "../nav/eosNav.js";
import { itemLocation } from "../needs/NeedsYouList.jsx";
import { isShownOnly, primaryAction } from "../needs/words.js";
import { clockOf, NEEDS_CARDS } from "./homeWords.js";
import { RoutineGlyph } from "../routines/RoutineGlyph.jsx";

export function NeedsCard({ item, routineName, routineIcon }) {
  const open = () => openLocation(itemLocation(item.id));
  return (
    <article className="eos-home-card">
      <div className="eos-home-card__meta">
        <RoutineGlyph icon={routineIcon} name={routineName ?? "Eos"} size={13} part="eos-home-card" />
        <span className="eos-home-card__routine">{routineName ?? "Eos"}</span>
        <span className="eos-home-card__time">{clockOf(item.createdAt)}</span>
      </div>
      <h3 className="eos-home-card__title">{item.title}</h3>
      {item.summary && <p className="eos-home-card__summary">{item.summary}</p>}
      <div className="eos-home-card__actions">
        <button type="button" className="eos-btn eos-btn--primary" onClick={open}>{primaryAction(item.kind)}</button>
        {item.state === "open" && !isShownOnly(item.id) && (
          <button type="button" className="eos-btn eos-btn--quiet" onClick={() => void laterInboxItem(item.id)}>Later</button>
        )}
      </div>
    </article>
  );
}

// The first three open items in Needs you's order, then "All N in Needs you".
// `shown` holds the runs whose cards already open under the input's live
// lines: their cards are not drawn twice, though the count takes them in.
export function NeedsYouCards({ items: all, names, icons = {}, shown = new Set() }) {
  const items = all.filter((i) => !shown.has(i.runId));
  if (items.length === 0) return null;
  return (
    <section className="eos-home-part" aria-labelledby="eos-home-needs">
      <h2 id="eos-home-needs" className="eos-label">Needs you</h2>
      <div className="eos-home-cards">
        {items.slice(0, NEEDS_CARDS).map((item) => <NeedsCard key={item.id} item={item} routineName={names[item.routineId]} routineIcon={icons[item.routineId]} />)}
      </div>
      {all.length > Math.min(items.length, NEEDS_CARDS) && (
        <button type="button" className="eos-link eos-home-all" onClick={() => openLocation("eos:/needs")}>All {all.length} in Needs you</button>
      )}
    </section>
  );
}
