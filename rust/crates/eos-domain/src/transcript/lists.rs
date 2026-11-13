//! A conversation's subagents and artifacts, derived on the server from the
//! rows' facts exactly as the dashboard derives them from
//! `/workers/:id/subagent-events` (`app/ui/src/lib/messageParser.js`
//! `buildBlocks` after `applyClears` / `applyRewinds` / `applyRecalls`, then
//! `collectSubagents` and `collectArtifacts`). Only what those two lists read
//! is computed; a subagent's own rows ([`rows_of_subagent`]) rebuild the rest
//! in the dashboard.

use std::collections::{HashMap, HashSet};

use eos_contracts::{ChatArtifact, Num, SubagentActivity, SubagentRun, SubagentSummary, artifact_slug_from_url};
use indexmap::IndexMap;
use serde_json::Value;

use super::row_facts::{AgentInput, ArtifactInput, Item, Prompt, RowFacts};
use super::{CallRef, Selectable, kept_rows};

/// One indexed row of a worker's log.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexedRow {
    pub id: i64,
    pub ts: i64,
    pub facts: RowFacts,
}

impl Selectable for IndexedRow {
    fn id(&self) -> i64 {
        self.id
    }
    fn ts(&self) -> i64 {
        self.ts
    }
    fn refs(&self) -> &[CallRef] {
        &self.facts.refs
    }
    fn always(&self) -> bool {
        self.facts.always
    }
    fn started(&self) -> Option<&str> {
        self.facts.started.as_deref()
    }
}

/// The rows the dashboard's parse sees: the subagent selection, in the
/// conversation's order, after the clear, rewind and recall passes.
/// `boot_prompt_offset` is 1 for a dispatched worker whose task card stands
/// for a prompt with no row (`bootPromptOffset`).
fn visible(rows: &[IndexedRow], boot_prompt_offset: u32) -> Vec<&IndexedRow> {
    // Rows from time 0 on, as `/workers/:id/subagent-events` reads the log.
    let rows: Vec<&IndexedRow> = kept_rows(rows.iter().filter(|r| r.ts > 0));
    let rows = after_last_clear(rows);
    let rows = without_rewound(rows, boot_prompt_offset);
    without_recalled(rows)
}

fn after_last_clear(rows: Vec<&IndexedRow>) -> Vec<&IndexedRow> {
    match rows.iter().rposition(|r| matches!(r.facts.prompt, Some(Prompt::Cleared))) {
        Some(at) => rows[at..].to_vec(),
        None => rows,
    }
}

fn is_subagent_end(row: &IndexedRow) -> bool {
    row.facts.items.iter().any(|i| matches!(i, Item::Completed { .. }))
}

fn prompt_text(row: &IndexedRow) -> Option<&str> {
    match &row.facts.prompt {
        Some(Prompt::User { text, .. } | Prompt::Orchestrator { text }) => Some(text),
        _ => None,
    }
}

/// `applyRewinds`: a rewind hides its abandoned branch, from the prompt it
/// returned to, except the subagents that ended there.
fn without_rewound(rows: Vec<&IndexedRow>, boot_prompt_offset: u32) -> Vec<&IndexedRow> {
    let mut out: Vec<&IndexedRow> = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(Prompt::Rewound { text, display, index }) = &row.facts.prompt else {
            out.push(row);
            continue;
        };
        let needles: Vec<&str> = [text, display].into_iter().flatten().map(String::as_str).collect();
        let by_text = out.iter().rposition(|r| {
            prompt_text(r)
                .is_some_and(|t| !t.is_empty() && needles.iter().any(|n| n.starts_with(t) || t.starts_with(n)))
        });
        let cut = by_text.or_else(|| {
            let index = (*index)?;
            let mut count = f64::from(boot_prompt_offset);
            out.iter().position(|r| {
                if prompt_text(r).is_none() {
                    return false;
                }
                let hit = count == index;
                count += 1.0;
                hit
            })
        });
        if let Some(cut) = cut {
            let ended: Vec<&IndexedRow> = out[cut..].iter().copied().filter(|r| is_subagent_end(r)).collect();
            out.truncate(cut);
            out.extend(ended);
        }
    }
    out
}

