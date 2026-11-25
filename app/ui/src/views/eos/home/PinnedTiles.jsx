import { useEffect } from "react";
import { ensurePinsLoaded, PIN_SLOTS, unpin, usePins } from "../../../state/eos/pinsStore.js";
import { notify } from "../../../lib/notify.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { clockOf, dayStart, numberWord } from "./homeWords.js";

// Where a tile opens: a Page's issue or an App on its screen; a View's routine.
export function tileLocation(tile) {
  if (tile.level === "page" || tile.level === "app") return buildLocation({ screen: "surface", surfaceId: tile.surfaceId });
  return buildLocation({ screen: "routine", routineId: tile.routineId });
}

// A tile's link in words: the design's own, or Eos's.
export function tileAction(tile) {
  if (tile.action) return tile.action;
  if (tile.level === "app") return "Open the App";
  return tile.level === "page" ? "Read the issue" : "Open it";
}

// What a tile with no headline says: its routine's status line (05 Q8), from
// the `routine.status` answer `{ state, live, last: { headline } }`.
export function tileStatus(status) {
  if (!status || typeof status !== "object") return "Nothing yet";
  if (status.live > 0) return "Running now";
  if (status.state === "paused") return "Paused";
  return status.last?.headline || "Nothing yet";
}

// When a tile's issue was printed: the clock today, "Yesterday", else the day.
export function tileWhen(at, now) {
  if (at == null) return null;
  const start = dayStart(now);
  if (at >= start) return clockOf(at);
  if (at >= start - 24 * 60 * 60 * 1000) return "Yesterday";
  return new Date(at).toLocaleDateString("en", { month: "short", day: "numeric" });
}

// What a tile holds, by its glyph: a Page's sheet, a View's panel, an App's window.
const LEVEL_GLYPH = {
  page: "M4.5 2.5h5l2 2v9h-7zM6.5 7h3M6.5 9.5h3",
  view: "M2.5 4h11v8h-11zM2.5 6.5h11",
  app: "M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z",
};
const LEVEL_WORD = { page: "Page", view: "View", app: "App" };
const PIN_GLYPH = "M6 2.5h4l-.5 4 2 2.5h-7l2-2.5zM8 9v4.5";
const ARROW = "M3.5 8h9M9 4.5 12.5 8 9 11.5";

// One pinned thing as a card: what it is and its name with when it was
// printed, its headline and detail, and its way in at the foot. The whole
// card opens it; Unpin shows on hover or focus.
function Tile({ tile, now }) {
  const drop = async () => {
    const r = await unpin(tile.surfaceId);
    if (!r.ok) notify.error(r.error, { title: "Unpinning did not work" });
  };
  const when = tileWhen(tile.issuedAt, now);
  return (
    <article className="eos-tile">
      <div className="eos-tile__meta">
        <svg className="eos-tile__glyph" aria-hidden="true" width="14" height="14" viewBox="0 0 16 16"><path d={LEVEL_GLYPH[tile.level] ?? LEVEL_GLYPH.view} /></svg>
        <span className="eos-tile__name">{tile.title}<span className="eos-sr">, {LEVEL_WORD[tile.level] ?? "View"}</span></span>
        {when && <span className="eos-tile__when">{when}</span>}
        <button type="button" className="eos-tile__unpin" aria-label={`Unpin ${tile.title}`} title="Unpin" onClick={() => void drop()}>
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16"><path d={PIN_GLYPH} /></svg>
          <span aria-hidden="true">Unpin</span>
        </button>
      </div>
      <p className="eos-tile__headline">{tile.headline ?? tileStatus(tile.status)}</p>
      {tile.detail && <p className="eos-tile__detail">{tile.detail}</p>}
      <button type="button" className="eos-tile__open" onClick={() => openLocation(tileLocation(tile))}>
        {tileAction(tile)}
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16"><path d={ARROW} /></svg>
      </button>
    </article>
  );
}

// The places left on Home, as one ghost the width of them: how a page gets here.
function FreePlaces({ count }) {
  return (
    <div className="eos-tile eos-tile--free" style={{ gridColumn: `span ${count}` }}>
      <p className="eos-tile__headline">{count === 1 ? "One more place" : `${numberWord(count).replace(/^./, (c) => c.toUpperCase())} more places`}</p>
      <p className="eos-tile__detail">Pin a Page or a View from its own screen to keep it here.</p>
    </div>
  );
}

// Home's pinned surfaces after Needs you: up to three cards drawn from 05's
// tile data, each with its unpin, and the places left as one ghost; live on
// surfaces:pins. Nothing shows while nothing is pinned.
export function PinnedTiles({ now = Date.now() }) {
  const { tiles } = usePins();
  useEffect(() => { ensurePinsLoaded(); }, []);
  if (!tiles?.length) return null;
  const free = PIN_SLOTS - tiles.length;
  return (
    <section className="eos-home-part" aria-labelledby="eos-home-pins">
      <div className="eos-pins__head">
        <h2 id="eos-home-pins" className="eos-label">Pinned</h2>
        <span className="eos-pins__count">{tiles.length} of {PIN_SLOTS}</span>
      </div>
      <div className="eos-pins">
        {tiles.map((tile) => <Tile key={tile.surfaceId} tile={tile} now={now} />)}
        {free > 0 && <FreePlaces count={free} />}
      </div>
    </section>
  );
}
