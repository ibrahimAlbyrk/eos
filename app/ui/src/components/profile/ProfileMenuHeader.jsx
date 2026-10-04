import { ProfileAvatar } from "./ProfileAvatar.jsx";
import { isProfileEmpty, profileSubtitle } from "../../lib/profileText.js";

const Chevron = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const MemoryIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
  </svg>
);

// Agents suggested memories the user hasn't decided on — straight to the Memory view.
export function MemoryReviewRow({ count, onOpen }) {
  return (
    <button type="button" className="prof-menu-review" role="menuitem" onClick={onOpen}>
      <span className="prof-menu-review__icon"><MemoryIcon /></span>
      <span className="prof-menu-review__text">
        <span>{count === 1 ? "An agent noticed something" : `Agents noticed ${count} things`}</span>
        <span className="prof-menu-review__sub">Kept only if you say so</span>
      </span>
      <span className="prof-menu-review__cta">Review</span>
    </button>
  );
}

const MoonIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </svg>
);

// A dream filed proposals — straight into the one-at-a-time review.
export function DreamReviewRow({ count, onOpen }) {
  return (
    <button type="button" className="prof-menu-review prof-menu-review--dream" role="menuitem" onClick={onOpen}>
      <span className="prof-menu-review__icon"><MoonIcon /></span>
      <span className="prof-menu-review__text">
        <span>Dreamt · {count} to review</span>
        <span className="prof-menu-review__sub">New memories and fixes to old ones</span>
      </span>
      <span className="prof-menu-review__cta">Review</span>
    </button>
  );
}

// Top of the account menu: who the user is (opens Settings › Profile), or — while
// the profile is empty — an invitation to set it up.
export function ProfileMenuHeader({ profile, onOpen, onSetUp = onOpen }) {
  if (!profile) return null;
  if (isProfileEmpty(profile)) {
    return (
      <div className="prof-menu-invite">
        <div className="prof-menu-invite__text">
          <b>Introduce yourself</b>
          <span>Every agent starts a task knowing nothing about you. Two minutes fixes that.</span>
        </div>
        <button type="button" className="prof-menu-invite__btn" role="menuitem" onClick={onSetUp}>Set up profile</button>
      </div>
    );
  }
  const { fullName, callName, handle } = profile.identity;
  const sub = profileSubtitle(profile) || (handle ? `@${handle}` : "");
  return (
    <button type="button" className="prof-menu-head" role="menuitem" onClick={onOpen}>
      <ProfileAvatar profile={profile} size={40} />
      <span className="prof-menu-head__text">
        <span className="prof-menu-head__name">{fullName || callName}</span>
        {sub && <span className="prof-menu-head__sub">{sub}</span>}
      </span>
      <span className="prof-menu-head__chev"><Chevron /></span>
    </button>
  );
}
