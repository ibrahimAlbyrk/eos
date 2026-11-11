//! Reading the vector corpus (`rust/fixtures/genui`) and running one vector.
//!
//! A vector is an input and what the TypeScript implementation returned for it.
//! [`run`] calls the Rust function the vector names and renders its result in the
//! shape — key order included — that the TypeScript result has, so the two can be
//! compared as text (or by hash, where the corpus stores only a digest).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use eos_genui::attrs::{self, BestDir, BestSpec};
use eos_genui::catalog::{self, CollectionStat, ViewProblem, ViewStats, ViewValidation};
use eos_genui::expr::{self, ExprAst, ExprScope, WhereGroupOp, WhereNode};
use eos_genui::markup::{self, MarkupNode, MarkupParse, MarkupPos};
use eos_genui::partial_json::{self, DEFAULT_PARTIAL_KEYS};
use eos_genui::spec::{self, AppValidation};
use eos_genui::{Object, Value};

pub(crate) fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().expect("the repository root")
}

pub(crate) fn fixtures() -> PathBuf {
    repo_root().join("rust/fixtures/genui")
}

pub(crate) fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// FNV-1a, 64 bit.
pub(crate) fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0000_0100_0000_01b3))
}

pub(crate) fn hex(h: u64) -> String {
    format!("{h:016x}")
}

fn obj<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(entries.into_iter().collect())
}

fn text(s: &str) -> Value {
    Value::String(s.to_owned())
}

fn num(n: usize) -> Value {
    Value::Number(n as f64)
}

fn list<T>(items: impl IntoIterator<Item = T>, f: impl Fn(T) -> Value) -> Value {
    Value::Array(items.into_iter().map(f).collect())
}

fn opt_text(s: Option<String>) -> Value {
    s.map_or(Value::Null, Value::String)
}

/// The corpus marks what JSON cannot hold: an undefined argument, a long run of
/// one character, strings joined.
fn decode(v: &Value) -> Option<Value> {
    Some(match v {
        Value::Array(items) => Value::Array(items.iter().map(|x| decode(x).unwrap_or(Value::Null)).collect()),
        Value::Object(o) => {
            if o.contains_key("$undef") {
                return None;
            }
            if let Some(Value::Array(rep)) = o.get("$rep") {
                let unit = rep[0].as_str().expect("$rep text");
                return Some(Value::String(unit.repeat(rep[1].as_f64().expect("$rep count") as usize)));
            }
            if let Some(Value::Array(parts)) = o.get("$cat") {
                let joined: String = parts
                    .iter()
                    .map(|p| decode(p).and_then(|p| p.as_str().map(str::to_owned)).expect("$cat part"))
                    .collect();
                return Some(Value::String(joined));
            }
            Value::Object(o.iter().filter_map(|(k, x)| decode(x).map(|x| (k, x))).collect())
        }
        other => other.clone(),
    })
}

fn decode_args(v: &Value) -> Vec<Option<Value>> {
    v.as_array().expect("an argument list").iter().map(decode).collect()
}

/// Everything the vectors refer to by name.
pub(crate) struct Corpus {
    pub(crate) docs: HashMap<String, Vec<u16>>,
    pub(crate) bases: Object,
    pub(crate) scopes: Object,
}

impl Corpus {
    pub(crate) fn load() -> Corpus {
        let as_object = |name: &str| match read_json(&fixtures().join(name)) {
            Value::Object(o) => o,
            _ => panic!("{name} is not an object"),
        };
        let docs = as_object("docs.json")
            .iter()
            .map(|(k, v)| (k.to_owned(), v.as_str().expect("a document").encode_utf16().collect()))
            .collect();
        Corpus { docs, bases: as_object("bases.json"), scopes: as_object("scopes.json") }
    }
}

pub(crate) struct Outcome {
    pub(crate) checked: usize,
    pub(crate) mismatches: Vec<String>,
}

