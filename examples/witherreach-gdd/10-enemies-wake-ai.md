# 10. Enemies, the Wake & AI

> **Scope.** This section owns the **enemies and their fights**: the **Wake** bestiary, the spawn /
> hunt-pressure model (**ThreatLevel**), AI behaviors, the five progression **Wardens** and the
> **Hollow Court** endgame bosses, and the **turned** players/NPCs as build-derived elites. The
> combat *mechanics* these enemies are fought with (stamina, poise, the damage triangle, rot-magic,
> Lightcraft) are **§9** — this section references them and owns the *enemy side* (rosters, poise
> pools, weaknesses, behaviors, boss hooks).
>
> **Cross-references (read, do not duplicate):** §5 owns the Taint bands and the `ThreatLevel`
> *band/Tide tiers* this section consumes; §6 owns the Long Dusk / Tides and region decay states that
> feed `ZoneTier`/`TideTier`; §8 owns the ascension tiers the Wardens gate and the build kits the
> turned entities inherit; §9 owns the combat model and the **physical / rot / light** triangle that
> sets every weakness here; §11 owns the regions, decay states, and Reliquaries the encounters sit in;
> §12 owns death/turning; §13 owns co-op scaling and turned-entity persistence.
>
> **Number status:** every value is **(illustrative — to tune)**, aligned with the rpg-combat expert
> brief and the §5 economy.

---

## 10.1 Design philosophy — the Wake is dread and attrition

The **Wake** is the world's ambient antagonist: the corrupted dead and beasts, the rising tide of the
Long Dusk (concept bible §10). It is **not an XP piñata** — it is **dread and attrition**. Three
principles bind every encounter:

1. **The Wake's density IS the player's Taint meter externalized.** Spawn pressure scales with the
   player's **Taint band** and the **Long Dusk Tide** (§10.2). A banked, hot Revenant walking a
   blighted core in a late Tide is hunted hard; **casting or purging visibly calms the tide around
   them.** Carrying power literally raises the difficulty in real time (concept bible §8) — the Wake
   makes that economic truth visible in the world.
2. **Corruption draws the hunt.** The Wake senses **Taint** the way a predator smells blood (§10.4).
   You cannot out-skill being a beacon of rot — you manage it or you are found.
3. **Attrition over spectacle.** Most encounters threaten by *accumulation* — chip, festering,
   stamina drain, being slowly surrounded — not by single big hits. The danger is the round trip, not
   any one fight (the §12 Expedition).

---

## 10.2 ThreatLevel — the spawn & hunt-pressure model

A hidden **ThreatLevel (TL)** drives spawn density, composition, aggression, and the dispatch of elite
**Hunters**. It is the single authored knob that lets a zone scale with the player's state and the
Tide **without re-authoring** (encounters are budgets, not fixed placements — §10.8).

```
ThreatLevel (TL) = ZoneTier + TaintBandTier + TideTier
  ZoneTier      : fringe 0 / decayed 1 / blighted-core 2     (region decay, §6/§11)
  TaintBandTier : Lucid +0 / Marked +1 / Fevered +2 / Brink +3   (§5 bands)
  TideTier      : +1 per Long Dusk Tide advanced              (§6.5)
```

> `ZoneTier` is the coarse 3-band summary of §11's 5-state decay spectrum (Lingering → Festering →
> Withering → Blooming → Terminal): **Lingering/Festering → 0**, **Withering → 1**, **Blooming/
> Terminal → 2** *(illustrative mapping — §11-owned)*.

**TL → spawn budget.** Each TL value maps to a budget the spawner spends on fodder count + elite slots
+ a **Hunter dispatch chance** *(illustrative — to tune)*:

| TL | Fodder | Elite slots | Hunter chance | Feel |
|---|---|---|---|---|
| **0–1** | low | 0 | 0% | Quiet traversal; occasional husk. |
| **2–3** | medium | 0–1 | 10% | Contested ground; first skirmisher packs. |
| **4–5** | high | 1–2 | 35% | Pressured; afflicters and brutes appear. |
| **6–7** | very high | 2–3 | 70% | The worst-case swarm; a Hunter is likely on you. |
| **8** (cap) | max | 3 | 100% | A Brink Revenant in a blighted core in a late Tide — near-max everything. |

