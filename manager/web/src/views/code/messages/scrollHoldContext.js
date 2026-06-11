// Narrow channel from DisclosureRow to the stick-to-bottom scroller that owns
// it: "the user is expanding something — hold the viewport instead of gliding
// to the new bottom". Default no-op so disclosure rows rendered outside a
// stick scroller (right-panel viewers) need no provider.
import { createContext, useContext } from "react";

export const ScrollHoldContext = createContext(() => {});
export const useScrollHold = () => useContext(ScrollHoldContext);