/// Runs every vector of one corpus file, on as many threads as the machine has:
/// a single sweep vector stands for thousands of parses.
pub(crate) fn run_file(corpus: &Corpus, name: &str) -> Outcome {
    let vectors = read_json(&fixtures().join(name));
    let vectors = vectors.as_array().expect("a vector list");
    let next = AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map_or(4, usize::from).min(vectors.len().max(1));
    let mut parts: Vec<(usize, Outcome)> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                scope.spawn(|| {
                    let mut done = Vec::new();
                    loop {
                        let n = next.fetch_add(1, Ordering::Relaxed);
                        let Some(v) = vectors.get(n) else { break };
                        let mut out = Outcome { checked: 0, mismatches: Vec::new() };
                        run_vector(corpus, v, &format!("{name}#{n}"), &mut out);
                        done.push((n, out));
                    }
                    done
                })
            })
            .collect();
        workers.into_iter().flat_map(|w| w.join().expect("a corpus worker ran to the end")).collect()
    });
    parts.sort_by_key(|(n, _)| *n);
    let mut out = Outcome { checked: 0, mismatches: Vec::new() };
    for (_, part) in parts {
        out.checked += part.checked;
        out.mismatches.extend(part.mismatches);
    }
    out
}

fn run_vector(corpus: &Corpus, v: &Value, id: &str, out: &mut Outcome) {
    let function = v.get("fn").and_then(Value::as_str).expect("fn");
    if let Some(doc) = v.get("doc").and_then(Value::as_str) {
        let doc = corpus.docs.get(doc).unwrap_or_else(|| panic!("{id}: no document {doc}"));
        let rest = decode_args(v.get("rest").expect("rest"));
        let from = v.get("from").and_then(Value::as_f64).expect("from") as usize;
        let hashes = v.get("h8").and_then(Value::as_str).expect("h8").as_bytes();
        for (i, want) in hashes.chunks(8).enumerate() {
            if want == b"--------" {
                continue;
            }
            let cut = from + i;
            let prefix =
                String::from_utf16(&doc[..cut]).unwrap_or_else(|_| panic!("{id}: cut {cut} splits a character"));
            let mut args = vec![Some(Value::String(prefix))];
            args.extend(rest.iter().cloned());
            let got = run(corpus, function, &args).to_json();
            out.checked += 1;
            let got_hash = hex(fnv1a64(got.as_bytes()));
            if &got_hash.as_bytes()[8..] != want {
                out.mismatches.push(format!("{id} cut {cut}: rust returned {}", clip(&got)));
            }
        }
        return;
    }
    let args = match v.get("base").and_then(Value::as_str) {
        Some(base) => {
            let mut input = Some(corpus.bases.get(base).unwrap_or_else(|| panic!("{id}: no base {base}")).clone());
            for op in decode(v.get("ops").expect("ops")).as_ref().and_then(Value::as_array).expect("ops") {
                apply_op(&mut input, op);
            }
            vec![input]
        }
        None => decode_args(v.get("args").expect("args")),
    };
    let got = run(corpus, function, &args).to_json();
    out.checked += 1;
    let matches = match (v.get("out"), v.get("h").and_then(Value::as_str)) {
        (Some(want), _) => want.to_json() == got,
        (None, Some(h)) => hex(fnv1a64(got.as_bytes())) == h,
        (None, None) => panic!("{id}: no expected result"),
    };
    if !matches {
        let want = v.get("out").map_or_else(
            || "(hash only: node rust/tools/genui-vectors/generate.mjs --explain <file> <n>)".to_owned(),
            |w| clip(&w.to_json()),
        );
        out.mismatches.push(format!("{id} {function}\n    typescript: {want}\n    rust:       {}", clip(&got)));
    }
}

fn clip(s: &str) -> String {
    if s.chars().count() > 1200 { format!("{}…", s.chars().take(1200).collect::<String>()) } else { s.to_owned() }
}

// ---- edits (see tools/genui-vectors/lib/ops.mjs) -----------------------------------