**Consequences the model guarantees:**
- **Carrying high Taint raises difficulty in real time** — banking power is paid in hunt-pressure now,
  not later.
- **Venting calms the tide** — casts (which lower Taint, §9) and purging at a Hearth drop your
  `TaintBandTier`, visibly thinning the spawns around you.
- **Lingering worsens TL** — sustained noise/Taint in an area raises a **local alert level** (§10.4),
  pulling in more Wake. Greedy farming is punished; quick, quiet Expeditions are rewarded (aligns with
  the §6 "don't dawdle" clock).
- **Encroachment** (§6.5): unheld regions worsen one decay step per Tide, raising their `ZoneTier`
  and thus their baseline TL — the map itself gets more dangerous if you don't hold it with Greater
  Hearths.

**Co-op TL** uses the **hottest present Revenant's band** for `TaintBandTier` and scales the spawn
budget with party size (§13.6) — one Brink glass-cannon raises the hunt for the whole party.

---

## 10.3 The Wake bestiary (six classes)

The roster is authored as **six enemy classes** (narrative/level writers expand the named roster per
region, §11). Every weakness keys off the §9 damage triangle. Poise pools are the §9 stagger gate.

| Class | Role / threat | Poise *(illus.)* | Weakness | Named examples (by region) |
|---|---|---|---|---|
| **Fodder (Husks)** | Swarm/attrition; density scales hardest with TL. Dangerous only in numbers. | ~10 | **strike, light** | *Gloaming Husks* (R1), *Cinder-Shamblers* (R2), *Drowned* (R3) |
| **Skirmishers** | Fast flankers; punish over-extension & empty stamina; bait dodges. | ~15 | **slash** | *Gloamhounds* (R1), *Carrionbirds*, *Ash-Stalkers* (R2) |
| **Brutes** | Heavy hitters, **hyperarmor**; anchor a fight. **Bloated** burst **rot-gas on death** (raise your Taint) — punish melee. | ~60 | **pierce; stagger-then-crit** | *Rotbruisers*, *Bloated* (R3 marsh), *Cinder-Ogres* (R2) |
| **Afflicters** | Ranged Rot; apply festering; **buff the swarm** — a **priority kill**. | ~20 | **any burst** (Wrack), **light** | *Blightspeakers* (R3), *Choir-Echoes* (R5) |
| **Hunters / Stalkers** | **Elite, dispatched by high TL** (§10.2). Track across the Expedition, ambush, persistent. The embodiment of "corruption draws the hunt." | ~50 | **light, parry-crit** | *the Famished* (the elite Hunter class; named instances in deep regions) |
| **Turned** | Build-derived elites seeded from fallen players/NPCs (§10.7). | varies | varies (by build) | *the Turned* (e.g. **Coll** turned, §3) |

**Class behaviors in a mixed pack** (the §10.4 group tactics in one line): **fodder** swarm and
surround; **skirmishers** flank and bait; **brutes** anchor and trade through your chip; **afflicters**
hang back and rot you from range. The composition forces **spacing, target priority, and stamina
discipline** — you cannot facetank a mixed pack.

**Tide-gated variants.** Each Tide unlocks tougher variants of the existing classes (§6.5) — e.g. a
*Festering Husk* (applies Rot on hit) replaces the plain Husk in late Tides; a *Choir-Bound
Blightspeaker* gains a heal-aura. The class roster is fixed; the **variants** are the difficulty-over-
time lever (content scope: §18).

---

## 10.4 AI behavior framework

### 10.4.1 Sensory model (three senses)

| Sense | Trigger | Counterplay |
|---|---|---|
| **Sight** | **Light-gated** — your lantern/torch reveals you; in the dark you are hard to see (but the dark raises Taint ×5, §6 — the trade). | Move dark *and* low-Taint; break line of sight. |
| **Sound** | Sprinting, combat, breaking nodes. | Crouch-walk; fight quickly and move on. |
| **Corruption-scent** | **Taint draws them** — high Taint = you "glow" to the Wake **regardless of light**. The unique sense that makes carrying power dangerous. | Lower your band (cast/purge); Beacon auras (§8/§13) suppress party scent. |

