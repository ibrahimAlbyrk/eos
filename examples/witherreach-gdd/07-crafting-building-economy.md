# 7. Crafting, Building & Economy

> **Scope.** This section specifies how the Revenant turns the world's two-track supply
> (clean vs blighted resources) into tools, food, gear, and a defensible **Hearth** — and the
> **resource economy** (material sources and sinks) that governs it. It owns the *material* side
> of every transaction; the *corruption* side (Taint spent, Hollowing accrued) is owned by the
> keystone spec.
>
> **Cross-references (read, do not duplicate):** §5 owns the Taint / Hollowing / Blight **meter**
> and its costs (cast, purge, temper, ascend, render); §6 owns needs, light/dark, weather, and the
> Long Dusk decay clock; §8 owns ascension (which *spends* what is crafted/banked here); §10 owns
> the **Wake** and **Wardens** (raid behaviour, Warden fights that kindle a **Greater Hearth**);
> §13 owns co-op netcode. Where a transaction has two sides, this section restates only the
> material side and cross-references the other — never both.
>
> **Number status:** every quantity below is **(illustrative — to tune)**. They are a self-consistent
> starting set authored to sit inside the survival economy, not final balance values.

---

## 7.1 The two ledgers (boundary statement)

WITHERREACH runs on **two parallel ledgers** that share transactions:

1. **The Taint-meter ledger** (owned by §5): the corruption *quantity* — Taint gained from dark
   and blighted food, spent on casting / tempering / ascending, dropped on death, purged at a
   Hearth. This section never redefines those values; it references them.
2. **The material/resource ledger** (owned here, §7): clean vs blighted resources, crafting
   recipes, gear-tier material costs, Hearth fuel, base-building inputs, repair.

The keystone fusion (§5/§8) means the two ledgers are deliberately coupled: **tempering** debits
Taint (§5) *and* Blight materials (§7); **purging** and the **Cleansing rite** debit clean
materials (§7) while their Taint/Hollowing effect is §5's; **rendering** converts a §7 material
into §5 Taint. The design intent is that *scarcity of clean resources* is the real economic
constraint — it is what makes purging a genuine cost rather than a free reset, and what forces the
player to keep transacting in the Blight to stay supplied.

---

## 7.2 Resource taxonomy — clean vs blighted (the two-track supply)

All harvesting and crafting draws from two opposed resource tracks. (Source table mirrors
survival economy; see §6 for where each is found, §5 for the Taint splash on blighted harvest.)

| | **Clean** | **Blighted** |
|---|---|---|
| Abundance | Scarce — only in held / Lucid zones and behind cleared **Wardens** | Plentiful — in decayed and blighted-core zones |
| Taint to harvest | 0 | +1–3 splash per node (see §5) |
| Used for | Hearth fuel, purge cost, **Cleansing rite**, clean (T1 Forged) gear, clean food, repair | Tempering, Tainted (T2/T3) gear, blighted food, **render → Taint** |
| Strategic role | The **safety** resource (gates purge, fuel, stave-off) | The **power** resource (gates the build) |

### 7.2.1 Concrete resource roster (illustrative — to tune)

Each named resource is one harvest/salvage line so recipes below have real inputs.

**Clean track** (held / Lucid zones; 0 Taint):
| Resource | Source | Primary use |
|---|---|---|
| **Heartwood** | Living trees in held zones | T1 gear hafts, structure frames, fuel |
| **Pale Tallow** | Clean fauna fat, rendered at Cookfire | Lantern/torch fuel, candles, clean rations |
| **Saltbone** | Old unburied dead in consecrated ground | Purge reagent, Cleansing-rite reagent, blessed oil |
| **Clearwater** | Warded springs (rare) | Clean food, alchemy base, Hearth coolant |
| **Emberbark** | Resin-rich bark, held forests | **Hearth fuel** (high burn value), forge fuel |
| **Wardstone** | Quarried in cleared regions | Hearth/Greater-Hearth cores, shelter warding |

**Blighted track** (decayed / core zones; +Taint splash on harvest):
| Resource | Source | Primary use |
|---|---|---|
| **Rotwood** | Festered trees, core zones | Tainted gear frames, cheap (degrading) fuel |
| **Blightsap** | Weeping nodes, blighted core | **Tempering** catalyst, render → Taint |
| **Wake-essence** | Harvested from slain Wake (see §10) | Tempering, Tainted gear, render → Taint |
| **Festered Hide / Chitin** | Brutes, Carapace fauna | Tainted/heavy armor, T2 plating |
| **Miasma Salts** | Crystallised in Blight-storms | Blighted ammo, alchemy, Affliction reagents |
| **Crown-shard** | **Warden** drops only (see §10) | T3 Ascended gear, **Warden-relic** crafting |

