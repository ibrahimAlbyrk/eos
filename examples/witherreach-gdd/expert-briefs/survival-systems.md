# WITHERREACH — Survival Systems & Corruption Economy (Expert Brief)

> **Authority:** Domain brief for the **Taint / Hollowing / Blight economy** and all
> survival systems (needs, light/dark, the Long Dusk decay clock, weather, crafting,
> base-building, Hearths, resource & gear-tier economy). Built on the LOCKED concept bible
> (`00-concept-bible.md`, esp. §5/§7/§8/§11). Bible terms used verbatim per §14 glossary.
>
> **Number status:** every rate/curve/constant below is marked **(illustrative — tune)**.
> They are a self-consistent *starting set* that satisfies the §8 guardrails, not final values.
> They exist so section writers and balance have one concrete model to build against, not "A or B."
>
> **Two bible seams flagged & resolved in §0.4** (neither is a keystone contradiction).

---

## 0. Foundations

### 0.1 Canonical quantities (from §8.3 — do not rename)
- **Taint** — current *carried* corruption. ONE meter. Both spendable power-currency (cast / temper / ascend) and the primary survival-threat readout. Rises from surviving the corrupted world; falls only when **spent** or **purged** (never passively — see §0.4-B).
- **Hollowing** — *permanent* accumulated corruption. The soft-permadeath track. Max ⇒ **turning** (§11).
- **Blight (resource)** — world-side materials (blighted nodes, tainted food, Wake essence). The *supply* that feeds Taint. Lives in your pack as loot/ingredients; can be **rendered** into Taint or used as a crafting input.

### 0.2 The one-sentence loop (the keystone, made mechanical)
> Surviving forces you to take on Taint (dark + blighted food) → Taint is the only fuel for power (cast / temper / ascend) → **carrying** Taint to spend later raises your real-time danger (festering, spoilage, Wake hunt-pressure, turning-risk). Every Hearth visit you choose how much danger to keep.

### 0.3 Master scale (illustrative — tune)
- **Taint** is an absolute point pool, `0 … T_max`. Fresh Revenant `T_max = 100`.
- **Hunger** `0 … 100` (100 = full).
- **Hollowing** `0 … 100`, read as **10 pips** of 10. Turn at 100.
- All Taint rates below are **points/minute** at baseline; multipliers stack multiplicatively unless noted.

### 0.4 Flagged bible seams (resolved here, surfaced in report)
- **Seam A — what currency ascension spends.** §7 prose says "skills *ascend* by spending **Blight**"; §8.1 says **Taint** is "spendable currency for … ascending skills." §8 is the titled single-source-of-truth, so: **the spend is Taint (the meter).** Blight(resource) is the upstream supply that converts to Taint; **tempering** additionally consumes Blight *materials* as ingredients (so both words stay true). Resolution: *ascension cost = Taint; tempering cost = Taint + Blight-materials.*
- **Seam B — "Taint falls only by purging at a Hearth" (§8.1) vs Taint being a spendable cast/ascend currency (§8.1, same sentence).** A currency you spend must decrease when spent. Resolution, locked: **Taint never passively decays. It goes DOWN only by (a) spending it — casting rot-magic, tempering, ascending — or (b) purging at a Hearth.** This makes rot-magic a deliberate in-field *release valve*: **your mana is your danger meter**, so spending it in a fight lowers your threat in the moment — but you had to carry the danger to have power available, and your build **floor** (§4) caps how far casting can bring you down. This is an enrichment of §8.1's *spirit* (no free passive bleed-off; reduction always costs an action), not a contradiction. Surfaced to the concept owner as a clarification.

---

## 1. The Taint meter — exact model

### 1.1 Floor, ceiling, bands
- **T_floor** — build-set minimum Taint. **Purge cannot drop below it; casting cannot drop below it.** This is the lever the bible calls "baseline Taint floor sets survival difficulty" (§8). Set by path + slotted skills + equipped tempered gear (§6).
- **T_max** — build-set ceiling (carry cap). Tainted ascension raises it (hold more spendable danger); Warded keeps it low.
- **Threat bands key on the fraction `f = Taint / T_max`** so they auto-scale to any build:

