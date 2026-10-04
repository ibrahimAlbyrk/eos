import { useRef } from "react";
import { ProfileAvatar } from "../../components/profile/ProfileAvatar.jsx";
import { CONTROLS } from "../controls.jsx";
import { clearProfileAvatar, setProfileAvatar } from "../../state/profileStore.js";
import { profileSubtitle } from "../../lib/profileText.js";

const Segmented = CONTROLS.segmented;
const VIEWS = [
  { value: "edit", label: "Edit" },
  { value: "preview", label: "Preview as agent" },
];

const STATUS_TEXT = { saving: "Saving…" };

const CameraIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
);

export function ProfileHeader({ profile, status, error, view, onView }) {
  const fileRef = useRef(null);
  const { fullName, callName, avatar } = profile.identity;
  const sub = profileSubtitle(profile);

  const pick = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void setProfileAvatar(file);
  };

  return (
    <div className="prof-head">
      <div className="prof-head__avatar">
        <ProfileAvatar profile={profile} size={64} />
        <button type="button" className="prof-head__cam" aria-label="Change photo" title="Change photo" onClick={() => fileRef.current?.click()}>
          <CameraIcon />
        </button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={pick} />
      </div>
      <div className="prof-head__text">
        <div className="prof-head__name">{fullName || callName || "Your profile"}</div>
        <div className="prof-head__sub">
          {error ? <span className="prof-head__err">{error}</span> : (STATUS_TEXT[status] ?? sub) || "Tell agents who they work with"}
          {avatar && <button type="button" className="prof-link-btn" onClick={() => void clearProfileAvatar()}>Remove photo</button>}
        </div>
      </div>
      <Segmented value={view} onChange={onView} options={VIEWS} />
    </div>
  );
}