fn apply_op(input: &mut Option<Value>, op: &Value) {
    let op = op.as_array().expect("an edit");
    let kind = op[0].as_str().expect("edit kind");
    let path = op[1].as_array().expect("edit path");
    let Some((last, parents)) = path.split_last() else {
        *input = Some(op[2].clone());
        return;
    };
    let mut parent = input.as_mut().expect("an input to edit");
    for seg in parents {
        parent = step(parent, seg);
    }
    match (kind, parent, last) {
        ("set", Value::Object(o), Value::String(k)) => {
            o.insert(k.clone(), op[2].clone());
        }
        ("set", Value::Array(a), Value::Number(i)) if *i as usize == a.len() => a.push(op[2].clone()),
        ("set", Value::Array(a), Value::Number(i)) => a[*i as usize] = op[2].clone(),
        ("del", Value::Object(o), Value::String(k)) => {
            o.remove(k);
        }
        ("del", Value::Array(a), Value::Number(i)) => {
            if (*i as usize) < a.len() {
                a.remove(*i as usize);
            }
        }
        ("push", parent, last) => match step(parent, last) {
            Value::Array(a) => a.push(op[2].clone()),
            other => panic!("push onto {other:?}"),
        },
        ("splice", parent, last) => {
            let Value::String(s) = step(parent, last) else { panic!("splice of a non-string") };
            let (start, count) = (op[2].as_f64().expect("start") as usize, op[3].as_f64().expect("count") as usize);
            let units: Vec<u16> = s.encode_utf16().collect();
            let mut spliced: Vec<u16> = units[..start].to_vec();
            spliced.extend(op[4].as_str().expect("text").encode_utf16());
            spliced.extend_from_slice(&units[start + count..]);
            *s = String::from_utf16(&spliced).expect("a splice between characters");
        }
        (kind, parent, last) => panic!("edit {kind} at {last:?} of {parent:?}"),
    }
}

fn step<'a>(parent: &'a mut Value, seg: &Value) -> &'a mut Value {
    match (parent, seg) {
        (Value::Object(o), Value::String(k)) => o.get_mut(k).unwrap_or_else(|| panic!("no key {k}")),
        (Value::Array(a), Value::Number(i)) => &mut a[*i as usize],
        (parent, seg) => panic!("no {seg:?} in {parent:?}"),
    }
}

// ---- dispatch ------------------------------------------------------------------------

fn arg(args: &[Option<Value>], i: usize) -> Option<&Value> {
    args.get(i).and_then(Option::as_ref)
}

fn str_arg(args: &[Option<Value>], i: usize) -> &str {
    arg(args, i).and_then(Value::as_str).unwrap_or_else(|| panic!("argument {i} must be text"))
}

fn scope_of(v: Option<&Value>) -> ExprScope<'_> {
    ExprScope {
        item: v.and_then(|s| s.get("item")),
        state: v.and_then(|s| s.get("state")),
        data: v.and_then(|s| s.get("data")),
    }
}

