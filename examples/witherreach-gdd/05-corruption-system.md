# 5. The Corruption System

> **Keystone specification.** This is the single most important system in WITHERREACH and the most rigorous section of this document. Everything else — survival (§6), crafting and Hearths (§7), RPG progression (§8), combat (§9), the Wake (§10), the death model (§12), and co-op (§13) — transacts in the economy defined here. The thesis (concept bible §8): **survival pressure and character power are the same resource — the Blight, carried as Taint — expressed through one meter the player must constantly trade in two opposite directions.** Survival meters are not chores bolted onto an RPG; they *are* the RPG economy.
>
> All numeric values are **illustrative — to tune**. They are a self-consistent starting set drawn verbatim from the survival-systems master spec, sufficient to build and balance against, not final.

---

## 5.1 The three quantities

There are exactly three corruption quantities. All downstream documents use these terms verbatim (glossary, concept bible §14).

| Quantity | What it is | Lives | Moves how |
|---|---|---|---|
| **Taint** | Your **current carried corruption**. ONE meter, `0 … T_max`. Simultaneously (a) the spendable currency for casting rot-magic, tempering gear, and ascending skills, and (b) your primary survival-threat readout. | On your person, real-time. | **Rises** from surviving the corrupted world (dark, blighted food, the Blight). **Falls only** by being **spent** (cast / temper / ascend) or **purged** at a Hearth. **Never decays passively.** |
| **Hollowing** | Your **permanent accumulated corruption**. `0 … 100`, read as **10 pips of 10**. The soft-permadeath track. | Permanent, on the character. | **Rises** on death, on Brink exposure, and on Taint overflow. **Cannot be purged** by normal means; reduced only by the rate-limited Cleansing rite (§5.7). At 100 ⇒ **turning**. |
| **Blight (resource)** | The **world-side substance**: blighted nodes, tainted food, Wake essence. The *supply* that feeds Taint. | In your pack, as loot/ingredients. | Harvested from the world; **rendered** into Taint (player-elected) or consumed as a crafting input. Holding raw Blight in the pack carries **no** Taint until rendered or eaten. |

**The relationship in one line:** Blight (resource) is the supply → it converts into Taint (the carried meter) → unspent/over-carried Taint is what ultimately advances Hollowing (the ratchet).

**Two locked rulings (binding economy resolutions):**
- **(A) The spend currency is Taint.** Skills **ascend by spending Taint** at a Hearth; **tempering** additionally consumes **Blight-materials** as ingredients. (So "ascend with Blight" and "spend Taint" are both honoured: ascension cost = Taint; temper cost = Taint + Blight-materials.)
- **(B) Taint never passively decays.** It goes down **only** by (a) spending it — casting rot-magic, tempering, ascending — or (b) purging at a Hearth. There is no free bleed-off; every reduction costs an action. This makes rot-magic a deliberate in-field **release valve**: your mana *is* your danger meter, so venting it in a fight lowers your threat in the moment — but you had to carry the danger to have the power available, and your build **floor** caps how far casting can bring you down (§5.6).

---

## 5.2 The Taint meter — floor, ceiling, threat bands

### Floor and ceiling

- **`T_floor`** — your build-set minimum Taint. **Neither purging nor casting can drop Taint below it.** This is the lever the concept bible calls "baseline Taint floor sets survival difficulty" (§8). Set **only** by **Path + slotted skills + equipped tempered gear** (plus Hearth upgrades for purge efficiency). The six character attributes (Vigor, Endurance, Might, Finesse, Attunement, Resolve) are derived-combat stats (§8) and **do not** touch the Taint economy — they never alter floor, ceiling, purge, or gain. *(One narrow combat-side exception: an Attunement-type attribute may modestly reduce rot-magic **cast cost** — a bounded, floor-capped modifier on the spend amount only, specified in §8/§9; it never alters floor/ceiling/purge/gain.)*
- **`T_max`** — your build-set carry ceiling. Tainted ascension raises it (hold more spendable danger); Warded keeps it low. Taint cannot exceed `T_max` (overflow rule below).

### Threat bands (the survival readout)

Threat keys on the **fraction `f = Taint / T_max`**, so the bands auto-scale to any build — a build with a high floor *rests* in a higher band, which is exactly how "the strongest builds live one bad Expedition from turning" is expressed numerically.

