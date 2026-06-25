// Composition root — the only place that knows all the rings. Wires
//   source.onSnapshot → reducer/queue → presenter
// Held by AppDelegate, so it lives for the process lifetime. Keeps AppDelegate
// from growing a status-bar responsibility; every collaborator is behind a port.

import Cocoa

final class StatusBarCoordinator {
    private let source: AgentStatusSource
    private let reducer = FleetReducer()
    private let queue: CompletionQueue
    private let controller: StatusItemController
    // navigator (and the brandImage init param) are retained as inputs for the
    // forthcoming status-bar panel; idle until that lands.
    private let navigator: AgentNavigator

    // Diff baseline: the previous snapshot, indexed by id. nil ⇒ next snapshot
    // seeds silently (cold start / post-reconnect — no completion storm).
    private var prev: [String: AgentSnapshot]?
    private var latest: [AgentSnapshot] = []
    private let dwell: TimeInterval = 4.35 // 4.35 = 3× the original 1.45s, kept longer so completions are readable

    init(navigator: AgentNavigator,
         brandImage: NSImage?,
         onQuit: @escaping () -> Void,
         onOpenWindow: @escaping () -> Void,
         source: AgentStatusSource = SSEAgentStatusSource()) {
        self.navigator = navigator
        self.source = source
        queue = CompletionQueue(scheduler: MainQueueScheduler(), dwell: dwell)
        controller = StatusItemController(dwell: dwell,
                                          onQuit: onQuit, onOpenWindow: onOpenWindow)

        queue.onAnnounce = { [weak self] completion, remaining in
            self?.controller.announce(completion, remaining: remaining)
        }
        queue.onDrained = { [weak self] in
            guard let self = self else { return }
            let count = self.runningCount(self.latest)
            self.controller.endAnnouncing(running: count > 0, count: count)
        }

        source.onConnectivity = { [weak self] up in
            guard let self = self else { return }
            self.controller.setConnected(up)
            if !up { self.prev = nil }   // reconnect reseeds silently
        }
        source.onSnapshot = { [weak self] snapshots in self?.ingest(snapshots) }
    }

    func start() { source.start() }

    private func ingest(_ snapshots: [AgentSnapshot]) {
        latest = snapshots
        let diff = reducer.diff(prev: prev, next: snapshots)

        let presentIds = Set(snapshots.map { $0.id })
        let activeIds = Set(snapshots.filter { $0.state.isInFlight }.map { $0.id })
        queue.ingest(completed: diff.completed, presentIds: presentIds, activeIds: activeIds)

        // Never overwrite a completion pill mid-play — the running face resumes
        // when the queue drains (onDrained).
        if !queue.isPlaying {
            controller.renderRunning(running: diff.running, count: diff.runningCount)
        }
        prev = reducer.index(snapshots)
    }

    private func runningCount(_ snapshots: [AgentSnapshot]) -> Int {
        snapshots.reduce(0) { $0 + ($1.state.isBusy ? 1 : 0) }
    }
}
