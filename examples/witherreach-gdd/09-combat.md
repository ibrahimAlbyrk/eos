# 9. Combat Design

> **Scope.** This section owns the **combat mechanics**: the stamina/poise/health three-meter
> model, committed motion-value attacks, the **physical / rot / light** damage triangle, the weapon
> archetypes and **Weapon Arts**, **melee / ranged / rot-magic / Lightcraft**, and status effects.
> **Rot-magic is the bridge to the corruption economy: every cast spends carried Taint off the meter
> per §5.** This section specifies what each weapon and spell *does*; it does **not** specify the
> enemies, the Wake bestiary, the Warden fights, or turned entities — those are **§10**.
>
> **Cross-references (read, do not duplicate):** §5 owns the Taint / Hollowing meter, the threat
> bands, and **every Taint cost** (cast −4…−12, rot-art −2…−8, Ascendant Ultimate −20…−40) — this
> section reproduces costs only as references and owns the *effects*. §8 owns the six attributes, the
> ascension lanes, and the **progression** branches that unlock weapons and spells; §6 owns light/
> dark/weather that drive the meter; §10 owns the Wake, Wardens, and AI; §12 owns death; §13 owns
> co-op combat roles.
>
> **Number status:** every value, coefficient, and formula below is **(illustrative — to tune)** —
> a self-consistent starting set aligned with the rpg-combat expert brief and the §5 economy, not
> final balance.

---

## 9.1 Combat philosophy — deliberate, committed, stamina-gated

WITHERREACH combat is **Soulslike weight, not action-RPG button-mash** (concept bible §10). Every
attack is a **commitment** the player pays for in stamina and recovery frames; reading the enemy,
spacing, and resource discipline beat reflexes. Three meters decide a fight:

| Meter | Whose | What it governs |
|---|---|---|
| **Stamina** | yours | The **action economy** — attacking, dodging, blocking, sprinting all spend it (§9.2). |
| **Poise** | both sides | The **stagger economy** — absorbing hits without flinching; broken poise opens a critical (§9.4). |
| **Health** | both sides | Survival. Damage is gated through absorption and the type triangle (§9.7). |

A fourth meter, **Taint** (§5), is uniquely the rot-caster's *resource* — casting spends it, so for
a Tainted build **fighting is also de-corruption** (§9.10). This is the bridge that makes combat and
the survival economy one loop.

**The committed-attack contract (binding feel target).** No attack is free or instantly cancellable.
Each has **startup → active → recovery**; you may only dodge-cancel *after* recovery begins, and
heavy/charged swings carry **hyperarmor** (poise-gated) so you can trade through chip but get punished
on a whiffed commit. This is what makes positioning and stamina-budgeting the core skill, not spam.

---

## 9.2 Stamina economy

Stamina (`SP = 80 + 4·END`, §8) is the in-fight currency. It governs how many actions you can chain
before you are **gassed** — empty stamina is the most dangerous state in the game.

| Action | Stamina cost *(illustrative — to tune)* |
|---|---|
| Light attack | **14** |
| Heavy attack | **28** |
| Charged heavy | 28 (held; +damage, no extra stamina) |
| Roll / dodge | **18** |
| Backstep | 8 |
| Sprint | **8 / s** |
| Weapon Art | **20–35** (per art) |
| Block (on hit) | `= incomingPoiseDmg × (1 − shieldStability)` routed to stamina (§9.5) |

**Regen:** **35 / s**, beginning **0.6 s** after the last stamina action; **halved while guarding or
aiming**; **paused** during attack recovery. **An empty-stamina block → guard break → stagger**
(you are open to a critical). Running yourself dry mid-combo is the cardinal sin the model punishes.

**Equip-load tiers** (`EL% = carriedWeight / (40 + 1.5·END)`, §8) couple weight to mobility — the
classic Souls trade of defense vs. agility:

| Load | Roll | Regen |
|---|---|---|
| **< 30%** | Fast roll (long i-frames) | Full |
| **30–70%** | Normal roll | Full |
| **70–100%** | Fat roll (short i-frames) | **−25%** |
| **> 100%** | **No roll** (overloaded) | Penalized |

Weight buys **absorption and poise** but kills mobility and stamina economy. Heavy armor is the
Warded anchor's domain (§13); a Tainted glass-cannon stays light and dodges.

