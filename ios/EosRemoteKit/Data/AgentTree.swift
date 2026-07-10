import Foundation

// Agents tree + attention policy (REDESIGN_CONTRACT §D) — pure ports of the Mac's lib/tree.js
// buildAgentTree and lib/agentAttention.js, with the running-first root comparator of §D2.

public struct AgentNode: Identifiable, Sendable, Equatable {
    public let worker: Worker
    public let children: [AgentNode]
    public var id: String { worker.id }

    public init(worker: Worker, children: [AgentNode] = []) {
        self.worker = worker
        self.children = children
    }

    // Root + all descendants; the Code-list subtitle's "N workers" is subtreeSize − 1.
    public var subtreeSize: Int { children.reduce(1) { $0 + $1.subtreeSize } }
}

public enum AgentTree {
    // D-4: KILLING is still "hot" (orange/active) — a session being torn down counts as running.
    public static func isRunningState(_ state: String) -> Bool {
        state == "WORKING" || state == "SPAWNING" || state == "KILLING"
    }

    public static func recencyKey(_ w: Worker) -> Double { max(w.turnStartedAt ?? 0, w.startedAt) }

    public static func subtreeRunning(_ node: AgentNode) -> Bool {
        isRunningState(node.worker.state) || node.children.contains(where: subtreeRunning)
    }

    // Max recencyKey over the node and all descendants — what rootCompare orders idle roots by.
    public static func subtreeRecencyKey(_ node: AgentNode) -> Double {
        node.children.reduce(recencyKey(node.worker)) { max($0, subtreeRecencyKey($1)) }
    }

    // §D2: running subtrees first, then most recently active, identical keys break by id desc.
    public static func rootCompare(_ a: AgentNode, _ b: AgentNode) -> Bool {
        let runA = subtreeRunning(a), runB = subtreeRunning(b)
        if runA != runB { return runA }
        let keyA = subtreeRecencyKey(a), keyB = subtreeRecencyKey(b)
        if keyA != keyB { return keyA > keyB }
        return a.id > b.id
    }

    // §D1: child ↔ parent via parent_id (missing parent ⇒ root); children sorted started_at ASC
    // inside every parent; roots ordered by rootCompare.
    public static func buildTree(_ workers: [Worker]) -> [AgentNode] {
        let ids = Set(workers.map(\.id))
        var childRows: [String: [Worker]] = [:]
        var rootRows: [Worker] = []
        for w in workers {
            if let pid = w.parentId, ids.contains(pid) { childRows[pid, default: []].append(w) }
            else { rootRows.append(w) }
        }
        func build(_ w: Worker) -> AgentNode {
            let kids = (childRows[w.id] ?? [])
                .sorted { $0.startedAt == $1.startedAt ? $0.id < $1.id : $0.startedAt < $1.startedAt }
                .map(build)
            return AgentNode(worker: w, children: kids)
        }
        return rootRows.map(build).sorted(by: rootCompare)
    }

    // Running filter (§C2): keep only nodes that are themselves running or carry a running
    // descendant — parents stay as context, idle siblings drop. Order is preserved.
    public static func pruneRunning(_ nodes: [AgentNode]) -> [AgentNode] {
        nodes.compactMap { n in
            let kids = pruneRunning(n.children)
            guard isRunningState(n.worker.state) || !kids.isEmpty else { return nil }
            return AgentNode(worker: n.worker, children: kids)
        }
    }

    // MARK: attention policy (§D4, port of lib/agentAttention.js)

    public static func sigOf(_ w: Worker) -> String {
        "\((w.tokensIn ?? 0) + (w.tokensOut ?? 0))|\(w.toolCalls ?? 0)|\(w.costUSD ?? 0)"
    }

    public static func isStopped(_ state: String) -> Bool {
        state == "IDLE" || state == "DONE" || state == "SUSPENDED"
    }

    // nil lastViewedSig = never seeded (existed before launch) — never flag those, to avoid a
    // wall of false positives on startup.
    public static func needsAttention(lastViewedSig: String?, worker: Worker) -> Bool {
        guard !worker.id.isEmpty, isStopped(worker.state), let sig = lastViewedSig else { return false }
        return sig != sigOf(worker)
    }
}
