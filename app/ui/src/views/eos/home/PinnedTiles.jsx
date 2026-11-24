import { useEffect } from "react";
import { ensurePinsLoaded, PIN_SLOTS, unpin, usePins } from "../../../state/eos/pinsStore.js";
import { notify } from "../../../lib/notify.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";

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

function Tile({ tile }) {
  const drop = async () => {
    const r = await unpin(tile.surfaceId);
    if (!r.ok) notify.error(r.error, { title: "Unpinning did not work" });
  };
  return (
    <article className="eos-tile">
      <div className="eos-tile__meta">
        <span className="eos-tile__name">{tile.title}</span>
        <button type="button" className="eos-tile__unpin" aria-label={`Unpin ${tile.title}`} title="Unpin" onClick={() => void drop()}>
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16"><path d="M6 2.5h4l-.5 4 2 2.5h-7l2-2.5zM8 9v4.5" /></svg>
        </button>
      </div>
      <p className="eos-tile__headline">{tile.headline ?? tileStatus(tile.status)}</p>
      {tile.detail && <p className="eos-tile__detail">{tile.detail}</p>}
      <button type="button" className="eos-link eos-tile__open" onClick={() => openLocation(tileLocation(tile))}>{tileAction(tile)}</button>
    </article>
  );
}

// Home's pinned surfaces after Needs you (SurfacePins.dc.html): up to three
// tiles drawn from 05's tile data, each with its unpin button; live on
// surfaces:pins. Nothing shows while nothing is pinned.
export function PinnedTiles() {
  const { tiles } = usePins();
  useEffect(() => { ensurePinsLoaded(); }, []);
  if (!tiles?.length) return null;
  return (
    <section className="eos-home-part" aria-labelledby="eos-home-pins">
      <div className="eos-pins__head">
        <h2 id="eos-home-pins" className="eos-label">Pinned</h2>
        <span className="eos-pins__count">{tiles.length} of {PIN_SLOTS}</span>
      </div>
      <div className="eos-pins">
        {tiles.map((tile) => <Tile key={tile.surfaceId} tile={tile} />)}
      </div>
    </section>
  );
}
