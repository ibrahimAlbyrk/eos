//! What a usage report costs.

use eos_contracts::{ModelPrice, ModelPricing};

use crate::worker::Usage;

/// The price that applies to a prompt of `input_tokens`: a tiered price's
/// first tier that takes it, else its last.
pub fn select_tier_price(pricing: &ModelPricing, input_tokens: f64) -> Option<&ModelPrice> {
    match pricing {
        ModelPricing::Flat(price) => Some(price),
        ModelPricing::Tiered { tiers } => tiers
            .iter()
            .find(|t| t.max_input_tokens.is_none_or(|max| input_tokens <= max.0))
            .or(tiers.last())
            .map(|t| &t.price),
    }
}

/// The cost in USD of `tokens` at `pricing` (prices are per million tokens).
///
/// `tokens_in` is the billable, uncached input: cached tokens bill once, at
/// the cache-read rate. A tiered price picks its tier by the whole prompt
/// (billable input plus what was served from cache).
pub fn cost_usd(pricing: Option<&ModelPricing>, tokens: &Usage) -> f64 {
    let prompt = (tokens.tokens_in + tokens.tokens_cache_read) as f64;
    let Some(p) = pricing.and_then(|pricing| select_tier_price(pricing, prompt)) else { return 0.0 };
    let cost = (tokens.tokens_in as f64 * p.r#in.0
        + tokens.tokens_out as f64 * p.out.0
        + tokens.tokens_cache_read as f64 * p.cache_read.0
        + tokens.tokens_cache_create as f64 * p.cache_create.0
        + tokens.tokens_cache_create_1h as f64 * p.cache_create_1h.map_or(0.0, |n| n.0))
        / 1_000_000.0;
    // A broken price never turns into a negative or unreadable bill.
    if cost.is_finite() && cost >= 0.0 { cost } else { 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_contracts::ModelPriceTier;
    use eos_contracts::primitives::Num;

    fn price(input: f64, out: f64) -> ModelPrice {
        ModelPrice {
            r#in: Num(input),
            out: Num(out),
            cache_read: Num(input / 10.0),
            cache_create: Num(input * 1.25),
            cache_create_1h: Some(Num(input * 2.0)),
        }
    }

    #[test]
    fn tokens_are_priced_per_million_and_cached_ones_once() {
        let flat = ModelPricing::Flat(price(10.0, 50.0));
        let used = Usage {
            tokens_in: 1_000_000,
            tokens_out: 100_000,
            tokens_cache_read: 2_000_000,
            tokens_cache_create: 400_000,
            tokens_cache_create_1h: 100_000,
            cost_usd: 0.0,
        };
        // 10 + 5 + 2 + 5 + 2
        assert!((cost_usd(Some(&flat), &used) - 24.0).abs() < 1e-9);
        assert_eq!(cost_usd(None, &used), 0.0, "a model without a price bills nothing");
    }

    #[test]
    fn a_tiered_price_goes_by_the_whole_prompt() {
        let tiers = vec![
            ModelPriceTier { max_input_tokens: Some(Num(200_000.0)), price: price(1.0, 1.0) },
            ModelPriceTier { max_input_tokens: None, price: price(2.0, 2.0) },
        ];
        let tiered = ModelPricing::Tiered { tiers };
        let small = Usage { tokens_in: 100_000, ..zero() };
        let large = Usage { tokens_in: 100_000, tokens_cache_read: 150_000, ..zero() };
        assert!((cost_usd(Some(&tiered), &small) - 0.1).abs() < 1e-9);
        // 100k at 2 + 150k cached at 0.2
        assert!((cost_usd(Some(&tiered), &large) - 0.23).abs() < 1e-9);
    }

    fn zero() -> Usage {
        Usage {
            tokens_in: 0,
            tokens_out: 0,
            tokens_cache_read: 0,
            tokens_cache_create: 0,
            tokens_cache_create_1h: 0,
            cost_usd: 0.0,
        }
    }
}
