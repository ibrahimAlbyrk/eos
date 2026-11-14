//! Route matching: a tree over path segments. A lookup walks the request path
//! once, compares segments against sorted literals and allocates nothing.

use crate::http::request::MAX_PARAMS;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Segment {
    Literal(Box<str>),
    Param(Box<str>),
    Rest(Box<str>),
}

/// Splits a pattern into segments. `Err` says what is wrong with it.
pub(crate) fn parse_pattern(pattern: &str) -> Result<Vec<Segment>, &'static str> {
    let Some(rest) = pattern.strip_prefix('/') else { return Err("a pattern starts with /") };
    let mut out = Vec::new();
    let mut params = 0;
    let parts: Vec<&str> = rest.split('/').collect();
    for (i, part) in parts.iter().enumerate() {
        let seg = if let Some(name) = part.strip_prefix("{*").and_then(|p| p.strip_suffix('}')) {
            if i + 1 != parts.len() {
                return Err("{*rest} must be the last segment");
            }
            Segment::Rest(name.into())
        } else if let Some(name) = part.strip_prefix('{').and_then(|p| p.strip_suffix('}')) {
            Segment::Param(name.into())
        } else if let Some(name) = part.strip_prefix(':') {
            // The route table of `eos-contracts` writes parameters this way.
            Segment::Param(name.into())
        } else if part.contains(['{', '}']) {
            return Err("a parameter is a whole segment: {name}");
        } else {
            Segment::Literal((*part).into())
        };
        if let Segment::Param(name) | Segment::Rest(name) = &seg {
            if name.is_empty() {
                return Err("a parameter needs a name");
            }
            params += 1;
        }
        out.push(seg);
    }
    if params > MAX_PARAMS {
        return Err("too many parameters");
    }
    Ok(out)
}

#[derive(Debug, Default)]
struct Node {
    /// Sorted by segment text.
    literals: Vec<(Box<str>, usize)>,
    param: Option<usize>,
    /// The route that takes the rest of the path from here.
    rest: Option<usize>,
    route: Option<usize>,
}

#[derive(Debug)]
pub(crate) struct Tree {
    nodes: Vec<Node>,
}

impl Default for Tree {
    fn default() -> Self {
        Self { nodes: vec![Node::default()] }
    }
}

pub(crate) type Spans = [(u32, u32); MAX_PARAMS];

impl Tree {
    /// Adds a route; `Err(existing)` when a route of the same shape is there.
    pub(crate) fn insert(&mut self, segments: &[Segment], route: usize) -> Result<(), usize> {
        let mut at = 0;
        for seg in segments {
            at = match seg {
                Segment::Literal(text) => match self.nodes[at].literals.binary_search_by(|(t, _)| t.as_ref().cmp(text))
                {
                    Ok(i) => self.nodes[at].literals[i].1,
                    Err(i) => {
                        let next = self.push();
                        self.nodes[at].literals.insert(i, (text.clone(), next));
                        next
                    }
                },
                Segment::Param(_) => match self.nodes[at].param {
                    Some(next) => next,
                    None => {
                        let next = self.push();
                        self.nodes[at].param = Some(next);
                        next
                    }
                },
                Segment::Rest(_) => {
                    return match self.nodes[at].rest.replace(route) {
                        Some(existing) => {
                            self.nodes[at].rest = Some(existing);
                            Err(existing)
                        }
                        None => Ok(()),
                    };
                }
            };
        }
        match self.nodes[at].route {
            Some(existing) => Err(existing),
            None => {
                self.nodes[at].route = Some(route);
                Ok(())
            }
        }
    }

    fn push(&mut self) -> usize {
        self.nodes.push(Node::default());
        self.nodes.len() - 1
    }

    /// The route for `path` (which starts with `/`) and where its parameters sit.
    pub(crate) fn find(&self, path: &str) -> Option<(usize, Spans)> {
        let mut spans = [(0, 0); MAX_PARAMS];
        let route = self.walk(0, path, 1, 0, &mut spans)?;
        Some((route, spans))
    }