/// `applyRecalls`: a recalled message the agent never answered is hidden.
fn without_recalled(rows: Vec<&IndexedRow>) -> Vec<&IndexedRow> {
    let mut row_ids = Vec::new();
    let mut client_ids = HashSet::new();
    for row in &rows {
        if let Some(Prompt::Recalled { row_id, client_msg_id }) = &row.facts.prompt {
            row_ids.extend(*row_id);
            client_ids.extend(client_msg_id.as_deref());
        }
    }
    if row_ids.is_empty() && client_ids.is_empty() {
        return rows;
    }
    rows.into_iter()
        .filter(|row| match &row.facts.prompt {
            Some(Prompt::Recalled { .. }) => false,
            #[allow(clippy::cast_precision_loss)]
            Some(Prompt::User { client_msg_ids, .. }) => {
                !row_ids.contains(&(row.id as f64)) && !client_msg_ids.iter().any(|c| client_ids.contains(c.as_str()))
            }
            _ => true,
        })
        .collect()
}

/// One event of the expanded stream: its row, the row's time, the event.
#[derive(Clone, Copy)]
struct Event<'a> {
    row: i64,
    ts: f64,
    item: &'a Item,
}

/// What a tool's result tells the lists.
#[derive(Clone, Copy, Default)]
struct Outcome<'a> {
    is_error: bool,
    artifact_url: Option<&'a str>,
}

/// `deriveToolLifecycle`: whether a tool is still running, and its result.
#[derive(Default)]
struct Lifecycle<'a> {
    results: HashMap<&'a str, Outcome<'a>>,
    done_results: HashMap<&'a str, Outcome<'a>>,
    done: HashSet<&'a str>,
    /// The last turn barrier's and the last exit barrier's position.
    turn: Option<usize>,
    exit: Option<usize>,
}

impl<'a> Lifecycle<'a> {
    fn of(events: &[Event<'a>]) -> Self {
        let mut lc = Self::default();
        for (i, ev) in events.iter().enumerate() {
            match ev.item {
                Item::Result { id: Some(id), is_error, artifact_url, .. } => {
                    lc.results.insert(id, Outcome { is_error: *is_error, artifact_url: artifact_url.as_deref() });
                }
                Item::Done { id: Some(id), is_error, result, artifact_url } => {
                    lc.done.insert(id);
                    if *result {
                        lc.done_results
                            .insert(id, Outcome { is_error: *is_error, artifact_url: artifact_url.as_deref() });
                    }
                }
                Item::Turn => lc.turn = Some(i),
                Item::Exit => lc.exit = Some(i),
                _ => {}
            }
        }
        lc
    }

    fn result_of(&self, id: Option<&str>) -> Option<Outcome<'a>> {
        let id = id?;
        self.results.get(id).or_else(|| self.done_results.get(id)).copied()
    }

    fn exit_after(&self, at: usize) -> bool {
        self.exit.is_some_and(|e| e > at)
    }

    fn is_closed(&self, id: &str, at: usize, turn_exempt: bool) -> bool {
        self.results.contains_key(id)
            || self.done.contains(id)
            || self.exit_after(at)
            || (!turn_exempt && self.turn.is_some_and(|t| t > at))
    }
}

/// A subagent's working span (`agentSpans`).
struct Span {
    start: f64,
    end: f64,
    background: bool,
}

/// A tool a subagent ran.
struct Tool<'a> {
    id: &'a str,
    name: &'a str,
    ts: f64,
    running: bool,
    row: i64,
    artifact: Option<&'a ArtifactInput>,
    outcome: Option<Outcome<'a>>,
}

/// An `agentRun` block.
struct Run<'a> {
    id: &'a str,
    description: &'a str,
    resume_of: Option<&'a str>,
    model: Option<&'a str>,
    effort: Option<&'a str>,
    subagent_type: Option<&'a str>,
    status: &'a str,
    background: bool,
    usage: Option<&'a Value>,
    end_ts: Option<f64>,
    ts: f64,
}

/// The blocks the two lists read, in the parser's order.
enum Block<'a> {
    Run(Run<'a>),
    /// A transcript-level `Artifact` call.
    Artifact {
        ts: f64,
        input: Option<&'a ArtifactInput>,
        outcome: Option<Outcome<'a>>,
    },
}

struct Completion<'a> {
    status: &'a str,
    usage: Option<&'a Value>,
}

const NO_AGENT_INPUT: AgentInput = AgentInput { description: None, model: None, subagent_type: None };

/// `buildBlocks` over the expanded stream, as far as runs and artifacts go.
struct Parse<'a> {
    blocks: Vec<Block<'a>>,
    tools: HashMap<&'a str, Vec<Tool<'a>>>,
}

