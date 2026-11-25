import { CLASSES, stateLine } from "../../capabilities/words.js";
import { AskRows, Fact } from "../../frame.jsx";

// What the live test's state says to the user (eos-contracts `LiveTest`).
const LIVE_WORDS = {
  not_run: "Send one real test first. Nothing goes out until you press Send a test.",
  sent: "Eos sent the test. Did your phone alert you?",
  failed: "The test did not go out. You can send it again.",
  alerted: "The test reached you.",
  not_alerted: "The test did not reach you. Decline it, or ask Eos for another way.",
};

export const liveStateOf = (detail) => detail.payload?.liveTest?.state;
export const settingKey = (name) => `setting:${name}`;

// A capability Eos proposes to add (06 G9, eos-contracts `CapabilityProposal`):
// its name and what it does, then its facts on hairlines (what it can do,
// each with what it counts as, what it reaches, runs and costs, what it asks
// for, how it was checked, who waits for it), the live test where one is
// due, and what Eos cannot promise as a footnote. Install is the user's,
// outside the frame; a secret is asked in the app's own prompt.
export function CapabilityProposal({ detail, values = {}, setValue = () => {} }) {
  const p = detail.payload ?? {};
  const { name, summary, actions = [], reach = {}, secrets = [], settings = [], routines = [], limits = [] } = p;
  const reaches = [...(reach.hosts ?? []), ...(reach.apps ?? []), ...(reach.files ?? [])];
  const live = liveStateOf(detail);
  const findings = p.review?.findings?.length ?? 0;
  const rows = [
    actions.length > 0 && ["Can do", (
      <ul className="eos-needs-card__list" aria-label="What it can do">
        {actions.map((a) => (
          <li key={a.name}>{a.summary ?? a.name}<span className="eos-needs-card__class"> · {CLASSES[a.class] ?? a.class}</span></li>
        ))}
      </ul>
    )],
    ["Reaches", reaches.length ? reaches.join(", ") : "Nothing outside this Mac"],
    p.source && ["Runs", <PublishedSource key="source" source={p.source} />],
    p.cost && ["Costs", p.cost],
    secrets.length > 0 && ["Asks for", `${secrets.map((s) => s.label).join(", ")}, in Eos's own prompt`],
    p.tests && ["Checked", (
      <span className={p.tests.passed ? "eos-fact eos-fact--ok" : "eos-fact eos-fact--err"}>
        {p.tests.passed ? "Eos's tests passed under the sandbox" : "Eos's tests did not pass"}
        {p.review?.verdict === "pass" ? `; the reviewer passed it${findings ? ` with ${findings} notes` : ""}.` : "."}
      </span>
    )],
    routines.length > 0 && ["Waiting", routines.map((r) => r.name).join(", ")],
  ].filter(Boolean);
  return (
    <div className="eos-needs-card eos-needs-proposal">
      <p className="eos-needs-card__lead"><strong>{name ?? detail.item.title}</strong>{summary ? ` · ${summary}` : ""}</p>
      {p.replaces && <ReplacedVersion replaces={p.replaces} />}
      <AskRows rows={rows} />
      {live && <LiveTest state={live} />}
      {live && live !== "alerted" && live !== "sent" && settings.map((s) => {
        const field = `eos-setting-${s.name}`;
        return (
          <div key={s.name} className="eos-needs-question eos-needs-well">
            <label htmlFor={field} className="eos-label">{s.label}</label>
            <input
              id={field}
              className="eos-needs-question__answer"
              value={values[settingKey(s.name)] ?? ""}
              onChange={(e) => setValue(settingKey(s.name), e.target.value)}
            />
          </div>
        );
      })}
      {limits.length > 0 && (
        <div className="eos-needs-limits">
          <p className="eos-label">What Eos cannot promise</p>
          <ul className="eos-needs-card__list eos-needs-card__class" aria-label="What Eos cannot promise">
            {limits.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// The live test as three stations on one line, as a run's are drawn: the
// way behind solid, the station it is at lit in its tone (breathing while
// Eos waits for the user's word), the way ahead dashed; then what it means
// as a fact in the same tone.
const STATIONS = ["Test", "Sent", "Reached you"];
const LIVE_AT = { not_run: 0, failed: 1, sent: 1, alerted: 2, not_alerted: 2 };
const LIVE_STOP_WORDS = {
  not_run: ["Not sent yet", "", ""],
  failed: ["", "Did not go out", ""],
  sent: ["", "Waiting for your word", ""],
  alerted: ["", "", "It did"],
  not_alerted: ["", "", "It did not"],
};

function LiveTest({ state }) {
  const at = LIVE_AT[state] ?? 0;
  const tone = LIVE_TONES[state];
  const stop = (i) => {
    if (i > at) return "eos-beat__stop eos-beat__stop--ahead";
    if (i < at) return "eos-beat__stop";
    return `eos-beat__stop eos-beat__stop--newest eos-beat__stop--${tone}${state === "sent" ? " eos-beat__stop--working" : ""}`;
  };
  return (
    <section className="eos-needs-live" aria-label="One real test">
      <p className="eos-label">One real test before it is yours</p>
      <div className={at === STATIONS.length - 1 ? "eos-beat eos-beat--ends eos-needs-live__line" : "eos-beat eos-needs-live__line"} aria-hidden="true">
        <ol className="eos-beat__line">
          {STATIONS.map((name, i) => (
            <li key={name} className={stop(i)}>
              <span className="eos-beat__mark">
                <span className="eos-beat__dot" />
                <span className="eos-beat__tag">{name}</span>
                <span className={i === at ? `eos-beat__word eos-beat__word--${tone}` : "eos-beat__word"}>{(LIVE_STOP_WORDS[state] ?? [])[i] || "\u00a0"}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <Fact tone={tone} role="status">{LIVE_WORDS[state] ?? state}</Fact>
    </section>
  );
}

// The live test's state in its tone.
const LIVE_TONES = { not_run: "active", sent: "active", failed: "err", alerted: "ok", not_alerted: "warn" };

// Code from elsewhere (06 G12): the package it runs, pinned, who published
// it, and everything it installed.
function PublishedSource({ source }) {
  const { package: pkg = {}, community, dependencies = [] } = source;
  return (
    <>
      <span>{pkg.name} {pkg.version} from {pkg.registry}{community ? ", published by someone other than the service (community)" : ""}.</span>
      {dependencies.length > 0 && (
        <ul className="eos-needs-card__list eos-needs-card__class" aria-label="What it installs">
          {dependencies.map((d) => <li key={d}>{d}</li>)}
        </ul>
      )}
    </>
  );
}

// A repair replaces the installed version (06 G9): which one, and what the
// new one may do that it could not, before the user says yes.
function ReplacedVersion({ replaces }) {
  const { version, widens = [] } = replaces;
  return (
    <div className="eos-needs-replaces">
      <Fact tone={widens.length ? "warn" : undefined}>
        Replaces version {version}, which you installed.{widens.length ? " New in this version:" : " It reaches and may do nothing more."}
      </Fact>
      {widens.length > 0 && (
        <ul className="eos-needs-card__list eos-needs-card__class" aria-label="What it adds">
          {widens.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
    </div>
  );
}

// A capability that needs the user before it works again: why, in words, and
// the version that still works. What happened is the lead's.
export function CapabilityProblem({ detail }) {
  const why = stateLine({ state: detail.payload?.state ?? "needs_setup", stateCode: detail.payload?.stateCode });
  if (!why && !detail.payload?.goBack) return null;
  return (
    <div className="eos-needs-card">
      {why && <Fact className="eos-needs-card__class">{why}</Fact>}
      {detail.payload?.goBack && <Fact className="eos-needs-card__class">Version {detail.payload.goBack} still works on this Mac.</Fact>}
    </div>
  );
}
