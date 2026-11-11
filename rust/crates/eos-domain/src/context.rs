//! How full a session's context window is.

/// Occupancy as a whole percentage, capped at 100; `None` when the model's
/// window is unknown. The dashboard's usage ring computes the same number
/// (`app/ui/src/lib/contextWindow.js`), so the two never disagree.
pub fn context_pct(used: i64, limit: Option<i64>) -> Option<i64> {
    let limit = limit.filter(|l| *l > 0)?;
    // JavaScript's Math.round: halves go up.
    let pct = ((used as f64 / limit as f64) * 100.0 + 0.5).floor();
    Some((pct as i64).min(100))
}

#[cfg(test)]
mod tests {
    use super::*;

    // core/src/__tests__/context-usage.test.ts
    #[test]
    fn rounds_caps_and_refuses_an_unknown_window() {
        assert_eq!(context_pct(400, Some(1_000_000)), Some(0));
        assert_eq!(context_pct(5_000, Some(1_000_000)), Some(1), "0.5 rounds up");
        assert_eq!(context_pct(150_000, Some(200_000)), Some(75));
        assert_eq!(context_pct(250_000, Some(200_000)), Some(100));
        assert_eq!(context_pct(10, None), None);
        assert_eq!(context_pct(10, Some(0)), None);
    }
}
