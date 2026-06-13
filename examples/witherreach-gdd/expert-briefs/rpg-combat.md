# WITHERREACH — RPG Progression & Combat (Expert Brief)

> **Authority:** Domain brief for **RPG progression & character systems** (Warded/Tainted
> paths, stats/attributes, skill trees, ascension, build archetypes) and **combat design**
> (stamina economy, melee/ranged/rot-magic, weapons, damage/poise/stagger model) and
> **enemies/AI** (the Wake, Wardens, turned entities, encounter & threat design).
> Covers GDD sections **8 (RPG Progression)**, **9 (Combat)**, **10 (Enemies, the Wake & AI)**.
> Built on the LOCKED concept bible (`00-concept-bible.md`, esp. §8/§9/§10/§11). Glossary terms used verbatim (§14).
>
> **Number status:** every stat value, cost, coefficient, and formula below is **(illustrative — tune)**.
> They are a self-consistent *starting set*, authored to sit inside the survival-systems economy, not final balance.
>
> **Economy alignment (locked with survival-systems-expert, see `survival-systems.md` §10/§11):**
> all my costs transact in **Taint**. I own: rot-magic **damage/scaling/effects**, ascension-node
> **effects + `T_floor`/`T_max` deltas**, weapon/poise/stamina model, the Wake **bestiary** and **Warden** stats.
> Survival owns: the **Taint costs** themselves (cast −4…−12, temper −20…−50, ascend −30…−80), the
> fraction bands (Lucid/Marked/Fevered/Brink) and the **hunt-pressure tiers** my spawn tables consume.
> My per-node floor deltas (§3–§4) are budgeted to **sum into survival's anchors** (`survival-systems.md` §4).

---

## 0. Two answers I owe the survival-systems expert (now locked here)

1. **Ascension is a Hearth transaction**, not a cast-time spend. You ascend a node at the Hearth by spending
   banked Taint (and materials), exactly like temper — so ascension competes with **purge** and **temper** for the
   same banked Taint at the session climax (this is the bank/purge/invest decision made concrete in progression).
   In-field you only spend Taint on **casting** rot-magic and **weapon arts**. *(Confirms their §11 assumption.)*
2. **Normal repeatable casts stay inside −4…−12 Taint** (my spell-tier map in §8.2 lands at 4–6 / 6–9 / 9–12).
   **One exception, flagged:** *Ascendant Ultimates* are not per-cast spam — they are charged/channelled,
   once-per-expedition or Hearth-primed climactic abilities costing **−20…−40 Taint** over a wind-up. They are
   gated precisely so they don't break the "fire several casts per fight, floor-respecting" rule. Survival should
   account for this as a separate sink category, not as a regular cast.

---

## 1. Attributes & Stats (the stat list)

**Six primary attributes** — the only things ascension *levels* numerically. Tight on purpose (Soulslike-legible:
Vigor/Endurance/Strength/Dexterity/Attunement + one unique corruption stat, **Resolve**). Raised at the Hearth
via the **Vital** ascension lane (§2); soft-capped so investment has diminishing returns past a breakpoint.

| Attribute | Drives (primary) | Drives (secondary) | Soft-cap (illustrative) |
|---|---|---|---|
| **Vigor (VGR)** | Max Health | Festering resistance (mitigates Fevered HP-bleed); fire/light tolerance | 40 |
| **Endurance (END)** | Max Stamina + regen | Equip-load capacity; base poise | 40 |
| **Might (MGT)** | Strength weapon scaling; heavy-weapon req. | Carry weight; guard stability; strike poise-damage | 50 |
| **Finesse (FIN)** | Dexterity weapon scaling; ranged draw/aim | Attack recovery speed; crit damage; cast-startup | 50 |
| **Attunement (ATN)** | Rot-magic potency (spell power scaling) | Spell-slot count; cast speed | 50 |
| **Resolve (RSV)** | **T_max bonus** (bank more safely); **purge efficiency** | Reduces Taint-driven Wake aggro; reduces Hollowing-on-death | 40 |