| Band | `f` range | Survival meaning (illustrative — tune) |
|---|---|---|
| **Lucid** | 0.00 – 0.35 | Baseline. Faint corruption glow. No penalties. |
| **Marked** | 0.35 – 0.60 | Carried food/supplies spoil ×1.5; minor Wake hunt-pressure (+1 tier); first cosmetic mutation. |
| **Fevered** | 0.60 – 0.85 | Wound **festering** (healing −40%, slow HP bleed if hit); spoilage ×2.5; Wake hunt-pressure +2 tiers; screen/audio corruption FX. |
| **Brink** | 0.85 – 1.00 | **Turning-risk.** Hollowing accrues +1/min while here (§5). Max hunt-pressure. Hard telegraph (vignette, heartbeat, whispers). |

> Because bands are fractional, a Tainted build with a high floor *sits in Marked/Fevered at rest* — that is the bible's "lives one bad expedition from turning" (§4/§8), expressed numerically.

### 1.2 Overflow
- Taint cannot exceed `T_max`. Gains that would exceed it **spill into Hollowing at 50%** (illustrative): 2 excess Taint ⇒ +1 Hollowing. Greed past the ceiling permanently costs you. This also hard-caps how hot you can bank.

---

## 2. Taint SOURCES (gain) — sources/sinks table

All rates **illustrative — tune.** Ambient gain formula:

```
TaintGain(/min) = base_zone × light_mult × weather_mult × Tide_mult × starvation_mult
```

### 2.1 Continuous (per minute)
| Source | Value | Notes |
|---|---|---|
| `base_zone` — Hearth-lit safe radius | **0.0** | No passive gain inside a fueled Hearth's light. |
| `base_zone` — Reach fringe (decay tier 1) | **0.5** lit / **2.5** dark | Dark = 5× lit. "Dark is the world's corrupting breath" (§8). |
| zone decay multiplier | ×1.0 fringe / ×1.5 decayed / ×2.5 blighted core | Stacks on base. Dark blighted core ≈ 2.5×2.5 = **6.25/min**. |
| `light_mult` | lit **1.0**, dark **5.0** (i.e. base already encodes it) | Torch/lantern/Hearth radius = lit; outside it = dark. |
| `weather_mult` | clear 1.0 / ashfall 1.5 / **Blight-storm 3.0** | §9. Shelter reduces it. |
| `Tide_mult` | 1.0 + 0.15 × (Tide−1) | §8 decay clock. Tide 5 ≈ ×1.6 ambient. |
| `starvation_mult` | 1.0 normally, **2.0** at Hunger 0 | Starving makes the Blight bite harder (ties hunger to the meter). |

### 2.2 Discrete (per event)
| Source | Taint | Notes |
|---|---|---|
| Eat **blighted** food | +6 … +15 | Scales with satiation value (§7.2). The hunger on-ramp. |
| Eat **clean** food | **+0** | Rare, low satiation. The only Taint-free calories. |
| Render Blight resource → Taint | +2 … +8 per unit | **Player-elected.** You may instead bank the material in your pack (no Taint). |
| Harvest blighted node (raw) | +1 … +3 | Small unavoidable splash while harvesting in the rot. |
| Take a wound while in Fevered/Brink (festering) | +1 … +3 per hit | Corruption enters the wound; couples combat risk to the meter. |
| Death (corpse-cache drop is separate, §3.5) | — | No Taint *gain*; death advances **Hollowing**, not Taint. |

---

## 3. Taint SINKS (loss) — and the bank-vs-purge-vs-invest decision

Taint goes down ONLY via these. None is passive.