/// Calls the function a vector names and renders the result as the TypeScript one.
pub(crate) fn run(corpus: &Corpus, function: &str, args: &[Option<Value>]) -> Value {
    let a0 = arg(args, 0);
    match function {
        "parseMarkup" => markup_out(&markup::parse_markup(str_arg(args, 0))),
        "parsePartial" => markup_out(&markup::parse_partial(str_arg(args, 0))),
        "parsePartialJson" => {
            let keys: Option<Vec<&str>> = arg(args, 1)
                .and_then(|o| o.get("partialKeys"))
                .and_then(Value::as_array)
                .map(|k| k.iter().filter_map(Value::as_str).collect());
            let r = partial_json::parse_partial_json(str_arg(args, 0), keys.as_deref().unwrap_or(DEFAULT_PARTIAL_KEYS));
            let mut out = Object::new();
            if let Some(value) = r.value {
                out.insert("value", value);
            }
            out.insert("complete", Value::Bool(r.complete));
            if let Some(error) = r.error {
                out.insert("error", Value::String(error));
            }
            Value::Object(out)
        }
        "parseLooseJson" => match partial_json::parse_loose_json(str_arg(args, 0)) {
            Ok(value) => obj([("ok", Value::Bool(true)), ("value", value)]),
            Err(e) => obj([("ok", Value::Bool(false)), ("error", Value::String(e.message)), ("at", num(e.at))]),
        },
        "parseExpr" => parse_expr_out(str_arg(args, 0)),
        "checkExpr" => opt_text(expr::check_expr(str_arg(args, 0))),
        "exprRefs" => list(expr::expr_refs(str_arg(args, 0)), Value::String),
        "evalExpr" => expr::eval_expr(str_arg(args, 0), &scope_of(arg(args, 1))),
        "truthy" => Value::Bool(expr::truthy(a0.expect("a value"))),
        "hasTemplate" => Value::Bool(expr::has_template(str_arg(args, 0))),
        "fillTemplate" => Value::String(expr::fill_template(str_arg(args, 0), &scope_of(arg(args, 1)), None)),
        "parseWhere" => parse_where_out(str_arg(args, 0)),
        "checkWhere" => opt_text(expr::check_where(str_arg(args, 0))),
        "matchWhere" => Value::Bool(expr::match_where_text(a0, str_arg(args, 1), arg(args, 2))),
        "exprAll" => {
            let src = str_arg(args, 0);
            let scope = corpus.scopes.get("expr");
            let item_only = ExprScope { item: scope.and_then(|s| s.get("item")), ..ExprScope::default() };
            obj([
                ("parse", parse_expr_out(src)),
                ("check", opt_text(expr::check_expr(src))),
                ("refs", list(expr::expr_refs(src), Value::String)),
                ("value", expr::eval_expr(src, &scope_of(scope))),
                ("itemOnly", expr::eval_expr(src, &item_only)),
                ("bare", expr::eval_expr(src, &ExprScope::default())),
            ])
        }
        "templateAll" => {
            let t = str_arg(args, 0);
            obj([
                ("has", Value::Bool(expr::has_template(t))),
                ("filled", Value::String(expr::fill_template(t, &scope_of(corpus.scopes.get("expr")), None))),
                ("bare", Value::String(expr::fill_template(t, &ExprScope::default(), None))),
            ])
        }
        "whereAll" => {
            let src = str_arg(args, 0);
            let items = corpus.scopes.get("whereItems").and_then(Value::as_array).expect("whereItems");
            let state = corpus.scopes.get("whereState");
            obj([
                ("parse", parse_where_out(src)),
                ("check", opt_text(expr::check_where(src))),
                ("matches", list(items, |item| Value::Bool(expr::match_where_text(Some(item), src, state)))),
                ("stateless", list(items, |item| Value::Bool(expr::match_where_text(Some(item), src, None)))),
            ])
        }
        "splitIds" => list(attrs::split_ids(a0), Value::String),
        "splitLabels" => list(attrs::split_labels(a0), Value::String),
        "parseCols" => cols_out(a0),
        "parseChips" => chips_out(a0),
        "parseOptions" => options_out(a0),
        "parseBest" => best_out(a0),
        "parseSort" => sort_out(a0),
        "attrBool" => Value::Bool(attrs::attr_bool(a0, arg(args, 1) == Some(&Value::Bool(true)))),
        "attrNum" => attrs::attr_num(a0).map(Value::Number).or_else(|| arg(args, 1).cloned()).unwrap_or(Value::Null),
        "attrText" => {
            attrs::attr_text(a0).map(Value::String).or_else(|| arg(args, 1).cloned()).unwrap_or_else(|| text(""))
        }
        "dataRef" => attrs::data_ref(a0, arg(args, 1)).cloned().unwrap_or_else(|| obj([("$undef", num(1))])),
        "attrsAll" => obj([
            ("ids", list(attrs::split_ids(a0), Value::String)),
            ("labels", list(attrs::split_labels(a0), Value::String)),
            ("cols", cols_out(a0)),
            ("chips", chips_out(a0)),
            ("options", options_out(a0)),
            ("best", best_out(a0)),
            ("sort", sort_out(a0)),
            (
                "bool",
                Value::Array(vec![Value::Bool(attrs::attr_bool(a0, false)), Value::Bool(attrs::attr_bool(a0, true))]),
            ),
            (
                "num",
                Value::Array(vec![
                    attrs::attr_num(a0).map_or(Value::Null, Value::Number),
                    Value::Number(attrs::attr_num(a0).unwrap_or(7.0)),
                ]),
            ),
            (
                "text",
                Value::Array(vec![
                    text(&attrs::attr_text(a0).unwrap_or_default()),
                    Value::String(attrs::attr_text(a0).unwrap_or_else(|| "fallback".to_owned())),
                ]),
            ),
        ]),
        "validateView" => view_out(&catalog::validate_view(a0.unwrap_or(&Value::Null))),
        "validateApp" => match spec::validate_app(a0.unwrap_or(&Value::Null)) {
            AppValidation::Ok { warnings, html_bytes } => obj([
                ("ok", Value::Bool(true)),
                ("warnings", problems_out(&warnings)),
                ("stats", obj([("htmlBytes", num(html_bytes))])),
            ]),
            AppValidation::Rejected { problems, warnings } => obj([
                ("ok", Value::Bool(false)),
                ("problems", problems_out(&problems)),
                ("warnings", problems_out(&warnings)),
            ]),
        },
        "formatProblems" => Value::String(catalog::format_problems(&problems_in(a0))),
        "genuiRejection" => {
            let r = spec::genui_rejection(&problems_in(a0));
            obj([("error", Value::String(r.error)), ("problems", problems_out(&r.problems))])
        }
        "statsLine" => Value::String(catalog::stats_line(&stats_in(a0.expect("stats")))),
        "presentSuccessText" => {
            let opts = arg(args, 2);
            let unresolved =
                opts.and_then(|o| o.get("unresolvedImages")).and_then(Value::as_f64).unwrap_or(0.0) as usize;
            let warnings = problems_in(opts.and_then(|o| o.get("warnings")));
            Value::String(spec::present_success_text(
                str_arg(args, 0),
                &stats_in(arg(args, 1).expect("stats")),
                unresolved,
                &warnings,
            ))
        }
        "appSuccessText" => Value::String(spec::app_success_text(str_arg(args, 0))),
        "isComponentName" => Value::Bool(catalog::is_component_name(str_arg(args, 0))),
        "viewIdFromBytes" => {
            let bytes: Vec<u8> = a0
                .and_then(Value::as_array)
                .expect("bytes")
                .iter()
                .map(|b| b.as_f64().expect("a byte") as u8)
                .collect();
            let mut at = 0;
            let id = spec::new_view_id(|buf| {
                for slot in buf.iter_mut() {
                    *slot = bytes[at % bytes.len()];
                    at += 1;
                }
            });
            text(id.as_str())
        }
        "accepts" => Value::Bool(arg(args, 1).is_some_and(|input| accepts(str_arg(args, 0), input))),
        other => panic!("the corpus names a function the harness does not know: {other}"),
    }
}