> **Render** (clean of Taint terms in §5): a unit of **Blightsap / Wake-essence** may be carried
> as a *material* (no Taint) **or** rendered at the Render bench into **+2…+8 Taint** (§5). This is
> the player-elected on-ramp that converts the resource ledger into the meter ledger.

---

## 7.3 Crafting system

### 7.3.1 Crafting stations

Crafting is station-gated; stations are placed at a **Hearth** (or any base; §7.8) and unlocked by
the Hearth build tree (§7.6). All stations require the Hearth's safe radius to be lit to operate
(no crafting in the open dark — keeps base-building load-bearing).

| Station | Makes | Tier-gate |
|---|---|---|
| **Workbench** | Tools, light sources, structure pieces, ammo | Hearth Tier I |
| **Forge** | Weapons & armor (T1 Forged → T2 Tempered) | Hearth Tier II |
| **Cookfire** | Clean & blighted food, tallow rendering | Hearth Tier I |
| **Tannery** | Hides → leather/chitin armor | Hearth Tier II |
| **Render Bench** | Blight material → Taint (§5); blighted ammo | Hearth Tier II |
| **Alchemy Table** | Blessed oil, blight-bombs, salves, repair paste | Hearth Tier III |
| **Reliquary Altar** | **Warden-relic** & T3 Ascended crafting (§8) | Greater Hearth |

### 7.3.2 Recipe format & sample recipes (illustrative — to tune)

Recipes are `inputs → output` with a station and a craft time. **Cooking recipes are owned here;
the hunger-restore and Taint-on-eat *values* are §6/§5 — referenced, not redefined.**

**Tools & utility** (Workbench):
| Output | Inputs | Notes |
|---|---|---|
| **Torch** ×3 | 1 Heartwood + 1 Pale Tallow | ~10-min burn (§6) |
| **Lantern** | 2 Heartwood + 1 Wardstone + 2 Pale Tallow | ~30-min/oil burn (§6); refuel with Pale Tallow |
| **Repair Paste** | 2 Saltbone + 1 Clearwater | Restores T1 gear durability (Alchemy at higher tiers) |
| **Bolts** ×10 | 1 Heartwood + 1 Saltbone | Scarce ammo (§9 ranged) |
| **Blighted Bolts** ×10 | 1 Heartwood + 1 Miasma Salt | Applies Rot status (§9); small Taint splash on craft (§5) |

**Food** (Cookfire) — *hunger/Taint values are §6/§5; recipes are §7:*
| Output | Inputs | Restores (see §6) | Taint (see §5) |
|---|---|---|---|
| **Clean Broth** | 1 Clearwater + clean forage | +15–25 hunger | +0 |
| **Tallow Hardtack** | 1 Pale Tallow + clean grain | +15–25 hunger | +0 |
| **Blighted Stew** | Wake/blighted meat + Rotwood char | +35–55 hunger | +6–15 |
| **Festerwine** | 1 Blightsap + Miasma Salt | +35–55 hunger, minor stamina buff | +6–15 |

> Clean food is rare, low-yield, and perishable; blighted food is plentiful and nourishing but
> raises Taint — the sustainable diet routes through the Blight (the §5/§6 on-ramp). Spoilage
> scales with the player's Taint band (§5/§6) — carrying high Taint rots the pack faster, so a
> *banked* player must also manage food decay.

Weapon/armor recipes are specified through the **gear-tier system** (§7.4) rather than as flat
recipes, because their defining property is the **upgrade rail**, not the base craft.

---

## 7.4 Gear-tier system

Four tiers. The defining economic property — locked with the survival economy — is that **gear
power and survival difficulty are the same axis**: there is no "strong + safe" gear, only
"strong + hot" or "modest + stable."

| Tier | Source | Material track | Effect on the floor |
|---|---|---|---|
| **T0 Scavenged** | Found in the world | — | None; weak, no `T_floor` impact |
| **T1 Forged** | Crafted at Forge | **Clean** materials | Reliable; no / low `T_floor` impact — the Warded baseline |
| **T2 Tempered** | T1 + **temper** (§7.5) | Clean base + **Taint + Blight mats** | Stronger; **+`T_floor` per piece equipped** (§5/§8) |
| **T3 Ascended** | T2 + ascension node (§8) | + **Crown-shard / Warden relic** | Build-defining; largest `T_floor` / `T_max` shift (§8) |

### 7.4.1 The two upgrade rails (mirrors the path tension)