---

## 9.3 Attacks & motion values (committed)

Damage scales with the **motion value (MV)** of the specific animation — the same weapon deals very
different damage on a light tap vs. a charged overhead. MVs are the lever that makes heavy, committed
attacks worth the recovery risk.

| Attack | Motion value *(illustrative — to tune)* |
|---|---|
| Light attack | **100%** |
| Heavy attack | **160%** |
| Charged heavy | **220%** |
| Running attack | **110%** |
| Rolling attack | **95%** |
| Jump attack | **130%** |
| Weapon Art | **120–260%** (per art) |

**Combo & recovery.** Light attacks chain into short strings with low per-hit recovery (combo
pressure); heavies have long recovery and are spaced into openings. **Whiffing a heavy is the primary
punish window** — the model is built so greedy attacking loses fights.

---

## 9.4 Poise, stagger & criticals (the stagger economy)

Every hit deals **poise damage** to the target's poise pool alongside health damage. Poise is the
"how hard did that rock the target" layer:

- At **poise 0** the target is **staggered** — a **~2 s** open window — and becomes eligible for a
  **critical**.
- **Criticals:** **riposte** (after a parry, §9.5), **backstab** (from behind), **visceral** (on a
  staggered enemy). Crit multiplier **×2.5 (riposte / visceral) … ×3.0 (backstab)**.
- **Poise regenerates** after **~3 s** without being hit.
- **Hyperarmor** on heavy/charged swings (poise-gated by END + armor) lets you **trade through** light
  incoming hits without flinching — the bruiser's bread and butter.

**Poise damage per hit** *(illustrative — to tune)*: blade light **6** / blunt heavy **35** /
greatweapon heavy **45**. High-poise enemies (brutes, Wardens) must be **broken** before they can be
critically punished — staggering is the melee win condition against tough targets (enemy poise pools:
§10).

---

## 9.5 The guard layer — block & parry

Blocking routes incoming damage to **stamina**, not a separate posture bar (kept Soulslike, **not**
Sekiro):

- **Block:** stamina absorbs `incomingPoiseDmg × (1 − shieldStability)`; large shields have high
  stability (cheap blocks) and weight (equip-load cost). **Run out of stamina while blocking →
  guard break → stagger.**
- **Parry:** **small shields and parry tools** have a tight active window that, on a successful parry,
  staggers the attacker and grants a guaranteed **riposte** (×2.5). High risk, high reward — the
  skill-expression ceiling of defense.

Shields and parrying are tuned so blocking is *sustainable but stamina-hungry* and parrying is
*decisive but punishing on a miss*.

---

## 9.6 The damage model

Health damage resolves through one formula:

```
Dmg = (BaseAR + Σscaling) × MotionValue × (1 − Absorption) × TypeMod
```

- **BaseAR** — the weapon's flat attack rating (raised by upgrade rails, §9.9).
- **Scaling** — `BaseAR × gradeCoeff × statSaturation(attr)`. Weapons carry a **letter grade
  S/A/B/C/D/E** per attribute; coefficients (illustrative): **S 1.0 / A 0.85 / B 0.6 / C 0.4 /
  D 0.25 / E 0.1**. `statSaturation` is a soft-capping curve so each attribute has diminishing
  returns past its breakpoint (§8 soft-caps).
- **Absorption** — from armor + Warded **Bulwark** nodes (§8).
- **TypeMod** — the damage-type triangle (§9.7).

This is the standard Souls AR-and-scaling model: a STR build pumps **Might** to saturate an
S/A-MGT greatweapon; a DEX build pumps **Finesse** for fast blades; a caster pumps **Attunement**
for spell power.

---

## 9.7 The damage-type triangle (path choice = effectiveness vs. enemy type)

There are **three damage types**, and which one you can field is set by your **Path** (§8). This is the
mechanical reason co-op wants both Paths (§13) and the reason solo players carry a secondary rail.

