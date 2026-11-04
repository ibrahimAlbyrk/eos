// Visual answers (Settings › General): level / apps / location sharing are
// settings.json keys, the logo.dev key the config.json genui block. The PUT is
// the user's alone — the only way location sharing turns on (the flat
// PUT /api/settings refuses these keys; see the module's protectedSettings).

import type { Router } from "../../routes/Router.ts";
import { writeJson } from "../../middleware/errorHandler.ts";
import { readBody } from "../../middleware/bodyReader.ts";
import { validate } from "../../middleware/validate.ts";
import { uiTokenOk } from "../../routes/fs-shared.ts";
import { ROUTES, type UserSettings } from "../../../contracts/src/http.ts";
import { GENUI_SETTING_KEYS, GenuiSettingsPatchSchema, type GenuiSettings } from "../../../contracts/src/genui/spec.ts";

export interface GenuiSettingsRouteDeps {
  readonly settings: () => GenuiSettings;
  readonly userSettings: { patch(p: UserSettings): unknown };
  // Writes one config.json block and reloads the config (throws when it can't).
  patchConfig(key: string, patch: Record<string, unknown>): void;
  readonly uiToken: string;
}

export function registerGenuiSettingsRoutes(r: Router, c: GenuiSettingsRouteDeps): void {
  r.get(ROUTES.settingsGenui, ({ res }) => {
    writeJson(res, 200, c.settings());
  });

  r.put(ROUTES.settingsGenui, async ({ req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const patch = validate(GenuiSettingsPatchSchema.strict(), await readBody(req));
    const settings: UserSettings = {};
    if (patch.level !== undefined) settings[GENUI_SETTING_KEYS.level] = patch.level;
    if (patch.apps !== undefined) settings[GENUI_SETTING_KEYS.apps] = patch.apps;
    if (patch.locationShare !== undefined) settings[GENUI_SETTING_KEYS.locationShare] = patch.locationShare;
    if (Object.keys(settings).length) c.userSettings.patch(settings);
    // undefined drops the key when the block is written back: "" / null clear it.
    if (patch.logoDevKey !== undefined) {
      try {
        c.patchConfig("genui", { logoDevKey: patch.logoDevKey || undefined });
      } catch (e) {
        writeJson(res, 500, { error: `failed to write config: ${e instanceof Error ? e.message : String(e)}` });
        return;
      }
    }
    writeJson(res, 200, c.settings());
  });
}