#[allow(clippy::too_many_lines)]
fn parse<'a>(events: &[Event<'a>]) -> Parse<'a> {
    let lc = Lifecycle::of(events);
    let mut tool_use_ids: HashSet<&str> = HashSet::new();
    let mut spans: IndexMap<&str, Span> = IndexMap::new();
    let mut started: HashSet<&str> = HashSet::new();
    let mut call_by_agent: HashMap<&str, &str> = HashMap::new();
    let mut ended: Vec<(&Item, f64)> = Vec::new();
    let mut resume_of: HashMap<&str, &str> = HashMap::new();
    let mut profiles: HashMap<&str, (Option<&str>, Option<&str>)> = HashMap::new();

    for ev in events {
        match ev.item {
            Item::Profile { call_id: Some(call), model, effort } => {
                profiles.insert(call, (model.as_deref(), effort.as_deref()));
            }
            Item::Running { id: Some(id), name, parent: None, .. } if name.as_deref() == Some("Agent") => {
                if !spans.contains_key(id.as_str()) {
                    spans.insert(id, Span { start: ev.ts, end: f64::INFINITY, background: false });
                }
            }
            Item::Started { call_id: Some(call), agent_id, resumes } => {
                started.insert(call);
                let earlier = match resumes {
                    Some(r) => Some(r.as_str()),
                    None => agent_id.as_deref().and_then(|a| call_by_agent.get(a).copied()),
                };
                if let Some(earlier) = earlier.filter(|e| !e.is_empty() && e != call) {
                    resume_of.insert(call, earlier);
                }
                if let Some(agent) = agent_id.as_deref().filter(|a| !a.is_empty()) {
                    call_by_agent.insert(agent, call);
                }
                if tool_use_ids.contains(call.as_str()) && !spans.contains_key(call.as_str()) {
                    spans.insert(call, Span { start: ev.ts, end: f64::INFINITY, background: true });
                }
            }
            Item::Completed { .. } => ended.push((ev.item, ev.ts)),
            Item::Use { id: Some(id), name, spawns, .. } => {
                tool_use_ids.insert(id);
                if (*spawns || name.as_deref() == Some("Agent")) && !spans.contains_key(id.as_str()) {
                    spans.insert(id, Span { start: ev.ts, end: f64::INFINITY, background: false });
                }
            }
            _ => {}
        }
    }
    for call in &started {
        if let Some(span) = spans.get_mut(call) {
            span.background = true;
        }
    }

    let mut agent_end: HashMap<&str, f64> = HashMap::new();
    let mut completions: HashMap<&str, Completion> = HashMap::new();
    for (item, ts) in ended {
        let Item::Completed { call_id, agent_id, status, usage } = item else { continue };
        let call = match call_id {
            Some(call) => Some(call.as_str()),
            None => agent_id.as_deref().and_then(|a| call_by_agent.get(a).copied()),
        };
        let Some(call) = call.filter(|c| !c.is_empty()) else { continue };
        completions
            .insert(call, Completion { status: status.as_deref().unwrap_or("completed"), usage: usage.as_ref() });
        if let Some(span) = spans.get_mut(call) {
            span.end = ts;
        }
        agent_end.insert(call, ts);
    }
    for ev in events {
        match ev.item {
            // A pulse-only agent (no tool call yet) ends with its tool_done.
            Item::Done { id: Some(id), .. } => {
                if spans.get(id.as_str()).is_some_and(|s| !s.background) && !agent_end.contains_key(id.as_str()) {
                    agent_end.insert(id, ev.ts);
                }
            }
            Item::Result { id: Some(id), ts_transcript, .. } => {
                // A background span's result is only its launch stub.
                if let Some(span) = spans.get_mut(id.as_str()).filter(|s| !s.background) {
                    span.end = ev.ts;
                    agent_end.insert(id, ts_transcript.unwrap_or(ev.ts));
                }
            }
            _ => {}
        }
    }

    let mut tools: HashMap<&str, Vec<Tool>> = HashMap::new();
    let mut attributed: HashSet<&str> = HashSet::new();
    for (at, ev) in events.iter().enumerate() {
        let Item::Running { id: Some(id), name, parent, artifact, .. } = ev.item else { continue };
        if tool_use_ids.contains(id.as_str()) || spans.contains_key(id.as_str()) {
            continue;
        }
        let owner = match parent {
            Some(parent) if spans.contains_key(parent.as_str()) => parent.as_str(),
            Some(_) => {
                // Under a subagent launched before these rows: never the main stream's.
                attributed.insert(id);
                continue;
            }
            None => match nearest_span(&spans, ev.ts) {
                Some(owner) => owner,
                None => continue,
            },
        };
        attributed.insert(id);
        let turn_exempt = spans.get(owner).is_some_and(|s| s.background);
        tools.entry(owner).or_default().push(Tool {
            id,
            name: name.as_deref().unwrap_or("unknown"),
            ts: ev.ts,
            running: !lc.is_closed(id, at, turn_exempt),
            row: ev.row,
            artifact: artifact.as_ref(),
            outcome: lc.result_of(Some(id)),
        });
    }
    let mut blocks = Vec::new();
    for (at, ev) in events.iter().enumerate() {
        let (id, agent, artifact, ts, parent_model) = match ev.item {
            Item::Running { id: Some(id), agent, artifact, .. } => {
                if tool_use_ids.contains(id.as_str()) || attributed.contains(id.as_str()) {
                    continue;
                }
                (Some(id.as_str()), agent, artifact, ev.ts, None)
            }
            Item::Use { id, agent, artifact, ts_transcript, parent_model, .. } => {
                (id.as_deref(), agent, artifact, ts_transcript.unwrap_or(ev.ts), parent_model.as_deref())
            }
            _ => continue,
        };
        let Some(run_id) = id.filter(|id| spans.contains_key(id)) else {
            if artifact.is_some() {
                blocks.push(Block::Artifact { ts, input: artifact.as_ref(), outcome: lc.result_of(id) });
            }
            continue;
        };
        let agent = agent.as_ref().unwrap_or(&NO_AGENT_INPUT);
        let background = started.contains(run_id);
        let completion = background.then(|| completions.get(run_id)).flatten();
        let closed =
            if background { completion.is_some() || lc.exit_after(at) } else { lc.is_closed(run_id, at, false) };
        let end_status = completion.map_or(if background { "stopped" } else { "completed" }, |c| c.status);
        let profile = profiles.get(run_id);
        blocks.push(Block::Run(Run {
            id: run_id,
            description: agent.description.as_deref().unwrap_or("agent"),
            resume_of: resume_of.get(run_id).copied(),
            model: profile.and_then(|p| p.0).or(agent.model.as_deref()).or(parent_model),
            effort: profile.and_then(|p| p.1),
            subagent_type: agent.subagent_type.as_deref(),
            status: if closed { end_status } else { "running" },
            background,
            usage: completion.and_then(|c| c.usage),
            end_ts: if closed { agent_end.get(run_id).copied() } else { None },
            ts,
        }));
    }
    Parse { blocks, tools }
}

