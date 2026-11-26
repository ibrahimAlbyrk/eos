// Settings › Eos — every setting of Eos mode in one place (09 §4.5), each read
// from and written through the route of the area that owns it
// (state/eos/eosSettingsStore.js). It opens on where Eos stands, in the
// stopped band's shape with Stop everything or Resume beside it; then each
// area under Eos's label on hairlines: how much all routines may spend and
// keeping the Mac awake for schedules, what may interrupt, learning and
// reminders, how pages read (text size, more contrast, plain reading), the
// doors (Start at login, the quick panel's shortcut, the eos command), a test
// notification, and what leaves the Mac with forgetting (asked in Eos's
// dialog, with its way back) and exporting what was learned.

import { useEffect, useState } from "react";
import {
  changeEosSetting, exportLearned, forgetAllLearned, loadEosSettings, sendTestPush, tidyMemoryNow, undoForgetAll, useEosSettings,
} from "../state/eos/eosSettingsStore.js";
import { ensureHaltLoaded, resumeEos, stopEos, useHalt } from "../state/eos/haltStore.js";
import { Dialog } from "../views/eos/frame.jsx";
import { sinceAt } from "../views/eos/routine/words.js";
import { ToggleControl } from "./controls.jsx";
import { AccessibilityRow, Choice, CommandRow, Row, ShortcutRow } from "./EosDoors.jsx";