| Band | `f` range | Survival meaning *(illustrative — to tune)* |
|---|---|---|
| **Lucid** | 0.00 – 0.35 | Baseline. Faint corruption glow. No penalties. |
| **Marked** | 0.35 – 0.60 | Carried food/supplies spoil ×1.5; minor Wake hunt-pressure (+1 tier); first cosmetic mutation. |
| **Fevered** | 0.60 – 0.85 | Wound **festering** (healing −40%, slow HP bleed if hit); spoilage ×2.5; Wake hunt-pressure +2 tiers; screen/audio corruption FX. |
| **Brink** | 0.85 – 1.00 | **Turning-risk.** Hollowing accrues **+1/min** while here (§5.7). Maximum Wake hunt-pressure. Hard telegraph — vignette, heartbeat, whispers (UI: §14). |

### Overflow

Taint cannot exceed `T_max`. Any gain that would exceed it **spills into Hollowing at 50%** *(illustrative — to tune)*: 2 excess Taint ⇒ +1 Hollowing. Greed past the ceiling permanently costs you, and this hard-caps how hot you can bank.

---

## 5.3 Taint SOURCES (gain)

Surviving the corrupted world raises Taint. There are continuous (ambient, per-minute) and discrete (per-event) sources.

### Ambient gain formula

```
TaintGain (/min) = base_zone × light_mult × weather_mult × Tide_mult × starvation_mult
```

Where `base_zone` is the lit baseline for the zone's decay tier, and the multipliers stack multiplicatively. *(All values illustrative — to tune.)*

**`base_zone` — lit baseline by decay tier** (and the resulting dark value at `light_mult ×5`):

| Zone (decay state — §11) | Lit (×1) | Dark (×5) |
|---|---|---|
| Inside a fueled **Hearth** safe radius | **0.0** | 0.0 |
| Reach **fringe** (decay tier 1) | 0.5 | 2.5 |
| **Decayed** (tier 2, ×1.5) | 0.75 | 3.75 |
| **Blighted core** (tier 3, ×2.5) | 1.25 | **6.25** |

> A dark blighted core at peak (1.25 × 5) ≈ **6.25 Taint/min** — the worst sustained ambient in the game. "Dark is the world's corrupting breath" (§8): dark is a flat **×5** over lit.

**The multipliers:**

| Multiplier | Values | Notes |
|---|---|---|
| `light_mult` | lit **1.0** / dark **5.0** | Inside a torch/lantern/Hearth radius = lit; outside = dark (§6.2). |
| `weather_mult` | clear **1.0** / ashfall **1.5** / Blight-storm **3.0** | §6.3. Shelter reduces it. |
| `Tide_mult` | `1.0 + 0.15 × (Tide − 1)` | The Long Dusk clock (§6.5). Tide 5 ≈ ×1.6 ambient. |
| `starvation_mult` | **1.0** normally / **2.0** at Hunger 0 | Starving makes the Blight bite harder — couples hunger to the meter (§6.1). |

### Discrete sources (per event)

| Source | Taint | Notes |
|---|---|---|
| Eat **blighted** food | **+6 … +15** | Scales with satiation value (§6.1). The hunger on-ramp into the economy. |
| Eat **clean** food | **+0** | Rare, low satiation — the only Taint-free calories. |
| **Render** Blight resource → Taint | **+2 … +8** per unit | **Player-elected.** You may instead bank the raw material in your pack at no Taint cost. |
| Harvest a **blighted node** (raw) | **+1 … +3** | Small unavoidable splash while harvesting in the rot. |
| Take a wound while **Fevered/Brink** (festering) | **+1 … +3** per hit | Corruption enters the wound; couples combat risk to the meter. |
| **Death** | — | No Taint *gain*; death advances **Hollowing**, not Taint (§5.7, §12). |

---

## 5.4 Taint SINKS (loss)

Taint goes down **only** via these. **None is passive.** Sinks split into **in-field** spends (during an Expedition) and **Hearth transactions** (at the safe haven). Every in-field spend is **floor-capped** — it cannot drop Taint below `T_floor`.

### In-field spends (Expedition)