| Type | Source | Strong vs. | Weak vs. | Status |
|---|---|---|---|---|
| **Physical** (strike / slash / pierce) | All weapons (baseline) | Universal; per-sub-type weakness: **skeletons → strike**, **armored → pierce**, **fleshy → slash** | — | — |
| **Rot** | Tainted **rot-magic**, blight-tempered weapons (§9.9) | **Living tissue, players, Warded enemies, Warden cores** | **The Wake** (already rot-saturated) | Applies **Rot** (§9.13) |
| **Light / Cleansing** | Warded **Lightcraft**, hearth-fire enchant, blessed oil (scarce/consumable for non-Warded) | **The Wake and the Hollowed** — the anti-corruption damage; the party's swarm answer | Living/Warded targets (modest) | Applies **Sear** vs. the Wake (§9.13) |

> **The interdependence:** Tainted **Rot** shreds bosses and living foes but bounces off the rotted
> Wake; Warded **Light** clears the Wake but lacks burst for a Warden's living core. A solo player
> covers the gap with consumables (blight-bombs, blessed oil) and a second weapon; a co-op party
> covers it with **both Paths present** (§13.4). **Physical is the always-available floor** so no
> build is ever locked out of dealing damage.

---

## 9.8 Weapon archetypes

Seven archetypes, differentiated by **weight → feel** (scaling, speed, poise damage). Masteries and
Arts are unlocked through the §8 Martial lane; the **mechanics** live here.

| Archetype | Scaling | Speed | Poise dmg | Identity |
|---|---|---|---|---|
| **Greatweapons** (greatswords, great-hammers) | MGT | Slow | **High** | Hyperarmor trades, stagger-breakers, heavy stamina cost. The Ash-Knight's frontline. |
| **Blades** (straight/curved swords, daggers) | FIN | Fast | Low | Riposte-focused, low stamina, combo pressure. The Bloodletter's tool. |
| **Polearms / Spears** | MGT/FIN | Medium | Medium | Reach, pierce, poke-and-retreat; safest neutral. |
| **Blunt / Maces / Flails** | MGT | Medium | High | Strike damage; anti-armor / anti-skeleton specialist. |
| **Bows / Crossbows** | FIN | — | — | Ranged; scarce, scavenged ammo (§9.11). |
| **Catalysts** (rot-staves, bone-relics) | ATN | — | — | Cast **rot-magic** (§9.10); off-hand or two-hand. |
| **Shields** | — | — | — | Block stability % vs. weight; small shields **parry** (§9.5). |

**Two-handing** a weapon raises effective MGT (Souls-standard ×1.5) and poise; **power-stancing** /
dual-wield is an archetype-specific Art unlock, not universal.

---

## 9.9 Weapon Arts & the two upgrade rails

**Weapon Arts** are special moves (Ashes-of-War style) unlocked per weapon family in the §8 Martial
lane. They cost **stamina (20–35)**; **rot-infused arts additionally cost a small repeatable Taint
band of −2…−8** off the meter (§5) — kept deliberately small so the player can still read their
Lucid/Marked/Fevered/Brink band mid-fight. Examples:

| Art | Weapon | Effect |
|---|---|---|
| **Ground Slam** | Greatweapon | AoE poise-break; hyperarmor through the wind-up. |
| **Riposte Stance** | Blade / small shield | Parry-into-guaranteed-crit stance. |
| **Impale** | Spear | Pierce + pull (reposition the target). |
| **Carrion Edge** *(rot-infused, −2…−8 Taint)* | Any blight-tempered weapon | Coats the weapon in Rot for a short window; applies **Rot** stacks (§9.13). |

**Gear has two upgrade rails** (mirroring the Path tension; material costs owned by §7):

| Rail | Cost | Effect on the weapon | Effect on `T_floor` |
|---|---|---|---|
| **Clean reinforcement** | clean materials, at a smith | +physical AR, sharper scaling | **No floor change** — the Warded rail; lower ceiling, safe. |
| **Blight-tempering** | **−20…−50 Taint** + Blight materials (§5/§7) | Higher ceiling; adds **Rot** scaling / innate Rot | **+5…+15 `T_floor` per equipped piece** — the Tainted rail; power literally buys survival difficulty (§5.6, §6.2). |

There is no "strong + safe" weapon — only "strong + hot" or "modest + stable."

---

## 9.10 Rot-magic — the bridge (full spec)