### 3.1 Cast rot-magic (in-field release valve)
- Per cast **−4 … −12 Taint** (cost by spell tier — **confirmed w/ rpg-combat-expert:** Lesser 4–6 / Standard 6–9 / Greater 9–12; damage/scaling owned by them, interface §11).
- Cannot bring Taint below `T_floor`. Rot-infused weapon arts are also in-field Taint spends; keep them in a small repeatable band (~2–8) so the player can predict their meter.
- Net effect: a fight is also a *de-corruption*, but you must have carried Taint to fight that way — and your floor stops a Tainted build from ever casting itself fully safe.

### 3.1b Ascendant Ultimate (gated in-field major spend)
- Tainted-capstone climactic ability — **NOT** a repeatable cast. Charged/channelled over a wind-up, gated **once-per-Expedition or Hearth-primed**, costing **−20 … −40 Taint** (mini-temper-sized). Owned by rpg-combat-expert; cost transacts here.
- **Activation rule (mine):** requires `Taint ≥ T_floor + cost` to fire (floor-capped like every spend — it cannot breach the floor).
- **Design role:** a deliberate, rare panic-escape — a single ult can yank a Tainted build out of **Brink** (e.g. 178→138 at `T_max=210` ⇒ f 0.85→0.66) in one wind-up, halting Brink Hollowing-accrual. Because it's gated once/Expedition + floor-capped, it *reinforces* "turning is stave-off-able" (§3.7) without becoming a spammed dump — the player still climbs back up and still ratchets Hollowing via deaths/overflow.

### 3.2 Temper gear (at Hearth/forge)
- **−20 … −50 Taint + Blight materials** per temper. Raises a gear piece's tier/stats. **Equipping tempered gear raises your `T_floor`** (§6.2) — power literally buys survival difficulty.

### 3.3 Ascend skills (at Hearth)
- **−30 … −80 Taint** per node (Seam A: spend is Taint). Permanent build power. Tainted nodes also **raise `T_floor` and `T_max`**; Warded nodes **lower `T_floor`** (and raise purge efficiency / cap `T_max`).

### 3.4 Purge (at Hearth) — the safety valve
- Drives Taint **down to `T_floor`** (never below). Consumes **Hearth fuel + clean materials**, time-gated (channel ~10–30 s).
- **Purge cost curve (illustrative — tune):**
```
PurgeCost(fuel) = k_p × ΔTaint × (1 + Hollowing / 100)
ΔTaint = Taint − T_floor,   k_p = 0.4
```
  - Purging 60 Taint at Hollowing 0 ⇒ 24 fuel. Same purge at Hollowing 50 ⇒ 36 fuel. **The more Hollowed you are, the more expensive escape becomes** — the descent has grip, but purge is *always available* (guardrail satisfied).

### 3.5 Death (corpse-cache, §11)
- On death you **drop carried Taint above `T_floor` as a recoverable corpse-cache** (Souls-style). Respawn at last lit Hearth at `T_floor`. Retrieve the cache to recover the banked power, or lose it. Death also advances **Hollowing** (§5.1).

### 3.6 The session-climax decision (bank / purge / invest)
At the Hearth with carried `Taint = T_end`, you split it three ways:
- **Bank (hold):** keep `T_end`. Next Expedition starts hot — higher band ⇒ more festering, spoilage, hunt-pressure from minute 1, and overflow-to-Hollowing risk. *Power potential preserved.*
- **Purge:** dump to `T_floor` for fuel+clean mats. *Safe next run; the power you'd banked is gone for good.*
- **Invest (ascend/temper):** convert `T_end` into permanent power now, then purge the remainder. *Locks the value in as build, not carry-risk.*

**Worked Expedition (illustrative — tune).** Baseline build, `T_floor=20`, `T_max=100`, start `Taint=20`, Hunger 100, 30-min lantern:
1. 20 min in a decayed zone, lit (0.5×1.5=0.75/min): +15 → **35** (enters Marked). Hunger ~82.
2. Eat blighted ration: Hunger→100, +10 → **45**.
3. Lantern dies; 10 min dark (2.5×1.5=3.75/min): +37 → **82** (Fevered, near Brink). Wake closing in.
4. Fight with rot-magic, 4 casts ×−5: −20 → **62**.
5. Loot objective + render Blight +8 → **70**.
6. 15 min lit return trip: +11 → arrive Hearth at **81** (Fevered).
7. **Decision:** Purge to 20 (≈ `0.4×61 = 24` fuel, safe) — *or* spend 50 on an ascension node (→31) then purge 11 (→20) — *or* bank all 81 and start next run in Fevered, ready to cast/invest big but hunted.

