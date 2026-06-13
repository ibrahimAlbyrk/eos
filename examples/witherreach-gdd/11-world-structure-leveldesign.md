# 11. World Structure, Biomes & Level Design

> **Scope.** This section turns the fiction of §2 (Setting, World & Lore) into *playable space*: the concentric-basin layout, the five-state decay spectrum as a level-design grammar, the six regions as built environments, the design of **Reliquaries**, the principles of exploration and navigation in the gloom, how the **Long Dusk** encroachment physically reshapes the map over **Tides**, and the **Greater Hearth** reclaim loop expressed spatially. It owns *space and blockout intent*. It does **not** own: the Taint/Hollowing/Blight economy (§5), survival rates and the decay clock's numbers (§6), Hearth/base-building rules (§7), the ascension trees (§8), combat (§9), or the Wake bestiary and Warden encounter stats (§10) — those are referenced, never re-specified. The world's *meaning* (what each region tells) is fixed in §2.4; this section builds the rooms that story happens in. Glossary terms (concept bible §14) are used verbatim. All illustrative numbers are marked **(illustrative — to tune)**.

---

## 11.1 Spatial thesis — the basin, the descent, the rising tide

The **Witherreach** is a single **concentric basin** — a great caldera-valley with the drowned capital at its lowest, central point, where the sun guttered into the earth (§2.4). Three locked spatial truths follow, and every level-design decision serves them:

1. **Decay radiates from the centre.** The **Blight** bleeds outward from the **Hollow Crown** at the basin floor. Decay is **worst at the heart, thinnest at the rim**. A player can read their depth — how far from the heart, how deep into the truth — purely from the decay state of the ground under their feet (§11.2).
2. **Progress is inward *and* downward.** The player starts at the rim (R1) and pushes toward the centre (R6). Descent is literal elevation loss *and* thematic descent — into death, into the past, into the truth. **Every region transition trends downhill**; the silhouette of the world is a funnel, and the camera should always be able to find the centre by looking *down-valley*.
3. **The map is a tide, not a conquest.** The **Long Dusk** rises up the basin walls over time (§2.5, §6). Held ground is impermanent: a region you cleared at one decay state will, untended, sink back. The player is never finally finished with a region — they are holding a line against water.

This is the spatial expression of design pillars 2 (*The World Is Already Dying*) and 4 (*Earn the Light*). The world is not a sandbox to conquer; it is a basin filling with rot, and the player's whole campaign is a fighting descent toward the drain.

---

## 11.2 The decay-state spectrum as a level-design grammar

The five **decay states** (§2.4.1) are the single most important level-design tool in the game. They are a *readable spectrum* the player learns to read at a glance, and they govern geometry, lighting, fog, props, traversal, audio, and encounter density together. They are the world-facing, art-and-design gradient; mechanically they map onto the three-tier zone decay used by the survival economy (fringe / decayed / blighted-core — §6), so a designer authoring a space picks a decay state and inherits both a look and a difficulty tier.

| Decay state | Maps to (§6 zone tier) | What the *space* becomes | Navigation & traversal | Encounter density (drives §10) |
|---|---|---|---|---|
| **Lingering** | Fringe | Recognizable architecture and roads; the walking dead still wear who they were; twilight, not full dark. Space reads like a *place that was a place*. | Open, legible, real sightlines. Wayfinding by intact landmarks. | Sparse, slow Husks; the tutorial-safe density. |
| **Festering** | Fringe → Decayed | Blight pools in low ground; corpses fused to the earth; rot has texture and smell. Paths begin to be *blocked* by rot-growth. | First detours around Blight pools and fused debris; light radius starts to matter. | Skirmishers appear; first afflicters at the edges. |
| **Withering** | Decayed | Architecture and flesh **merge**; human shapes are going; walls become ribcages, doors become mouths. Space loses legibility — you navigate a thing that *was* built. | Disorienting; landmarks corrupt; the dark thickens; vertical collapse opens new routes and closes old ones. | Brutes anchor; the Gravemade; hunter dispatch becomes likely. |
| **Blooming** | Decayed → Blighted core | Rot-coral, Blight-blooms, barely-human forms; **the most beautiful and the most lethal** (the *Annihilation* Shimmer register — §2.8). Gorgeous, alien, glowing. | The richest Blight nodes sit here, in the darkest, highest-decay pockets — risk and reward are the same geometry. | Near-max density; Famished hunters; the Communed and their works. |
| **Terminal** | Blighted core | Not architecture anymore — a single rot-organism. The heart. The city *is* a body. | There is no "navigation" so much as *passage through an interior*; the ground breathes. | The apex — the endgame's authored encounters, not ambient tide. |