Rot-magic is the **mechanical bridge between combat and the corruption economy**: it is powered by
**spending Taint straight off the carried meter** (§5.4), so **casting in-field lowers your survival
threat** in the moment — the **in-field release valve**. But you must have *carried* the Taint to cast
it, and your **`T_floor` caps how far casting can bring you down** (a deep Tainted build can never cast
itself safe — §5.6). Mid-Expedition this loops the caster through the economy: **cast (shed danger +
deal damage) → re-gather Taint (blighted food, darkness) → cast again.**

### 9.10.1 Casting framework

- A **Catalyst** (rot-staff / bone-relic) must be in hand.
- Spells are equipped into **Attunement slots**: `slots = 2 + floor(ATN/12) + Rot-Sorcery nodes` (§8).
- **Spell power** scales with **Attunement** (and the **Blightveins** mutation adds a % of *carried
  Taint* to it — §8). **Cast speed** scales with FIN/ATN.
- Casts have **commitment**: a windup and a recovery, dodge-cancellable only after recovery begins.
  **Weighty, not spammy** — a cast is a committed attack like any heavy swing (§9.3).

### 9.10.2 Spell tiers → Taint cost (locked inside §5's −4…−12 band)

| Tier | Taint cost | Role |
|---|---|---|
| **Lesser** | **−4…−6** | Spammy bolts, single Rot-applicators, utility. |
| **Standard** | **−6…−9** | Bread-and-butter: bursts, cones, short DoT clouds. |
| **Greater** | **−9…−12** | Nukes, big AoE, summons — the top of *repeatable* casting. |
| **Ascendant Ultimate** | **−20…−40** (charged / channelled, gated **≤1 per Expedition**) | **Not a normal cast.** Floor-capped activation: requires `Taint ≥ T_floor + cost`. Doubles as a **Brink panic-escape** (one ult yanks a deep build out of turning-risk — §5/§8.8.2). |

Every in-field cast is **floor-capped** — it can never drop Taint below `T_floor`. This is the
load-bearing reason the strongest builds rest in the danger bands and must come home to a Hearth to
get truly safe (§5.6).

### 9.10.3 The five schools (within the Tainted **Rot-Sorcery** branch, §8)

