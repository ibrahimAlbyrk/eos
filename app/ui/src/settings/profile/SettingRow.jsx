// One settings row in the modal's own markup (stg-row): label + description on
// the left, the control beside it — or below it with `stack`.
export function SettingRow({ label, desc, stack = false, children }) {
  return (
    <div className={`stg-row${stack ? " stg-row--stack" : ""}`}>
      <div className="stg-row__text">
        <div className="stg-row__label">{label}</div>
        {desc && <div className="stg-row__desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}