Every weapon/armor line can be pushed up **one of two rails** — this is the gear-economy
expression of the Warded↔Tainted choice (§8):

- **Clean reinforcement** (Forge, **clean materials only**, a smith action — *no Taint cost*):
  raises physical stats, durability, and poise. **No `T_floor` change.** Lower ceiling. The
  **Warded** rail. Pairs with **Lightcraft** buffs (blessed oil, hearth-fire enchant — clean-fuelled
  anti-**Wake** damage; mechanics in §9).
- **Blight-tempering** (§7.5): higher ceiling, adds **Rot** scaling / innate Rot, **+`T_floor` per
  equipped piece**. The **Tainted** rail.

### 7.4.2 Gear slots (illustrative)

6 equip slots feeding the `T_floor` total (§8 archetype math): main-hand, off-hand
(shield / catalyst / second weapon), head, chest, hands, legs. **Equip-load** (`EL%`, §8/§9) is
the second cost of armor weight; tempered plating is heavy *and* hot.

---

## 7.5 Tempering (the Taint + Blight-materials process)

Tempering is the single craft that converts banked power into permanent gear strength at the cost
of permanent survival difficulty.

- **Where:** the **Forge** at a fuelled **Hearth** (Hearth Tier II+).
- **Cost — two sides:**
  - *Taint side (owned by §5):* **−20 … −50 Taint** per temper, drawn straight off the carried
    meter (and floor-capped — you cannot temper below `T_floor`; see §5).
  - *Material side (owned here):* Blight catalysts per the table below, plus the T1 base item.
- **Result:** raises the piece to **T2 Tempered** (or re-tempers for more); adds Rot scaling/innate
  Rot; and **equipping it raises `T_floor` by +5 … +15** (§5/§8). Removing the piece removes that
  floor contribution — so gear is a *reversible* floor source, unlike a Tainted ascension node.

| Temper grade | Taint (see §5) | Blight materials (owned here) | Floor added / piece (see §5/§8) |
|---|---|---|---|
| **Temper I** | −20 | 2 Blightsap + 1 Wake-essence | +5 |
| **Temper II** | −35 | 3 Blightsap + 2 Festered Chitin + 1 Miasma Salt | +10 |
| **Temper III** | −50 | 4 Wake-essence + 1 **Crown-shard** | +15 |

**T3 Ascended** is *not* a temper — it is a temper **plus** an ascension node spent at the Hearth
(§8) and a **Warden relic** at the Reliquary Altar; it produces the largest floor/ceiling shift and
is build-defining. (Ascension transaction & node deltas: §8.)

---

## 7.6 The Hearth — build & upgrade tree

The **Hearth** is the spine of the game (§5/§6 keystone): a warded fire/shrine that is the **only**
place you **bank / purge / temper / ascend / Cleanse**, the **respawn** point (§12), and a **safe
radius** where ambient Taint gain is **0** (§5/§6). It must be **built and fuelled** — an unfuelled
Hearth goes dark: no safe radius, no respawn.

### 7.6.1 Fuel model (locked anchors; burn rates illustrative — to tune)

- A Hearth burns **clean combustible resources** — **Emberbark** (high burn value) and
  **Heartwood / Pale Tallow** (lower) — the **same scarce clean-resource track** that purge and the
  Cleansing rite draw on (§7.2). **Fuelling therefore competes with purging for safety materials**
  (intended — "Earn the Light," pillar 4).
- **Blighted fuel is a stopgap, not a haven.** Burning **Rotwood** keeps the flame lit but
  **degrades the Hearth**: its radius **stops suppressing Taint** (ambient gain rises toward the
  dark-rate, §5/§6) until clean fuel is restored. A blight-fed fire is a desperate measure.
- **Burn rate (illustrative — to tune):** base Hearth consumes ~1 Emberbark-equivalent / 4 min of
  active safe-radius; **Greater Hearths cost more** (region-scale, §7.7). Maintenance is a permanent
  clean-resource sink — the macro "held breath against the dark."

### 7.6.2 Upgrade categories & tree (illustrative — to tune)

The five upgrade **categories are locked**; the node specifics below are authored within them.
Each upgrade costs **clean materials** (Wardstone + Heartwood + tier reagents) and a build time;
they form a shallow tree gated by Hearth Tier (I–III).