function Group({ title, children }) {
  return (
    <section className="stg-group eos-stg__group" aria-label={title}>
      <h3 className="eos-label eos-stg__label">{title}</h3>
      {children}
    </section>
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
      <label className="eos-stg__money">
        <span aria-hidden="true">$</span>
        <input aria-label="Daily limit in dollars" inputMode="decimal" value={shown} style={{ width: `${Math.max(shown.length, 1) + 0.5}ch` }} onChange={(e) => setText(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        <span className="eos-stg__unit">a day</span>
      </label>
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

const TEXT_SCALES = [100, 115, 130].map((n) => ({ value: n, label: `${n} %` }));

// How a routine's pages read (05 Q11): bigger text, more contrast, or every
// issue in Eos's own plain look.
function Reading({ settings }) {
  return (
    <>
      <Row label="Text size" description="How large the text of a page is.">
        <Choice label="Text size" options={TEXT_SCALES} value={settings.textScale} onChange={(n) => void changeEosSetting("surfaces", { textScale: n })} />
      </Row>
      <Row label="More contrast" description="Text and lines on pages stand out more.">
        <ToggleControl value={settings.contrast === "more"} onChange={(on) => void changeEosSetting("surfaces", { contrast: on ? "more" : "normal" })} />
      </Row>
      <Switch area="surfaces" settings={settings} field="plain" label="Plain reading" description="Every issue in Eos's own plain look instead of its page's design." />
    </>
  );
}

const INTERRUPTS = [
  { value: "all", label: "Everything", line: "Everything that waits for me" },
  { value: "urgent", label: "Only urgent", line: "Only what is urgent" },
  { value: "none", label: "Nothing", line: "Nothing" },
];

function Attention({ settings }) {
  const change = (patch) => void changeEosSetting("attention", patch);
  const quiet = settings.quietOn
    ? `Nothing interrupts from ${settings.quietFrom} to ${settings.quietTo}.`
    : "Off: what may interrupt does, at any hour.";
  return (
    <>
      <Row label="What may interrupt" description="The rest waits in Needs you and in the digests.">
        <Choice label="What may interrupt" options={INTERRUPTS} value={settings.interrupts} onChange={(interrupts) => change({ interrupts })} />
      </Row>
      <Row label="Quiet hours" description={settings.digests.length ? `${quiet} Digests come at ${settings.digests.join(" and ")}.` : quiet}>
        <span className="eos-stg__quiet">
          <span className="eos-stg__times" aria-disabled={!settings.quietOn}>
            <input type="time" aria-label="Quiet from" value={settings.quietFrom} disabled={!settings.quietOn} onChange={(e) => change({ quietFrom: e.target.value })} />
            <span aria-hidden="true">to</span>
            <input type="time" aria-label="Quiet until" value={settings.quietTo} disabled={!settings.quietOn} onChange={(e) => change({ quietTo: e.target.value })} />
          </span>
          <ToggleControl value={settings.quietOn} onChange={(on) => change({ quietOn: on })} />
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
  const waits = item.state === "needs-approval";
  return (
    <Row
      label="Start at login"
      tone={waits ? "warn" : undefined}
      description={waits ? "Waiting for your approval in System Settings › Login Items." : "Eos opens hidden when you log in, so schedules run."}
    >
      <ToggleControl value={item.state !== "off"} onChange={(on) => void flip(on)} />
    </Row>
  );
}

function TidyNow() {
  const [line, setLine] = useState(null);
  return (
    <Row label="Tidy memory" description={line ?? "Eos tidies what it learned every night. Tidy it now instead."}>
      <button type="button" className="eos-btn" onClick={async () => setLine((await tidyMemoryNow()) ?? line)}>Tidy now</button>
    </Row>
  );
}

function PushTest() {
  const [line, setLine] = useState(null);
  return (
    <Row label="Test notification" description={line ?? "Sends one notification to the iPhones paired with this Mac."}>
      <button type="button" className="eos-btn" onClick={async () => setLine((await sendTestPush()) ?? line)}>Send a test</button>
    </Row>
  );
}

const MEMORY_ICON = "M8 2.5 13.5 5.5 8 8.5 2.5 5.5zM2.5 8.5 8 11.5l5.5-3M2.5 11 8 14l5.5-3";

// Asks before every learned note goes, with Cancel first and focused: the
// notes can be brought back for 30 days, About you is kept.
export function ForgetDialog({ onClose }) {
  const forget = () => {
    onClose();
    void forgetAllLearned();
  };
  return (
    <Dialog
      id="eos-stg-forget"
      from="Settings › Eos"
      icon={MEMORY_ICON}
      title="Forget every note Eos learned from your work?"
      line="Agents stop being reminded of them at once. About you stays. You can bring the notes back for 30 days."
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="eos-btn eos-btn--quiet" onClick={onClose}>Cancel</button>
          <button type="button" className="eos-btn eos-btn--primary" onClick={forget}>Forget everything</button>
        </>
      )}
    />
  );
}

function Privacy({ forgotten }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <p className="eos-stg__note">
        <span>Routines send only to the places their Goes to names, and only as freely as their Freedom allows. Notes Eos learns stay on this Mac, and reach your other Macs only through Sync, encrypted. Text inside pull requests, mails or web pages never becomes a note.</span>
      </p>
      <Row
        label="Forget everything learned"
        tone={forgotten === null ? undefined : "ok"}
        description={forgotten === null ? "Every note from Learned from work. About you is kept." : `Forgot ${forgotten === 1 ? "one note" : `${forgotten} notes`}. You can bring them back for 30 days.`}
      >
        {forgotten === null
          ? <button type="button" className="eos-btn eos-btn--stop" onClick={() => setAsking(true)}>Forget everything</button>
          : <button type="button" className="eos-btn" onClick={() => void undoForgetAll()}>Bring them back</button>}
      </Row>
      <Row label="Export what was learned" description="Every note with what it was learned from, as one file.">
        <button type="button" className="eos-btn" onClick={() => void exportLearned()}>Export</button>
      </Row>
      {asking && <ForgetDialog onClose={() => setAsking(false)} />}
    </>
  );
}

// Where Eos stands, said as an Eos screen leads: the fact at 24 with its
// tone's mark in the margin, what it means dim under it, the one act after.
function Standing({ routines }) {
  const { halt } = useHalt();
  const on = halt?.on === true;
  let words = ["Stop everything", "No routine runs and nothing is sent until you resume."];
  if (on) words = [`Eos is stopped${halt.since != null ? ` since ${sinceAt(halt.since)}` : ""}.`, words[1]];
  else if (halt) words = ["Eos is running on this Mac.", `${routines ? `Routines may spend $${routines.dayBudgetUsd} a day together. ` : ""}Stop everything halts every run and every send at once.`];
  let tone = "";
  if (halt) tone = on ? " eos-stg__fact--err" : " eos-stg__fact--ok";
  return (
    <div className={on ? "eos-stg__standing eos-stg__standing--stopped" : "eos-stg__standing"} role="status" aria-label="Stop everything">
      <p className={`eos-stg__fact${tone}`}>{words[0]}</p>
      <p className="eos-stg__means">{words[1]}</p>
      <span className="eos-stg__acts">
        {on
          ? <button type="button" className="eos-btn eos-btn--primary" onClick={() => void resumeEos()}>Resume</button>
          : <button type="button" className="eos-btn eos-btn--stop" onClick={() => void stopEos()}>Stop everything</button>}
      </span>
    </div>
  );
}

export function EosSettings() {
  const { routines, signals, attention, memory, surfaces, forgotten } = useEosSettings();
  useEffect(() => {
    void loadEosSettings();
    ensureHaltLoaded();
  }, []);
  const doors = globalThis.window?.eosDoors;
  return (
    <div className="eos-stg">
      <h2 className="eos-label eos-stg__title">Eos</h2>
      <Standing routines={routines} />
      <Group title="Routines">
        {routines ? <DailyLimit settings={routines} /> : <Ghost />}
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
      <Group title="What interrupts you">
        {attention ? <Attention settings={attention} /> : <Ghost />}
      </Group>
      <Group title="Memory">
        {memory ? (
          <>
            <Switch area="memory" settings={memory} field="learning" label="Learning" description="Eos writes down what your corrections and the work's outcomes teach it." />
            <Switch area="memory" settings={memory} field="reminders" label="Reminders" description="Agents are reminded of what Eos learned, in every chat and every run." />
          </>
        ) : <Ghost />}
        <TidyNow />
      </Group>
      <Group title="Pages">
        {surfaces ? <Reading settings={surfaces} /> : <Ghost />}
      </Group>
      {doors && (
        <Group title="Doors">
          <StartAtLogin doors={doors} />
          <ShortcutRow doors={doors} />
          <AccessibilityRow doors={doors} />
          <CommandRow doors={doors} />
        </Group>
      )}
      <Group title="Remote">
        <PushTest />
      </Group>
      <Group title="What leaves the Mac">
        <Privacy forgotten={forgotten} />
      </Group>
    </div>
  );
}

// An area not read yet: one row of two bars, so the pane keeps its shape.
function Ghost() {
  return (
    <div className="eos-skeleton eos-skeleton--rows eos-stg__ghost" aria-hidden="true">
      <div className="eos-skeleton__row"><span /><span /></div>
    </div>
  );
}