**Three rules of the grammar:**

- **A region is authored as a *range* of decay states, not one.** The decay deepens as the player pushes from a region's rim-side edge toward its heart-side edge — so even within R1 there is a Lingering outer band and a Festering inner band. The whole basin is a continuous gradient; region boundaries are *narrative* chapters cut into one physical slope.
- **Decay state is the difficulty telegraph.** Because decay state maps to the survival zone tier (§6) and feeds the Wake's Threat Level (§10), the player reads danger from the environment art alone — *before* a single enemy appears. Pushing into a Blooming pocket is a visible, informed risk. This is the corruption economy's risk/reward rendered as level geometry (§10.9 in the combat brief).
- **Decay state is *mutable* per region** (§11.6, §11.7). The same physical space can be Festering today and Withering after a Tide, or rolled back to Lingering by a Greater Hearth. The geometry is authored once; the decay state is a scalar that re-dresses it. This is a hard constraint inherited from the technical decision that decay is a **state machine over authored geometry, not voxel terrain** (§16) — designers may **not** promise terrain deformation; they reshape space with material, fog, lighting, prop-swaps, blocking volumes, and navmesh, all driven by the region's decay scalar.

---

## 11.3 The six regions

The structure is **locked at six concentric rings**, with **five progression Wardens (R1–R5)** gating the five ascension tiers (§8), and **R6 as the endgame** (the Famished King → the Hollow Crown), which sits outside the five-tier gate (§2.4.2). The narrative meaning of each region is fixed in §2.4.2 and is not re-litigated here; below is the **level-design** treatment — biome identity, the decay states it spans, blockout intent, its hub/landmark, its Warden arena, and its Reliquary.

### 11.3.1 Region summary

| Ring | Region | Decay span | Hub / key landmark | Warden (§10) | Reliquary | Spatial signature |
|---|---|---|---|---|---|---|
| **R1** | **The Gloaming Marches** | Lingering | **Ashfast** (home Hearth-hold) | The Mire-Stag *(beast)* | A fallen border-shrine | Open cold heath & mist-fens; the legible tutorial bowl. |
| **R2** | **The Cinderwood** | Lingering → Festering | The Wardens' cremation-grounds | The Cinder-Alpha *(beast)* | The **Pyre-cairns** | Vertical burning forest; ash-fall and ember-light. |
| **R3** | **The Mourning Marsh** | Festering | The reed-choir flats | The Drowned Choir *(Choir remnant)* | A sunken Communion-chapel | Black-water labyrinth; the floor is water and rot. |
| **R4** | **The Hollowing Wastes** | Withering → Blooming | The **Black Hearth** (Communed seat) | The Communed champion | A Communed ascension-vault | The Shimmer expanse; beauty-grotesque, disorienting. |
| **R5** | **The Cathedral of Ash** | Blooming *(near-Crown)* | The cathedral nave | The Ashen Penitent *(named)* | The cathedral itself | Bone-white ash-desert; still, blanched, holy-and-wrong. |
| **R6** | **The Hollow Court** | Terminal | The Sunhold throne-floor | The Famished King → the Hollow Crown | — *(this is the endgame)* | The buried-sun caldera; the city is one body. |

### 11.3.2 R1 — The Gloaming Marches *(Lingering)*

The **frontier of hope** and the game's teaching ground. A cold heath of mist-fens, dead heather, and broken farmsteads under a low twilight that is *not* full dark — the only region where the player can routinely see without the deathlight, so they learn the world before they learn the dark. Blockout is an **open, legible bowl**: long sightlines, intact roads, the silhouette of **Ashfast** (the home Hearth-hold and first hub) visible from much of the region as a fixed wayfinding anchor, and the basin's down-valley pull always readable on the horizon. The Festering inner edge introduces the first Blight pools and the first detours. The Warden, **the Mire-Stag**, lives in a flooded fen-arena and teaches the meta-loop (kill → kindle → roll back). The Reliquary is a **fallen border-shrine** — the introductory delve that seeds the first relic-fragments of the mystery. *Teaching goals: light radius, clean-vs-blighted nodes, reading decay state, the Hearth loop.*

