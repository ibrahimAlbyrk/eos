import "./geo.css";
import { GeoMap } from "./Map.jsx";

// GeoMap, not Map: a component named Map would shadow the global in its module.
export const components = { Map: GeoMap };
