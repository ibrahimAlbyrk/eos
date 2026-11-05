// Who may reach a route from outside this Mac, in one place: the kernel's rules
// (contracts/src/route-planes.ts, remote/tiers.ts) plus what each feature module
// declares for its own routes.
//   localOnly — never forwarded to or from a paired computer (the peer gateway).
//   remote    — the phone's capability tier; anything unlisted is refused.
// The ui-token itself is checked by each handler.

import { KERNEL_LOCAL_ONLY_ROUTES, compileRouteRules, type RouteRule } from "../../contracts/src/route-planes.ts";
import { createTierClassifier, type RemoteRouteRule, type TierClassifier } from "../remote/tiers.ts";

export interface RouteAccess {
  readonly localOnly?: readonly RouteRule[];
  readonly remote?: readonly RemoteRouteRule[];
}

export interface ComposedRouteAccess {
  isLocalOnly(method: string, path: string): boolean;
  classifyRemote: TierClassifier;
}

export function composeRouteAccess(features: readonly (RouteAccess | undefined)[]): ComposedRouteAccess {
  const own = features.filter((f): f is RouteAccess => Boolean(f));
  return {
    isLocalOnly: compileRouteRules([...KERNEL_LOCAL_ONLY_ROUTES, ...own.flatMap((f) => f.localOnly ?? [])]),
    classifyRemote: createTierClassifier(own.flatMap((f) => f.remote ?? [])),
  };
}
