// App-wide singleton keymap — the one registry every binding site shares (the
// analog of search/index.js for the command palette). useGlobalKeymap reads it;
// useKeybinding registers onto it.

import { createKeymap } from "./keymap.js";

export const keymap = createKeymap();

export { combo, isMod } from "./keymap.js";