### 11.3.3 R2 — The Cinderwood *(Lingering → Festering)*

The **human response to the Witherfall**: a vast dead, slow-burning forest that is also the Ashen Wardens' sacred cremation-grounds. This is the region of **funereal grandeur** — charcoal cathedrals of trees, ash falling like snow, embers glowing in the dark like a field of small graves. Blockout introduces **verticality**: the forest is layered (canopy walkways, root-hollows, ravines), so traversal becomes three-dimensional and the deathlight's radius matters more (ember-glow gives false comfort but does not suppress Taint — only true light does, §6). Ash-fall is a recurring weather surge that cuts light radius and raises Taint-rate (§6), so the Cinderwood teaches **weather as a spatial pressure**. The Warden, **the Cinder-Alpha**, gates the sacred ash-grounds. The Reliquary, **the Pyre-cairns**, is a Warded burial-vault carrying the founding lore and Lightcraft rewards.

### 11.3.4 R3 — The Mourning Marsh *(Festering)*

The **rite itself, heard before it is understood.** A rot-flooded lowland where the **floor is water** — black, Blight-pooled, sound-carrying water — and the architecture is sunken hamlets and reed-choirs that still faintly carry the Communion's song (the Choir-Echo, §15). Blockout is a **labyrinth of black water and causeways**: navigation is governed by what is wadeable vs drowning-deep, and the Blight pools *in the water itself*, so the player is wading through the Taint supply. This is where the **dark's breath and the Choir-Echo** first become navigational instruments (§11.5) — you hear the rite getting louder as you near its machinery. The Warden, **the Drowned Choir**, floods its arena with rot. The Reliquary is a **sunken Communion-chapel** holding the Fragment of the Song — the single most important mystery delve in the mid-game.

### 11.3.5 R4 — The Hollowing Wastes *(Withering → Blooming)*

The **alternative made physical** — the Communed heartland, and the game's beauty-in-decay at its most seductive and most lethal. A mutated beauty-grotesque expanse of rot-coral, Blight-blooms, and fused flesh-and-stone (the **Shimmer** peak, §2.8, §15). Blockout deliberately **breaks legibility**: landmarks mutate, the ground undulates, and the iridescent soul-glow is bright enough to navigate by but bright in *all the wrong directions* — the region is designed to disorient, so the player must lean on the deathlight and held landmarks rather than the gorgeous, lying glow of the rot. The Communed settlement clusters around a **Black Hearth** (their anti-Hearth — §7) and the Hollow Heir's seat, the one inhabited place this deep. The Warden is the **Communed champion** — the tragic mirror of what the player could become. The Reliquary is a **Communed ascension-vault** (Tainted rewards, the "unfinished rite" gospel).

### 11.3.6 R5 — The Cathedral of Ash *(Blooming, near-Crown)*

The **cost and limit of mercy.** A ruined cathedral-complex set in a bone-white ash-desert — eerily still, blanched, holy-and-wrong. Empty of the living: only the corrupted **First Warden** (the Ashen Penitent) and her failed pilgrimage's dead remain. Blockout is a **monumental, vertical interior** — a single great structure the player ascends and descends through (nave, crypts, bell-towers, ossuaries), in deliberate contrast to the open earlier regions; the space is claustrophobic and reverent, a held breath. The ash-desert approach is a near-featureless white plain that makes the cathedral's silhouette the only landmark for a long, dread-building traverse. The cathedral **is** the Reliquary — the End-it keystone, where the player learns a living human could not be the door. The Warden, **the Ashen Penitent**, has a clean/light-only core (§10).

### 11.3.7 R6 — The Hollow Court / the Sunhold *(Terminal)*

The **origin and the end.** The drowned capital at the basin floor, where the sun guttered into the earth — fused into a single rot-organism around the **Hollow Crown**. This is not navigated like a place but **passed through like an interior of a living thing**: the city *is* a body, the streets are vessels, and a sick parody of dawnlight leaks *upward from below the ground* (a false sunrise from a grave — §15). Blockout is the **bottom of the funnel** — every prior descent has pointed here. There is no ambient-tide pacing; R6 is an authored endgame sequence: the approach, the **Famished King** (penultimate gate), and the **Hollow Crown** (the final encounter and the three-ending choice, §3.4). R6 has no Reliquary because the whole region is the final Reliquary.

