import { api } from "../../api/client.js";
import { initials } from "../../lib/profileText.js";

// The user's face everywhere it appears (sidebar, account menu, Settings, the
// interview): their photo, else the aurora orb with their initials, else the
// quiet placeholder. `className` lets a host keep its own sizing hook.
export function ProfileAvatar({ profile, size = 24, className = "" }) {
  const style = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.36)) };
  const cls = (mod) => `prof-avatar prof-avatar--${mod}${className ? ` ${className}` : ""}`;
  if (profile?.identity.avatar) {
    return <img className={cls("photo")} src={api.profileAvatarUrl(profile.rev)} alt="" style={style} draggable={false} />;
  }
  const letters = initials(profile);
  if (!letters) return <span className={cls("empty")} style={style} aria-hidden="true" />;
  return <span className={cls("orb")} style={style} aria-hidden="true">{letters}</span>;
}
