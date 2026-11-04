// Composition root for the built-in slot items of the Agents view. Importing this
// module runs the registrations (import side effect); AgentsView imports it so
// the slots are filled before they render.

import { headerRight, sidebarNav, mainViews } from "../../slots/index.js";
import { JobsBeacon } from "../jobs/JobsBeacon.jsx";
import { UpdateBeacon } from "../update/UpdateBeacon.jsx";
import { NewTaskNavItem, ChangesNavItem, ArchiveNavItem } from "./sidebar/navItems.jsx";
import { ArchiveView } from "../archive/ArchiveView.jsx";
import { MemoryView } from "../memory/MemoryView.jsx";

headerRight.add({ id: "jobs", order: 10, once: true, Component: JobsBeacon });
headerRight.add({ id: "update", order: 20, once: true, Component: UpdateBeacon });

sidebarNav.add({ id: "new-task", order: 10, Component: NewTaskNavItem });
sidebarNav.add({ id: "changes", order: 20, Component: ChangesNavItem });
sidebarNav.add({ id: "archive", order: 30, Component: ArchiveNavItem });

mainViews.add({ id: "archive", Component: ArchiveView });
mainViews.add({ id: "memory", Component: MemoryView });