| Sink | Taint | Rules | Owner |
|---|---|---|---|
| **Cast rot-magic** | **−4 … −12** (Lesser 4–6 / Standard 6–9 / Greater 9–12) | Floor-capped. A fight is also a *de-corruption*. Damage/scaling/cooldowns: §9. | cost here / effect §9 |
| **Rot-infused weapon arts** | **−2 … −8** each | Floor-capped. Kept in a small, repeatable band so the player can still read their band mid-fight. | cost here / effect §9 |
| **Ascendant Ultimate** | **−20 … −40** | Tainted-capstone climactic ability — **not** a repeatable cast. Charged/channelled, gated **≤1 per Expedition** (or Hearth-primed). Floor-capped: requires `Taint ≥ T_floor + cost` to fire. | cost here / effect §9 |

> **Mechanical role of the Ultimate:** a deliberate, rare panic-escape. A single Ult can yank a Tainted build out of **Brink** in one wind-up — e.g. 178 → 138 at `T_max = 210` ⇒ `f` 0.85 → 0.66 — halting Brink Hollowing-accrual. Because it is gated once/Expedition and floor-capped, it reinforces "turning is stave-off-able" without becoming a spammed dump; the player still climbs back up and still ratchets Hollowing through deaths and overflow.

> **The floor-cap is load-bearing:** because every in-field spend is floor-capped, a high-floor Tainted build literally **cannot cast/art/ult itself below its `T_floor`**. This is the mechanical reason the strongest builds rest in the danger bands and can never fully self-purge in the field — they must come home to a Hearth to get safe.

### Hearth transactions

| Sink | Taint | Rules | Owner |
|---|---|---|---|
| **Temper gear** | **−20 … −50** + Blight materials | Per temper. Raises a gear piece's tier/stats. **Equipping tempered gear raises `T_floor`** — power literally buys survival difficulty (§7, §6.2). | cost here / gear §7 |
| **Ascend skills** | **−30 … −80** per node | Spends banked Taint (ruling A). Permanent build power. Tainted nodes raise `T_floor` and `T_max`; Warded nodes lower `T_floor` (and raise purge efficiency / cap `T_max`). Node effects: §8. | cost here / effect §8 |
| **Purge** (the safety valve) | drives Taint **down to `T_floor`** (never below) | Consumes **Hearth fuel + clean materials**, channelled ~10–30 s. Cost formula below. | here / Hearth §7 |
| **Death corpse-cache** | drop carried Taint **above `T_floor`** as a recoverable cache | Respawn at last lit Hearth at `T_floor`; retrieve the cache to recover the banked power, or lose it. Death also advances **Hollowing** (§5.7). Full death model: §12. | here / model §12 |

### The purge cost curve

Purge is **always available, but its price climbs with Hollowing** — the descent has grip, but is never a dead end (guardrail, §5.8).

```
PurgeCost(fuel) = k_p × ΔTaint × (1 + Hollowing / 100)
ΔTaint = Taint − T_floor        k_p = 0.4   (illustrative — to tune)
```

- Purging **60 Taint at Hollowing 0** ⇒ `0.4 × 60 × 1.0` = **24 fuel**.
- The **same purge at Hollowing 50** ⇒ `0.4 × 60 × 1.5` = **36 fuel**.
- The more Hollowed you are, the more expensive escape becomes — but it stays finite at any Hollowing, so you are never structurally trapped. Hearth purge-efficiency upgrades lower `k_p` (§7).

---

## 5.5 The Hearth decision — bank / purge / invest

This is the session climax (the moment the Expedition loop in §4 turns on). At the Hearth with carried `Taint = T_end`, you split it three ways. **Three claimants compete for the same banked Taint — purge, temper, ascend.**

| Choice | What you do | Trade |
|---|---|---|
| **Bank (hold)** | Keep `T_end`. | Next Expedition starts hot — higher band from minute one ⇒ more festering, spoilage, hunt-pressure, and overflow-to-Hollowing risk. **Power potential preserved.** |
| **Purge** | Dump to `T_floor` for fuel + clean materials (cost curve above). | **Safe next run; the power you'd banked is gone for good.** |
| **Invest** | Convert `T_end` into permanent power now — ascend a node and/or temper gear — then purge the remainder. | **Locks the value in as build, not carry-risk.** Raises `T_floor` if Tainted/tempered. |

Neither is correct — that irreducible choice is the core tension of every session.

