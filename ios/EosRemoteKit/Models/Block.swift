import Foundation

// One normalized transcript block — the output of the event→block parser (spec 03 §4.2, port of
// messageParser.js buildBlocks). The envelope carries identity (id/workerId/blockId), the
// creation-domain sort key (ts), a live flag for render-time overlays, and a typed `payload` enum
// so views read structured fields instead of re-parsing strings. Every payload case mirrors a JS
// block shape (Messages.jsx renderBlock, spec 03 §1).
public struct Block: Identifiable, Sendable, Equatable {
    public let id: String          // stable render key (spec 03 §4.9 keying)
    public let workerId: String
    public let blockId: String?    // live→durable handoff (thinking / assistant)
    public let ts: Double          // creation-domain ts (tsTranscript / anchorTs), spec 03 §4.9
    public var live: Bool
    public let payload: Payload

    public init(id: String, workerId: String, blockId: String? = nil, ts: Double, live: Bool = false, payload: Payload) {
        self.id = id; self.workerId = workerId; self.blockId = blockId
        self.ts = ts; self.live = live; self.payload = payload
    }

    public enum Payload: Sendable, Equatable {
        case user(text: String, optimistic: Bool)
        case assistant(text: String)
        case thinking(text: String)
        case tool(Tool)
        case toolGroup(lane: Lane, summary: String, tools: [Tool])
        case agentRun(AgentRun)
        case report(text: String, fromWorker: String?, workerName: String?)
        case directive(text: String, fromParent: String?, parentName: String?)
        case peerRequest(text: String, fromWorker: String?, fromName: String?)
        case loop(text: String)
        case loopCheck(LoopCheck)
        case terminal(Terminal)
        case deliveryFailed(text: String)
        case cleared
        case turnError(reason: String, message: String)
        case gitPush(ok: Bool, message: String, branch: String?)
        case gitPull(ok: Bool, message: String, branch: String?)
        case worktreePreserved(path: String, branch: String, diffStat: String)
    }

    public enum Lane: String, Sendable, Equatable { case generic, worker }
}

// A single tool call — the universal tool row (spec 03 §2, §4.2.1). `verb` is verbFor(name);
// `running`/`done` are authoritative from the lifecycle pass. Optional links: `skillBody`/`skillPath`
// (Skill), `peerTo` (ask_peer / respond_to_peer).
public struct Tool: Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public var verb: String
    public let input: JSONValue
    public var result: ToolResult?
    public var running: Bool
    public var done: Bool
    public let ts: Double
    public var skillBody: String?
    public var skillPath: String?
    public var peerTo: AgentRef?

    public init(id: String, name: String, verb: String, input: JSONValue,
                result: ToolResult? = nil, running: Bool, done: Bool, ts: Double,
                skillBody: String? = nil, skillPath: String? = nil, peerTo: AgentRef? = nil) {
        self.id = id; self.name = name; self.verb = verb; self.input = input
        self.result = result; self.running = running; self.done = done; self.ts = ts
        self.skillBody = skillBody; self.skillPath = skillPath; self.peerTo = peerTo
    }
}

public struct ToolResult: Sendable, Equatable {
    public let text: String
    public let isError: Bool
    public let patch: JSONValue?
    public init(text: String, isError: Bool, patch: JSONValue? = nil) {
        self.text = text; self.isError = isError; self.patch = patch
    }
}

public struct AgentRef: Sendable, Equatable {
    public let id: String?
    public let name: String?
    public init(id: String?, name: String?) { self.id = id; self.name = name }
}

// A sub-agent run — the folded Agent/spawnsSubagent block (spec 03 §4.2.2). Inner tool calls fold
// into `tools`; `background`/`status`/`result` come from the subagent lifecycle events.
public struct AgentRun: Sendable, Equatable {
    public let toolUseId: String
    public let description: String
    public let prompt: String
    public let model: String?
    public let subagentType: String?
    public let status: String
    public let background: Bool
    public let result: String?
    public let tools: [Tool]

    public init(toolUseId: String, description: String, prompt: String, model: String?,
                subagentType: String?, status: String, background: Bool, result: String?, tools: [Tool]) {
        self.toolUseId = toolUseId; self.description = description; self.prompt = prompt
        self.model = model; self.subagentType = subagentType; self.status = status
        self.background = background; self.result = result; self.tools = tools
    }
}

// A durable goal-check verdict (spec 03 §4.2.3). maxAttempts is nil for an unbounded loop.
public struct LoopCheck: Sendable, Equatable {
    public let attempt: Int?
    public let maxAttempts: Int?
    public let strategy: String?
    public let met: Bool
    public let outcome: String?
    public let reason: String

    public init(attempt: Int?, maxAttempts: Int?, strategy: String?, met: Bool, outcome: String?, reason: String) {
        self.attempt = attempt; self.maxAttempts = maxAttempts; self.strategy = strategy
        self.met = met; self.outcome = outcome; self.reason = reason
    }
}

// A terminal run block (spec 03 §4.2.4). Durable rows are `done`; the live overlay (Phase 4b) sets
// live=true on the envelope while streaming.
public struct Terminal: Sendable, Equatable {
    public let runId: String?
    public let command: String
    public let output: String
    public let exitCode: Int
    public let note: String?
    public let truncated: Bool
    public let done: Bool

    public init(runId: String?, command: String, output: String, exitCode: Int, note: String?, truncated: Bool, done: Bool) {
        self.runId = runId; self.command = command; self.output = output
        self.exitCode = exitCode; self.note = note; self.truncated = truncated; self.done = done
    }
}
