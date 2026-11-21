// Settings › Eos — every setting of Eos mode in one place (09 §4.5), each read
// from and written through the route of the area that owns it
// (state/eos/eosSettingsStore.js): how much all routines may spend, keeping
// the Mac awake for schedules, what may interrupt, learning and reminders,
// Start at login, a test notification, what leaves the Mac with forgetting
// and exporting what was learned, and Stop everything.

import { useEffect, useState } from "react";
import {
  changeEosSetting, exportLearned, forgetAllLearned, loadEosSettings, sendTestPush, undoForgetAll, useEosSettings,
} from "../state/eos/eosSettingsStore.js";
import { ensureHaltLoaded, resumeEos, stopEos, useHalt } from "../state/eos/haltStore.js";
import { ToggleControl } from "./controls.jsx";

function Row({ label, description, children }) {
  return (
    <div className="stg-row">
      <div className="stg-row__text">
        <div className="stg-row__label">{label}</div>
        {description && <div className="stg-row__desc">{description}</div>}
      </div>
      {children}
    </div>
  );
}

function Group({ title, children }) {
  return (
    <div className="stg-group">
      <div className="stg-group__title">{title}</div>
      {children}
    </div>
  );
}

function DailyLimit({ settings }) {
  const [text, setText] = useState(null);
  const shown = text ?? String(settings.dayBudgetUsd);
  const save = () => {
    const usd = Number(shown);
    setText(null);
    if (shown.trim() !== "" && Number.isFinite(usd) && usd >= 0 && usd !== settings.dayBudgetUsd) {
      void changeEosSetting("routines", { dayBudgetUsd: usd });
    }
  };
  return (
    <Row label="Daily limit for all routines" description="Routines stop starting for the day once together they have spent this much.">
      <div className="stg-input eos-stg-money">
        <span aria-hidden="true">$</span>
        <input aria-label="Daily limit in dollars" inputMode="decimal" value={shown} onChange={(e) => setText(e.target.value)} onBlur={save} />
      </div>
    </Row>
  );
}

function Switch({ area, settings, field, label, description }) {
  return (
    <Row label={label} description={description}>
      <ToggleControl value={settings[field]} onChange={(on) => void changeEosSetting(area, { [field]: on })} />
    </Row>
  );
}

const INTERRUPTS = [
  { value: "all", label: "Everything that waits for me" },
  { value: "urgent", label: "Only what is urgent" },
  { value: "none", label: "Nothing" },
];

function Attention({ settings }) {
  const change = (patch) => void changeEosSetting("attention", patch);
  return (
    <>
      <Row label="What may interrupt" description="The rest waits in Needs you and in the digests.">
        <select className="stg-select" aria-label="What may interrupt" value={settings.interrupts} onChange={(e) => change({ interrupts: e.target.value })}>
          {INTERRUPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Row>
      <Row label="Quiet hours" description={settings.digests.length ? `Digests come at ${settings.digests.join(", ")}.` : undefined}>
        <span className="eos-stg-quiet">
          <ToggleControl value={settings.quietOn} onChange={(on) => change({ quietOn: on })} />
          <input type="time" aria-label="Quiet from" value={settings.quietFrom} disabled={!settings.quietOn} onChange={(e) => change({ quietFrom: e.target.value })} />
          <input type="time" aria-label="Quiet until" value={settings.quietTo} disabled={!settings.quietOn} onChange={(e) => change({ quietTo: e.target.value })} />
        </span>
      </Row>
    </>
  );
}

// The shell's login-item door (window.eosDoors); a browser tab has none.
function StartAtLogin({ doors }) {
  const [item, setItem] = useState(null);
  useEffect(() => { doors.loginItem().then(setItem, () => {}); }, [doors]);
  if (!item?.available) return null;
  const flip = async (on) => setItem(await doors.setLoginItem(on).catch(() => item));
  return (
    <Row
      label="Start at login"
      description={item.state === "needs-approval" ? "Waiting for your approval in System Settings › Login Items." : "Eos opens hidden when you log in, so schedules run."}
    >
      <ToggleControl value={item.state !== "off"} onChange={(on) => void flip(on)} />
    </Row>
  );
}

function PushTest() {
  const [line, setLine] = useState(null);
  return (
    <Row label="Test notification" description={line ?? "Sends one notification to the iPhones paired with this Mac."}>
      <button type="button" className="m-btn" onClick={async () => setLine((await sendTestPush()) ?? line)}>Send a test</button>
    </Row>
  );
}

function Privacy({ forgotten }) {
  const forget = () => {
    if (window.confirm("Forget every note Eos learned from your work? About you stays. You can undo this for 30 days.")) void forgetAllLearned();
  };
  return (
    <>
      <Row
        label="What leaves the Mac"
        description="Routines send only to the places their Goes to names, and only as freely as their Freedom allows. Notes Eos learns stay on this Mac, and reach your other Macs only through Sync, encrypted. Text inside pull requests, mails or web pages never becomes a note."
      />
      <Row
        label="Forget everything learned"
        description={forgotten === null ? "Every note from Learned from work. About you is kept." : `Forgot ${forgotten === 1 ? "one note" : `${forgotten} notes`}. You can bring them back for 30 days.`}
      >
        {forgotten === null
          ? <button type="button" className="m-btn m-btn--danger" onClick={forget}>Forget everything</button>
          : <button type="button" className="m-btn" onClick={() => void undoForgetAll()}>Undo</button>}
      </Row>
      <Row label="Export what was learned" description="Every note with what it was learned from, as one file.">
        <button type="button" className="m-btn" onClick={() => void exportLearned()}>Export</button>
      </Row>
    </>
  );
}

function StopEverything() {
  const { halt } = useHalt();
  return (
    <Row label="Stop everything" description={halt?.on ? "Eos is stopped: no routine runs and nothing is sent until you resume." : "No routine runs and nothing is sent until you resume."}>
      {halt?.on
        ? <button type="button" className="m-btn m-btn--accent" onClick={() => void resumeEos()}>Resume</button>
        : <button type="button" className="m-btn m-btn--danger" onClick={() => void stopEos()}>Stop everything</button>}
    </Row>
  );
}

export function EosSettings() {
  const { routines, signals, attention, memory, forgotten } = useEosSettings();
  useEffect(() => {
    void loadEosSettings();
    ensureHaltLoaded();
  }, []);
  const doors = globalThis.window?.eosDoors;
  return (
    <>
      <h2 className="stg-title">Eos</h2>
      <Group title="Routines">
        {routines && <DailyLimit settings={routines} />}
        {signals && (
          <Switch
            area="signals"
            settings={signals}
            field="keepAwakeForSchedules"
            label="Keep the Mac awake for schedules"
            description="On mains power, the Mac does not sleep while a schedule waits to run."
          />
        )}
      </Group>
      {attention && (
        <Group title="What interrupts you">
          <Attention settings={attention} />
        </Group>
      )}
      {memory && (
        <Group title="Memory">
          <Switch area="memory" settings={memory} field="learning" label="Learning" description="Eos writes down what your corrections and the work's outcomes teach it." />
          <Switch area="memory" settings={memory} field="reminders" label="Reminders" description="Agents are reminded of what Eos learned, in every chat and every run." />
        </Group>
      )}
      {doors && (
        <Group title="Doors">
          <StartAtLogin doors={doors} />
        </Group>
      )}
      <Group title="Remote">
        <PushTest />
      </Group>
      <Group title="Privacy">
        <Privacy forgotten={forgotten} />
      </Group>
      <Group title="Stop">
        <StopEverything />
      </Group>
    </>
  );
}
