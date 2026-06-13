# 6. Survival Systems

> **Principle (concept bible §8):** survival pressure in WITHERREACH is **not** a stack of orthogonal chore-meters. Every survival pressure is expressed through the **one** corruption economy defined in §5 — either as a **Taint-rate** modifier (light, weather, shelter) or as a **Taint-supply** on-ramp (food). **There are no standalone temperature, sanity, or thirst bars.** The only extra visible need is **Hunger**, and even its sustainable answer routes through the Blight economy. This section specifies those survival inputs and the world-clock (the Long Dusk and its Tides) that scales them; it references §5 for the meter itself, §7 for crafting/Hearths/shelter construction, and §11 for region decay states.
>
> All values are **illustrative — to tune**, drawn from the survival-systems master spec.

---

## 6.1 Hunger — the Taint supply on-ramp

Hunger is the one survival need carried as its own visible bar. Its purpose is to **force engagement with the Blight food economy** — "hunger" is mechanically the *supply on-ramp* for Taint (§5.3).

- **Scale & decay:** `0 … 100` (100 = full), decays **~0.9 / min** *(illustrative — to tune)* — full → empty ≈ **110 min**, slightly longer than a maximum 90-min Expedition, so a player eats **~1–2×** per run.
- **At Hunger 0** (starvation): stamina regen **−50%**, max-HP soft-cap, **and `starvation_mult = 2.0`** applied to ambient Taint gain (§5.3) — starving literally makes the Blight bite harder, tying hunger directly to the threat meter.
- **The two food tracks:**

| Food | Hunger | Taint | Availability |
|---|---|---|---|
| **Clean food** | +15 … +25 | **+0** | Scarce, perishable. The only Taint-free calories (in held/Lucid zones — §7). |
| **Blighted food** | +35 … +55 | **+6 … +15** | Plentiful, in decayed/core zones. Scales Taint with satiation. |

- **Sustainable eating routes through Blight** (§8 thesis): clean food cannot feed you indefinitely, so to keep eating is to keep taking on Taint.
- **Spoilage couples to your meter:** carried food/supplies spoil faster the higher your Taint band — **×1.5 in Marked, ×2.5 in Fevered** (§5.2). Carrying high Taint rots your pack, so banking power has a logistics cost as well as a danger cost.

---

## 6.2 Light vs dark — warmth and shelter, folded into Taint-rate

Light is the **only** thing that suppresses ambient Taint gain. There is **no temperature bar**: the "cold/exposure" pressure of a dark-fantasy survival world *is* the dark's Taint multiplier.

- **The core rule:** lit = `light_mult ×1.0`; dark = `light_mult ×5.0` (§5.3). Inside a torch/lantern/Hearth radius you are *lit*; outside it you are *dark*. Dark is the world's corrupting breath — a flat **×5** over lit.
- **Light sources** *(illustrative — to tune)*:

| Source | Burn | Radius | Cost |
|---|---|---|---|
| **Torch** | ~10 min | Small | Cheap; **occupies a hand** (trades a weapon/shield slot). |
| **Lantern** | ~30 min / oil | Medium | Consumes oil (a managed resource — §7). |
| **Hearth** | ∞ while fueled | Large | The safe zone: ambient Taint gain **0.0** inside its radius. Built and fueled (§7). |

- **The "closing dark."** Running out of light mid-Expedition spikes ambient Taint **×5** instantly — e.g. a decayed zone jumps 0.75 → 3.75/min the moment your lantern dies. Managing the light-budget against distance-from-Hearth is the signature moment-to-moment tension (§4.2).
- **Shelter and warmth are not a separate system.** "Cold" is dark; "exposure" is weather (§6.3). Both resolve into the Taint-rate, defended by light and by base-building (§7), never by a temperature meter.
- **Equipped tempered gear raises `T_floor`** (§5.6): power gear sets survival difficulty, Warded gear keeps the floor low at lower stats. This is where "build = floor" is physically equipped on the body.

---

## 6.3 Weather — Taint-pressure, not a separate stat

Weather is purely a **Taint-rate modulator and light suppressor** (`weather_mult` in §5.3). There is **no separate weather survival stat**; a storm hurts you only through the corruption economy.

