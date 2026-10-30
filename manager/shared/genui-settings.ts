// The visual-answers switches as one value: level / apps / location sharing from
// settings.json (GENUI_SETTING_KEYS), the logo.dev key from config.json's genui
// block. Anything malformed reads as its default, and a bad key is no key.

import {
  GENUI_SETTING_DEFAULTS,
  GENUI_SETTING_KEYS,
  GenuiLevelSchema,
  LogoDevKeySchema,
  type GenuiSettings,
} from "../../contracts/src/genui/spec.ts";
import type { UserSettings } from "../../contracts/src/http.ts";
import type { DaemonConfig } from "./config.ts";

export function genuiSettingsOf(settings: UserSettings, config: Pick<DaemonConfig, "genui">): GenuiSettings {
  const level = GenuiLevelSchema.safeParse(settings[GENUI_SETTING_KEYS.level]);
  const apps = settings[GENUI_SETTING_KEYS.apps];
  const locationShare = settings[GENUI_SETTING_KEYS.locationShare];
  const key = LogoDevKeySchema.safeParse(config.genui?.logoDevKey);
  return {
    level: level.success ? level.data : GENUI_SETTING_DEFAULTS.level,
    apps: typeof apps === "boolean" ? apps : GENUI_SETTING_DEFAULTS.apps,
    locationShare: typeof locationShare === "boolean" ? locationShare : GENUI_SETTING_DEFAULTS.locationShare,
    logoDevKey: key.success ? key.data : null,
  };
}