/// The span a tool with no parent ran in: the first one it falls inside, else
/// the latest one started before it that may still take tools.
fn nearest_span<'a>(spans: &IndexMap<&'a str, Span>, ts: f64) -> Option<&'a str> {
    let mut best = None;
    let mut best_dist = f64::INFINITY;
    for (agent, span) in spans {
        if ts >= span.start && ts <= span.end {
            return Some(agent);
        }
        // A finished background span is frozen: late strays never join it.
        if span.background && ts > span.end {
            continue;
        }
        if ts > span.start && ts - span.start < best_dist {
            best_dist = ts - span.start;
            best = Some(*agent);
        }
    }
    best
}

/// The expanded stream of the visible rows.
fn events_of<'a>(rows: &[&'a IndexedRow]) -> Vec<Event<'a>> {
    #[allow(clippy::cast_precision_loss)]
    rows.iter()
        .flat_map(|row| row.facts.items.iter().map(|item| Event { row: row.id, ts: row.ts as f64, item }))
        .collect()
}

/// `collectSubagents`: runs in launch order, a run that continues another
/// joining its subagent.
fn group_runs<'p, 'a>(blocks: &'p [Block<'a>]) -> Vec<Vec<&'p Run<'a>>> {
    let mut runs: Vec<&Run> = blocks
        .iter()
        .filter_map(|b| match b {
            Block::Run(run) => Some(run),
            Block::Artifact { .. } => None,
        })
        .collect();
    runs.sort_by(|a, b| a.ts.partial_cmp(&b.ts).unwrap_or(std::cmp::Ordering::Equal));
    let mut agents: Vec<Vec<&Run>> = Vec::new();
    let mut agent_of: HashMap<&str, usize> = HashMap::new();
    for run in runs {
        let at = match run.resume_of.and_then(|r| agent_of.get(r).copied()) {
            Some(at) => at,
            None => {
                agents.push(Vec::new());
                agents.len() - 1
            }
        };
        agents[at].push(run);
        agent_of.insert(run.id, at);
    }
    agents
}