### 3.7 Guardrail compliance (§8)
- **Purge always available but costly** ✔ — `PurgeCost` is finite at any Hollowing; only the *price* climbs.
- **Taint spendable faster than it floors** ✔ — peak ambient gain ≈ 6.25/min (dark blighted core); combined dump rate (cast burst + invest + purge) vastly exceeds it, so you are never *trapped* above `T_floor` involuntarily.
- **Turning telegraphed & stave-off-able** ✔ — Hollowing only accrues in Brink or on death, both player-visible and avoidable; §5.2 telegraph + §5.3 stave-off.

---

## 4. Build = survival difficulty (the Taint floor per build)

Path + slotted skills + tempered gear set `T_floor` and `T_max`. Illustrative anchors:

| Build | `T_floor` | `T_max` | Resting band | Identity |
|---|---|---|---|---|
| **Pure Warded** | ~5 (≈0.05·max) | ~90 | deep Lucid | Stable, low ceiling. Party anchor/support. Best purge efficiency. |
| **Hybrid / fresh Revenant** | ~20 | ~100 | low Lucid | Flexible default. |
| **Heavy Tainted** | ~50 (≈0.45·max) | ~160 | Marked/Fevered | High ceiling, lives near turning. Big cast/ascension reserves. |
| **Pure Tainted (ascended)** | ~90 (≈0.45·max) | ~210 | Fevered | Devastating; one bad run from Brink. Glass cannon. |

- A Tainted build's high `T_max` is what lets it bank ~`0.85·T_max − T_floor` of spendable danger before Brink (e.g. ~88 pts at 210/90). The high floor is the permanent tax that keeps it in the danger bands at rest.
- **Choosing a build IS choosing your survival mode** (§8). No separate difficulty slider does this work; the path tree does.
- **Attributes do NOT feed the corruption economy (locked).** The economy's structural levers — `T_floor`, `T_max`, purge efficiency, and ambient Taint gain — are set ONLY by path + slotted skills + tempered gear (+ Hearth upgrades for purge efficiency). The 6 attributes (Vigor/Endurance/Might/Finesse/Attunement/Resolve) are derived-combat stats (rpg-combat-expert's domain) and do not touch floor/ceiling/purge/gain. **One permitted touchpoint, owned by combat:** an Attunement-type attribute MAY modestly reduce rot-magic *cast cost* — but that is a combat-side modifier on the spend amount only, stays floor-capped, and must remain bounded enough that casting never becomes a free, band-skipping dump. It never alters floor, ceiling, purge, or gain.

---

## 5. Hollowing — the soft-permadeath track

### 5.1 Gains (illustrative — tune)
| Source | Hollowing |
|---|---|
| **Death** | +5 base, **+ up to +5 scaled by banked-Taint fraction at death** (`+5 × f`) — dying *hot* hurts more. So ~10–20 deaths to turn if you die cold, far fewer if you die at Brink. |
| **Brink exposure** | +1 / min while `f ≥ 0.85`. Leaving Brink stops it instantly. |
| **Overflow spill** | per §1.2 (2 excess Taint ⇒ +1 Hollowing). |

Hollowing **cannot be purged by normal means** (§8). It is a near-ratchet you fight the whole game (§3/§5 pillars).

### 5.2 Turning telegraph (the 10 pips — §11 "telegraphed, not a surprise")
| Pips | State |
|---|---|
| 0–3 | Cosmetic marks, faint whispers. |
| 4–6 | Stat drift: Warded skills weaken, Tainted strengthen; Wake grows *less* aggressive (you smell like them). |
| 7–8 | "**The Pull**": periodic involuntary twitches, vision corruption, NPCs recoil. |
| 9 | **Brink of Turning** — strong audiovisual telegraph; last-chance rites unlocked; co-op party explicitly warned. |
| 10 (=100) | **Turn** → character becomes a Wake-creature (§9 "Be consumed", §10 turned entities). May populate the world / co-op. |

