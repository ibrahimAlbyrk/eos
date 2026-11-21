import { createContext } from "react";

// Eos › Memory › About you draws the Agents Memory body, which reads the app's
// providers. The app hands it in (EosView.jsx); the sample gallery, which has
// no providers, leaves it out.
export const AboutYouSlot = createContext(null);
