//! Spreading activation: from the notes and hooks a situation matched, a
//! little of each one's activation flows along its links, two steps out, so
//! a note linked to what matched comes back too. Bounded whatever the graph:
//! at most 24 seeds, 64 nodes go on after the first step, a hook passes to
//! its 32 strongest notes, and at most 1,000 nodes are visited.

use std::collections::{HashMap, HashSet};

const MAX_SEEDS: usize = 24;
const STEPS: usize = 2;
const CARRY_ON: usize = 64;
const HOOK_FAN_OUT: usize = 32;
pub const MAX_VISITED: usize = 1_000;
const DECAY: f64 = 0.5;

/// A link as spreading walks it, from a node it reached.
#[derive(Debug, Clone, PartialEq)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub weight: f64,
    /// The strength of the node at `to` (1 for a hook).
    pub to_strength: f64,
}

/// A hook's id (`mh-`): it passes only to its strongest notes.
fn is_hook(id: &str) -> bool {
    id.starts_with("mh-")
}

/// What reached each node by spreading from `seeds` (id, activation in
/// 0..=1); `neighbours` answers every link from any of the ids it is given.
/// Seeds themselves are left out unless spreading reached them too.
pub fn spread(seeds: &[(String, f64)], mut neighbours: impl FnMut(&[String]) -> Vec<Edge>) -> HashMap<String, f64> {
    let mut seeds: Vec<(String, f64)> = seeds.to_vec();
    seeds.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    seeds.truncate(MAX_SEEDS);
    let mut active: HashMap<String, f64> = seeds.iter().cloned().collect();
    let mut visited: HashSet<String> = active.keys().cloned().collect();
    let mut reached: HashMap<String, f64> = HashMap::new();
    let mut frontier: Vec<String> = seeds.into_iter().map(|(id, _)| id).collect();
    for _ in 0..STEPS {
        if frontier.is_empty() {
            break;
        }
        let mut by_node: HashMap<&str, Vec<Edge>> = HashMap::new();
        let edges = neighbours(&frontier);
        for edge in &edges {
            if frontier.contains(&edge.from) {
                by_node.entry(edge.from.as_str()).or_default().push(edge.clone());
            }
        }
        let mut step: HashMap<String, f64> = HashMap::new();
        for node in &frontier {
            let Some(mut out) = by_node.remove(node.as_str()) else { continue };
            let degree = out.len() as f64;
            if is_hook(node) {
                out.sort_by(|a, b| (b.weight * b.to_strength).total_cmp(&(a.weight * a.to_strength)));
                out.truncate(HOOK_FAN_OUT);
            }
            let a = active.get(node).copied().unwrap_or(0.0);
            for edge in out {
                if !visited.contains(&edge.to) {
                    if visited.len() >= MAX_VISITED {
                        continue;
                    }
                    visited.insert(edge.to.clone());
                }
                *step.entry(edge.to).or_default() += a * DECAY * edge.weight / degree.sqrt();
            }
        }
        for (id, gained) in &step {
            *reached.entry(id.clone()).or_default() += gained;
            *active.entry(id.clone()).or_default() += gained;
        }
        let mut next: Vec<(String, f64)> = step.into_iter().collect();
        next.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        next.truncate(CARRY_ON);
        frontier = next.into_iter().map(|(id, _)| id).collect();
    }
    for value in reached.values_mut() {
        *value = value.min(1.0);
    }
    reached
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(from: &str, to: &str, weight: f64) -> Edge {
        Edge { from: from.into(), to: to.into(), weight, to_strength: 1.0 }
    }

    #[test]
    fn activation_flows_two_steps_and_fades() {
        let graph = [
            edge("mn-a", "mh-x", 1.0),
            edge("mh-x", "mn-b", 1.0),
            edge("mn-b", "mn-c", 1.0),
            edge("mn-c", "mn-d", 1.0),
        ];
        let reached =
            spread(&[("mn-a".into(), 1.0)], |ids| graph.iter().filter(|e| ids.contains(&e.from)).cloned().collect());
        assert!((reached["mh-x"] - 0.5).abs() < 1e-9);
        assert!((reached["mn-b"] - 0.25).abs() < 1e-9);
        assert!(!reached.contains_key("mn-c"), "two steps only");
        assert!(!reached.contains_key("mn-a"));
    }

    #[test]
    fn a_hook_passes_only_to_its_strongest_notes_and_degree_divides() {
        let mut graph: Vec<Edge> = (0..40)
            .map(|i| Edge {
                from: "mh-h".into(),
                to: format!("mn-{i:02}"),
                weight: 1.0,
                to_strength: f64::from(i) / 40.0,
            })
            .collect();
        graph.push(edge("mn-seed", "mh-h", 1.0));
        let reached =
            spread(&[("mh-h".into(), 1.0)], |ids| graph.iter().filter(|e| ids.contains(&e.from)).cloned().collect());
        let notes: Vec<_> = reached.keys().filter(|k| k.starts_with("mn-")).collect();
        assert_eq!(notes.len(), HOOK_FAN_OUT);
        assert!(!reached.contains_key("mn-00"), "the weakest are left out");
        assert!((reached["mn-39"] - 0.5 / 40f64.sqrt()).abs() < 1e-9, "divided by the square root of its degree");
    }

    /// A random graph of 10,000 nodes, each with up to 30 links: spreading
    /// from 50 seeds never visits more than 1,000 nodes.
    #[test]
    fn spreading_visits_at_most_a_thousand_nodes_on_a_large_random_graph() {
        let mut state: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let nodes = 10_000u64;
        let mut links: HashMap<String, Vec<Edge>> = HashMap::new();
        for n in 0..nodes {
            let from = if n.is_multiple_of(10) { format!("mh-{n}") } else { format!("mn-{n}") };
            for _ in 0..(next() % 30) {
                let to = next() % nodes;
                let to = if to.is_multiple_of(10) { format!("mh-{to}") } else { format!("mn-{to}") };
                links.entry(from.clone()).or_default().push(Edge {
                    from: from.clone(),
                    to,
                    weight: 1.0,
                    to_strength: 0.5,
                });
            }
        }
        for round in 0..20 {
            let seeds: Vec<(String, f64)> =
                (0..50).map(|i| (format!("mn-{}", (round * 977 + i * 131) % 1_000 * 10 + 1), 1.0)).collect();
            let seeds: Vec<(String, f64)> = seeds.into_iter().filter(|(id, _)| links.contains_key(id)).collect();
            let reached =
                spread(&seeds, |ids| ids.iter().flat_map(|id| links.get(id).cloned().unwrap_or_default()).collect());
            assert!(reached.len() <= MAX_VISITED, "round {round}: {}", reached.len());
            assert!(reached.len() > 100, "it spread");
            assert!(reached.values().all(|v| (0.0..=1.0).contains(v)));
        }
    }
}
