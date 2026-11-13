// Before the first render, the stores the first screen reads take their answers from the
// boot snapshot, each through its own loader (so no request is made and the same code
// runs as later): the first render then draws the chat list, the transcript, the account
// and the profile at once instead of an empty window first. Hooks that keep their state
// in React start from the snapshot in their initializers (useLive, settings).
import { ROUTES } from "../api/routes.js";
import { bootPageChat, peekBootPart } from "../api/boot.js";
import { applyCatalog } from "../lib/models.js";
import { applyDescriptors, applyProfiles } from "../lib/backendCaps.js";
import { applyFeatures } from "./featuresStore.js";
import { ensureAccountsLoaded } from "./accountsStore.js";
import { ensureProfileLoaded } from "./profileStore.js";
import { ensureProjectsLoaded } from "./projectsStore.js";
import { primeNewest } from "./eventsStore.js";

export async function primeFromBoot() {
  const config = peekBootPart(ROUTES.uiConfig);
  if (config) {
    applyCatalog(config.modelCatalog);
    applyDescriptors(config.backends);
    applyProfiles(config.backendProfiles);
    applyFeatures(config.features);
  }
  // Only what the snapshot holds: a store whose answer is missing loads after the
  // render, as it would without a snapshot, instead of holding the render up.
  const held = (path) => peekBootPart(path) !== undefined;
  const chat = bootPageChat();
  await Promise.all([
    held(ROUTES.accounts) && ensureAccountsLoaded(),
    held(ROUTES.profile) && ensureProfileLoaded(),
    held(ROUTES.projects) && ensureProjectsLoaded(),
    chat && primeNewest(chat),
  ]);
}