### Worked Expedition *(illustrative — to tune)*

Baseline Hybrid build, `T_floor = 20`, `T_max = 100`, start `Taint = 20`, Hunger 100, 30-min lantern:

| # | Event | Taint | Band |
|---|---|---|---|
| 1 | 20 min in a **decayed** zone, lit (0.5 × 1.5 = 0.75/min): **+15** | 20 → **35** | enters Marked (Hunger ~82) |
| 2 | Eat blighted ration (Hunger → 100): **+10** | 35 → **45** | Marked |
| 3 | Lantern dies; 10 min **dark** decayed (2.5 × 1.5 = 3.75/min): **+37** | 45 → **82** | Fevered, near Brink — the Wake closes in |
| 4 | Fight with rot-magic, 4 casts × −5: **−20** | 82 → **62** | Fevered |
| 5 | Loot objective + render Blight **+8** | 62 → **70** | Fevered |
| 6 | 15 min lit return trip: **+11** | 70 → **81** | arrive Hearth at Fevered |

**Decision at the Hearth (`T_end = 81`):**
- **Purge** to `T_floor = 20` ⇒ `0.4 × 61 = 24` fuel — safe next run, 61 power forfeited; **or**
- **Invest** 50 into an ascension node (→ 31), then purge 11 (→ 20) — value locked in as permanent build; **or**
- **Bank** all 81 — start the next Expedition in Fevered, ready to cast/invest big, but hunted from minute one.

---

## 5.6 Build = survival difficulty (the Taint-floor model)

Your Path + slotted skills + tempered gear set `T_floor` (resting danger) and `T_max` (carry ceiling). **No separate difficulty slider does this work — the Path tree does.** Choosing a build *is* choosing your survival mode (§8).

| Build | `T_floor` | `T_max` | Resting band | Identity |
|---|---|---|---|---|
| **Pure Warded** | ~5 | ~90 | deep Lucid | Stable, low ceiling. Party anchor/support. Best purge efficiency. |
| **Hybrid / fresh Revenant** | ~20 | ~100 | low Lucid | Flexible default. |
| **Heavy Tainted** | ~50 | ~160 | Marked/Fevered | High ceiling, lives near turning. Big cast/ascension reserves. |
| **Pure Tainted (ascended)** | ~90 | ~210 | Fevered | Devastating; one bad run from Brink. Glass cannon. |

- For Tainted builds the floor sits at roughly a **quarter-to-half of `T_max`**, so they *rest* in Marked/Fevered — the high floor is the permanent tax that keeps them in the danger bands even at rest. A Tainted build can bank up to ≈ `0.85·T_max − T_floor` of spendable danger before Brink (e.g. ~88 points at 210/90).
- Floor and ceiling are assembled from per-node/per-piece deltas atop an **irreducible innate Revenant floor ≈ 5** *(illustrative — to tune; effects owned by §8, costs by §5.4)*:

| Source | `T_floor` Δ | `T_max` Δ |
|---|---|---|
| Innate Revenant floor | **≈ +5** (irreducible) | — |
| Tainted node, tier I–II | +3 … +8 | +10 … +20 |
| Tainted node, tier III–IV | +8 … +15 | +20 … +40 |
| Ascendant node, tier V | +15 … +25 | +30 … +60 |
| Warded node | −2 … −8 (floors out at ≈5) | (caps `T_max`) |
| Tempered gear, per piece equipped | +5 … +15 | — |

These deltas sum to the build anchors above. **Gear power and survival difficulty are the same axis** — there is no "strong + safe" gear, only "strong + hot" or "modest + stable" (§7).

---

## 5.7 Hollowing — the soft-permadeath track

Hollowing is the permanent corruption ratchet you fight for the entire game (concept bible §11; full session/death model in §12). It is **not** roguelike erasure and **not** consequence-free — it is a slow, telegraphed, stave-off-able descent toward **turning**.

### Hollowing gains *(illustrative — to tune)*

| Source | Hollowing |
|---|---|
| **Death** | **+5 base, + up to +5 scaled by banked-Taint fraction at death** (`+5 × f`). Dying *hot* hurts more ⇒ ~10–20 deaths to turn if you die cold, far fewer if you die at Brink. |
| **Brink exposure** | **+1 / min** while `f ≥ 0.85`. Leaving Brink stops it instantly. |
| **Overflow spill** | per §5.2 — 2 excess Taint over `T_max` ⇒ +1 Hollowing. |