| Category | Tier I node | Tier II node | Tier III node | Bound (must honour) |
|---|---|---|---|---|
| **Radius** | *Kindled Ring* — base safe radius | *Warded Ring* — +50% radius | *Beacon Ring* — +100% radius, edge fog-cutting | — |
| **Purge efficiency** | *Cleansing Basin* — enables purge | *Pure Font* — `k_p` 0.4 → 0.30 | *Wellspring* — `k_p` → **~0.20 floor** | **`k_p` never below ~0.20** (§5 guardrail) |
| **Storage** | *Cache* — small stash | *Vault* — large stash | *Reliquary Stores* — sortable, shared (co-op) | — |
| **Crafting stations** | Workbench + Cookfire | Forge + Tannery + Render Bench | Alchemy Table | (Reliquary Altar = Greater Hearth only) |
| **Storm-shelter quality** | *Lean-to* — `weather_mult` ×3.0 → ×2.2 | *Warded Roof* — → ×1.6 | *Stormhold* — → **~×1.3 floor** | **`weather_mult` never to ×1.0** (§6 guardrail) |

- **Purge efficiency** lowers survival's `k_p` in the purge-cost curve (§5) — at the **~0.20
  floor**, purging stays meaningfully costly (a §5/§8 guardrail; never 0). The **Warded ascension
  path** (§8 *Hearthkeeping*) stacks *additively* on top of this Hearth upgrade to push effective
  purge cost lower still — the structure and the build both invest in safety.
- **Storm-shelter quality** reduces a **Blight-storm**'s `weather_mult` (§6) down to the **~×1.3
  floor** — weather always bites. This is *how base-building earns its keep in the corruption
  economy*: shelter is not a separate "temperature" system, it is a Taint-rate reducer (§6).

---

## 7.7 The Greater Hearth — region-scale build tree

A **Greater Hearth** is **kindled only by defeating a region Warden** (§8 gates the next ascension
Tier on the same kill; the Warden fight is §10). It is the macro version of the Hearth:

- **Decay rollback (pin):** rolls the region's decay-state **back one step and pins it while
  fuelled** (fringe ← decayed ← blighted-core; §6 decay clock). If its fuel lapses or it falls,
  **decay creeps back** — the reclaimed map is impermanent (USP #2).
- **Cleansing rite host:** the **only** place to run the Cleansing rite — **−10 Hollowing (1 pip)**
  for a large clean-resource cost, **rate-limited to ≤1 / Tide / Greater Hearth** (§5). This is the
  sole Hollowing reducer; this section owns the clean-material cost, §5 owns the Hollowing effect.
- **Greater-Hearth upgrades (illustrative — to tune):** *Greater Radius* (region-scale safe zone),
  *Rite Efficiency* (lowers the clean cost of a Cleanse, never its rate-limit), *Fuel Reservoir*
  (longer burn between refuels — Greater Hearths are fuel-hungry), and *Aegis Projection*
  (a maintained anti-encroachment buffer at the region edge).

| Greater-Hearth upgrade | Effect | Cost track |
|---|---|---|
| **Greater Radius** | Region-scale safe radius | Wardstone + Emberbark (large) |
| **Rite Efficiency** | −clean cost per Cleanse (rate-limit unchanged) | Saltbone + Clearwater |
| **Fuel Reservoir** | +burn time per refuel | Emberbark + Wardstone |
| **Aegis Projection** | Slows encroachment at region edge while fuelled | Wardstone (heavy upkeep) |

---

## 7.8 Base-building

Base-building is the constructed safety layer around a Hearth. It is **not** a separate survival
system — every structure feeds back into the Taint economy via **light**, **shelter (`weather_mult`)**,
and **station access**.

### 7.8.1 Structure system (illustrative — to tune)

- **Snap-grid placement** of modular pieces (foundations, walls, roofs, doors, stairs) keyed to
  build materials: **Heartwood / Wardstone** (clean, durable) or **Rotwood** (blighted, cheap, but
  contributes a small ambient Taint near the structure — never build your safe-room from rot).
- **Shelter quality** is computed from enclosure (roof + walls + Wardstone warding) and feeds the
  **storm-shelter** reduction of `weather_mult` (§7.6.2 / §6). A fully enclosed, Wardstone-warded
  room reaches the ×1.3 floor; an open lean-to does not.
- **Functional placement:** crafting stations (§7.3.1), storage, and light sources are placed
  within the base; the Hearth's safe radius defines where they operate.

### 7.8.2 Hearth defence vs the Wake (raid layer)

Hearth raids are **authored against hunt-pressure, not on a fixed timer**: a raid trigger keys off
the player's **Taint band + Long-Dusk Tide** (the §10 / §5 hunt-pressure model — *banking hot near
a Hearth invites a raid*). Defensive structures (palisades, warded stakes, blessed braziers — the
latter deal **Light/Cleansing** damage to the **Wake**, §9) let a player trade clean materials for
standing defence. **Wake raid behaviour and stats are owned by §10**; this section owns only the
*material cost* of defences and the *trigger coupling* to Taint/Tide.