| Event | `weather_mult` | Light radius | Duration / telegraph |
|---|---|---|---|
| **Clear** | ×1.0 | — | Default. |
| **Ashfall** | ×1.5 | −20% | Sustained. |
| **Blight-storm** | **×3.0** | **−50%** | 2–4 min, telegraphed **~30 s** out. |

- **Frequency rises with the Tide** (§6.5) — the deeper the Long Dusk, the more often storms hit.
- **Counterplay is base-building** (§7): shelter quality reduces a storm's `weather_mult`. A roofed, warded shelter turns a Blight-storm from **×3.0 → ≈×1.3**. This is *how* base-building earns its keep inside the corruption economy — it is shelter-against-Taint-rate, not "temperature shelter."

---

## 6.4 What is explicitly NOT a separate meter

For clarity to systems and UI (§14), the following are **deliberately not** modelled as standalone bars — each is folded into the one Taint economy:

| Classic survival meter | In WITHERREACH it is… |
|---|---|
| Temperature / cold | the **dark's Taint multiplier** (`light_mult ×5`, §6.2). |
| Exposure / weather | a **`weather_mult` on Taint gain** (§6.3), countered by shelter. |
| Sanity | a **band/Hollowing effect** — corruption FX and "The Pull" come from Taint band (§5.2) and Hollowing pips (§5.7), not a sanity bar. |
| Thirst | **not modelled** as a separate need. |

**Hunger is the one extra visible bar** (§6.1) — and its only sustainable answer is the Blight food economy. This is a core USP: one corruption economy instead of a chore-meter stack (concept bible §4, §8).

---

## 6.5 The Long Dusk — the decay clock and its Tides

The world is dying on a clock, with or without the player (design pillar 2). The macro pressure that pushes the meta loop (§4.4) forward is the **Long Dusk** and its **Tides**.

### No day/night — permanent dusk

The Reach sits in permanent rotting twilight (concept bible §5). There is **no day/night cycle**; the in-Expedition rhythm comes from **weather surges** (§6.3), not sunrise. This keeps the only periodic environmental pressure tied to the corruption economy.

### The macro clock — Tides (cadence)

- The Long Dusk deepens in **Tides** (eras). **A Tide advances per ~10 hours of cumulative out-in-the-Reach time** *(illustrative — to tune)* — time spent **on Expedition only**; Hearth, menu, and paused time do **not** count. ~**5–6 Tides** across a ~50–80 h playthrough.
- This cadence means you **cannot out-grind the clock at base** (idling at the Hearth doesn't stall the rot's advance against you, but it also doesn't *advance* it), while slow or co-op players are not punished by wall-clock time.
- **Each Tide deepens the rot** *(illustrative — to tune)*:

| Effect per Tide | Change |
|---|---|
| Ambient Taint | `Tide_mult += 0.15` (§5.3); Tide 5 ≈ ×1.6 |
| Wake spawn-pressure | +1 tier (§10) |
| Encroachment speed | +20% |
| Bestiary | tougher Wake variants unlock (§10 owns the bestiary) |

- **You push it back hearth by hearth, but never finally win.** Defeating a **Warden** kindles a **Greater Hearth** that locally rolls the clock back (§7), but the **global** Tide still rises. Net: a tide you push back, never finally win (pillar 2).

### Encroachment — the map as a tide

- Each region carries a **decay-state**: **fringe → decayed → blighted core** (full region/biome treatment in §11). These states drive the `base_zone` ambient Taint (§5.3).
- **Unheld regions worsen one decay step per Tide.** A lit **Greater Hearth rolls its radius back one step and pins it while fueled**; if its fuel lapses or it falls, decay creeps back in. The reclaimed map is therefore **impermanent** (USP #2) — "Earn the Light" is an ongoing maintenance cost, not a one-time conquest (pillar 4).

> Cross-references: the Taint meter, bands, and overflow that all of the above feed are specified in §5; Hearths, fuel, shelter-building, and the clean/blighted resource tracks in §7; the Wake spawn-pressure tiers and Wardens in §10; region decay states, biomes, and Reliquaries in §11; the death/respawn model in §12; HUD readouts for hunger, light, and weather in §14.