### 5.3 Stave-off (so it is a fought descent, not a silent wipe — §8 "stave-off-able")
- **Cleansing rite** at a **Greater Hearth** removes **1 pip (−10 Hollowing)** for a large clean-resource cost; rate-limited (e.g. once per Tide per Greater Hearth). This is the *only* Hollowing reducer — extraordinary, not normal purge.
- A disciplined Warded player can hold the line indefinitely; a greedy Tainted player still ratchets toward turning. Matches "strongest builds live closest to turning" (§4).

---

## 6. Survival needs (no standalone temperature/sanity bars — §8)

### 6.1 Hunger (the Taint supply on-ramp)
- `0 … 100`, decays **~0.9/min** (full→empty ≈ 110 min — slightly longer than a max 90-min Expedition, so you eat ~1–2× per run). **(illustrative — tune)**
- At **Hunger 0**: stamina regen −50%, max-HP soft-cap, **and `starvation_mult = 2.0`** on Taint gain (§2.1).
- **Clean food:** +15–25 hunger, **0 Taint**, rare/perishable. **Blighted food:** +35–55 hunger, **+6–15 Taint**, plentiful. ⇒ Sustainable eating routes through Blight (§8). Spoilage rate scales with your Taint band (§1.1) — carrying high Taint rots your pack faster.

