// Domain layer — pure, no AppKit. Unit-testable headless.
//
// The fleet's value types and the snapshot-diff reducer. Completion detection is
// a pure function of two consecutive /workers snapshots (never a trust of an
// inline SSE payload), exactly as the architecture design specifies: GET
// /workers keeps terminal rows, so a busy→settled transition is observable as a
// state change in the list rather than a disappearance.

import Foundation

// The seven canonical worker states (contracts/src/events.ts WorkerStateSchema).
enum AgentState: String {
    case spawning  = "SPAWNING"
    case working   = "WORKING"
    case idle      = "IDLE"
    case ending    = "ENDING"
    case done      = "DONE"
    case killing   = "KILLING"
    case suspended = "SUSPENDED"

    // The canonical "busy/running" predicate the daemon itself uses
    // (manager/routes/workers.ts:107) — drives the running animation + count.
    var isBusy: Bool { self == .spawning || self == .working }

    // "Still in flight" for completion purposes: a worker shutting down (ENDING)
    // hasn't finished yet, so a busy→ENDING step must NOT announce — we wait for
    // it to land on a settled state. Including ENDING here means the final
    // ENDING→DONE step is the one that fires (with an authoritative exit_code).
    var isInFlight: Bool { isBusy || self == .ending }

    // A directive is "finished" when the worker settles into IDLE (turn done,
    // awaiting input) or DONE (worker ended). Product decision #2: completion
    // fires on the transition out of the busy set into idle/terminal — not only
    // on full DONE. SUSPENDED/KILLING are neither (daemon-restart / user-kill);
    // they never announce.
    var isSettled: Bool { self == .idle || self == .done }
}

// One agent as the indicator cares about it — the projection of a /workers row
// onto the handful of fields this feature reads. AppKit-free value type.
struct AgentSnapshot: Equatable {
    let id: String
    let state: AgentState
    let name: String?
    let isOrchestrator: Bool
    let parentId: String?
    let startedAt: Double?       // epoch ms
    let endedAt: Double?         // epoch ms
    let turnStartedAt: Double?   // epoch ms — authoritative turn clock
    let exitCode: Int?           // terminal exit; non-zero ⇒ failure
    let role: String?
    let definition: String?

    // Display label, with the null-name fallback the design + WorkerRowSchema
    // both anticipate (a short id).
    var displayName: String {
        if let n = name, !n.isEmpty { return n }
        return String(id.prefix(6))
    }
}

// A finished directive ready to play in the ticker.
struct Completion: Equatable {
    let agentId: String
    let name: String
    let failed: Bool
    // >0 ⇒ a collapsed overflow summary standing in for N completions
    // ("✓ N agents done"), so a large fan-out can't monopolize the indicator.
    let summaryCount: Int

    init(agentId: String, name: String, failed: Bool, summaryCount: Int = 0) {
        self.agentId = agentId
        self.name = name
        self.failed = failed
        self.summaryCount = summaryCount
    }
}

struct FleetDiff {
    let running: Bool
    let runningCount: Int
    let completed: [Completion]
}

// The reducer: a pure diff of two snapshots. Deterministic, survives
// missed/duplicated SSE frames, needs no payload guarantees from the daemon.
struct FleetReducer {

    // A worker "completed" a directive across S(t-1) → S(t) when it was in
    // flight (SPAWNING/WORKING/ENDING) and is now settled (IDLE/DONE).
    //   - prev == nil ⇒ cold start / post-reconnect reseed: emit NO completions
    //     (establish the baseline silently — otherwise every already-DONE worker
    //     would flood the ticker on launch).
    //   - failure: a DONE row with a non-zero exit_code uses the failure
    //     treatment. IDLE settles and ENDING→DONE(exit 0) are successes.
    func diff(prev: [String: AgentSnapshot]?, next: [AgentSnapshot]) -> FleetDiff {
        let runningCount = next.reduce(0) { $0 + ($1.state.isBusy ? 1 : 0) }
        let running = runningCount > 0

        guard let prev = prev else {
            return FleetDiff(running: running, runningCount: runningCount, completed: [])
        }

        var completed: [Completion] = []
        for n in next {
            guard let p = prev[n.id] else { continue }       // newly appeared — not a completion
            guard p.state.isInFlight, n.state.isSettled else { continue }
            let failed = (n.state == .done) && (n.exitCode != nil && n.exitCode != 0)
            completed.append(Completion(agentId: n.id, name: n.displayName, failed: failed))
        }
        return FleetDiff(running: running, runningCount: runningCount, completed: completed)
    }

    func index(_ snapshots: [AgentSnapshot]) -> [String: AgentSnapshot] {
        var map: [String: AgentSnapshot] = [:]
        for s in snapshots { map[s.id] = s }
        return map
    }
}