/// A conversation's lists, before the inputs of the tools the running
/// subagents are on are read.
pub struct ConversationLists<'a> {
    parse: Parse<'a>,
}

impl std::fmt::Debug for ConversationLists<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConversationLists").field("blocks", &self.parse.blocks.len()).finish_non_exhaustive()
    }
}

impl<'a> ConversationLists<'a> {
    /// Derives the lists from every indexed row of a worker's log.
    pub fn derive(rows: &'a [IndexedRow], boot_prompt_offset: u32) -> Self {
        let visible = visible(rows, boot_prompt_offset);
        Self { parse: parse(&events_of(&visible)) }
    }

    /// The tool each running subagent run is on: the row that started it.
    fn activity(&self, run: &Run) -> Option<&Tool<'a>> {
        if run.status != "running" {
            return None;
        }
        let tools = self.parse.tools.get(run.id)?;
        tools.iter().rev().find(|t| t.running).or_else(|| tools.last())
    }

    /// The rows whose input [`subagents`](Self::subagents) words.
    pub fn activity_rows(&self) -> Vec<i64> {
        let runs = self.parse.blocks.iter().filter_map(|b| match b {
            Block::Run(run) => Some(run),
            Block::Artifact { .. } => None,
        });
        let mut rows: Vec<i64> = runs.filter_map(|run| self.activity(run)).map(|t| t.row).collect();
        rows.sort_unstable();
        rows.dedup();
        rows
    }

    /// Every subagent, in launch order. `inputs` holds the input of each row
    /// [`activity_rows`](Self::activity_rows) named (as the row's payload
    /// has it); one missing is an empty input.
    pub fn subagents(&self, inputs: &HashMap<i64, Value>) -> Vec<SubagentSummary> {
        let wire = |run: &Run, description: &str| {
            let tools = self.parse.tools.get(run.id).map_or(&[][..], Vec::as_slice);
            SubagentRun {
                tool_use_id: run.id.to_owned(),
                description: description.to_owned(),
                resume_of: run.resume_of.map(str::to_owned),
                model: run.model.map(str::to_owned),
                effort: run.effort.map(str::to_owned),
                subagent_type: run.subagent_type.map(str::to_owned),
                status: run.status.to_owned(),
                background: run.background,
                usage: run.usage.cloned().unwrap_or(Value::Null),
                end_ts: run.end_ts.map(Num),
                ts: Num(run.ts),
                tool_count: u32::try_from(tools.len()).unwrap_or(u32::MAX),
                last_tool_ts: tools.last().map(|t| Num(t.ts)),
                activity: self
                    .activity(run)
                    .map(|t| SubagentActivity { name: t.name.to_owned(), input: activity_input(inputs.get(&t.row)) }),
            }
        };
        group_runs(&self.parse.blocks)
            .into_iter()
            .filter_map(|runs| {
                let (first, last) = (runs.first()?, runs.last()?);
                let own: Vec<SubagentRun> = runs.iter().map(|r| wire(r, first.description)).collect();
                let mut latest = wire(last, first.description);
                latest.tool_use_id = first.id.to_owned();
                latest.subagent_type = first.subagent_type.map(str::to_owned);
                Some(SubagentSummary { latest, runs: own })
            })
            .collect()
    }

    /// `collectArtifacts`: every page published or opened, its own calls and
    /// its subagents', newest activity first.
    pub fn artifacts(&self) -> Vec<ChatArtifact> {
        let mut by_key: IndexMap<String, ChatArtifact> = IndexMap::new();
        let mut visit = |ts: f64, input: Option<&ArtifactInput>, outcome: Option<Outcome>| {
            let Some((url, title)) = artifact_of(input, outcome) else { return };
            let slug = artifact_slug_from_url(&url);
            let key = slug.clone().unwrap_or_else(|| url.clone());
            let prev = by_key.get(&key);
            let entry = ChatArtifact {
                url: prev.map_or(url, |p| p.url.clone()),
                slug,
                title: prev.and_then(|p| p.title.clone()).or(title),
                ts: Num(ts),
            };
            by_key.insert(key, entry);
        };
        for block in &self.parse.blocks {
            match block {
                Block::Artifact { ts, input, outcome } => visit(*ts, *input, *outcome),
                Block::Run(run) => {
                    for tool in self.parse.tools.get(run.id).into_iter().flatten() {
                        if tool.name == "Artifact" {
                            visit(tool.ts, tool.artifact, tool.outcome);
                        }
                    }
                }
            }
        }
        let mut list: Vec<ChatArtifact> = by_key.into_values().collect();
        list.sort_by(|a, b| b.ts.0.partial_cmp(&a.ts.0).unwrap_or(std::cmp::Ordering::Equal));
        list
    }
}

