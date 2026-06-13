# 8. RPG Progression & Character Systems

> **Scope.** This section specifies how a **Revenant** grows: the six attributes, the four
> **ascension lanes** (Vital, Martial, **Warded**, **Tainted**), the skill nodes within them (with
> their `T_floor` / `T_max` deltas), the **ascension** transaction (a **Hearth** spend of banked
> **Taint**, gated on **Warden** kills), and the build archetypes that prove the keystone thesis:
> **your build *is* your survival difficulty.**
>
> **Cross-references (read, do not duplicate):** §5 owns the Taint / Hollowing / Blight **meter**,
> the `T_floor` / `T_max` model, the band cuts, and every **Taint cost** (ascension node −30…−80,
> temper −20…−50, cast −4…−12); §6 owns needs/light/dark/weather/decay; §7 owns crafting, gear
> tiers, tempering's *material* cost, and the Hearth build economy; **§9 owns the combat model**
> (stamina/poise/damage, weapon archetypes & arts, the full **rot-magic** spell spec) and **§10 owns
> the Wake bestiary, the Warden *fights*, and turned entities**. In this section the **Warden-kill →
> ascension-tier gate** is progression cadence and lives here; the **fights** themselves are §10.
>
> **Number status:** every stat, delta, and threshold is **(illustrative — to tune)**. Per-node
> deltas are authored within the locked §2.3-equivalent budget bands and tuned so representative
> allocations land on the **archetype anchors** (§8.8) — those anchors are the binding constraint
> (locked in both expert briefs), the per-node bands the guide.

---

## 8.1 Progression architecture (not classes — four mixable lanes)

Progression is **not a class system**. It is investment along **four ascension lanes**, freely
mixable. The *ratio* of your investment is your build identity, and — through the **Taint floor**
(§5) — your survival difficulty. A player never "picks Warded" or "picks Tainted"; they accrue a
floor by what they spend on.

**The four lanes:**

| Lane | Theme | Floor effect | Ceiling effect | Material the node wants |
|---|---|---|---|---|
| **Vital** (path-neutral) | Raise the six attributes (§8.2) | **0** | **0** | Clean or blighted |
| **Martial** (path-neutral) | Weapon masteries, footwork, combat economy (§8.5) | **0** | **0** | Clean or blighted |
| **Warded** (the resist path) | Purge / sustain / protect (§8.6) | **lowers `T_floor`** | caps `T_max` | **Clean** materials |
| **Tainted** (the embrace path) | Rot-magic + mutation (§8.7) | **raises `T_floor`** | **raises `T_max`** | **Blight** catalysts |