### 6.2 Light vs dark (warmth/shelter folded into Taint-rate)
- Light is the *only* thing that suppresses Taint gain (§2.1: lit 1×, dark 5×). There is **no temperature bar** — "cold/exposure" pressure *is* the dark's Taint multiplier.
- **Light sources (illustrative — tune):** Torch — ~10 min burn, small radius, occupies a hand. Lantern — ~30 min/oil, medium radius. Hearth — infinite while fueled, large radius, the safe zone. Running out of light mid-Expedition spikes Taint 5× — the "closing dark" tension (§2 player-feel #1).
- **Equipped tempered gear raises `T_floor`** (§3.2): power gear sets survival difficulty; Warded gear keeps the floor low at lower stats. This is where "build = floor" is physically equipped.

### 6.3 What is explicitly NOT a separate meter
No temperature, no sanity, no thirst-as-separate-system. Every such pressure is expressed through **light → Taint-rate** or **food → Taint-supply**. Hunger is the one extra visible bar, and its only sustainable answer is the Blight economy (§8).

---

## 7. The decay clock — the Long Dusk & its Tides (§7/§8/pillar 2)

### 7.1 No day/night; permanent dusk
The world is in permanent rotting twilight (§5). There is **no day/night cycle**. The in-Expedition rhythm comes from **weather surges** (§8 below), not sunrise.

### 7.2 The macro clock — Tides (cadence)
- The Long Dusk deepens in **Tides** (eras). **Cadence (illustrative — tune): a Tide advances per ~10 hours of cumulative *out-in-the-Reach* time** (time on Expedition; Hearth/menu/paused time does NOT count) — so you cannot out-grind the clock at base, but slow/co-op players aren't punished by wall-clock. ~5–6 Tides across a ~50–80 h playthrough.
- **Each Tide deepens rot:** `Tide_mult` ambient +0.15 (§2.1); Wake spawn-pressure +1 tier; encroachment speed +20%; tougher Wake variants unlock (combat expert owns the bestiary).
- **Warden kills can locally roll the clock back** (kindle a Greater Hearth) — the global tide still rises, but you reclaim ground hearth-by-hearth (pillar 4). *Net: a tide you push back, never finally win* (pillar 2).

### 7.3 Encroachment (the map as a tide)
- Each region carries a **decay-state** (fringe → decayed → blighted core). Unheld regions worsen **one step per Tide**. A lit **Greater Hearth rolls its radius back one step and pins it** while fueled; if its fuel lapses or it falls, decay creeps back. ⇒ The reclaimed map is impermanent (USP #2).

### 7.4 Weather as Taint-pressure (§ "weather")
- Weather is purely a **Taint-rate modulator + light suppressor** — no separate weather survival stat.
- **Events (illustrative — tune):** clear (`weather_mult 1.0`) / ashfall (1.5, −20% light radius) / **Blight-storm** (3.0, −50% light radius, lasts 2–4 min, telegraphed ~30 s out). Storm frequency rises with Tide.
- **Counterplay = base-building:** shelter quality reduces a storm's `weather_mult` (a roofed, warded shelter ⇒ storm ×3.0 → ×1.3). This is *how* base-building earns its keep in the corruption economy, not as a separate "temperature shelter."

---

## 8. Crafting, base-building, Hearths & the resource/gear economy

### 8.1 Resources — clean vs blighted (the two-track supply)
| | Clean | Blighted |
|---|---|---|
| Abundance | Scarce, in held/Lucid zones | Plentiful, in decayed/core zones |
| Taint to harvest | 0 | +1–3 splash (§2.2) |
| Used for | Purge cost, light fuel, Warded gear, clean food, Cleansing rite | Tempering, Tainted gear, blighted food, render→Taint |
| Strategic role | The *safety* resource (gates purge & stave-off) | The *power* resource (gates the build) |

Scarcity of **clean** resources is the real economic constraint — it's what makes purging a genuine cost, not a free reset.

### 8.2 The Hearth & Greater Hearth
- **Hearth** (§14): warded fire/shrine = safe radius (Taint gain 0), respawn point (§11), and the **only place you bank / purge / temper / ascend / Cleanse**. Built and **fueled** — an unfueled Hearth goes dark (no safe radius, no respawn). Upgradeable: larger radius, **purge efficiency** (lowers `k_p`), storage, crafting stations, storm shelter quality (§7.4).
- **Hearth fuel (locked anchor; exact burn rates author-owned by GDD §7):** a Hearth burns **clean combustible resources** — the SAME scarce clean-resource track purge/Cleanse draw on (§8.1), so fueling competes with purging for safety materials (intended; "Earn the Light", pillar 4). Burning **blighted** fuel as a stopgap keeps the flame lit but **degrades the Hearth** — its radius stops suppressing Taint (gain rises toward dark-rate), so a blight-fed fire is a desperate measure, not a safe haven. Greater Hearths cost more fuel (region-scale). **Bounds §7 MUST honor:** purge-efficiency upgrades may lower `k_p` from 0.4 to a floor of **~0.2** (never 0 — purge stays costly, §8 guardrail); storm-shelter quality may reduce a Blight-storm's `weather_mult` from ×3.0 to a floor of **~×1.3** (never ×1.0 — weather always bites). **Hearth raid/defense vs the Wake is NOT locked here** — if authored, drive its trigger off Taint-band/Tide hunt-pressure (§1.1/§7.2) and coordinate Wake behavior with rpg-combat-expert.
- **Greater Hearth:** region-scale, **kindled only by defeating a Warden** (§7/§10). Rolls back local decay one step and pins it (§7.3); hosts the Cleansing rite (§5.3). Maintaining it (fuel) is ongoing — the macro version of "Earn the Light" (pillar 4).

### 8.3 Gear tiers (the gear economy)
| Tier | Source | Effect on economy |
|---|---|---|
| T0 Scavenged | found | No floor impact, weak. |
| T1 Forged | clean materials | Reliable, no/low `T_floor` impact. The Warded baseline. |
| T2 Tempered | T1 + **Taint + Blight mats** (§3.2) | Stronger; **+`T_floor` per piece equipped**. The power-for-difficulty trade. |
| T3 Ascended | T2 + ascension node | Build-defining; largest `T_floor`/`T_max` shift. |

Gear power and survival difficulty are the **same axis** — there is no "strong + safe" gear, only "strong + hot" or "modest + stable."

---

## 9. Co-op economy hooks (§11 / §6) — interface with tech-coop

- **Blight-transfer revive (§11):** a downed ally is revived within a window by an ally **sacrificing banked Taint**. Economy side I own: **reviver pays ~30 Taint, transferred to the revived player** (they come up at low HP carrying that +Taint — the cost is borne in *corruption*, splitting the danger). Illustrative — tune. **The revive window, netcode, and downed-state mechanics are tech-coop's domain.**
- **Party role structure falls out of §4 floors automatically:** a low-floor Warded anchor holds the Hearth/light and Cleanses; high-floor Tainted strikers deal the rot-damage and get transfused. No separate class system needed — the Taint floor *is* the role.
- **Shared Hearth:** one settlement bank/purge for the party; design note for tech-coop — banked corpse-caches and Cleansing-rite rate-limits are per-player, the Hearth/fuel/decay-rollback are shared.

---

## 10. Master constants table (single source for balance — all illustrative, tune)

| Constant | Value | Where |
|---|---|---|
| `T_max` (fresh) | 100 | §0.3 |
| Band cuts (`f`) | 0.35 / 0.60 / 0.85 | §1.1 |
| Overflow spill | 50% of excess → Hollowing | §1.2 |
| Base ambient (fringe) | 0.5 lit / 2.5 dark per min | §2.1 |
| Zone decay mult | 1.0 / 1.5 / 2.5 | §2.1 |
| Weather mult | 1.0 / 1.5 / 3.0 | §2.1, §7.4 |
| `Tide_mult` | 1 + 0.15·(Tide−1) | §2.1, §7.2 |
| `starvation_mult` | 2.0 at Hunger 0 | §2.1, §6.1 |
| Blighted food | +35–55 hunger, +6–15 Taint | §6.1 |
| Clean food | +15–25 hunger, +0 Taint | §6.1 |
| Cast cost | −4…−12 Taint (Lesser 4–6 / Std 6–9 / Greater 9–12) | §3.1 |
| Ascendant Ultimate | −20…−40 Taint, ≤1/Expedition, floor-capped | §3.1b |
| Innate Revenant floor | ~5 (irreducible) | §4 |
| Temper cost | −20…−50 Taint + Blight mats | §3.2 |
| Ascend node cost | −30…−80 Taint | §3.3 |
| Purge cost | `0.4 × ΔTaint × (1 + Hollowing/100)` fuel | §3.4 |
| Hunger decay | 0.9 / min | §6.1 |
| Torch / lantern / Hearth | ~10 / ~30 / ∞ min | §6.2 |
| Hollowing: death | +5 + 5·f | §5.1 |
| Hollowing: Brink | +1 / min | §5.1 |
| Cleansing rite | −10 Hollowing, large clean cost, ≤1/Tide/GreaterHearth | §5.3 |
| Tide cadence | ~10 h out-in-Reach time/Tide; ~5–6 Tides | §7.2 |
| Encroachment | +1 decay step/Tide if unheld | §7.3 |
| Co-op revive | −30 Taint reviver → revived | §9 |

---

## 11. Cross-domain interfaces (who owns the seam)

- **rpg-combat-expert** owns: rot-magic **damage/scaling/cooldowns** (I own only the **Taint *cost*** per cast, §3.1); ascension-node **effects** (I own the **Taint *cost*** and the floor/ceiling deltas, §3.3/§4); Wake **bestiary & Warden** stats (I own the **hunt-pressure tiers driven by Taint band/Tide**, §1.1/§7.2). **CONFIRMED & LOCKED w/ them:** ascension is a **Hearth transaction** (spends banked Taint, like temper — so bank/purge/invest has three claimants); cast costs Lesser 4–6 / Standard 6–9 / Greater 9–12; in-field spends = casts + rot-infused weapon arts + the gated Ascendant Ultimate (§3.1b). Their per-node floor deltas (Tainted I–II +3–8, III–IV +8–15, Ascendant V +15–25 floor & +30–60 `T_max`; Warded −2–8; tempered gear +5–15) are budgeted to sum to my §4 anchors atop an **irreducible innate Revenant floor ≈5** — verified consistent.
- **narrative-world** owns: faction/lore framing of Warded vs Tainted, the Hollow Crown, ending triggers. I own the **mechanical** turning track that feeds the §9 "Be consumed" ending (§5).
- **tech-coop** owns: revive window/netcode/downed-state, shared-world persistence of Hearths/decay/turned-players (§9).
- **market-business**: difficulty/accessibility implications of the floor model (§4) and the no-extra-meters simplicity (§6.3) are positioning points (USP #1/#3).

---

## 12. Summary of locked mechanical decisions
1. **One meter, fractional bands.** Taint is `0…T_max`; threat keys on `f = Taint/T_max` (Lucid/Marked/Fevered/Brink). Build sets `T_floor` (resting danger) and `T_max` (carry ceiling). Overflow spills to Hollowing.
2. **Taint falls only by spending or purging** (Seam B resolved): casting/temper/ascend spend it (rot-magic is an in-field release valve, floor-capped); purge dumps to floor for clean-resource cost that rises with Hollowing.
3. **Bank / purge / invest** is the session climax, and all three §8 guardrails are met numerically (§3.7).
4. **Hollowing** is a near-ratchet (death + Brink + overflow), telegraphed across 10 pips, stave-off-able only by a rate-limited Greater-Hearth Cleansing rite.
5. **Survival = the same economy:** light→Taint-rate, hunger→Taint-supply, weather→Taint-multiplier, base-building→shelter that lowers that multiplier. No standalone temp/sanity bars.
6. **Long Dusk** deepens per ~10 h out-in-Reach (Tides ×ambient/hunt/encroachment); Greater Hearths roll decay back locally but impermanently.

---

## 13. Difficulty & accessibility invariants (for GDD §19)

Assist toggles soften **pressure**, never the **structure** of the keystone. Three locked rulings:

- **R1 — Hollowing is tiered, not on the normal ladder.** The standard difficulty ladder (Story/Normal/Survival presets + individual pressure toggles) softens only **moment-to-moment Taint pressure** (gain rate, light-fuel drain, Wake hunt-pressure, revive window) and leaves **Hollowing/turning untouched** — turning stays a real stake at every standard setting (pillars 3 & 5). A **separate, explicitly-labelled opt-in "Assist Mode"** (à la Celeste) MAY touch the permadeath track — reduce Hollowing-on-death (e.g. 50% or 0), slow Brink accrual (+1→+0.5/min), or disable turning — but only behind a clear "this changes the core stakes" notice, never silently inside Normal/Hard.
- **R2 — keystone-survival invariant (the hard floor).** No assist setting — individual or preset — may reduce expected **end-of-Expedition carried Taint below the Marked threshold (f ≥ 0.35)** for a baseline build on a nominal (~30–45 min) Expedition, and **purge must stay costly** (k_p ≥ 0.2, §8.2). Illustrative implication: the Taint-gain-rate assist bottoms out at **~0.5× baseline** (clamp any toggle combo that would undershoot Marked). **Assist softens pressure, not the on-ramp:** it must NOT make clean food abundant or clean fuel free — the bank/purge decision must survive at every difficulty.
- **R3 — toggles are orthogonal to build, never a Warded nudge.** Build is identity (pillar 3), so assist toggles are a **pressure-multiplier layer applied ON TOP of the chosen build** — they scale the world (gain/light/hunt/revive), leaving the build's *relative* floor/ceiling identity intact. A Tainted glass-cannon on max assist is still "the hot build relative to Warded," just in a gentler world — accessibility must never deny the Tainted fantasy to the players who most need assist. Difficulty **presets are curated bundles of these orthogonal toggles**, bounded by R2; they never auto-reassign or nudge the player's path.

---

*End of survival-systems brief. Numbers illustrative; model locked. Querying writers: ask via peer tools.*