/// `artifactFromTool`: the page an `Artifact` call names (its link and the
/// title it gives), or `None`.
fn artifact_of(input: Option<&ArtifactInput>, outcome: Option<Outcome>) -> Option<(String, Option<String>)> {
    let input = input.cloned().unwrap_or_default();
    let action = input.action.as_deref().unwrap_or("publish");
    if outcome.is_some_and(|o| o.is_error) || input.asset {
        return None;
    }
    if action != "publish" && action != "open" {
        return None;
    }
    let url = match input.url {
        Some(url) => url,
        None if action == "publish" => outcome.and_then(|o| o.artifact_url)?.to_owned(),
        None => return None,
    };
    if url.is_empty() {
        return None;
    }
    let title = match input.title {
        Some(title) => Some(title),
        None if input.root => None,
        None => input.page_name,
    };
    Some((url, title))
}

/// The plain values of a tool's input, as the list words a running tool.
pub fn activity_input(input: Option<&Value>) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(Value::Object(fields)) = input {
        for (key, value) in fields {
            let kept = match value {
                Value::String(text) => {
                    Value::String(super::row_facts::utf16_prefix(text, eos_contracts::ACTIVITY_TEXT_MAX).to_owned())
                }
                Value::Number(_) | Value::Bool(_) => value.clone(),
                _ => continue,
            };
            out.insert(key.clone(), kept);
        }
    }
    Value::Object(out)
}

/// The ids of the rows that rebuild one subagent (any of its runs' call ids)
/// in the dashboard's parse: every row of its runs and of their tools, the
/// lifecycle rows of its agent ids, and the last turn and exit barriers
/// (all a tool's "still running?" reads of them). Rows the clear, rewind and
/// recall passes hide are left out, so the parse needs no prompt rows.
/// Empty when no subagent has that call.
pub fn rows_of_subagent(rows: &[IndexedRow], boot_prompt_offset: u32, call_id: &str) -> Vec<i64> {
    let visible = visible(rows, boot_prompt_offset);
    let events = events_of(&visible);
    let parse = parse(&events);
    let Some(runs) = group_runs(&parse.blocks).into_iter().find(|runs| runs.iter().any(|r| r.id == call_id)) else {
        return Vec::new();
    };
    let run_ids: HashSet<&str> = runs.iter().map(|r| r.id).collect();
    let mut calls: HashSet<&str> = run_ids.clone();
    for run in &runs {
        calls.extend(parse.tools.get(run.id).into_iter().flatten().map(|t| t.id));
    }
    let mut agents: HashSet<&str> = HashSet::new();
    for ev in &events {
        match ev.item {
            Item::Running { id: Some(id), parent: Some(parent), .. } if run_ids.contains(parent.as_str()) => {
                calls.insert(id);
            }
            Item::Started { call_id: Some(call), agent_id: Some(agent), .. } if run_ids.contains(call.as_str()) => {
                agents.insert(agent);
            }
            _ => {}
        }
    }
    let names = |item: &Item| -> bool {
        let call = |id: &Option<String>| id.as_deref().is_some_and(|id| calls.contains(id));
        let agent = |id: &Option<String>| id.as_deref().is_some_and(|id| agents.contains(id));
        match item {
            Item::Use { id, .. } | Item::Result { id, .. } | Item::Done { id, .. } => call(id),
            Item::Running { id, parent, .. } => call(id) || call(parent),
            Item::Started { call_id, agent_id, .. } | Item::Completed { call_id, agent_id, .. } => {
                call(call_id) || agent(agent_id)
            }
            Item::Profile { call_id, .. } => call(call_id),
            Item::Turn | Item::Exit => false,
        }
    };
    let last_turn = events.iter().rev().find(|ev| matches!(ev.item, Item::Turn)).map(|ev| ev.row);
    let last_exit = events.iter().rev().find(|ev| matches!(ev.item, Item::Exit)).map(|ev| ev.row);
    visible
        .iter()
        .filter(|row| Some(row.id) == last_turn || Some(row.id) == last_exit || row.facts.items.iter().any(&names))
        .map(|row| row.id)
        .collect()
}