---

## 11.4 Reliquaries — landmark dungeon design

A **Reliquary** is a landmark dungeon in the wilds: a self-contained delve that holds **one concentrated dose of the central mystery** *and* **one build-defining reward**, with risk scaling to its depth and decay state. Reliquaries are the optional-but-rewarding spine of exploration — the reason to leave the critical path — and each is authored to the §2 environmental-storytelling patterns (the Tableau of the Last Moment, the Hearth-Scar, the Blight-Halo).

### 11.4.1 The Reliquary contract (every Reliquary delivers all four)

1. **A mystery payload.** Exactly one piece of the cosmology (§2.2), delivered diegetically — relic-fragments, a frozen tableau, a Choir-Echo, a journal. Never an exposition dump; a Reliquary *shows*, the player assembles (§2.8).
2. **A build-defining reward.** One catalyst, weapon, tempered-gear schematic, or ascension catalyst worth the risk (effects owned by §7/§8). The reward is **legible from the entrance** as a goal — the player can see the prize they are descending toward.
3. **A risk gradient that matches the basin.** A Reliquary's interior is its own miniature decay slope: it deepens in decay state from threshold to core, so the delve *is* a compressed descent (the macro structure in microcosm). The deeper room is the more-decayed, higher-Threat-Level room (§10), and the reward sits at the deepest, hottest point.
4. **A return problem.** Like the basin itself, a Reliquary is a **round trip** under the Expedition clock (§4, §12): the player must carry their accumulated Taint, depleting light, and (often) a fragile objective *back out*. Souls-style **loop-back shortcuts** (a deep door that opens back toward the entrance) are the standard structural device — they reward reaching the core by collapsing the return, and they re-connect the Reliquary to the Hearth network (§11.8).

### 11.4.2 Reliquary archetypes

To keep the ~one-per-region set distinct (and to give the team reusable kits), Reliquaries come in three structural archetypes:

| Archetype | Structure | Example | Design intent |
|---|---|---|---|
| **The Vault** | A descending spiral or shaft — one deepening route to a single core chamber. | R4 Communed ascension-vault | The purest "compressed descent"; teaches the basin's shape in 20 minutes. |
| **The Warren** | A branching, looping network with multiple cores and a central shortcut hub. | R1 border-shrine; R3 sunken chapel | Exploration and choice; the Hearth-Scar and Tableau patterns thrive here. |
| **The Ascent** | An *upward* climb (a tower, a cathedral) inverting the descent — the reward is at the top, the dread is the height. | R5 Cathedral of Ash *(region-scale)* | A deliberate change of rhythm; verticality as the threat. |

### 11.4.3 Reliquaries and the clock

A Reliquary's decay state advances with the **Tides** like any unheld ground (§11.6) — a Reliquary cleared early at Festering may be Withering on a return visit, with a denser Wake and a harder return. This makes the *timing* of a delve a strategic choice, not just its existence, and keeps optional content alive across a playthrough rather than checkbox-dead.

---

## 11.5 Exploration & navigation in the gloom

The core navigation constraint of WITHERREACH is the **finite light radius** (§6): the player can only reliably see, and only suppress Taint, inside their carried light. Therefore **the dark is the real fog-of-war** — not a UI overlay, but the literal unlit world. Every navigation system is built around this.

**Locked navigation principles:**