> **Stealth = low light + low Taint + crouch. It is impossible at Brink** — a Brink Revenant cannot
> hide; the corruption-scent overwhelms every other input. The deepest builds buy their way *around*
> this only with the camouflage inversion (§10.4.4).

### 10.4.2 Group tactics & local alert

- Fodder **swarm/surround**; skirmishers **flank and bait** dodges; brutes **anchor**; afflicters
  **hang back** — the pack composition enforces spacing and target priority (§10.3).
- **Local alert / horde-build:** sustained noise/Taint in an area raises a **local alert level** that
  **pulls in more Wake** over time. Camping a rich node farms a horde down on yourself — the built-in
  "keep moving" pressure that mirrors the §6 clock.

### 10.4.3 Hunters — the persistent elite

**Hunters (Stalkers)** are dispatched by high TL (§10.2) and run a **search → track → ambush** state
machine, **persisting for the whole Expedition**. They do not patrol a fixed leash — they hunt *you*,
re-acquiring across zones, ambushing at chokes and in the dark. A Hunter on your trail is the signal
that you are carrying too much Taint for the region and the Tide; **the answer is to vent, reach
light, or reach the Hearth** — you rarely simply out-DPS a Hunter while still hot.

### 10.4.4 The camouflage inversion (Tainted Feral payoff)

At high Taint with **Wake-kinship** mutations (**Shroud** / **One of the Tide**, §8), low-tier Wake
**stop aggroing** — the deepest-Tainted builds, who suffer the worst hunt-pressure by default, can buy
the ability to **walk through the tide unseen by all but elites.** Thematically: *the closer you are to
turning, the more the Wake mistakes you for kin.* The riskiest builds get the strongest horde-stealth —
but **Hunters, Brutes, and Wardens still see them**, and the inversion fails the moment they attack.

---

## 10.5 The five progression Wardens

Each **Warden** is a biome's **apex corruption** — a multi-phase Soulslike set-piece that **gates a
Greater Hearth** (rolls back local decay, §6/§7) **and unlocks the next ascension Tier** (§8). There
are **five progression Wardens, R1–R5**, mapping 1:1 to the five ascension tiers (§8.4.2). Names are
narrative canon (§3); the **fight design** is here.

### 10.5.1 The Warden design template (every Warden)

1. **Soulslike fundamentals:** readable tells, poise/stagger windows, a punish economy under stamina
   pressure, multi-phase escalation.
2. **A corruption-economy hook unique to the fight** — what makes a Warden *WITHERREACH*, not generic
   Souls. Each interrogates a different facet of the Taint economy (§10.5.2).
3. **Phase-2 core check:** breaking the Warden's poise/armor exposes a **corruption core** (weak to
   **rot** or **light**, §9.7) — the damage gate that ends the fight. This is where the damage triangle
   becomes a boss-design lever.
4. **Tide scaling:** Wardens scale to the current Tide (a late-Tide Warden is tougher), but their
   **gate position is region-fixed** — progression is ordered (§8).
5. **Rewards:** a kindled **Greater Hearth** (decay rollback + Cleansing-rite host, §12.7) + a
   **Warden relic** (catalyst/weapon/ascension catalyst) + the **next ascension Tier** unlocked + a
   **clean-material cache** (feeds the purge/Cleanse economy).

### 10.5.2 The roster

