import { useEffect, useMemo, useRef, useState } from "react";
import { PROJECT_ICONS, ICON_COLORS, DEFAULT_ICON_COLOR, IconGlyph } from "../../lib/projectIcons.jsx";
import { EMOJI_CATEGORIES, searchEmoji } from "../../lib/emojiData.js";

// Emoji / Icons picker for a project's icon. onChange(icon | null) — null is
// "Clear" (back to the default folder). Opens on the tab matching the current
// icon; a swatch recolors the current glyph in place.
export function IconPicker({ value, onChange, onClose, anchorRef }) {
  const [tab, setTab] = useState(value?.kind === "emoji" ? "emoji" : "icons");
  const [query, setQuery] = useState("");
  const [color, setColor] = useState(value?.kind === "icon" && value.color ? value.color : DEFAULT_ICON_COLOR);
  const rootRef = useRef(null);

  useEffect(() => {
    // The anchor toggles the picker itself — closing here too would reopen it.
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target) && !anchorRef?.current?.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [onClose, anchorRef]);

  const switchTab = (t) => { setTab(t); setQuery(""); };

  const pickColor = (c) => {
    setColor(c);
    if (value?.kind === "icon") onChange({ ...value, color: c });
  };

  return (
    <div className="icon-picker glass-pop" ref={rootRef} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <div className="icon-picker__head">
        <div className="icon-picker__tabs">
          <button className={"icon-picker__tab" + (tab === "emoji" ? " on" : "")} onClick={() => switchTab("emoji")}>Emoji</button>
          <button className={"icon-picker__tab" + (tab === "icons" ? " on" : "")} onClick={() => switchTab("icons")}>Icons</button>
        </div>
        <button className="icon-picker__clear" onClick={() => onChange(null)}>Clear</button>
      </div>
      <input
        className="icon-picker__search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={tab === "emoji" ? "Search emojis" : "Search icons"}
        autoFocus
      />
      {tab === "icons"
        ? <IconsTab query={query} color={color} value={value} onColor={pickColor} onPick={(id) => onChange({ kind: "icon", value: id, color })} />
        : <EmojiTab query={query} value={value} onPick={(emoji) => onChange({ kind: "emoji", value: emoji })} />}
    </div>
  );
}

function IconsTab({ query, color, value, onColor, onPick }) {
  const q = query.trim().toLowerCase();
  const icons = q ? PROJECT_ICONS.filter((i) => i.tags.includes(q)) : PROJECT_ICONS;
  return (
    <>
      <div className="icon-picker__colors">
        {ICON_COLORS.map((c) => (
          <button
            key={c}
            className={"icon-picker__swatch" + (c === color ? " on" : "")}
            style={{ background: c }}
            title={c}
            onClick={() => onColor(c)}
          />
        ))}
      </div>
      <div className="icon-picker__grid" style={{ color }}>
        {icons.map((i) => (
          <button
            key={i.id}
            className={"icon-picker__cell" + (value?.kind === "icon" && value.value === i.id ? " on" : "")}
            title={i.id}
            onClick={() => onPick(i.id)}
          >
            <IconGlyph id={i.id} size={16} />
          </button>
        ))}
        {icons.length === 0 && <div className="icon-picker__empty">No icons</div>}
      </div>
    </>
  );
}

function EmojiTab({ query, value, onPick }) {
  const scrollRef = useRef(null);
  const results = useMemo(() => (query.trim() ? searchEmoji(query) : null), [query]);

  const jumpTo = (id) => {
    const el = scrollRef.current?.querySelector(`[data-cat="${id}"]`);
    if (el) scrollRef.current.scrollTop = el.offsetTop;
  };

  const cell = (item) => (
    <button
      key={item.emoji}
      className={"icon-picker__cell icon-picker__cell--emoji" + (value?.kind === "emoji" && value.value === item.emoji ? " on" : "")}
      title={item.tags}
      onClick={() => onPick(item.emoji)}
    >{item.emoji}</button>
  );

  return (
    <>
      {!results && (
        <div className="icon-picker__cats">
          {EMOJI_CATEGORIES.map((c) => (
            <button key={c.id} className="icon-picker__cat" title={c.label} onClick={() => jumpTo(c.id)}>{c.icon}</button>
          ))}
        </div>
      )}
      <div className="icon-picker__scroll" ref={scrollRef}>
        {results
          ? <div className="icon-picker__grid icon-picker__grid--emoji">
              {results.map(cell)}
              {results.length === 0 && <div className="icon-picker__empty">No emojis</div>}
            </div>
          : EMOJI_CATEGORIES.map((c) => (
              <div key={c.id} data-cat={c.id}>
                <div className="icon-picker__label">{c.label}</div>
                <div className="icon-picker__grid icon-picker__grid--emoji">{c.items.map(cell)}</div>
              </div>
            ))}
      </div>
    </>
  );
}