> Design note: raids make "Earn the Light" spatial — a hot, under-defended Hearth in a late Tide is
> a liability, reinforcing the bank-or-purge tension at the base itself.

---

## 7.9 The economy — sources & sinks ledger

The **material/resource ledger** (this section). The **Taint-meter ledger** is §5 — cross-referenced,
never restated here as if owned.

### 7.9.1 Resource SOURCES (material gain)

| Source | Yields | Track |
|---|---|---|
| Harvest clean nodes (held/Lucid zones) | Heartwood, Pale Tallow, Saltbone, Clearwater, Emberbark, Wardstone | **Clean** |
| Harvest blighted nodes (decayed/core) | Rotwood, Blightsap, Festered Hide/Chitin, Miasma Salts | **Blighted** (+Taint splash, §5) |
| Slay the **Wake** (§10) | Wake-essence, blighted meat | **Blighted** |
| Salvage T0/found gear | Scrap materials | Mixed |
| **Warden** kill cache (§10) | Clean-material cache + **Crown-shard** + Warden relic | **Clean + unique** |
| Greater-Hearth held region | Steady clean-node access (decay pinned back) | **Clean** |

### 7.9.2 Resource SINKS (material spend)

| Sink | Costs | Notes |
|---|---|---|
| **Hearth fuel** | Clean combustibles (Emberbark/Heartwood/Tallow) | Permanent upkeep; competes with purge (§7.6.1) |
| **Purge** (§5) | Clean materials + fuel | Material side here; Taint→floor effect is §5 |
| **Cleansing rite** (§5) | Large clean cost (Saltbone, Clearwater, Wardstone) | ≤1/Tide/Greater Hearth; Hollowing effect is §5 |
| **Crafting** (§7.3) | Per-recipe inputs | Tools, food, ammo, structures |
| **Tempering** (§7.5) | Blight materials (+ Taint, §5) | Blighted-track sink; raises `T_floor` |
| **Repair** | Repair Paste / clean mats | Durability upkeep |
| **Base-building** (§7.8) | Heartwood/Wardstone/Rotwood | Structures, defences |
| **Render** (§5) | Blightsap/Wake-essence → Taint | Converts material ledger → meter ledger |

### 7.9.3 The central economic tension

The **clean track is the scarce one**, and it is spent in *competition*: every Emberbark burned to
hold the light is one not spent purging; every Saltbone in a Cleansing rite is one not in blessed
oil or repair. The **blighted track is abundant but always charges Taint** to use (harvest splash,
temper, render). This asymmetry is the engine of the keystone (§5): you are always slightly short
on the resource that keeps you *safe*, and always surrounded by the resource that makes you
*powerful-but-corrupt*. There is no equilibrium — only the recurring bank/purge/invest decision
(§5/§8) made concrete in materials.

---

## 7.10 Co-op economy notes

Cross-references §13 (co-op design) and the survival co-op hooks:

- **Shared Hearth:** one settlement Hearth serves the party for bank / purge / temper / ascend /
  Cleanse. The **Hearth, its fuel, storage, and decay-rollback are shared**; **banked corpse-caches
  (§12) and Cleansing-rite rate-limits are per-player**.
- **Division of labour falls out of the floor model (§8), not a class system:** a low-floor
  **Warded** anchor tends the Hearth, holds the light, and fuels/Cleanses; high-floor **Tainted**
  strikers spend the banked power. The **Blight-transfer revive** (reviver sacrifices banked Taint
  to a downed ally; §5/§13) is the corruption-side of co-op support — its material/netcode side is
  §13's.

---

## 7.11 Open Questions

- **Per-node temper floor stacking with many slots.** Six tempered pieces at +15 each would add
  +90 `T_floor` from gear alone, exceeding the §8 archetype gear-budget (~+15). Intent (locked with
  the systems experts): tempered gear contributes a *capped, illustrative ~+15* to a build's floor
  in the archetype math, not a naïve per-slot sum. Whether the cap is a hard rule (e.g.
  highest-N-pieces count) or a soft diminishing curve is a **balance-pass decision** — flagged for
  §5/§8 reconciliation.
- **Blighted-fuel degradation curve.** The locked rule is "blighted fuel keeps the flame but
  degrades the safe radius toward dark-rate." The exact degradation shape (instant vs ramped, and
  whether it also disables banking/respawn) is left to tuning; specified here as *radius stops
  suppressing Taint*, conservatively.
