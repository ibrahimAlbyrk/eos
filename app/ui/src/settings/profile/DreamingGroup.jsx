import { useEffect, useMemo } from "react";
import { CONTROLS } from "../controls.jsx";
import { SettingRow } from "./SettingRow.jsx";
import { useProjects, refreshProjects } from "../../state/projectsStore.js";
import { useDreams, ensureDreamStatusLoaded, dreamNow } from "../../state/dreamStore.js";
import { useOpenMemory } from "../../hooks/useOpenMemory.js";
import { setMemoryPage } from "../../state/memoryViewStore.js";
import { MODEL_OPTIONS, dreamStatusLine, fmtDreamTime, runSummary } from "../../lib/dreamProposals.js";
import { projectLabel } from "../../lib/memoryGroups.js";
import { MoonIcon } from "../../views/memory/DreamProposal.jsx";

const Toggle = CONTROLS.toggle;
const Segmented = CONTROLS.segmented;
const Select = CONTROLS.select;
const Slider = CONTROLS.slider;

const SCHEDULES = [
  { value: "nightly", label: "Every night" },
  { value: "away", label: "While I'm away" },
  { value: "manual", label: "Only when I ask" },
];
const NIGHT_TIMES = ["22:00", "23:00", "00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00"].map((t) => ({ value: t, label: t }));
const AWAY_MINUTES = [10, 20, 30, 60].map((m) => ({ value: m, label: `${m} min` }));

// Settings › Profile › Learning — Dreaming: on/off, when, which projects, the
// model and limits, and where the last dream left things.
export function DreamingGroup({ profile, onSave }) {
  const s = profile.dreaming;
  const set = (patch) => onSave({ dreaming: patch });
  const { projects, loaded } = useProjects();
  const { status } = useDreams();
  const openMemory = useOpenMemory();
  useEffect(() => { if (!loaded) void refreshProjects(); ensureDreamStatusLoaded(); }, [loaded]);

  const folders = useMemo(() => [...new Set([...projects.map((p) => p.folders?.[0]).filter(Boolean), ...s.excludedProjects])].sort(), [projects, s.excludedProjects]);
  const toggleProject = (folder) => set({
    excludedProjects: s.excludedProjects.includes(folder) ? s.excludedProjects.filter((f) => f !== folder) : [...s.excludedProjects, folder],
  });
  const last = status?.lastRun;

  return (
    <div className="stg-group">
      <div className="stg-group__title">Learning</div>
      <div className="prof-dream">
        <span className={`prof-dream__icon${s.enabled ? " is-on" : ""}`}><MoonIcon size={16} /></span>
        <div className="prof-dream__text">
          <div className="prof-dream__label">Dreaming</div>
          <div className="prof-dream__desc">While you’re away, Eos rereads finished chats and suggests what’s worth remembering — new memories, fixes to old ones. You approve every change.</div>
        </div>
        <span className="dr-toggle"><Toggle value={s.enabled} onChange={(v) => set({ enabled: v })} /></span>
      </div>

      {s.enabled && (
        <div className="dr-settings">
          <SettingRow label="When" desc={s.schedule === "nightly" ? "Or the next time your Mac is awake" : s.schedule === "away" ? "No message from you and no agent working" : "Press Dream now when you want one"}>
            <span className="dr-settings__when">
              <Segmented value={s.schedule} onChange={(v) => set({ schedule: v })} options={SCHEDULES} />
              {s.schedule === "nightly" && <Select value={s.nightlyAt} onChange={(v) => set({ nightlyAt: v })} options={NIGHT_TIMES} />}
              {s.schedule === "away" && <Select value={s.awayMinutes} onChange={(v) => set({ awayMinutes: v })} options={AWAY_MINUTES} />}
            </span>
          </SettingRow>
          <SettingRow label="Look at" desc="Chats from projects you turn off are never read." stack>
            <span className="stg-chips">
              {folders.map((f) => (
                <button key={f} type="button" aria-pressed={!s.excludedProjects.includes(f)} className={`stg-chip${s.excludedProjects.includes(f) ? " is-off" : " is-on"}`} title={f} onClick={() => toggleProject(f)}>
                  {projectLabel(f)}
                </button>
              ))}
              <button type="button" aria-pressed={s.includeNoFolder} className={`stg-chip${s.includeNoFolder ? " is-on" : " is-off"}`} onClick={() => set({ includeNoFolder: !s.includeNoFolder })}>No-folder chats</button>
            </span>
          </SettingRow>
          <SettingRow label="Reads with" desc="On your Claude plan, on this Mac">
            <Select value={s.model} onChange={(v) => set({ model: v })} options={MODEL_OPTIONS} />
          </SettingRow>
          <SettingRow label="Per dream, read up to" desc="The rest waits for the next one">
            <Slider value={s.maxChats} onChange={(v) => set({ maxChats: v })} min={5} max={60} step={5} format={(v) => `${v} chats`} />
          </SettingRow>
          <SettingRow label="Hold off when plan usage is above" desc="Dreams never eat the limits you need for work">
            <Slider value={Math.round(s.usageCeiling * 100)} onChange={(v) => set({ usageCeiling: v / 100 })} min={30} max={100} step={5} format={(v) => `${v}%`} />
          </SettingRow>
          <SettingRow label="Morning note" desc="One banner when a dream finds something">
            <Toggle value={s.morningNote} onChange={(v) => set({ morningNote: v })} />
          </SettingRow>
        </div>
      )}

      <div className="dr-settings__status">
        <span className="dr-settings__statustext">
          <b>{last ? `Last dream · ${fmtDreamTime(last.startedAt)}` : "No dreams yet"}</b>
          <span>{[last ? runSummary(last) : null, dreamStatusLine(status, s)].filter(Boolean).join(" · ")}</span>
        </span>
        <button type="button" className="prof-link-btn" onClick={() => { openMemory(); setMemoryPage("log"); }}>Dream log</button>
        <button type="button" className="mem-btn mem-btn--soft" disabled={status?.running || status?.blocked === "sign-in"} onClick={() => void dreamNow()}>
          {status?.running ? "Dreaming…" : "Dream now"}
        </button>
      </div>
    </div>
  );
}
