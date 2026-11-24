import { createContext } from "react";

// The chat a transcript belongs to: what a card in it acts for (a routine's
// run started from the chat is told back to it).
export const ChatContext = createContext(null);
