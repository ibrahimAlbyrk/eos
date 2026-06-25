// Domain layer — pure, no AppKit. The sequential completion ticker's state
// machine: a FIFO buffer of finished directives, played one at a time so
// several near-simultaneous completions queue and play in order (neighbours in
// the menu bar never shift). Time is injected via a Scheduler port so the
// dwell is testable without sleeping.

import Foundation

// Injected clock for the dwell timing. Production uses MainQueueScheduler; a
// test can drive a fake that fires synchronously.
protocol ScheduledToken: AnyObject {
    func cancel()
}

protocol Scheduler: AnyObject {
    @discardableResult
    func schedule(after seconds: TimeInterval, _ work: @escaping () -> Void) -> ScheduledToken
}

final class MainQueueScheduler: Scheduler {
    private final class Token: ScheduledToken {
        let item: DispatchWorkItem
        init(_ item: DispatchWorkItem) { self.item = item }
        func cancel() { item.cancel() }
    }

    @discardableResult
    func schedule(after seconds: TimeInterval, _ work: @escaping () -> Void) -> ScheduledToken {
        let item = DispatchWorkItem(block: work)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
        return Token(item)
    }
}

// The ticker buffer + playback engine. Knows nothing about icons or AppKit; it
// emits "announce this for its dwell" and "the queue drained" callbacks that a
// CompletionPresenter renders.
final class CompletionQueue {
    // Show one completion for this long before advancing (design HOLD = 1450ms).
    private let dwell: TimeInterval
    // Beyond this many pending, collapse the tail into one summary toast so a
    // 20-agent fan-out can't block the indicator for a minute.
    private let maxVisible: Int
    private let scheduler: Scheduler

    private var pending: [Completion] = []
    private var currentId: String?
    private var token: ScheduledToken?

    // (completion to show, how many still queued behind it) — drives the +N badge.
    var onAnnounce: ((Completion, _ remaining: Int) -> Void)?
    var onDrained: (() -> Void)?

    var isPlaying: Bool { currentId != nil }

    init(scheduler: Scheduler, dwell: TimeInterval = 1.45, maxVisible: Int = 6) {
        self.scheduler = scheduler
        self.dwell = dwell
        self.maxVisible = maxVisible
    }

    // Feed a fresh snapshot diff into the ticker.
    //   - completed: agents that just finished (enqueue, newest-wins per agent).
    //   - presentIds / activeIds: the live fleet. A pending toast is dropped if
    //     its agent restarted (is in flight again) or vanished — a finished-then-
    //     immediately-restarted agent must not announce a phantom completion. The
    //     item currently on screen always finishes its dwell (never interrupted).
    func ingest(completed: [Completion], presentIds: Set<String>, activeIds: Set<String>) {
        pending.removeAll { c in
            c.summaryCount == 0 && (activeIds.contains(c.agentId) || !presentIds.contains(c.agentId))
        }
        for c in completed {
            if let i = pending.firstIndex(where: { $0.agentId == c.agentId }) {
                pending[i] = c                      // per-agent coalesce: keep latest
            } else {
                pending.append(c)
            }
        }
        collapseOverflow()
        if currentId == nil { advance() }
    }

    // Keep at most (maxVisible - 1) individual toasts; fold the rest into a
    // single trailing summary ("✓ N agents done"), preserving any failure.
    private func collapseOverflow() {
        guard pending.count > maxVisible else { return }
        let keep = Array(pending.prefix(maxVisible - 1))
        let folded = Array(pending.suffix(from: maxVisible - 1))
        let anyFailed = folded.contains { $0.failed }
        let summary = Completion(agentId: "__summary__",
                                 name: "\(folded.count) agents",
                                 failed: anyFailed,
                                 summaryCount: folded.count)
        pending = keep + [summary]
    }

    private func advance() {
        token?.cancel()
        guard !pending.isEmpty else {
            currentId = nil
            onDrained?()
            return
        }
        let item = pending.removeFirst()
        currentId = item.agentId
        onAnnounce?(item, pending.count)
        token = scheduler.schedule(after: dwell) { [weak self] in
            self?.advance()
        }
    }
}