**Resolve is the spine stat of the corruption economy** — the one attribute with no melee/magic analog. It lets a
character *carry* corruption more safely (raises `T_max`, improving the spendable band before Brink) and *shed* it
more cheaply (purge efficiency lowers survival's `k_p`). Warded builds prioritize it; it is the stat that makes
"play with fire safely" a real investment rather than a free pass — it never lowers `T_floor`, only widens the
usable band above it.

### 1.1 Derived stats (illustrative formulas — tune)
- **Health:** `HP = 300 + 25·VGR` (soft-cap bends at VGR 40).
- **Stamina:** `SP = 80 + 4·END`; **regen** `= 35/s`, starting `0.6 s` after the last stamina action (halved while
  guarding or aiming).
- **Equip Load:** `EL% = carriedWeight / (40 + 1.5·END)` → roll/regen tier (§7.1).
- **Poise (stagger resistance):** `Poise = armorPoise + 0.4·END` (hyperarmor budget during heavy swings).
- **Taint Capacity bonus:** `T_max += 1.5·RSV` (stacks on build base; see §6).
- **Purge efficiency:** `k_p_effective = 0.4 · (1 − 0.006·RSV − Σ Warded purge-nodes)` (drives survival's purge curve).
- **Carry weight:** `= 50 + 2·MGT`.

> `T_floor` is **not** a stat — it is set entirely by build (path tier + slotted Tainted skills + equipped tempered
> gear, minus Warded subtractions), per survival §1.1/§4. Resolve mitigates the *consequences* of a high floor; it
> does not lower the floor.

---

## 2. Progression architecture & the ascension mechanic

Progression is **not classes**. It is investment along **four ascension lanes**, freely mixable; the *ratio* of your
investment is your build identity and (via the floor) your survival difficulty.

**The four lanes:**
1. **Vital** (path-neutral) — raise the six attributes (§1). Costs Taint; **no floor/T_max change.**
2. **Martial** (path-neutral) — weapon masteries, footwork, combat skills (§5). Costs Taint; **no floor change.**
3. **Warded** (the resist path) — purge/sustain/protect nodes (§3). Costs Taint; **lowers `T_floor`**, raises purge
   efficiency, caps `T_max`.
4. **Tainted** (the embrace path) — rot-magic + mutation (§4). Costs Taint; **raises `T_floor` AND `T_max`.**

### 2.1 The ascension transaction (locked)
- **Ascension happens at a Hearth.** You spend banked **Taint** (survival's cost band: **−30…−80 per node**) plus a
  node-type material (Warded nodes want **clean** materials; Tainted nodes want **Blight catalysts**; Vital/Martial
  take either). Spending Taint lowers your *carried* Taint immediately (a side benefit) — but a **Tainted** node
  permanently raises your `T_floor`, so your safe resting point rises even as your carried Taint drops.
- **Ascension competes with purge and temper for the same banked Taint** (survival §3.6). This is the keystone
  decision relocated into progression: *bank it (carry the danger), purge it (waste it for safety), or ascend/temper
  it (lock it into permanent power, and if Tainted, into permanent floor).*
- **Why ALL growth spends corruption:** the bible's "every level pulls you closer" — even Warded and Martial growth
  is paid in Taint. Spending Taint on a **Warded** node is doubly purifying (sheds current Taint *and* lowers future
  floor); spending it on a **Tainted** node is doubly damning (sheds current Taint but raises the floor it can never
  drop below again). The currency is the same; the *direction* of the consequence is the path.

### 2.2 Ascension Tiers gate on Wardens (ties progression to bosses)
Each lane has **5 tiers** (I–V). Reaching a new tier requires (a) a threshold of cumulative invested nodes in that
lane AND (b) a **Warden kill** that kindles a Greater Hearth. So progression cadence is: *push the map → kill the
region Warden → unlock the next ascension tier → spend the expedition's banked Taint on it.* Tier gating on Wardens
is what makes Greater Hearths matter mechanically beyond the survival-clock rollback (survival §8.2).

### 2.3 Floor / ceiling budget (sums into survival's anchors)
Per-node deltas, authored so the archetypes in §6 land on survival's §4 anchors (innate Revenant floor ≈ **5**, the
irreducible minimum — you are never fully clean):

| Node class | `T_floor` Δ | `T_max` Δ | Notes |
|---|---|---|---|
| Vital / Martial (any tier) | 0 | 0 | Power without corruption tax — the Warded-striker's friend. |
| Warded I–III | −2 … −5 each | −5 … −10 (caps ceiling) | Cannot push floor below innate ~5. +purge efficiency. |
| Warded IV–V (capstone) | −5 … −8 | −10 (cap) | Big purge-efficiency + party-cleanse auras. |
| Tainted I–II | +3 … +8 each | +10 … +20 | Cheap rot-magic / minor mutation. |
| Tainted III–IV | +8 … +15 each | +20 … +40 | Core spell schools, stronger mutations. |
| Tainted V (Ascendant capstone) | +15 … +25 each | +30 … +60 | Build-defining ultimates; raises ceiling so you can still bank big above a high floor. |
| Tempered gear piece equipped | +5 … +15 each | 0 | Survival §3.2 / §8.3 — gear is the other floor source. |

Worked sums → §6.

---

## 3. The Warded tree (resist corruption)

Theme: holding the line — light, purity, endurance, protecting allies. Lowers `T_floor`, raises purge efficiency,
caps `T_max`. Lower damage ceiling, highest survivability and support. Four branches:

- **Hearthkeeping** — purge efficiency (lower `k_p`), faster banking, larger Hearth radius, cheaper Cleansing-rite
  contribution, light-fuel economy. *Capstone — Everlight:* your equipped light source burns 50% slower and its
  radius suppresses party Taint gain.
- **Bulwark** — poise, guard stability, flat damage reduction, festering resistance (synergy with Vigor). *Capstone
  — Unbowed:* hyperarmor on guard; cannot be staggered above X% stamina.
- **Cleansing** — reduce Taint **gain rate** (a personal `light_mult`/zone discount), slow spoilage, reduce
  Hollowing-on-death, convert a sliver of incoming rot-damage to stamina. *Capstone — Hold the Line:* once per
  expedition, purge to floor in the field (no Hearth) for a clean-material cost.
- **Beacon (co-op/support)** — Blight-transfer (revive) efficiency, ally revive speed, an aura that lowers *party*
  Taint gain and Wake aggro. *Capstone — Warden's Aegis:* project a temporary safe radius (mobile mini-Hearth,
  cooldown-gated).

**Effect on combat:** Warded players get **clean/light** weapon buffs (blessed oil, hearth-fire enchant) that are
the premium anti-Wake damage (§7.3) — they are the party's answer to swarms and the Hollowed, even though their raw
melee ceiling is modest.

---

## 4. The Tainted tree (embrace corruption)

Theme: rot-magic, mutation, glass-cannon power drawn from the carried meter. Raises `T_floor` **and** `T_max`.
Highest ceiling in the game, lives in the danger bands at rest. Four branches:

- **Rot-Sorcery** — the spell school (full spec §8): unlock/empower spells, add spell-slots, reduce cast cost toward
  the −4 end of the band, +Attunement synergy. *Ascendant — Plaguelord:* unlocks an Ascendant Ultimate (§8.2).
- **Mutation** — passive body-warping buffs, each raising the floor: **Claws** (natural slash weapon, scales ATN),
  **Carapace** (innate armor/poise, no equip-load cost), **Blightveins** (a % of your *carried Taint* adds to weapon
  damage — power literally scales with how corrupted you are), **Gorge** (blighted food heals HP). *Ascendant —
  Wakeform:* a transformation that trades Hollowing-risk for a burst of stats.
- **Feral / Wake-kinship** — predator traits: **Carrion Feast** (lifesteal vs the Wake), **Frenzy** (attack speed +
  scales with Taint band — strongest at Fevered/Brink), and **Shroud** (at high Taint with kinship, low-tier Wake
  stop aggroing — you read as one of them; see §9.4 the camouflage inversion). *Ascendant — One of the Tide:*
  full Wake-camouflage among all but elites while at Brink.
- **Ascendant** — the deep `T_max`-raising capstones (90→210 across the path, survival §4) and the build-defining
  ultimates. These are where "the strongest builds live nearest turning" is bought.

**Effect on combat:** Tainted players are the **rot** damage dealers — devastating vs living tissue, players,
Warded enemies, and Warden cores (§7.3), but **weaker vs the already-rotted Wake** (saturated in rot), so they need
physical weapons or a Warded ally for swarm control. This is the co-op interdependence made into a damage-type
triangle.

---

## 5. Martial trees & weapons (path-neutral)

All builds buy these; they cost Taint to ascend but never touch the floor — the lane that lets a Warded character
hit hard without corrupting, and lets a Tainted glass-cannon have a melee fallback.

### 5.1 Martial branches
- **Weapon Masteries** (one line per archetype, §5.2): scaling bonuses + **Weapon Arts** (special moves, Ashes-of-War
  style) for that family.
- **Footwork** — dodge i-frames (+frames at higher nodes), roll stamina cost, backstep, sprint economy, quickstep.
- **Resolve-in-Arms** (combat economy) — in-combat stamina regen, posture/poise bonuses, critical/riposte damage,
  ammo crafting & recovery, throwables.

### 5.2 Weapon archetypes (weight → feel)
| Archetype | Scaling | Speed | Poise dmg | Identity |
|---|---|---|---|---|
| **Greatweapons** (greatswords, great-hammers) | MGT | Slow | **High** | Hyperarmor, stagger-breakers, fat stamina cost. |
| **Blades** (straight/curved swords, daggers) | FIN | Fast | Low | Riposte-focused, low stamina, combo pressure. |
| **Polearms/Spears** | MGT/FIN | Medium | Medium | Reach, pierce, poke-and-retreat. |
| **Blunt/Maces/Flails** | MGT | Medium | High | Strike damage, anti-armor/anti-skeleton. |
| **Bows / Crossbows** | FIN | — | — | Ranged, scarce ammo (§7.4). |
| **Catalysts** (rot-staves, bone-relics) | ATN | — | — | Cast rot-magic (§8); off-hand or two-hand. |
| **Shields** | — | — | — | Block stability %, weight; small shields parry. |

### 5.3 Weapon Arts & the two upgrade rails
- **Weapon Arts** cost **stamina**; rot-infused arts additionally cost a small **repeatable Taint band of −2…−8**
  (kept small, per survival-systems, so the player can still read their Lucid/Marked/Fevered/Brink band mid-fight).
  Examples: greatweapon *Ground Slam* (AoE poise-break), blade *Riposte Stance* (parry-into-crit), spear *Impale*
  (pierce + pull).
- **Gear upgrade is two rails** (mirrors the path tension, survival §8.3):
  - **Clean reinforcement** (clean mats, smith) → +physical, **no floor change**, lower ceiling. The Warded rail.
  - **Blight-tempering** (Taint −20…−50 + Blight mats, survival §3.2) → higher ceiling, adds **rot** scaling/innate
    rot, **+`T_floor` per equipped piece**. The Tainted rail.

---

## 6. Build archetypes — build = survival difficulty

Five concrete archetypes spanning the Warded↔Tainted axis × combat style. Floor/T_max sums land on survival §4
anchors; resting band is the survival consequence of the build (the bible's keystone, made buildable).

| Archetype | Lanes | `T_floor` | `T_max` | Resting band | Combat identity | Survival difficulty |
|---|---|---|---|---|---|---|
| **Lantern-Warden** | Pure Warded + sword/board | ~5 | ~90 | deep Lucid | Tank/medic; clean-light vs Wake; best purge & Blight-transfer | **Easy** — party anchor |
| **Ash-Knight** | Warded-lean + Greatweapon | ~15 | ~100 | low Lucid | Poise bruiser, stagger-heavy melee, solo frontline | **Moderate** |
| **Bloodletter** | Hybrid Martial + Mutation/Feral | ~35 | ~150 | Marked/Fevered | Fast-blade lifesteal bruiser; Frenzy scales with Taint; vents via the occasional cast | **Hard** |
| **Rotcaller** | Heavy Tainted Rot-Sorcery | ~50 | ~160 | Fevered | Glass-cannon mage; casting is the in-field release valve; needs a Warded anchor in co-op | **Very Hard** |
| **Hollowing-Ascendant** | Pure Tainted (Ascendant) | ~90 | ~210 | Fevered/Brink | Highest ceiling in the game; Blightveins + ultimates; lives one bad run from turning | **Brutal** — the "power-ending" build |

*Read across:* as power rises, the floor rises, pushing the **resting band** from Lucid → Brink — so the strongest
builds permanently fight in higher hunt-pressure and accrue Hollowing-risk just by existing. **The skill tree is the
difficulty slider** (survival §4); there is no separate one.

---

## 7. Combat model

Soulslike weight: deliberate, committed, stamina-gated. Three meters matter in a fight — **Stamina** (yours, the
action economy), **Poise** (both sides, the stagger economy), and **Health**.

### 7.1 Stamina economy
- Pool `SP = 80 + 4·END`. Costs (illustrative): light attack **14**, heavy **28**, roll **18**, sprint **8/s**,
  weapon art **20–35**, block negates an incoming hit for stamina `= incomingPoiseDmg × (1 − shieldStability)`.
- **Regen 35/s**, begins **0.6 s** after the last action; **halved while guarding/aiming**; **paused** during
  attack recovery. Empty-stamina block → **guard break** → stagger (open to crit).
- **Equip-load tiers** (from §1.1 `EL%`): `<30%` fast roll + full regen; `30–70%` normal roll; `70–100%` fat roll +
  −25% regen; `>100%` no roll (overloaded). Weight ⇒ defense/poise but kills mobility — the classic trade.

### 7.2 Damage / Poise / Stagger (the three-layer model)
1. **Health damage:** `Dmg = (BaseAR + Σscaling) × MotionValue × (1 − Absorption) × TypeMod`.
   - **Scaling:** weapons have letter grades **S/A/B/C/D/E** per attribute; `scaling = BaseAR × gradeCoeff ×
     statSaturation(attr)` (saturation curve soft-caps with the attribute). Grade coeffs (illustrative): S 1.0 /
     A 0.85 / B 0.6 / C 0.4 / D 0.25 / E 0.1.
   - **Motion values (illustrative):** light 100% / heavy 160% / charged-heavy 220% / running 110% / rolling 95% /
     jump 130% / weapon-art varies (120–260%).
   - **Absorption** from armor + Bulwark nodes; **TypeMod** from the weakness table (§7.3).
2. **Poise / stagger:** every hit deals **poise damage** to a target's poise pool; at 0 → **staggered** (~2 s
   open window) → eligible for a **critical** (riposte on parry, backstab from behind, visceral on a staggered
   enemy) at **×2.5–3.0** damage. Poise **regenerates** after ~3 s without being hit. **Hyperarmor** on heavy
   swings (poise-gated by END + armor) lets you trade through light hits. Poise-damage per hit (illustrative):
   blade light **6** / greatweapon heavy **45** / blunt heavy **35**. Enemy poise pools §9.3.
3. **Guard layer:** blocking routes damage to **stamina** (no separate posture bar — kept Soulslike, not Sekiro);
   small shields can **parry** (tight window → guaranteed riposte).

### 7.3 Damage-type triangle (path choice = combat effectiveness vs enemy type)
- **Physical** (strike / slash / pierce) — universal baseline; enemies carry per-sub-type weakness (skeletons weak
  to **strike**, armored weak to **pierce**, fleshy weak to **slash**).
- **Rot** (Tainted rot-magic, tempered weapons) — strong vs **living tissue, players, Warded enemies, Warden cores**;
  **weak vs the Wake** (already rot-saturated). Applies the **Rot status** (§8.3).
- **Light / Cleansing** (Warded buffs, hearth-fire, blessed oil — scarce/consumable for non-Warded) — strong vs the
  **Wake and the Hollowed**; the anti-corruption damage. The party's swarm answer.

> This triangle is *why co-op wants both paths*: Tainted shreds bosses but struggles vs swarms; Warded clears the
> Wake but lacks the burst for a Warden's living core. Solo players cover the gap with consumables and a secondary
> weapon rail.

### 7.4 Ranged
Scarce, scavenged ammo (bible §10). **Bows** (FIN, draw-charge for damage), **Crossbows** (slow reload, high pierce,
low stat-dependence), **Throwables** (blight-bombs apply Rot; oil/light bombs vs the Wake). Ammo is crafted in the
Martial *Resolve-in-Arms* branch; **blighted ammo** applies Rot but adds a small Taint splash on craft/use.
Ranged is for **opening, weakening, exploiting weakness, kiting** — not a sustain DPS (scarcity is the governor).

---

## 8. Rot-magic — the bridge (full spec)

Rot-magic is the mechanical bridge between combat and the corruption economy: **it is powered by spending Taint
straight off the carried meter** (survival §3.1), so **casting in-field lowers your survival threat** — the
"in-field release valve." But you must have *carried* the Taint to cast, and your **`T_floor` caps how far casting
can bring you down**, so a deep Tainted build can never cast itself safe. Mid-expedition this loops casters through
the economy: cast (shed danger + deal damage) → re-gather Taint (blighted food / darkness) → cast again.

### 8.1 Casting framework
- **Catalyst** required (rot-staff / bone-relic) in hand. Spells equipped into **Attunement slots** (`slots = 2 +
  floor(ATN/12) + Rot-Sorcery nodes`).
- **Spell power** scales with **Attunement** (and Blightveins adds carried-Taint to it). **Cast speed** scales with
  FIN/ATN. Casts have **commitment** (windup + recovery, dodge-cancellable only after recovery start) — weighty,
  not spammy.

### 8.2 Spell tiers → Taint cost (locked inside survival's −4…−12 band)
| Tier | Taint cost | Role |
|---|---|---|
| **Lesser** | **4–6** | Spammy bolts, single Rot-stack applicators, utility. |
| **Standard** | **6–9** | Bread-and-butter: bursts, cones, short DoT clouds. |
| **Greater** | **9–12** | Nukes, big AoE, summons. The top of repeatable casting. |
| **Ascendant Ultimate** | **20–40** (charged/channelled, gated) | *Not a normal cast* — once-per-expedition or Hearth-primed. **Floor-capped activation: requires Taint ≥ `T_floor` + cost** (can't breach the floor; a near-floor player can't ult). Doubles as a Brink panic-escape (one ult drops you out of turning-risk), but its once/expedition gate keeps it stave-off-reinforcing, not a Hollowing dump. |

### 8.3 The five schools (within Rot-Sorcery)
- **Affliction** — **Rot status** DoT. Hits apply **Rot stacks**; at a threshold the target **festers**: a burst +
  lingering DoT. (Mechanically twins survival's "festering" — couples spell pressure to the meter.)
- **Wrack** — single-target burst nukes (the boss-killer school; high rot vs living cores).
- **Miasma** — AoE clouds / zone control (area denial, slows, applies Rot over time).
- **Carrion** — animate Wake fragments from corpses as temporary minions (action economy; corpses are ammo).
- **Bloodrot** (self-buff) — convert carried Taint into a weapon rot-enchant, lifesteal, or **Frenzy**; the
  hybrid-melee caster's bridge. Self-buffs spend a chunk up front, venting Taint into a damage window.

---

## 9. The Wake — ambient antagonist (spawn pressure, bestiary, AI)

The Wake is dread and attrition, not XP piñatas (bible §10). Spawn pressure scales with the player's **Taint** and
the **Long-Dusk Tide** — the locked relationship I model below in survival's hunt-pressure tiers.

### 9.1 Hunt-pressure / spawn model (consumes survival's bands & Tide)
A hidden **Threat Level** drives spawn density, composition, aggression, and elite "hunter" dispatch:

```
ThreatLevel (TL) = ZoneTier + TaintBandTier + TideTier
  ZoneTier      : fringe 0 / decayed 1 / blighted-core 2          (survival zone decay)
  TaintBandTier : Lucid +0 / Marked +1 / Fevered +2 / Brink +3    (survival §1.1 bands)
  TideTier      : +1 per Long-Dusk Tide advanced                  (survival §7.2)
```

TL maps to a **spawn budget** (fodder count + elite slots + hunter chance). Consequences:
- **Carrying high Taint raises difficulty in real time** (bible §8): a banked, Brink-band player walking a
  blighted core in a late Tide faces near-max TL — the worst-case swarm. **Casting/purging visibly calms the tide
  around you.** The Wake density *is* the player's corruption meter externalized into the world.
- **Spawn budget is authored, not hand-placed** (§ encounter design) so the same zone scales with the player's
  state and the Tide without re-authoring.

### 9.2 Bestiary framework (archetypes — narrative/level writers expand the named roster)
| Class | Examples | Role / threat | Poise | Weakness |
|---|---|---|---|---|
| **Fodder (Husks)** | shambling dead | Swarm/attrition; density scales hardest with TL | Low (~10) | strike, light |
| **Skirmishers** | Gloamhounds, Carrionbirds | Fast flankers; punish over-extension & stamina | Low (~15) | slash |
| **Brutes** | Rotbruisers, Bloated | Heavy hitters, hyperarmor; **Bloated burst rot-gas on death** (raise Taint) — punish melee | High (~60) | pierce, stagger-then-crit |
| **Afflicters** | Blightspeakers | Ranged rot, apply festering, buff swarms — **priority kill** | Low (~20) | any burst |
| **Hunters / Stalkers** | the Famished | **Elite, dispatched by high TL**; track across the expedition, ambush, persistent | High (~50) | light, parry-crit |
| **Turned** | ex-players/NPCs | §11 — elite, build-derived | varies | varies |

### 9.3 AI behavior framework
- **Sensory model:** **sight** (light-gated — your lantern reveals you), **sound** (sprint/combat noise), and the
  unique **corruption-scent** (**Taint draws them** — high Taint = you glow to them regardless of light). Stealth =
  low light + low Taint + crouch; impossible to hide at Brink.
- **Group tactics:** fodder swarm/surround; skirmishers flank and bait dodges; brutes anchor; afflicters hang back —
  forcing spacing, target-priority, and stamina discipline.
- **Local alert / horde-build:** sustained noise/Taint in an area raises a **local alert level**, pulling in more
  Wake — rewards quick, quiet expeditions and punishes greedy farming (aligns with the survival clock's
  "don't dawdle").
- **Hunters** run search → track → ambush states and persist for the expedition (the embodiment of "corruption
  draws the hunt").

### 9.4 The camouflage inversion (Tainted Feral payoff)
At high Taint with **Wake-kinship** mutations (§4 *Shroud* / *One of the Tide*), low-tier Wake **stop aggroing** —
the deepest-Tainted builds, who suffer the worst hunt-pressure by default, can buy the ability to *walk through the
tide* unseen by all but elites. The riskiest builds get the strongest stealth among the horde — thematically: the
closer you are to turning, the more the Wake mistakes you for kin.

### 9.5 Encounter / threat-design framework (for level writers)
- **Author with TL budgets, not fixed placements** — a zone is a budget that the player's Taint/Tide spends up.
- **Pacing:** oscillate tension (quiet traversal → ambush → respite), but lingering steadily worsens TL (Taint
  accrual + alert build) — a built-in "keep moving" pressure.
- **Risk-reward is spatial:** the richest Blight nodes sit in the darkest, highest-decay spots = highest TL — the
  corruption economy's risk/reward rendered as level geometry.

---

## 10. Wardens — region bosses (design framework)

Each Warden = a biome's apex corruption, a multi-phase Soulslike set-piece that **gates a Greater Hearth** (rolls
back local decay, survival §8.2) **and unlocks the next ascension Tier** (§2.2).

### 10.1 Design template (every Warden)
1. **Soulslike fundamentals:** readable tells, poise/stagger windows, a punish economy under stamina pressure,
   multi-phase escalation.
2. **A corruption-economy hook unique to the fight** — this is what makes a Warden *Witherreach*, not generic Souls.
   Each Warden interrogates a different facet of the Taint economy (illustrative hooks):
   - *Arena floods with rot* → your Taint climbs during the fight; vent via casts or win fast (punishes slow DPS).
   - *Only the core is damageable, and only by clean/light* → favors Warded, forces Tainted players to bring
     consumables (the damage-triangle as a boss gate).
   - *Feeds on your Taint* → high-Taint/banked players empower it (punishes greedy banking; rewards purging first).
   - *Staggers only to rot-magic in a window* → favors casters; melee must time the rot phase.
3. **Phase-2 core check:** breaking the Warden's poise/armor exposes a **corruption core** (weak to rot or light) —
   the damage gate that ends the fight.
4. **Tide scaling:** Wardens scale to the current Tide (a late-Tide Warden is tougher), but their *gate position* is
   region-fixed (progression is ordered).

### 10.2 Rewards (ties the loops together)
Kindled **Greater Hearth** (decay rollback + Cleansing-rite host) + a **Warden relic** (catalyst/weapon/ascension
catalyst) + **next ascension Tier unlocked** + a **clean-material cache** (feeds the purge/Cleanse economy).

### 10.3 Illustrative Warden sketches (concept, not final roster)
- **The Drowned Choir** (rot-marsh) — *arena-floods-with-rot* hook; phases add submerged afflicter-adds; core in the
  chest, weak to light. Teaches venting.
- **The Ashen Penitent** (cathedral of ash) — *only clean/light damages the core* hook; hyperarmor brute moveset;
  forces consumables or a Warded ally. Teaches the damage triangle.
- **The Famished King** (deep blight) — *feeds on your Taint* hook; the late-game Warden near the Hollow Crown;
  punishes the very glass-cannon builds that reach it banked-hot. Teaches purge-before-the-gate.

---

## 11. Turned players / NPCs (emergent elite tier)

A character (player or NPC) who maxes **Hollowing turns** into a Wake-creature (bible §10/§11; survival §5.2 — the
10th pip). Mechanically:
- **Build-derived powerset:** the originating build seeds the turned entity's kit — a turned **Rotcaller** becomes a
  caster-Wake (Affliction/Miasma), a turned **Ash-Knight** becomes a poise-heavy brute. The entity scales to the
  **build that produced it** and the current **Tide**.
- **Co-op-relevant & emergent:** a party member who turns can become a hostile, **named elite** encounter for the
  others (the world remembers your dead builds). Solo: turned faction NPCs/questgivers populate this tier.
- **Threat-design use:** a renewable, personalized **elite pool** (the *Famished* class in §9.2) — and a constant
  memento of the stakes. (Persistence/netcode of turned-player propagation is **tech-coop's** domain.)

---

## 12. Cross-domain interfaces (who owns the seam)

- **survival-systems-expert** owns: the **Taint costs** (cast −4…−12, temper −20…−50, ascend −30…−80), the
  fraction bands, the `T_floor`/`T_max` *model* and anchors, hunt-pressure *tiers*, Hollowing/turning *track*,
  purge curve. **I own:** rot-magic damage/scaling/effects; ascension-node **effects** + my per-node `T_floor`/
  `T_max` **deltas** (budgeted to sum into their §4 anchors, §2.3); the stat list; the stamina/poise/damage model;
  the Wake **bestiary** and **Warden** stats; the spawn tables that consume their TL tiers (§9.1). *Two open
  items now answered: ascension = Hearth transaction; casts stay in 4–12 (Ascendant Ultimates flagged as a
  separate 20–40 gated sink).*
- **narrative-world-expert** owns: lore framing of Warded vs Tainted, faction identity, the Hollow Crown, the
  endgame triggers, Warden/Wake *naming & fiction*. I own the **mechanical** skill/combat/bestiary scaffolding the
  fiction dresses.
- **tech-coop** owns: revive window/netcode/downed-state; persistence of turned-player propagation; encounter
  spawning at the netcode layer. I own the **design** of co-op combat roles (the damage-triangle interdependence,
  §7.3) and turned-entity kits (§11).
- **market-business**: "build = difficulty slider" (§6) and the path-driven replay axis are positioning points
  (Soulslike build-craft depth without a bolted-on difficulty menu).

---

## 13. Master combat constants (illustrative — tune)

| Constant | Value | Where |
|---|---|---|
| Attributes | VGR / END / MGT / FIN / ATN / RSV | §1 |
| HP | `300 + 25·VGR` | §1.1 |
| Stamina | `80 + 4·END`; regen 35/s @ 0.6 s delay | §1.1, §7.1 |
| Equip-load tiers | <30 fast / 30–70 normal / 70–100 fat / >100 none | §7.1 |
| Stamina costs | light 14 / heavy 28 / roll 18 / sprint 8/s / art 20–35 | §7.1 |
| Motion values | light 100 / heavy 160 / charged 220 / run 110 / roll 95 / jump 130 % | §7.2 |
| Scaling grades | S 1.0 / A .85 / B .6 / C .4 / D .25 / E .1 | §7.2 |
| Poise damage | blade-light 6 / blunt-heavy 35 / greatweapon-heavy 45 | §7.2 |
| Crit multiplier | ×2.5 riposte/visceral … ×3.0 backstab | §7.2 |
| Poise regen | after ~3 s no-hit | §7.2 |
| Damage types | physical (strike/slash/pierce) · rot · light/cleansing | §7.3 |
| Spell slots | `2 + floor(ATN/12) + Rot-Sorcery nodes` | §8.1 |
| Cast cost (Taint) | Lesser 4–6 / Standard 6–9 / Greater 9–12 | §8.2 |
| Ascendant Ultimate | 20–40 Taint, charged/gated; activates only if Taint ≥ T_floor+cost | §8.2 |
| Rot-infused weapon art | −2…–8 Taint (repeatable, kept small for band readability) | §5.3 |
| Ascension node cost | 30–80 Taint (survival), Hearth transaction | §2.1 |
| Floor Δ / node | Vital·Martial 0 · Warded −2…−8 · Tainted +3…+25 · temper-gear +5…+15 | §2.3 |
| T_max Δ / node | Tainted +10…+60 · Warded caps · Martial 0 | §2.3 |
| Ascension tiers | 5 per lane, gated on Warden kills | §2.2 |
| Threat Level | `ZoneTier + TaintBandTier + TideTier` | §9.1 |
| Enemy poise pools | fodder ~10 / skirmisher ~15 / afflicter ~20 / hunter ~50 / brute ~60 | §9.2 |

---

## 14. Summary of locked design decisions
1. **Stat list = 6 attributes:** Vigor, Endurance, Might, Finesse, Attunement, **Resolve** (the unique
   corruption-mastery stat: raises `T_max`, purge efficiency, lowers Taint-aggro & Hollowing-on-death — widens the
   usable band, never lowers the floor).
2. **Progression = 4 mixable ascension lanes** (Vital, Martial path-neutral; **Warded** lowers floor / **Tainted**
   raises floor & ceiling). **Ascension is a Hearth transaction** in **Taint**, competing with purge & temper for
   banked Taint — the keystone bank/purge/invest decision relocated into the tree. Tiers gate on **Warden kills**.
   Per-node floor/ceiling deltas **sum into survival's archetype anchors**.
3. **Combat = Soulslike three-layer model:** Stamina (action economy) · Poise→stagger→crit (×2.5–3.0) · Health,
   with committed motion-value attacks, hyperarmor trades, and a **physical / rot / light** damage triangle that
   makes path choice = effectiveness vs enemy type (and forces co-op interdependence). **Rot-magic is the bridge:**
   casts spend carried Taint (4–12), so fighting is an in-field release valve, floor-capped.
4. **Enemy/threat scaling = `ThreatLevel = ZoneTier + TaintBandTier + TideTier`** — the Wake's density/composition
   is the player's Taint meter externalized; bestiary authored as TL budgets; **Wardens** are economy-hooked
   multi-phase bosses gating Greater Hearths + ascension tiers; **turned** players/NPCs are a build-derived,
   Tide-scaled elite pool.

---

*End of rpg-combat brief. Numbers illustrative; model locked and economy-aligned with survival-systems. Querying writers: ask via peer tools.*