| # | Warden (§3) | Region | Tier | Core weakness | The corruption-economy hook |
|---|---|---|---|---|---|
| 1 | **The Mire-Stag** | R1 **Gloaming Marches** | **I** | rot | **Teaches the core check.** The Stag seeds **blight-pools** across the arena that raise your Taint if you stand in them; phase 2 lowers its antlered **core**. Teaches positioning, the core-break win condition, and that the floor is the arena. |
| 2 | **The Cinder-Alpha** | R2 **Cinderwood** | **II** | light | **Teaches light discipline.** The Alpha and its pack **snuff your light** and drag the fight into the dark (ambient Taint ×5, §6); you must hold a light source or land **Sear** to see and to damage the pack-bond core. Teaches the light economy under pressure. |
| 3 | **The Drowned Choir** | R3 **Mourning Marsh** | **III** | light | **Teaches venting.** The **arena floods with rot** — your Taint *climbs* through the fight; submerged afflicter-adds accelerate it. Vent via casts or win fast (punishes slow DPS); the chest-core is weak to light. Yields the **Fragment of the Song** (§3). |
| 4 | **The Communed Champion** *(the "tragic mirror"; epithet TBD by §3 — illustrative: "the Blooming Penitent")* | R4 **Hollowing Wastes** | **IV** | rot **or** light (mirror — see hook) | **Teaches that embracing the rot is a trap.** The Champion periodically **Blooms** — briefly invulnerable, **healing from ambient Blight** — and you must **deny it the Blight** (sear/destroy the bloom-nodes) to break the heal. It also **mirrors the player's leaned Path**, hardening against your primary damage type and rewarding a hybrid answer. Beauty-in-decay made into a boss: the seductive Communed gospel, refuted in mechanics. |
| 5 | **The Ashen Penitent** *(the First Warden, §3)* | R5 **Cathedral of Ash** | **V** | **light only** | **Teaches the damage triangle as a gate.** A hyperarmor brute whose **core takes only clean/light damage** — Tainted players *must* bring consumables (blessed oil, light-bombs) or a Warded ally; pure rot bounces off. The damage triangle made a hard boss requirement (§9.7). |

> **Design intent across the five:** the Wardens are a **curriculum** in the corruption economy —
> core-check (Mire-Stag) → light discipline (Cinder-Alpha) → venting (Drowned Choir) → the seduction
> is a trap (Communed Champion) → the triangle is a gate (Ashen Penitent). By R6 the player has been
> taught every lever they need for the endgame.

---

## 10.6 The Hollow Court — the endgame bosses (R6)

R6 (**Hollow Court / Sunhold**) sits **outside** the five-tier gate (§3.2). It holds two bosses:

### 10.6.1 The Famished King — the gauntlet gate

A final-approach **gauntlet boss** barring the throne (Crowned Circle's member who chose to *feed*,
§3). **Economy hook: he feeds on your Taint.** A high-Taint / banked player **empowers him** in real
time — his damage and aggression scale with the carried Taint of whoever he is fighting. This is the
capstone lesson of the curriculum: **purge before the gate.** A greedy glass-cannon who arrives
banked-hot fights a far stronger King; a player who purged down arrives to a beatable one. He is
**fixed** (not a progression Warden), Tide-scaled, and drops the approach to the Crown.

### 10.6.2 The Hollow Crown (Sovereign Vael) — the ending encounter

The dead god-king, anchor of the web (§3) — a **multi-phase set-piece that IS the ending encounter**,
not a progression Warden. The fight and the **three-choice resolution** (§3.4) are one event.

**Phase structure** *(fight design; the narrative beats are §3.4):*

| Phase | Form | Economy hook |
|---|---|---|
| **1 — The King** | Sovereign Vael's body | Standard multi-phase Warden moveset; readable tells, a poise/core gate. |
| **2 — The Choir** | The web itself answers — the massed dead, Choir-Echo afflicters, the arena becomes the binding | **"The Pull" mid-fight:** the more **Hollowed** you are (§5/§12), the harder the web tugs you toward turning during the fight — periodic involuntary debuffs scaled to your Hollowing pips. A near-turning player fights *and* fights their own corruption. |
| **3 — The Choice** | The anchor laid bare | Not a damage phase — the binding offers the **three endings** (§3.4) as capabilities of what the Revenant is: **End it (the Pyre)** / **Master it (the Crown)** / **Be consumed (the Hollowing)**. Resolution and co-op canon: **§13.8**. |

The Hollow Crown is the only boss whose **defeat is a choice, not just a health bar** — the
culmination of the whole corruption economy (concept bible §9; endings §3.4; co-op resolution §13.8).

