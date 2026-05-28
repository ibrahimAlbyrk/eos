import { createSearchRegistry } from "./registry.js";
import { agentsProvider } from "./providers/agents.js";
import { workflowsProvider } from "./providers/workflows.js";

// Default, app-wide registry. Order here = group order in the palette.
// Extend at runtime via `searchRegistry.register(myProvider)`.
export const searchRegistry = createSearchRegistry([agentsProvider, workflowsProvider]);
