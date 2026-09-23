import { createSearchRegistry } from "./registry.js";
import { agentsProvider } from "./providers/agents.js";
import { quickActionsProvider } from "./providers/quickActions.js";
import { templatesProvider } from "./providers/templates.js";
import { settingsProvider } from "./providers/settings.js";
import { changesProvider } from "./providers/changes.js";

// Default, app-wide registry. Order here = group order in the palette; Agents
// then Quick actions mirrors the reference (EOS.dc.html:2184).
// Extend at runtime via `searchRegistry.register(myProvider)`.
export const searchRegistry = createSearchRegistry([agentsProvider, quickActionsProvider, templatesProvider, settingsProvider, changesProvider]);