---

## 10.7 Turned players & NPCs — the emergent elite tier

A character (player or NPC) who maxes **Hollowing turns** into a **Wake-creature** (concept bible
§10/§11; the turning event is §12; co-op persistence §13.7). Mechanically these are the **Turned**
class (§10.3):

- **Build-derived powerset.** The originating build **seeds the turned entity's kit** (§8): a turned
  **Rotcaller** becomes a caster-Wake (Affliction/Miasma); a turned **Ash-Knight** becomes a
  poise-heavy brute; a turned **Bloodletter** becomes a fast lifesteal stalker. The entity scales to
  the **build that produced it** and the current **Tide**.
- **Named, personalized elites.** A turned entity is a **named** encounter wearing its origin's face,
  build, and gear silhouette — "the world remembers your dead builds." This is a **renewable,
  personalized elite pool** (the *Famished* Hunter slot in §10.3) and a constant memento of the stakes.
- **Co-op-relevant.** A party member who turns can become a hostile, named elite the others later face
  (§13.7); solo, turned faction NPCs (e.g. **Coll**, §3) populate this tier.
- **Persistence/netcode** of turned-entity propagation is **§13 / the tech brief**; the **kit design**
  is here (seeded from §8 archetypes).

---

## 10.8 Encounter & threat design (for level writers, §11)

- **Author with TL budgets, not fixed placements.** A zone is a **budget** the player's Taint/Tide
  *spends up* (§10.2) — the same geometry scales with player state and Tide without re-authoring.
- **Pacing:** oscillate tension (quiet traversal → ambush → respite), but **lingering steadily worsens
  TL** (Taint accrual + local alert) — a built-in "keep moving" pressure.
- **Risk-reward is spatial:** the richest Blight nodes sit in the **darkest, highest-decay** spots =
  **highest TL** (and, per §3.6, where grief was strongest — the Blight-Halo). The corruption
  economy's risk/reward is rendered as level geometry; the **Reliquary Delve** (§3.5/§11) is the
  concentrated form.
- **Hunters as the over-extension valve:** a player farming too hot for too long gets a Hunter
  dispatched (§10.4.3) — the spatial expression of "you've banked too much."

---

## 10.9 Master enemy constants *(illustrative — to tune)*

| Constant | Value | Where |
|---|---|---|
| ThreatLevel | `ZoneTier + TaintBandTier + TideTier` | §10.2 |
| ZoneTier | fringe 0 / decayed 1 / blighted-core 2 | §10.2 |
| TaintBandTier | Lucid +0 / Marked +1 / Fevered +2 / Brink +3 | §10.2 / §5 |
| TideTier | +1 per Tide advanced | §10.2 / §6 |
| TL cap | 8 (Brink + blighted-core + late Tide) | §10.2 |
| Enemy poise pools | fodder ~10 / skirmisher ~15 / afflicter ~20 / hunter ~50 / brute ~60 | §10.3 |
| Bestiary classes | Fodder · Skirmisher · Brute · Afflicter · Hunter · Turned | §10.3 |
| Progression Wardens | 5 (R1–R5), gate ascension Tiers I–V | §10.5 / §8 |
| Endgame bosses | Famished King (gate) → Hollow Crown (ending) | §10.6 |
| Damage triangle (sets weakness) | physical (strike/slash/pierce) · rot · light | §9.7 |

---

## 10.10 Open Questions

- **Communed Champion epithet (§3/narrative).** I use **the Communed Champion** (the "tragic mirror")
  with an illustrative working epithet ("the Blooming Penitent"); the final canon name is
  narrative-owned (§3) — flagged so it is named once, consistently.
- **Tide-variant content budget (§18).** The per-Tide enemy variants (§10.3) are the difficulty-over-
  time lever; their count is a production-scope call.
- **Hunter leash vs. true persistence (perf, §16/tech).** Hunters are specced as Expedition-persistent
  trackers; the server-side cost of true cross-zone persistence vs. a soft re-acquire is a profiling
  call — flagged to tech.
