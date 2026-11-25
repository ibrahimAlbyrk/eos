import { createContext } from "react";

// A host that draws a form's send itself, outside the view (Eos's surfaces:
// every send sits outside the frame), provides a function here. A Form then
// draws only its fields and offers { label, phase, reason, ready, submit } to
// it, and null when it goes.
export const SubmitOutside = createContext(null);