| School | Role | Signature |
|---|---|---|
| **Affliction** | **Rot** DoT | Hits apply **Rot stacks**; at threshold the target **festers** — a burst + lingering DoT (mechanically twins survival's festering, §5/§9.13). |
| **Wrack** | Single-target burst | The boss-killer school — high Rot vs. living **cores** (§10 Warden phase-2). |
| **Miasma** | AoE / zone control | Rot clouds, slows, area denial. |
| **Carrion** | Summons | Animate Wake fragments from corpses as temporary minions — corpses are ammo, an action-economy school. |
| **Bloodrot** | Self-buff | Convert carried Taint into a weapon **rot-enchant**, **lifesteal**, or **Frenzy** — the hybrid-melee caster's bridge; vents a chunk of Taint up front into a damage window. |

### 9.10.4 The Ascendant Ultimate (the gated climax)

Tainted-capstone abilities (unlocked by **Plaguelord** / **Ascendant Crown**, §8) — charged or
channelled, **once per Expedition** (or Hearth-primed). They are the only ≥20-Taint in-field sink and
are gated precisely so they don't break the "fire several casts per fight, band-readable" rule. Their
**effects** (e.g. a screen-clearing miasma detonation, a self-transformation *Wakeform* trading
Hollowing-risk for stats) are §9-owned; their cost and Brink-escape role are §5/§8.

---

## 9.11 Ranged combat

Ranged is **scarce, scavenged, and tactical — not a sustain DPS** (concept bible §10; scarcity is the
governor):

- **Bows** (FIN, draw-charge for damage), **Crossbows** (slow reload, high pierce, low stat-dependence).
- **Throwables:** **blight-bombs** (apply **Rot**, small Taint splash on craft/use), **oil / light
  bombs** (apply **Sear** vs. the Wake — the non-Warded answer to swarms).
- **Ammo** is crafted/recovered in the Martial **Resolve-in-Arms** branch (§8); **blighted ammo**
  applies Rot but adds a small Taint splash.

**Use ranged to open, weaken, exploit a weakness, or kite** — never as a primary damage stream.
Scarcity keeps it a precision tool.

---

## 9.12 Lightcraft — the Warded counterpart

The Warded Path's magic is **Lightcraft** — the **protective / anti-Wake** mirror of rot-magic.
Crucially, **Lightcraft is clean-fuelled: it does NOT spend Taint** (it draws on hearth-fuel /
clean-resource charges, §7). This keeps the Path identity clean — the Warded never have to carry
corruption to wield their magic.

| Lightcraft effect | Role |
|---|---|
| **Wardflame / blessed-oil enchant** | Adds **Light** damage to a weapon — the premium **anti-Wake / anti-Hollowed** damage (§9.7). |
| **Searing ward** | A short AoE pulse that applies **Sear** and pushes back the Wake — the swarm answer. |
| **Hearth-light aura** | (Beacon, §8) lowers *party* Taint gain and Wake aggro — the support backbone of co-op (§13). |
| **Mending light** | Modest heal / festering cleanse on an ally — clean-fuelled support, distinct from the Tainted lifesteal. |

Lightcraft is lower-ceiling than rot-magic for raw damage but is the only thing that hard-counters the
Wake at scale and supports a party without spending the meter.

---

## 9.13 Status effects

| Status | Applied by | Effect |
|---|---|---|
| **Rot** | Rot-magic, blight-tempered weapons, blight-bombs | Builds **Rot stacks**; at threshold the target **festers** — a damage burst + a lingering DoT. On the *player*, festering ties to the §5 Fevered/Brink bands (healing −40%, HP-bleed-if-hit). |
| **Sear** | Lightcraft, oil/light bombs, hearth-fire | The **anti-Wake** status — burns through the Wake's rot-saturation; strong vs. the Hollowed; interrupts Carrion summons. |
| **Stagger** | Poise depletion (§9.4) | ~2 s open window; enables a critical. |
| **Festering (player-side)** | Owned by §5 | The survival readout of Fevered/Brink; couples combat wounds to the meter (a hit while Fevered adds **+1…+3 Taint**, §5.3). |
| **Bleed / Frost / etc.** | (Reserved) | Additional physical sub-statuses are a balance-pass addition, not core to launch. |

---

## 9.14 Master combat constants *(illustrative — to tune)*

| Constant | Value | Where |
|---|---|---|
| Attributes | VGR / END / MGT / FIN / ATN / RSV | §8 |
| Health | `HP = 300 + 25·VGR` | §8 |
| Stamina | `SP = 80 + 4·END`; regen 35/s @ 0.6 s delay | §9.2 |
| Equip-load tiers | <30 fast / 30–70 normal / 70–100 fat / >100 none | §9.2 |
| Stamina costs | light 14 / heavy 28 / roll 18 / sprint 8/s / art 20–35 | §9.2 |
| Motion values | light 100 / heavy 160 / charged 220 / run 110 / roll 95 / jump 130 % | §9.3 |
| Scaling grades | S 1.0 / A .85 / B .6 / C .4 / D .25 / E .1 | §9.6 |
| Poise damage | blade-light 6 / blunt-heavy 35 / greatweapon-heavy 45 | §9.4 |
| Crit multiplier | ×2.5 riposte/visceral … ×3.0 backstab | §9.4 |
| Poise regen | after ~3 s no-hit | §9.4 |
| Damage types | physical (strike/slash/pierce) · **rot** · **light/cleansing** | §9.7 |
| Spell slots | `2 + floor(ATN/12) + Rot-Sorcery nodes` | §9.10 |
| Cast cost (Taint) | Lesser −4…−6 / Standard −6…−9 / Greater −9…−12 | §9.10 / §5 |
| Ascendant Ultimate | −20…−40 Taint, charged, ≤1/Expedition; fires only if `Taint ≥ T_floor + cost` | §9.10 / §5 |
| Rot-infused weapon art | −2…−8 Taint (repeatable, small for band readability) | §9.9 / §5 |
| Blight-temper (per piece) | −20…−50 Taint + materials; **+5…+15 `T_floor`** equipped | §9.9 / §5 |

---

## 9.15 Open Questions

- **Lightcraft fuel economy seam (§7).** Lightcraft is specified as clean-fuelled (no Taint cost); the
  exact charge/fuel currency (hearth-fuel vs. a dedicated "light charge") is a §7 crafting decision.
  Flagged so the Warded Path never accidentally acquires a Taint cost.
- **Status roster scope (§18).** Bleed/Frost and other physical sub-statuses are reserved, not specced
  — a content-scope call for the production roadmap.
