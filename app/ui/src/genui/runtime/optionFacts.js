import { createContext } from "react";

// A host that knows facts about the options of a view's choices (Eos's
// surfaces, from what the run handed in beside the view) provides a function
// here: (label, value) → [{ label, value }] or null. A Choice draws them as
// plain text in the option's card.
export const OptionFacts = createContext(null);