// Whether the Rust type for a boundary schema reads `input`.
fn accepts(schema: &str, input: &Value) -> bool {
    use eos_genui::wire::{GenuiChange, GenuiDelta, GenuiLevel, UserMessageAction, ViewAction, ViewKind, ViewState};
    fn reads<T: serde::de::DeserializeOwned>(json: &str) -> bool {
        serde_json::from_str::<T>(json).is_ok()
    }
    let json = serde_json::to_string(input).expect("a value serializes");
    match schema {
        "ViewId" => reads::<eos_genui::ViewId>(&json),
        "ViewAction" => reads::<ViewAction>(&json),
        "UserMessageAction" => reads::<UserMessageAction>(&json),
        "GenuiDelta" => reads::<GenuiDelta>(&json),
        "GenuiChange" => reads::<GenuiChange>(&json),
        "ViewState" => reads::<ViewState>(&json),
        "GenuiLevel" => reads::<GenuiLevel>(&json),
        "ViewKind" => reads::<ViewKind>(&json),
        other => panic!("no Rust type for schema {other}"),
    }
}

// ---- results in the TypeScript shape ---------------------------------------------------

fn pos_out(p: MarkupPos) -> Value {
    obj([("line", num(p.line)), ("col", num(p.col)), ("offset", num(p.offset))])
}

