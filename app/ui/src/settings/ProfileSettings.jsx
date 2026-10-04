import { useEffect, useState } from "react";
import { useProfile, ensureProfileLoaded, saveProfile } from "../state/profileStore.js";
import { ProfileHeader } from "./profile/ProfileHeader.jsx";
import { IdentityGroup, LanguageGroup, StyleGroup, WorkGroup } from "./profile/ProfileGroups.jsx";
import { InstructionsGroup } from "./profile/InstructionsGroup.jsx";
import { AgentPreview } from "./profile/AgentPreview.jsx";
import { DreamingRow } from "../components/profile/DreamingRow.jsx";
import { MemoryGroup } from "./profile/MemoryGroup.jsx";

// Settings › Profile — who the user is, as every agent sees it. Edit shows the
// form; "Preview as agent" swaps in the exact block a new agent gets, plus who
// receives it. Every change saves on its own (profileStore).
export function ProfileSettings() {
  const { profile, status, error } = useProfile();
  const [view, setView] = useState("edit");
  useEffect(() => { ensureProfileLoaded(); }, []);

  if (!profile) return <div className="stg-empty">Loading profile…</div>;

  return (
    <div className="prof-settings">
      <ProfileHeader profile={profile} status={status} error={error} view={view} onView={setView} />
      {view === "preview" ? (
        <AgentPreview profile={profile} onSave={saveProfile} />
      ) : (
        <>
          <IdentityGroup profile={profile} onSave={saveProfile} />
          <LanguageGroup profile={profile} onSave={saveProfile} />
          <WorkGroup profile={profile} onSave={saveProfile} />
          <StyleGroup profile={profile} onSave={saveProfile} />
          <InstructionsGroup profile={profile} onSave={saveProfile} />
          <MemoryGroup />
          <div className="stg-group">
            <div className="stg-group__title">Learning</div>
            <DreamingRow />
          </div>
        </>
      )}
    </div>
  );
}