- **Landmark wayfinding, not minimap omniscience.** There is no top-down satellite minimap. The player navigates by *silhouettes against the dark* — the down-valley pull of the basin, a Hearth's gold pool, a Greater Hearth's false dawn, a Warden's glowing core, a Reliquary's distant landmark. Level design is responsible for placing **readable, decay-aware landmarks** that survive (or visibly corrupt with) the region's decay state. The map/compass UI that supports this is specified in §14.8 (a diegetic hand-map that fills in only what the player has lit and seen; a deathlight-needle compass).
- **The deathlight is a navigation budget.** Because light is finite and fueled (§6), *how far you can see* and *how far you can safely go* are the same resource. Pushing past your light into the dark to reach a node is the moment-to-moment risk of exploration; the dark spikes Taint-rate ×5 (§6) and unmasks the Wake's corruption-scent (§10). Designers place reward against this: **the richest Blight nodes sit in the darkest, highest-decay pockets** — you trade light, safety, and Taint for power.
- **Audio is a navigation instrument.** The **dark's breath** (the web straining, with whispers) intensifies with darkness and with the player's Taint, and the **Choir-Echo** (the Communion's song) grows louder toward the Crown and near Choristers (§15). Both are *directional, diegetic cues*: the player learns to navigate by sound — toward or away from the breathing dark, toward the rising song to find a Reliquary's core. This is the audio environmental-storytelling of §3.6 made into a wayfinding system.
- **Verticality means descent.** Traversal trends downhill across the campaign and within most Reliquaries (§11.4). Climbing is the exception (R5, the Ascent archetype) and is used deliberately for tonal contrast. The player should always be able to *feel* which way is deeper.
- **Reclaimed ground is the safe network.** Lit Hearths and rolled-back regions form a shrinking-and-growing **safe graph** the player traverses between (§11.8); exploration is the act of pushing the frontier of that graph outward into the dark, knowing the tide pushes it back (§11.6).

---

## 11.6 The Long Dusk encroachment — the map as a tide

The **Long Dusk** is the map's antagonist on a clock (§2.5, §6). Spatially, it expresses as **encroachment**: unheld ground sinks one decay state deeper each **Tide** (§6), and the Blight rises up the basin walls toward the rim. This is the spatial face of design pillar 2 — *standing still loses ground.*

**How encroachment reshapes space (all driven by the region decay scalar — §16):**

- **The decay state advances.** A Lingering fringe becomes Festering; a Festering marsh becomes Withering. The *same geometry* re-dresses: material parameters rot, fog thickens and lowers visibility, lighting drops colder and dimmer, **prop sets swap** (clean props out, rot-growth in), and **navmesh changes** — new Blight pools and rot-growth block old paths, while collapse opens new ones. A route that was open at one Tide may be drowned at the next.
- **Encounter density rises.** Because decay state feeds the Wake's Threat Level (§10), an encroached region is denser and tougher without re-authoring a single spawn — the zone is a budget the player's Taint and the Tide spend up (§10.9 in the combat brief).
- **The rim drowns over a playthrough.** The Tide rises up the basin walls, so the early regions the player "finished" are visibly worse on a late return: Ashfast's Lingering Marches, untended, slide toward Festering and beyond. The world the player leaves behind is sinking behind them as they descend — a constant, legible reminder that the clock has teeth and that reclaiming is not winning (USP #2).
- **The encroachment front is a place.** Where held ground meets rising rot, there is a **visible front** — a line of advancing fog and rot-growth, the literal edge of the tide. This front is an authored, dynamic location: defense side-quests (the Encroachment / the Tended Flame patterns, §3.5) happen *here*, and the player can watch the line move. The front is where "the world is already dying" stops being a stat and becomes a horizon.

The macro cadence, multipliers, and the active-playtime clock anchoring are owned by §6 (and the technical anchoring by §16); this section owns only how that clock *looks and plays as space*.

---

## 11.7 The Greater Hearth reclaim spatial loop

The counter-force to encroachment is the **Greater Hearth**. This is the spatial expression of pillar 4 (*Earn the Light*) and the macro half of the core loop (§4): the player pushes the dark back **hearth by hearth**, and the reclaimed map is real but **impermanent**.

**The loop, as space:**

1. **Push the frontier.** The player drives an Expedition out of the safe graph (§11.8), through deepening decay, toward a region's **Warden** — the apex corruption gating that region (§10).
2. **Kill the Warden → kindle the Greater Hearth.** Defeating the Warden kindles a **Greater Hearth** at a region-scale node (mechanics §7). This is the payoff beat — and it is staged as a **visible reclaim wave**: a small false dawn spreads from the new Greater Hearth across the region.
3. **The region rolls back one decay state and pins it.** The Greater Hearth's radius rolls the local decay **back one step** and **pins it there while fueled** (§6). Spatially, the reclaim wave is authored as the canon describes (§15, confirmed with tech): **the cheap channels cross-fade** — a wave of pale-gold light, clearing fog, and material *healing* sweeps the region in real time (a single decay-blend scalar lerping fog, light color/intensity, exposure, and material params) — while **the prop and spawn changes hard-swap behind the advancing light front, out of the player's direct view**, with only a few hero-props near the player dither-fading during the blend window. The reclaim reads as *the light physically pushing the dark back, with the world resolving in its wake.* It is the single most cathartic environmental beat in the game and the literal inverse of the encroachment front (§11.6).
4. **Maintain it, or lose it.** A Greater Hearth costs ongoing fuel (§7). Let its fuel lapse or let it fall, and it goes dark — the pinned decay un-pins and the held rot **floods back** (the reclaim wave runs in reverse). Maintenance competes with the player's other clean-resource needs (purge, the Cleansing rite — §5/§6), so holding the map is a standing cost, never a completed checkbox.

**Spatial consequences for level design:**

- A Greater Hearth **reshapes its region's playability**: rolled-back decay means lower Threat Level (§10), reopened navmesh (rot-growth recedes, paths clear), restored landmarks, and a new safe node on the graph. Reclaiming is *legibly* worth it — the space becomes easier to live in.
- The Greater Hearth also **hosts the Cleansing rite** (the only Hollowing reducer, §5) and **unlocks the next ascension tier** (§8), so its location is a permanent destination, not a one-time objective. Designers place it as a region's new gravitational centre.
- Because both encroachment (§11.6) and reclaim run on the *same* decay scalar in *opposite directions*, the map is a genuine **tug-of-war over authored geometry** — the central spatial fantasy, delivered without voxel terrain (§16).

---

## 11.8 Level-design authoring principles

Binding guidance for anyone building WITHERREACH space:

- **Author with Threat-Level budgets, not fixed spawn placements.** A zone is a budget the player's Taint band and the current Tide spend up (§10.9 in the combat brief). Hand-place set-pieces (Wardens, Reliquary cores, scripted tableaux); let the ambient Wake tide be authored as density budgets keyed to decay state, so a space scales with the player's corruption and the clock without re-authoring.
- **The Hearth network is the spatial spine.** The map is a graph of safe nodes (Hearths, Greater Hearths) connected by dangerous edges (the dark wilds). Design every region so the player's mental model is "how far is the next light." Souls-style loop-back shortcuts (§11.4) re-stitch the frontier to the spine so a hard push out always shortens into a fast way home.
- **Decay-state-author once, dress N times.** Because decay is a scalar over authored geometry (§16), build a space at its *base* legible form and author the decay-state dressings (material/fog/light/prop/navmesh sets) as data on the same blockout. Never design a route that *only* exists at one decay state unless the navmesh change is intentional and reversible.
- **Pace tension as oscillation, with a built-in "keep moving."** Quiet traversal → ambush → respite, but lingering steadily worsens Threat Level (Taint accrual + local alert build, §10) — so the level itself pressures the player onward. Risk-reward is spatial: the prize is always deeper, darker, hotter.
- **Make depth and danger redundant.** Decay state, fog density, light scarcity, audio (the breath, the song), and Wake density should all rise together toward the heart, so the player reads danger from many channels at once and never *only* from an enemy already on top of them.
- **Respect the respawn resolver.** A player respawns at their last lit Hearth; if that Hearth's region has gone dark to the Long Dusk, the resolver falls back to the nearest lit/Greater Hearth (§16). Design Hearth placement and region adjacency so this fallback is never a soft-lock or a punishing teleport across the whole basin.

---

## 11.9 Open Questions

- **Region count vs the five-tier gate.** The structure is locked at six regions / five progression Wardens (R1–R5) + endgame R6 (§2.4.2). The basin's continuous-gradient design (§11.2) scales cleanly to five regions if production scope demands a cut (the natural candidates are R2 or R4, per the narrative brief's own note) — flagged for production/scope (§18), not decided here.
- **Hearth raid/defense as authored space.** The survival brief leaves Hearth raid/defense vs the Wake unlocked (§6); if authored, the encroachment front (§11.6) is its natural spatial home and its trigger should ride the Threat-Level model (§10). Routed to §6/§10 and production for a go/no-go.
- **Reliquary count per region.** This section assumes ~one signature Reliquary per region (plus R5/R6 being region-scale Reliquaries). Whether secondary minor Reliquaries populate each region is a content-scope decision for §18.