fn node_out(node: &MarkupNode) -> Value {
    match node {
        MarkupNode::Text(t) => obj([("type", text("text")), ("text", text(&t.text)), ("pos", pos_out(t.pos))]),
        MarkupNode::Element(el) => {
            let mut out: Object = [
                ("type", text("element")),
                ("name", text(&el.name)),
                ("attrs", Value::Object(el.attrs.clone())),
                ("attrPos", Value::Object(el.attr_pos.iter().map(|(k, p)| (k.as_str(), pos_out(*p))).collect())),
                ("children", list(&el.children, node_out)),
                ("text", text(&el.text)),
                ("pos", pos_out(el.pos)),
                ("selfClosing", Value::Bool(el.self_closing)),
            ]
            .into_iter()
            .collect();
            if el.partial {
                out.insert("partial", Value::Bool(true));
            }
            Value::Object(out)
        }
    }
}

fn markup_out(r: &MarkupParse) -> Value {
    let mut labels = Vec::new();
    markup::walk_markup(&r.nodes, |el, _, _| labels.push(text(&markup::tag_label(el))));
    obj([
        ("nodes", list(&r.nodes, node_out)),
        (
            "errors",
            list(&r.errors, |e| obj([("message", text(&e.message)), ("line", num(e.line)), ("col", num(e.col))])),
        ),
        ("depth", num(markup::markup_depth(&r.nodes))),
        ("labels", Value::Array(labels)),
    ])
}

fn ast_out(n: &ExprAst) -> Value {
    let t = |name: &str| ("t", text(name));
    match n {
        ExprAst::Num(v) => obj([t("num"), ("v", Value::Number(*v))]),
        ExprAst::Str(v) => obj([t("str"), ("v", text(v))]),
        ExprAst::Lit(v) => obj([t("lit"), ("v", v.map_or(Value::Null, Value::Bool))]),
        ExprAst::Id(name) => obj([t("id"), ("name", text(name))]),
        ExprAst::Member { obj: o, prop } => obj([t("member"), ("obj", ast_out(o)), ("prop", text(prop))]),
        ExprAst::Index { obj: o, index } => obj([t("index"), ("obj", ast_out(o)), ("index", ast_out(index))]),
        ExprAst::Unary { op, a } => obj([t("un"), ("op", text(op.as_str())), ("a", ast_out(a))]),
        ExprAst::Binary { op, a, b } => {
            obj([t("bin"), ("op", text(op.as_str())), ("a", ast_out(a)), ("b", ast_out(b))])
        }
        ExprAst::Cond { c, a, b } => obj([t("cond"), ("c", ast_out(c)), ("a", ast_out(a)), ("b", ast_out(b))]),
        ExprAst::Call { function, args } => {
            obj([t("call"), ("fn", text(function.as_str())), ("args", list(args, ast_out))])
        }
    }
}

fn parse_expr_out(src: &str) -> Value {
    match expr::parse_expr(src) {
        Ok(ast) => obj([("ok", Value::Bool(true)), ("ast", ast_out(&ast))]),
        Err(e) => obj([("ok", Value::Bool(false)), ("error", Value::String(e.message)), ("at", num(e.at))]),
    }
}

fn where_out(n: &WhereNode) -> Value {
    match n {
        WhereNode::Group(g) => obj([
            ("op", text(if g.op == WhereGroupOp::And { "and" } else { "or" })),
            ("of", list(&g.of, where_out)),
            ("not", Value::Bool(g.not)),
        ]),
        WhereNode::Clause(c) => {
            let mut out: Object = [("op", text(c.op.as_str())), ("not", Value::Bool(c.not))].into_iter().collect();
            if let Some(field) = &c.field {
                out.insert("field", text(field));
            }
            if let Some(lref) = &c.lref {
                out.insert("lref", text(lref));
            }
            if let Some(value) = &c.value {
                out.insert("value", value.clone());
            }
            if let Some(key) = &c.r#ref {
                out.insert("ref", text(key));
            }
            Value::Object(out)
        }
    }
}