Hollowing **cannot be purged by normal means.** It is a near-ratchet — a disciplined Warded player can hold the line indefinitely; a greedy Tainted player still ratchets toward turning, matching "the strongest builds live closest to turning."

### The turning telegraph (10 pips — "telegraphed, not a surprise")

Hollowing reads as 10 pips of 10. Turning is never a silent wipe; it announces itself across the whole track:

| Pips | State |
|---|---|
| **0–3** | Cosmetic marks, faint whispers. |
| **4–6** | Stat drift: Warded skills weaken, Tainted strengthen; the Wake grows **less** aggressive (you begin to smell like them). |
| **7–8** | **"The Pull"** — periodic involuntary twitches, vision corruption, NPCs recoil. |
| **9** | **Brink of Turning** — strong audiovisual telegraph; last-chance rites unlocked; in co-op the party is explicitly warned. |
| **10 (= 100)** | **Turn** → the character becomes a Wake-creature (concept bible §9 "Be consumed"; turned entities populate the world / co-op — §10, §13). |

### Stave-off (a fought descent, not a wipe)

- The **Cleansing rite** at a **Greater Hearth** removes **1 pip (−10 Hollowing)** for a large clean-resource cost, **rate-limited to ≤ once per Tide per Greater Hearth**. This is the **only** Hollowing reducer — extraordinary, not normal purge.
- A disciplined Warded player can hold indefinitely; a greedy Tainted player still trends toward turning. Turning is the survival-RPG's "real" death, and you fight it for the whole game.

---

## 5.8 The survival → power → risk loop (and guardrail compliance)

The keystone loop, stated mechanically:

> **Survive → take on Taint** (dark + blighted food are how you don't starve in the gloom — §6) **→ spend Taint for power** (cast / temper / ascend are the only fuel for growth) **→ but carrying Taint to spend later raises real-time danger** (festering, spoilage, Wake hunt-pressure, overflow, turning-risk). **Every Hearth visit, you choose how much danger to keep** (§5.5).

This is one loop, not a survival layer beside an RPG layer. It guarantees survival actions are always build-relevant (no "dead" busywork) and collapses N meters into one tuning axis.

**The three locked tuning guardrails (concept bible §8) are met numerically:**

| Guardrail | How it holds |
|---|---|
| **Purge always available but costly** | `PurgeCost` is finite at any Hollowing (§5.4); only the *price* climbs. |
| **Taint spendable faster than it floors** | Peak ambient gain ≈ 6.25/min (dark blighted core); combined dump rate (cast burst + invest + purge) vastly exceeds it, so the player is never *trapped* above `T_floor` involuntarily. |
| **Turning telegraphed & stave-off-able** | Hollowing accrues only in Brink or on death — both player-visible and avoidable; the 10-pip telegraph (§5.7) plus the Cleansing rite make it a fought descent, never a surprise wipe. |

---

## 5.9 Cross-domain interfaces

This section owns the **Taint cost** of every transaction, the **threat bands**, the **floor/ceiling model**, **Hollowing**, and the **bank/purge/invest** decision. It does **not** own:

- **Rot-magic damage/scaling/cooldowns, weapon arts, the Ascendant Ultimate's effect, and the cast-cost-efficiency attribute modifier** — §9 (combat); ascension-node *effects* and the six attributes — §8 (RPG progression). This section provides only the Taint *cost* and the floor/ceiling deltas.
- **Hearths, base-building, gear tiers, tempering ingredients, fuel, and clean/blighted resource sourcing** — §7 (crafting, building & economy).
- **Survival inputs** that *drive* Taint gain — hunger, light/dark, weather, the Long Dusk clock & Tides — §6 (survival systems).
- **Wake hunt-pressure tiers and Wardens** keyed off Taint band and Tide — §10 (enemies & AI); region decay states — §11 (world structure).
- **The corpse-cache death model, respawn, and Expedition session structure** — §12; **co-op Blight-transfer revive** (reviver pays ~30 Taint, transferred to the revived ally) and shared-Hearth persistence — §13.
- **HUD readability** of the meter, bands, and Hollowing pips — §14.