**Why all growth spends corruption (the bible's "every level pulls you closer"):** *every* lane,
even Warded and Martial, is paid for in **Taint** at the Hearth (§8.4). Spending Taint on a
**Warded** node is doubly purifying (sheds current Taint *and* lowers the future floor); spending
it on a **Tainted** node is doubly damning (sheds current Taint but raises a floor it can never drop
below again). The currency is the same; the *direction of the permanent consequence* is the path.

---

## 8.2 The six attributes

**Six primary attributes** — the only things ascension *levels* numerically — raised at the Hearth
via the **Vital** lane (§8.3). Soft-capped, so investment has diminishing returns past a breakpoint.
(Derived combat formulas — HP, stamina, poise, scaling — are owned by §9; reproduced here only as
references.)

| Attribute | Drives (primary) | Drives (secondary) | Soft-cap |
|---|---|---|---|
| **Vigor (VGR)** | Max Health | Festering resistance; fire/light tolerance | 40 |
| **Endurance (END)** | Max Stamina + regen | Equip-load capacity; base poise | 40 |
| **Might (MGT)** | Strength weapon scaling; heavy-weapon req. | Carry weight; guard stability; strike poise-damage | 50 |
| **Finesse (FIN)** | Dexterity weapon scaling; ranged draw/aim | Attack recovery; crit damage; cast-startup | 50 |
| **Attunement (ATN)** | Rot-magic potency; spell-slot count | Cast speed | 50 |
| **Resolve (RSV)** | **`T_max` bonus**; **purge efficiency** | Reduces Taint-driven Wake aggro; reduces Hollowing-on-death | 40 |

### 8.2.1 Resolve — the spine stat of the corruption economy

**Resolve** is the one attribute with no melee/magic analog. It lets a character **carry**
corruption more safely and **shed** it more cheaply:

- **`T_max += 1.5·RSV`** — widens the spendable band before **Brink** (§5), letting you bank more.
- **Purge efficiency:** contributes to `k_p_effective` (§5 purge curve) — cheaper escape.
- **Reduces Taint-driven Wake aggro and Hollowing-on-death** (§5/§10).

> **Resolve never lowers `T_floor`** — it widens the *usable band above* the floor. It makes
> "play with fire safely" a real investment, not a free pass. Warded builds prioritise it; Tainted
> glass-cannons skimp on it and pay for it in instability.

### 8.2.2 Derived stats (references — owned by §9)

`HP = 300 + 25·VGR` · `SP = 80 + 4·END` · `EL% = carriedWeight / (40 + 1.5·END)` ·
`Poise = armorPoise + 0.4·END` · `T_max += 1.5·RSV` (§5) · carry weight `= 50 + 2·MGT`. **See §9**
for the full combat derivation; **§5** for how `T_max` and purge efficiency enter the meter.

---

## 8.3 The Vital lane (path-neutral attributes)

Vital nodes raise the six attributes. **Floor 0 / `T_max` 0** — power without a corruption tax,
the lever a Warded striker uses to hit hard without corrupting and a Tainted caster uses for a
survivable HP/stamina base.

| Node (illustrative) | Tier | Effect | Floor Δ | `T_max` Δ |
|---|---|---|---|---|
| **Hardened Flesh** | I–V | +VGR (Max HP) per rank | 0 | 0 |
| **Long Wind** | I–V | +END (Stamina/regen, equip-load) | 0 | 0 |
| **Iron Grip** | I–V | +MGT (Strength scaling, carry) | 0 | 0 |
| **Quick Hands** | I–V | +FIN (Dex scaling, recovery) | 0 | 0 |
| **Open Veins** | I–V | +ATN (spell potency, slots) | 0 | 0 |
| **Steady Soul** | I–V | +RSV (`T_max`, purge eff — §8.2.1) | 0 | 0 |

> *Steady Soul* is path-neutral but indirectly defensive: it raises `T_max` and purge efficiency
> without touching the floor — the Tainted build's only floor-free way to widen its dangerous band.

---

## 8.4 The ascension transaction (Hearth spend, Warden-gated)

### 8.4.1 Ascension is a Hearth transaction (locked)

You **ascend a node at a Hearth** (§7) by spending **banked Taint** (the §5 cost band:
**−30 … −80 per node**) plus a node-type material (**Warded** nodes want **clean** materials,
**Tainted** nodes want **Blight catalysts**, **Vital/Martial** take either — §7). Spending Taint
lowers your *carried* Taint immediately (a side benefit) — but a **Tainted** node permanently raises
your `T_floor`, so your safe resting point rises even as your carried Taint drops.

**Ascension competes with purge and temper for the same banked Taint** (§5/§7). This is the keystone
decision relocated into the tree: at the Hearth you may **bank** it (carry the danger), **purge** it
(spend it for safety, lose the power), or **invest** it — ascend or temper — locking it into
permanent power, and if Tainted, into permanent floor. (The Taint *cost* is §5's; this section owns
what the node *does* and its floor/ceiling delta.)

### 8.4.2 Ascension Tiers gate on Warden kills (progression cadence)

Each lane has **5 Tiers (I–V)**. Reaching a new Tier requires **both**:
- **(a)** a threshold of cumulative invested nodes in that lane, **and**
- **(b)** a **Warden kill** that kindles a **Greater Hearth** (§7 / §10).

So the cadence is: *push the map → kill the region **Warden** → unlock the next ascension Tier →
spend the expedition's banked Taint on it.* This is what makes a **Greater Hearth** matter
mechanically beyond the decay-rollback (§7) — it is the gate on the top of every tree. **The Warden
*fight* is §10; the *gate* is here.**

| Tier | Unlocked by | Node band (Warded floor Δ / Tainted floor Δ / `T_max` Δ) |
|---|---|---|
| **I** | Start | Warded −2…−5 · Tainted +3…+8 · `T_max` ±10…20 |
| **II** | Warden 1 + lane threshold | Warded −2…−5 · Tainted +3…+8 · `T_max` ±10…20 |
| **III** | Warden 2 + lane threshold | Warded −2…−5 · Tainted +8…+15 · `T_max` ±20…40 |
| **IV** | Warden 3 + lane threshold | Warded −5…−8 · Tainted +8…+15 · `T_max` ±20…40 |
| **V (capstone)** | Final Warden + lane threshold | Warded −5…−8 (caps `T_max`) · Tainted +15…+25 / `T_max` +30…60 |

### 8.4.3 Floor / ceiling budget (sums into the survival anchors)

Per-node deltas are budgeted so the §8.8 archetypes land on the locked survival anchors (§5/§7),
atop an **irreducible innate Revenant floor ≈ 5** (you are never fully clean).

| Node class | `T_floor` Δ | `T_max` Δ | Notes |
|---|---|---|---|
| **Vital / Martial** (any tier) | **0** | **0** | Power without corruption tax |
| **Warded I–III** | −2 … −5 each | −5 … −10 (caps ceiling) | Cannot push floor below innate ~5; +purge efficiency |
| **Warded IV–V** (capstone) | −5 … −8 | −10 (cap) | Big purge-efficiency + party-cleanse auras |
| **Tainted I–II** | +3 … +8 each | +10 … +20 | Cheap rot-magic / minor mutation |
| **Tainted III–IV** | +8 … +15 each | +20 … +40 | Core schools, stronger mutations |
| **Tainted V** (Ascendant) | +15 … +25 each | +30 … +60 | Build-defining ultimates; raises ceiling so you can still bank big above a high floor |
| **Tempered gear / piece** (§7) | +5 … +15 | 0 | The *other* floor source — reversible (un-equip removes it) |

---

## 8.5 The Martial lane (path-neutral weapons & combat)

All builds buy Martial nodes; they **cost Taint to ascend but never touch the floor** — the lane
that lets a Warded character hit hard without corrupting, and gives a Tainted glass-cannon a melee
fallback. **Weapon archetypes, Weapon Arts, and the stamina/poise/damage model are owned by §9;**
this section owns the *progression branches* that unlock and scale them.

**Three branches:**
- **Weapon Masteries** — one mastery line per weapon archetype (greatweapons, blades,
  polearms/spears, blunt, bows/crossbows, catalysts, shields — §9): scaling bonuses + unlock the
  family's **Weapon Arts** (special moves; mechanics & Taint sliver-cost of rot-infused arts in §9).
- **Footwork** — dodge i-frames (+frames at higher nodes), roll stamina cost, backstep, sprint
  economy, quickstep.
- **Resolve-in-Arms** — in-combat stamina regen, posture/poise bonuses, critical/riposte damage,
  **ammo crafting & recovery** (feeds §7 ranged economy), throwables.

| Branch | Sample nodes (illustrative) | Floor Δ | `T_max` Δ |
|---|---|---|---|
| **Weapon Masteries** | *Family Adept I–III* (+scaling), *Art Unlock* (Weapon Art), *Family Master* (+art) | 0 | 0 |
| **Footwork** | *Sidestep* (i-frames), *Light Feet* (−roll cost), *Quickstep* (extra dodge) | 0 | 0 |
| **Resolve-in-Arms** | *Second Wind* (combat regen), *Executioner* (+crit), *Fletcher* (ammo craft/recover) | 0 | 0 |

---

## 8.6 The Warded tree (resist corruption)

Theme: holding the line — light, purity, endurance, protecting allies. **Lowers `T_floor`, raises
purge efficiency, caps `T_max`.** Lower damage ceiling, highest survivability and support. Its
magic is **Lightcraft** — protective / anti-**Wake**, **clean-fuelled (it does *not* spend Taint)** —
the path-identity counterpart to the Tainted's rot-magic (Lightcraft *mechanics* are §9). **Four
branches** (names locked): **Hearthkeeping · Bulwark · Cleansing · Beacon.**

> Warded floor deltas are **clamped at the innate ~5** — they cannot push a build below it. Their
> real work is to *claw back* floor added by tempered gear or hybrid Tainted dabbling, to cap
> `T_max`, and to stack purge efficiency. A pure-Warded build sits at the innate floor by virtue of
> taking *no* Tainted nodes/gear; Warded investment buys the *band control and purge* on top.

### 8.6.1 Hearthkeeping (purge, banking, light economy)

| Node | Tier | Effect | Floor Δ | `T_max` Δ |
|---|---|---|---|---|
| **Tend the Flame** | I | +purge efficiency (−`k_p`), faster banking | −2 | −5 |
| **Wide Warding** | II | +Hearth safe radius, cheaper Cleansing contribution | −3 | −6 |
| **Frugal Light** | III | Light-fuel economy (sources burn slower) | −3 | −8 |
| **Everlight** | V (capstone) | Equipped light burns **50% slower**; its radius **suppresses *party* Taint gain** | −6 | −10 (cap) |

### 8.6.2 Bulwark (poise, mitigation, festering resistance)

| Node | Tier | Effect | Floor Δ | `T_max` Δ |
|---|---|---|---|---|
| **Set Stance** | I | +poise, +guard stability | −2 | −5 |
| **Thick Skin** | II | Flat damage reduction | −3 | −6 |
| **Stalwart** | III | Festering resistance (synergy with VGR; §5/§9) | −4 | −8 |
| **Unbowed** | V (capstone) | Hyperarmor on guard; **cannot be staggered above X% stamina** (§9) | −7 | −10 (cap) |

### 8.6.3 Cleansing (reduce Taint gain & Hollowing)

| Node | Tier | Effect | Floor Δ | `T_max` Δ |
|---|---|---|---|---|
| **Clear Mind** | I | Reduce personal Taint **gain rate** (a `light_mult`/zone discount, §5/§6) | −3 | −5 |
| **Slow the Rot** | II | Slow supply spoilage; reduce Hollowing-on-death (§5) | −4 | −6 |
| **Turn the Wound** | III | Convert a sliver of incoming **Rot** damage to stamina (§9) | −4 | −8 |
| **Hold the Line** | V (capstone) | Once/Expedition, **purge to floor in the field** (no Hearth) for a clean-material cost (§7) | −8 | −10 (cap) |

### 8.6.4 Beacon (co-op / support)

| Node | Tier | Effect | Floor Δ | `T_max` Δ |
|---|---|---|---|---|
| **Lend Strength** | I | +**Blight-transfer** (revive) efficiency, +ally revive speed (§13) | −2 | −5 |
| **Shared Light** | II | Aura: lowers *party* Taint gain and Wake aggro (§5/§10) | −3 | −6 |
| **Standfast** | III | Aura: +party poise / festering resistance | −4 | −8 |
| **Warden's Aegis** | V (capstone) | Project a temporary **mobile mini-Hearth** safe radius (cooldown-gated) | −6 | −10 (cap) |

**Combat note (mechanics §9):** Warded players wield **clean/light** weapon buffs (blessed oil,
hearth-fire enchant) — the premium **anti-Wake** damage and the party's answer to swarms and the
Hollowed, even though their raw melee ceiling is modest.

---

## 8.7 The Tainted tree (embrace corruption)

Theme: rot-magic, mutation, glass-cannon power drawn from the carried meter. **Raises `T_floor`
AND `T_max`.** Highest ceiling in the game; lives in the danger bands at rest. The Tainted
**Rot-Sorcery** branch is **what unlocks rot-magic** (the spell schools and their **Taint-spending
cast mechanics are §9**). **Four branches** (names locked): **Rot-Sorcery · Mutation · Feral ·
Ascendant.**

### 8.7.1 Rot-Sorcery (the spell school — unlocks rot-magic; mechanics §9)

Unlocks/empowers spells, adds spell-slots (`slots = 2 + floor(ATN/12) + Rot-Sorcery nodes`, §9),
shifts cast cost toward the cheap end of the −4…−12 band (§5), +Attunement synergy. The five
schools (Affliction, Wrack, Miasma, Carrion, Bloodrot) and their costs/effects are **owned by §9**.

| Node | Tier | Effect | Floor Δ | `T_max` Δ |
|---|---|---|---|---|
| **Blightcaller** | I | Unlock **Lesser** rot-magic + 1 spell slot | +5 | +12 |
| **Festermind** | II | Unlock **Standard** spells, +1 slot | +7 | +14 |
| **Plaguewright** | III | Unlock **Greater** spells, +spell potency | +12 | +22 |
| **Plaguelord** | V (Ascendant capstone) | Unlock an **Ascendant Ultimate** (charged/gated, −20…−40 Taint; §5/§9) | +18 | +30 |

### 8.7.2 Mutation (passive body-warping — names locked: Claws / Carapace / Blightveins / Gorge)

Each mutation is a passive buff that raises the floor.

| Node | Tier | Effect | Floor Δ | `T_max` Δ |
|---|---|---|---|---|
| **Claws** | I | Natural slash weapon, **scales ATN** (§9) | +4 | +12 |
| **Carapace** | II | Innate armor / poise, **no equip-load cost** (§9) | +6 | +14 |
| **Gorge** | II | **Blighted food also heals HP** (§5/§6) | +5 | +12 |
| **Blightveins** | III | A % of your **carried Taint adds to weapon damage** — power scales with how corrupted you are (§9) | +13 | +24 |
| **Wakeform** | V (Ascendant capstone) | Transformation: trade Hollowing-risk for a burst of stats (§5/§9) | +20 | +36 |

### 8.7.3 Feral / Wake-kinship (names locked: Carrion Feast / Frenzy / Shroud)

Predator traits; the deepest nodes invert the hunt (the camouflage payoff, §10).

| Node | Tier | Effect | Floor Δ | `T_max` Δ |
|---|---|---|---|---|
| **Carrion Feast** | I | Lifesteal vs the **Wake** (§9/§10) | +4 | +10 |
| **Frenzy** | II | Attack speed **scales with Taint band** — strongest at Fevered/Brink (§5/§9) | +7 | +16 |
| **Shroud** | III | At high Taint, low-tier Wake **stop aggroing** — you read as one of them (§10) | +11 | +22 |
| **One of the Tide** | V (Ascendant capstone) | Full **Wake-camouflage** among all but elites while at **Brink** (§10) | +22 | +40 |

### 8.7.4 Ascendant (the ceiling branch — where 90→210 and "nearest turning" are bought)

The dedicated `T_max`-raising / ultimate branch. These nodes are where "the strongest builds live
nearest turning" is purchased — they raise the ceiling so a high-floor build can still bank a large
spendable reserve above it.

| Node | Tier | Effect | Floor Δ | `T_max` Δ |
|---|---|---|---|---|
| **Deepvessel** | III | +carry ceiling; bank more spendable danger | +8 | +30 |
| **Hollowheart** | IV | +ceiling; +overflow tolerance (§5 spill) | +12 | +40 |
| **Ascendant Crown** | V (capstone) | Build-defining ceiling capstone; unlocks the deepest Ascendant Ultimate path (§9) | +15 | +50 |

**Combat note (mechanics §9):** Tainted players are the **Rot** damage dealers — devastating vs
living tissue, players, Warded enemies, and Warden cores — but **weaker vs the already-rotted Wake**,
so they need physical weapons or a Warded ally for swarm control (the §9 damage-type triangle made
into co-op interdependence).

---

## 8.8 Build archetypes — build = survival difficulty

Five concrete archetypes spanning the Warded↔Tainted axis × combat style. The `T_floor` / `T_max`
values are the **locked survival anchors** (§5/§7); the **resting band** is the *survival
consequence* of the build (the keystone, made buildable). **Combat role is one line each — its
mechanics are §9.**

| Archetype | Lanes | `T_floor` | `T_max` | Resting band (§5) | Combat role (mechanics §9) | Survival difficulty |
|---|---|---|---|---|---|---|
| **Lantern-Warden** | Pure Warded + sword/board | ~5 | ~90 | deep Lucid | Tank/medic; clean-light vs Wake; best purge & Blight-transfer | **Easy** — party anchor |
| **Ash-Knight** | Warded-lean + Greatweapon | ~15 | ~100 | low Lucid | Poise bruiser; stagger-heavy melee; solo frontline | **Moderate** |
| **Bloodletter** | Hybrid Martial + Mutation/Feral | ~35 | ~150 | Marked/Fevered | Fast-blade lifesteal bruiser; Frenzy scales with Taint; vents via the occasional cast | **Hard** |
| **Rotcaller** | Heavy Tainted Rot-Sorcery | ~50 | ~160 | Fevered | Glass-cannon mage; casting is the in-field release valve; needs a Warded anchor in co-op | **Very Hard** |
| **Hollowing-Ascendant** | Pure Tainted (Ascendant) | ~90 | ~210 | Fevered/Brink | Highest ceiling; Blightveins + ultimates; lives one bad run from **turning** | **Brutal** — the "power-ending" build |

**Read across the table:** as power rises, the **floor** rises, pushing the resting band from
Lucid → Brink — so the strongest builds permanently fight in higher hunt-pressure (§10) and accrue
**Hollowing**-risk (§5) just by existing. **The skill tree is the difficulty slider** — there is no
separate one.

### 8.8.1 Worked floor accounting (illustrative — to tune)

How a build's `T_floor` is composed: **innate ~5 + Σ Tainted nodes − Σ Warded subtractions
(clamped at 5) + tempered gear (~capped +15)**. (Taint *cost* of each node is §5's −30…−80.)

- **Lantern-Warden** — innate 5; **no** Tainted nodes, **no** tempered gear; Warded subtractions
  hold it at the **innate floor ~5**; Warded `T_max` caps → **~90**. *(Floor cannot go below 5.)*
- **Ash-Knight** — innate 5 + one Temper II piece (~+10) = **~15**; deep Vital/Martial (floor-free);
  `T_max` ~100.
- **Bloodletter** — innate 5 + Mutation/Feral nodes (Claws +4, Frenzy +7, Blightveins +13 ≈ +24) +
  ~Temper +5 ≈ **~34→35**; Tainted `T_max` deltas → **~150**.
- **Rotcaller** — innate 5 + Rot-Sorcery deep (Blightcaller +5, Festermind +7, Plaguewright +12,
  Plaguelord +18 ≈ +42) − minor Warded dabble + ~light gear ≈ **~50**; `T_max` (Rot-Sorcery +
  Deepvessel) → **~160**.
- **Hollowing-Ascendant** — innate 5 + a deep Tainted allocation (Rot-Sorcery line +42, Blightveins
  +13, a ceiling node, capstones) summing **~+70 floor** + tempered gear **~+15** = **~90**; the
  **Ascendant** branch carries `T_max` to **~210**.

> The arithmetic is illustrative: per-node deltas are tuned so a representative allocation lands on
> the locked anchor, not so every possible build sums identically. The **anchors** (this table) are
> the balance contract; the node deltas (§8.4.3 / §8.6 / §8.7) are the guide that gets a build there.

### 8.8.2 The Ascendant Ultimate as a Brink escape (cross-ref)

A **Plaguelord / Ascendant Crown** build's once-per-Expedition **Ascendant Ultimate** (−20…−40 Taint,
floor-capped; mechanics §9, cost §5) doubles as a deliberate **Brink** panic-escape: one charged ult
can yank a deep-Tainted build out of turning-risk in a single wind-up, halting Brink Hollowing-accrual
(§5). Because it is gated once/Expedition and floor-capped, it **reinforces** "turning is
stave-off-able" without becoming a Hollowing dump — the player still climbs back up afterward.

---

## 8.9 Turning & the progression endgame (cross-references)

- **Turning** (§5/§12): a character who maxes **Hollowing** turns into a **Wake**-creature. The
  progression hook is that the **build seeds the turned entity's kit** (§10) — a turned **Rotcaller**
  becomes a caster-Wake, a turned **Ash-Knight** a poise-brute. This makes the deepest-Tainted builds
  (§8.8) both the strongest *and* the most consequential when they fall.
- **Endgame choice** (§3 / bible §9): a deep **Tainted** / **Hollowing-Ascendant** build is the
  natural fit for the **"Master it (the Crown)"** ending; a disciplined **Warded** build can hold the
  line for **"End it (the Pyre)"**; maxing Hollowing reaches **"Be consumed."** Progression and the
  narrative ending are the same axis — **the floor you chose is the ending you trend toward.**

---

## 8.10 Open Questions

- **Per-node band vs archetype-anchor ratio.** The §8.4.3 Tainted `T_max` band (≈2× the floor delta)
  and the locked Pure-Tainted anchor (floor +70 → `T_max` +110, ≈1.57×) do not reconcile by a naïve
  per-node sum. Resolved here by tuning node `T_max` deltas toward the **low edge** of band so a
  *focused* allocation lands on the **210** ceiling. Flagged for the §5/§9 balance pass — whether to
  (a) keep low-edge tuning, (b) add a soft `T_max` diminishing curve, or (c) split a dedicated
  ceiling-only node track. The **anchors are binding**; this is a path-to-anchor question only.
- **Tempered-gear floor cap (shared with §7).** Six tempered pieces at +15 would overshoot the
  ~+15 gear budget in §8.8.1. Intent: gear floor is capped/diminishing, not a per-slot sum. Exact
  rule is a §5/§7/§8 balance-pass decision (also flagged in §7).