    // `from` is the offset of the segment to match. Literal first, then a
    // parameter, then "the rest": the most specific route wins, and a dead end
    // backs up to the next choice.
    fn walk(&self, node: usize, path: &str, from: usize, depth: usize, spans: &mut Spans) -> Option<usize> {
        let node = &self.nodes[node];
        if from > path.len() {
            return node.route;
        }
        let tail = &path[from..];
        let end = from + tail.find('/').unwrap_or(tail.len());
        let seg = &path[from..end];
        if let Ok(i) = node.literals.binary_search_by(|(t, _)| t.as_ref().cmp(seg))
            && let Some(found) = self.walk(node.literals[i].1, path, end + 1, depth, spans)
        {
            return Some(found);
        }
        if depth < MAX_PARAMS {
            if let Some(next) = node.param
                && !seg.is_empty()
            {
                spans[depth] = (from as u32, end as u32);
                if let Some(found) = self.walk(next, path, end + 1, depth + 1, spans) {
                    return Some(found);
                }
            }
            if let Some(route) = node.rest
                && !tail.is_empty()
            {
                spans[depth] = (from as u32, path.len() as u32);
                return Some(route);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(patterns: &[&str]) -> Tree {
        let mut t = Tree::default();
        for (i, p) in patterns.iter().enumerate() {
            t.insert(&parse_pattern(p).expect("valid pattern"), i).expect("no clash");
        }
        t
    }

    fn params<'a>(path: &'a str, spans: &Spans, n: usize) -> Vec<&'a str> {
        spans[..n].iter().map(|&(a, b)| &path[a as usize..b as usize]).collect()
    }

    #[test]
    fn a_literal_wins_over_a_parameter_whatever_the_order() {
        let t = tree(&["/workers/{id}", "/workers/archived", "/workers", "/workers/{id}/events"]);
        assert_eq!(t.find("/workers/archived").map(|m| m.0), Some(1));
        assert_eq!(t.find("/workers").map(|m| m.0), Some(2));
        let (route, spans) = t.find("/workers/w-1").expect("matches");
        assert_eq!((route, params("/workers/w-1", &spans, 1)), (0, vec!["w-1"]));
        let (route, spans) = t.find("/workers/archived/events").expect("backs up from the literal");
        assert_eq!((route, params("/workers/archived/events", &spans, 1)), (3, vec!["archived"]));
    }

    #[test]
    fn extracts_several_parameters_and_the_rest() {
        let t = tree(&[
            "/workers/{id}/workflow-runs/{callId}/agents/{agentId}",
            "/fs/raw/{*path}",
            "/pdfjs",
            "/pdfjs/{*file}",
        ]);
        let path = "/workers/w1/workflow-runs/c1/agents/a1";
        let (route, spans) = t.find(path).expect("matches");
        assert_eq!((route, params(path, &spans, 3)), (0, vec!["w1", "c1", "a1"]));
        let path = "/fs/raw/Users/me/a%20b.txt";
        let (route, spans) = t.find(path).expect("matches");
        assert_eq!((route, params(path, &spans, 1)), (1, vec!["Users/me/a%20b.txt"]));
        assert_eq!(t.find("/fs/raw").map(|m| m.0), None, "the bare prefix is not the route");
        assert_eq!(t.find("/fs/raw/").map(|m| m.0), None, "the rest needs at least one character");
        assert_eq!(t.find("/pdfjs").map(|m| m.0), Some(2));
        assert_eq!(t.find("/pdfjs/web/viewer.html").map(|m| m.0), Some(3));
    }

    #[test]
    fn misses_what_no_route_covers() {
        let t = tree(&["/workers/{id}", "/health"]);
        for path in ["/", "/nope", "/workers", "/workers/", "/workers/a/b", "/health/", "/healthz"] {
            assert_eq!(t.find(path).map(|m| m.0), None, "{path}");
        }
    }

    #[test]
    fn reports_two_routes_of_the_same_shape() {
        let mut t = tree(&["/a/{id}", "/b/{*rest}"]);
        assert_eq!(t.insert(&parse_pattern("/a/{name}").expect("valid"), 9), Err(0));
        assert_eq!(t.insert(&parse_pattern("/b/{*other}").expect("valid"), 9), Err(1));
        assert_eq!(t.insert(&parse_pattern("/a/x").expect("valid"), 9), Ok(()));
    }

    #[test]
    fn rejects_malformed_patterns() {
        assert!(parse_pattern("workers").is_err());
        assert!(parse_pattern("/a/{*rest}/b").is_err());
        assert!(parse_pattern("/a/x{id}").is_err());
        assert!(parse_pattern("/a/{}").is_err());
        assert!(parse_pattern("/{a}/{b}/{c}/{d}/{e}").is_err());
        assert!(parse_pattern("/a/:").is_err());
        assert_eq!(parse_pattern("/").expect("root"), vec![Segment::Literal("".into())]);
        // Both ways of writing a parameter are one shape.
        assert_eq!(
            parse_pattern("/workers/:id/events").expect("valid"),
            parse_pattern("/workers/{id}/events").expect("valid")
        );
    }
}
