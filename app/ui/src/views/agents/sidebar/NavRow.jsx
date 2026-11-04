import { setMainView, useMainView } from "../../../slots/index.js";

// One row of the sidebar's primary nav (New task, Changes, Archive, …).
export function NavRow({ icon, label, meta, strong, selected, onClick }) {
  const cls = ["sb-nav-row"];
  if (strong) cls.push("strong");
  if (selected) cls.push("on");
  return (
    <button className={cls.join(" ")} onClick={onClick}>
      <span className="sb-nav-row__ic">{icon}</span>
      <span className="sb-nav-row__label">{label}</span>
      {meta != null && <span className="sb-nav-row__meta">{meta}</span>}
    </button>
  );
}

// A nav row that toggles a main view, for items declared as { label, icon, view }.
export function ViewNavRow({ item }) {
  const active = useMainView() === item.view;
  return (
    <NavRow
      icon={item.icon}
      label={item.label}
      meta={item.meta}
      selected={active}
      strong={active}
      onClick={() => setMainView(active ? null : item.view)}
    />
  );
}