fn parse_where_out(src: &str) -> Value {
    match expr::parse_where(src) {
        Ok(node) => obj([
            ("ok", Value::Bool(true)),
            ("node", where_out(&node)),
            ("readsState", Value::Bool(expr::where_reads_state(&node))),
        ]),
        Err(error) => obj([("ok", Value::Bool(false)), ("error", Value::String(error))]),
    }
}

fn cols_out(v: Option<&Value>) -> Value {
    list(attrs::parse_cols(v), |c| obj([("key", Value::String(c.key)), ("label", Value::String(c.label))]))
}

fn chips_out(v: Option<&Value>) -> Value {
    list(attrs::parse_chips(v), |c| obj([("label", Value::String(c.label)), ("where", Value::String(c.r#where))]))
}

fn options_out(v: Option<&Value>) -> Value {
    list(attrs::parse_options(v), |o| obj([("label", Value::String(o.label)), ("value", Value::String(o.value))]))
}

fn best_out(v: Option<&Value>) -> Value {
    match attrs::parse_best(v) {
        None => Value::Null,
        Some(BestSpec::Auto) => text("auto"),
        Some(BestSpec::Columns(cols)) => Value::Object(
            cols.into_iter().map(|(k, dir)| (k, text(if dir == BestDir::Min { "min" } else { "max" }))).collect(),
        ),
    }
}

fn sort_out(v: Option<&Value>) -> Value {
    attrs::parse_sort(v)
        .map_or(Value::Null, |s| obj([("field", Value::String(s.field)), ("desc", Value::Bool(s.desc))]))
}

fn problems_out(problems: &[ViewProblem]) -> Value {
    list(problems, |p| obj([("path", text(&p.path)), ("message", text(&p.message))]))
}

fn problems_in(v: Option<&Value>) -> Vec<ViewProblem> {
    let field = |p: &Value, key: &str| p.get(key).and_then(Value::as_str).expect("a problem field").to_owned();
    v.and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .map(|p| ViewProblem { path: field(p, "path"), message: field(p, "message") })
        .collect()
}

fn stats_out(s: &ViewStats) -> Value {
    obj([
        ("uiBytes", num(s.ui_bytes)),
        ("dataBytes", num(s.data_bytes)),
        ("elements", num(s.elements)),
        ("depth", num(s.depth)),
        ("components", list(&s.components, |c| text(c))),
        (
            "collections",
            list(&s.collections, |c| {
                obj([("name", text(&c.name)), ("count", num(c.count)), ("type", opt_text(c.kind.clone()))])
            }),
        ),
        ("images", num(s.images)),
        ("sites", num(s.sites)),
        ("maps", num(s.maps)),
        ("primaryActions", num(s.primary_actions)),
    ])
}

fn stats_in(v: &Value) -> ViewStats {
    let n = |key: &str| v.get(key).and_then(Value::as_f64).expect("a stats number") as usize;
    let collections = v.get("collections").and_then(Value::as_array).expect("collections");
    ViewStats {
        ui_bytes: n("uiBytes"),
        data_bytes: n("dataBytes"),
        elements: n("elements"),
        depth: n("depth"),
        components: v
            .get("components")
            .and_then(Value::as_array)
            .expect("components")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        collections: collections
            .iter()
            .map(|c| CollectionStat {
                name: c.get("name").and_then(Value::as_str).expect("name").to_owned(),
                count: c.get("count").and_then(Value::as_f64).expect("count") as usize,
                kind: c.get("type").and_then(Value::as_str).map(str::to_owned),
            })
            .collect(),
        images: n("images"),
        sites: n("sites"),
        maps: n("maps"),
        primary_actions: n("primaryActions"),
    }
}

fn view_out(r: &ViewValidation) -> Value {
    match r {
        ViewValidation::Ok { warnings, stats } => {
            obj([("ok", Value::Bool(true)), ("warnings", problems_out(warnings)), ("stats", stats_out(stats))])
        }
        ViewValidation::Rejected { problems, warnings } => obj([
            ("ok", Value::Bool(false)),
            ("problems", problems_out(problems)),
            ("warnings", problems_out(warnings)),
        ]),
    }
}
