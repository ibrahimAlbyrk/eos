// The declarative parts of Settings › Profile — each group owns one concern and
// saves only the leaves it shows.

import { CONTROLS } from "../controls.jsx";
import { SettingRow } from "./SettingRow.jsx";
import {
  AUTONOMY_OPTIONS, CHAT_LANGUAGE_OPTIONS, COMMIT_OPTIONS, LANGUAGE_OPTIONS, LEVEL_OPTIONS,
  REPLY_OPTIONS, ROLE_OPTIONS, UNCLEAR_OPTIONS,
} from "../../lib/profileOptions.js";

const Text = CONTROLS.text;
const Chips = CONTROLS.chips;
const Tags = CONTROLS.tags;
const Segmented = CONTROLS.segmented;

export function IdentityGroup({ profile, onSave }) {
  const set = (key) => (v) => onSave({ identity: { [key]: v } });
  return (
    <div className="stg-group">
      <div className="stg-group__title">Identity</div>
      <SettingRow label="Full name">
        <Text value={profile.identity.fullName} onChange={set("fullName")} placeholder="Your name" />
      </SettingRow>
      <SettingRow label="What agents call you" desc="Used in replies and notifications">
        <Text value={profile.identity.callName} onChange={set("callName")} placeholder="First name or nickname" />
      </SettingRow>
    </div>
  );
}

export function LanguageGroup({ profile, onSave }) {
  const set = (key) => (v) => onSave({ language: { [key]: v } });
  return (
    <div className="stg-group">
      <div className="stg-group__title">Language</div>
      <SettingRow label="Talk to me in">
        <Chips value={profile.language.chat} onChange={set("chat")} options={CHAT_LANGUAGE_OPTIONS} />
      </SettingRow>
      <SettingRow label="Code, commits & docs in">
        <Chips value={profile.language.code} onChange={set("code")} options={LANGUAGE_OPTIONS} />
      </SettingRow>
    </div>
  );
}

export function WorkGroup({ profile, onSave }) {
  const set = (key) => (v) => onSave({ work: { [key]: v } });
  return (
    <div className="stg-group">
      <div className="stg-group__title">Work</div>
      <SettingRow label="What you do" stack>
        <Chips value={profile.work.roles} onChange={set("roles")} options={ROLE_OPTIONS} multiple />
      </SettingRow>
      <SettingRow label="Stack" desc="Languages, frameworks and tools you work with" stack>
        <Tags value={profile.work.stack} onChange={set("stack")} placeholder="Add — e.g. TypeScript" />
      </SettingRow>
      <SettingRow label="Explain at" desc="Skips basics you already know">
        <Segmented value={profile.work.level} onChange={set("level")} options={LEVEL_OPTIONS} />
      </SettingRow>
    </div>
  );
}

export function StyleGroup({ profile, onSave }) {
  const set = (key) => (v) => onSave({ style: { [key]: v } });
  return (
    <div className="stg-group">
      <div className="stg-group__title">Working style</div>
      <SettingRow label="Replies" desc="How much agents write back">
        <Segmented value={profile.style.replies} onChange={set("replies")} options={REPLY_OPTIONS} />
      </SettingRow>
      <SettingRow label="Autonomy" desc="When to stop and check with you">
        <Segmented value={profile.style.autonomy} onChange={set("autonomy")} options={AUTONOMY_OPTIONS} />
      </SettingRow>
      <SettingRow label="When something's unclear">
        <Segmented value={profile.style.whenUnclear} onChange={set("whenUnclear")} options={UNCLEAR_OPTIONS} />
      </SettingRow>
      <SettingRow label="Commits">
        <Segmented value={profile.style.commits} onChange={set("commits")} options={COMMIT_OPTIONS} />
      </SettingRow>
    </div>
  );
}
