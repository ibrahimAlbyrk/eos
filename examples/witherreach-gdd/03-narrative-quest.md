# 3. Narrative & Quest Design

> **Scope.** This section is the implementable narrative spec: the design principles, the main-quest arc across three acts and five progression Wardens (plus the Crown), the three expanded endings, the key NPC roster, the repeatable side-quest patterns, the environmental-storytelling system, and a content budget. It builds directly on the cosmology and factions in §2 — read §2 first. Mechanics referenced here are owned elsewhere: the corruption economy in §5, survival/the Long Dusk clock in §6, Hearths in §7, the Warded/Tainted trees and ascension tiers in §8, combat/rot-magic/Lightcraft in §9, the Wake bestiary and Wardens in §10, regional spatial/level design and Reliquaries in §11, death/corpse-runs/turning in §12, co-op in §13. Glossary terms (concept bible §14) are used verbatim.

---

## 3.1 Narrative Design Principles

These are binding rules for every quest, line, and beat. They keep the story in lockstep with the pillars (concept bible §3) so the fiction *is* the systems, not a coat of paint over them.

1. **The player's relationship to the rot is the real arc.** The named plot is the spine; the *felt* story is the player watching themselves change. Build, Taint-floor, and Hollowing (§5, §8, §12) are characterization — the strongest characterization tools we have. Quests **react to the player's drift**, not the reverse.
2. **Show, never dump.** The cosmology (§2.2) is assembled from places, relics, and people across a whole playthrough (§3.6). No exposition NPC recites the mystery; the player earns it. The one exception is the Crown itself, where the truth is finally *spoken* — earned by the entire descent.
3. **The clock has teeth.** Quests can be **failed** by time and neglect (settlements fall, Hearths go dark, NPCs turn). Failure loses ground and people, not the story (pillar 5, "Die Forward"). At least the time-pressure side-quest templates (§3.5) must have real failure states.
4. **Grimdark, not nihilistic; the Wake is grief.** Every antagonist, including the ambient Wake and the god-king, is a *trapped person* (§2.8). Dread carries pity. The villain of WITHERREACH is a locked door, not a malevolence.
5. **Every meaningful quest is a referendum on bank-vs-purge / Warded-vs-Tainted.** Side content reinforces the keystone choice (concept bible §8): mercy costs scarce clean resources (and foreshadows the Pyre); power costs humanity (and foreshadows the Crown). No "filler" fetch quests that don't touch the economy.
6. **Diegetic delivery, minimal cinematics.** Favour in-world text, environmental tableaux, NPC dialogue at Hearths, and the Choir-Echo audio layer (§2.6.3, §15) over cutscenes. Reserve full cinematic weight for the three set-pieces that earn it: the Waking (opening), the Tide turns (Act II climax), and the Hollow Crown (the choice).

---

## 3.2 The Main Quest Arc

The arc is a literal and thematic **inward/downward spiral**: from the basin rim (least decayed, where hope clings) toward the sunken capital at the heart (Terminal decay, where the choice waits). Descent = into death, into the past, into the truth (§2.4).

**Structure (locked).** Six regions (§2.4.2). **Five progression Wardens, R1–R5**, each kill kindling a Greater Hearth and **unlocking one of the five ascension tiers (§8)** — this is the "5" the systems sections gate on, mapping 1:1 to the five tiers. **R6 (the Hollow Court) is the endgame, outside the five-tier gate**: the **Famished King** is a final-approach gauntlet boss, and the **Hollow Crown** is the ending encounter (the three-choice), not a progression Warden. The Long Dusk **Tides (§6)** pace the acts — the five ascension beats plus the final descent give ~6 escalation beats, satisfying survival's ~5–6 Tide cadence.

### 3.2.1 Act → Beat Map

| Act | Beat | Region / event | Warden (§10) | Ascension tier unlocked (§8) | Mystery revealed (§2.2) |
|---|---|---|---|---|---|
| **I — The Waking** | 1. **Unburied** | R1 rim — the Lamplighter finds the player's body | — | — | "You are a Revenant; lie down and you will *turn*." (the personal stake) |
| | 2. **Ashfast** | R1 hub — meet Hearthmother Vesna & the Wardens | — | — | A Tide is deepening; Hearths are falling; the Wardens need someone who can walk *deep* into the rot. |
| | 3. **First Light** | R1 — kindle the first Greater Hearth | **The Mire-Stag** | **Tier I** | Relics begin hinting at the Crown and at what the player is. |
| **II — The Descent** | 4. **The Other Offer** | R2 — the Communed make contact | **The Cinder-Alpha** | **Tier II** | The faction triangle activates; both poles react to the player's build/floor. |
| | 5. **The Rite Revealed** | R3 — the Pale Cantor & the First Warden's relics | **The Drowned Choir** *(yields the Fragment of the Song)* | **Tier III** | The Communion was a soul-binding anchored to the king that *locked* when he died; the sun was the severed door. *Why* the world won't die. |
| | 6. **The Seductive Heartland** | R4 — the Communed Marches, beauty-in-decay at its most seductive | **The Communed champion** *(tragic mirror)* | **Tier IV** | What the player could become, made physical. The "unfinished rite" gospel. |
| | 7. **The Tide Turns** *(Act II climax — set-piece)* | Scripted Long-Dusk escalation: the world visibly worsens, Hearths fall, the Famished hunt hardens | — | — | The binding is *degrading* (the Thinning) — which is why threshold-souls wake now and why the Crown can at last be reached. Decision pressure spikes. |
| **III — The Crown** | 8. **The Failed Mercy** | R5 — the Cathedral of Ash | **The Ashen Penitent** *(First Warden)* | **Tier V** | A living human could not be the door; **only a Revenant can.** The player now knows they are the key. |
| | 9. **The Approach** | R6 — descend into the Hollow Court; both factions converge | **The Famished King** *(gauntlet gate)* | — | The Crowned Circle each chose a fate (rule / feed / atone); the king chose none, becoming the hollow anchor. The Hollow Heir reveals her true aim. |
| | 10. **The Hollow Crown** *(set-piece — the choice)* | R6 — the throne | **The Hollow Crown** *(Sovereign Vael)* | — | The final truth, spoken in the Choir's massed voice; the binding lays the three choices (§3.4). |
| | 11. **Epilogue** | Per ending | — | — | World-state persists across sessions (concept bible §11; §13/§16). |

### 3.2.2 Act Beats (prose)

**ACT I — THE WAKING** *(the rim; establish the loop and the stakes).* The Revenant wakes at the blighted rim of R1. The **Lamplighter** finds the player's unburied body, names what they are, gives them a Hearth, and tells them the truth they cannot outrun: *lie down and you will turn.* This is the tutorial of the corruption economy (blighted food → Taint; purge at the Hearth; light suppresses the rot — §5, §6). The player reaches **Ashfast** (the first Hearth-hold), meets **Hearthmother Vesna** and the Wardens, and learns the crisis: a Tide is deepening, Hearths are falling, and the Wardens need someone who can walk *deep* into the rot — a Revenant — to kindle Greater Hearths. Defeating the first Warden (**the Mire-Stag**) kindles the first Greater Hearth and rolls back local decay; the player feels the first taste of pushing the dark back, and the first relic-fragments begin hinting at the Crown.

**ACT II — THE DESCENT** *(inward; the factions pull; identity hardens; the mystery opens).* The **Communed** make contact (the Hollow Heir or her emissaries) with the *opposite* answer: don't resist — master. By now the player has felt the seduction of banking Taint, and their build/floor is visibly committing them; **the faction triangle activates**, and both poles react to the player's drift. Through the **Pale Cantor** and the First Warden's relics, the player learns the Communion was a soul-binding anchored to the king that *locked* when he died, and that the sun was the severed door — beginning to grasp *why the world won't die* and to suspect *what they are*. The deeper Wardens — the **Drowned Choir** (the rite's machinery; yields the **Fragment of the Song**) and the Communed heartland's **champion** (beauty-in-decay at its most seductive) — are each a deeper decay state and one chapter of the world's story. The act climaxes with **the Tide turns**: a scripted Long-Dusk escalation where the world visibly worsens, Hearths fall, and the Famished hunt hardens — and the player learns the binding is *degrading* (the Thinning), which is why threshold-souls wake now and why the Crown can at last be reached.

**ACT III — THE CROWN** *(the heart; the choice).* At the **Cathedral of Ash** (R5), the corrupted **Ashen Penitent / First Warden** delivers the keystone truth through her tragedy: a living human cannot be the door — only a Revenant can. The player now knows they are the key. The descent into the sunken capital (R6) brings both factions converging: the Wardens urge **End it**; the Hollow Heir reveals her true aim (use the player as the key, or take the anchor herself). The **Famished King** bars the throne and reveals the Crowned Circle's choices. At the throne, **Sovereign Vael** speaks in the Choir's massed voice, gives the mystery's last truth, and the binding lays the **three choices** (§3.4). The epilogue plays per ending; world-state persists across sessions.

---

## 3.3 Key NPC Roster

Names are final canon (§2). For each NPC: their function and arc are load-bearing; their **fate is variable** by player choices and by the clock (an NPC can be lost to a failed quest or to the player's own drift). Faces should read against the player's current Hollowing stage (§2.2.5) — living NPCs recoil as the player Sours and is Pulled.

| NPC | Allegiance / role | Arc function | Fate variability |
|---|---|---|---|
| **The Lamplighter** | Ashen Warden — opening mentor & conscience | Finds the player, names what they are, voices the moral anchor of the game. Carries a salvaged lamp (a deathlight relic). Grieving, kind, clear-eyed. | Survives into mid-game; his fate varies by player choices (can be lost if the player drifts hard Tainted or fails to hold key Hearths). |
| **Hearthmother Vesna** | Ashen Warden — leader of Ashfast (R1); primary **Warded** quest-giver | Holds the **Hearth-keeper** line while the **Pyre-tenders** push to end the world; the political face of the End-it path's internal fracture (§2.6.1). | Her hold (Ashfast) can fall to encroachment if the player neglects R1 across Tides. |
| **Wren** | Ashen Warden — a young Warden the player can mentor | Embodies hope and the Warded ideal; a recurring questline and co-op-flavour companion. **Her survival is a barometer of the Warded path.** | Can live, fall in the field, or — tragically — turn if exposed to too much rot under the player's lead. |
| **The First Warden / the Ashen Penitent** | Ashen Wardens' legendary founder (a repentant Crowned-Circle officiant) — now the corrupted cathedral-Warden (R5) | Walked to the Crown generations ago to end the world and **failed**, becoming a corrupted set-piece boss. Her failure teaches the End-it line's central lesson: **only a Revenant can be the door.** | Fixed (she is a Warden); met first through relics/echoes, then fought (§10). |
| **The Hollow Heir, Lysandra Vael** | The Communed — lucid prophet; primary **Tainted** quest-giver | Claims soul-descent from the Ever-King through the web. Carries more Taint than anyone living and keeps her mind — proof of concept for her own gospel. Seductive, serene, genuinely caring in a way more unsettling than cruelty. Her true aim (crown the player as her instrument, or take the anchor herself) is the Tainted line's central reveal. | Survives to the Crown; in the **Master-it refuse-variant** she seats *her own* soul as the new anchor (§3.4.2). |
| **Coll** | The Communed — a pilgrim, met early as a hopeful believer | The soft-permadeath dread made personal: he visibly slides through the Hollowing stages (§2.2.5) over the game until he **turns**. The likely subject of the **Turned Acquaintance** side-quest (§3.5). | Turns over the course of the game (pace can vary); the player may be forced to put him down — or, rarely, find a way to save him. |
| **The Pale Cantor** | Former Choir-singer — between both factions | Took deep Taint but **did not fully turn** — half Chorister, half man, still partly lucid. He **remembers how the Communion was sung**, and therefore how it might be *unsung* (End-it) or *re-sung with a new anchor* (Master-it). The single most important lore NPC. | Can be ally, betrayer, or casualty depending on player choices — a fragile, ambiguous bridge. |
| **The Famished King** | Crowned Circle — the king's closest, who chose to *feed* | Now an eternal hunger-thing gating the Hollow Crown (penultimate Warden, R6). His existence reveals that each of the Circle chose a fate — and the king chose none. **Feeds on the player's Taint in combat** (§10). | Fixed (he is the gauntlet gate). |
| **Sovereign Vael / the Hollow Crown** | The dead god-king — the anchor of the web | Not a conversational NPC until the end, where he speaks in the Choir's massed voice, delivers the mystery's final truth, and the binding lays the three choices. | The ending encounter (§3.4); outcome is the player's choice. |

---

## 3.4 The Three Endings (expanded)

The endings **frame is LOCKED** (concept bible §9): **End it / Master it / Be consumed**. Each is a thing a fragment-of-the-door (the player's threshold-soul + deathlight, §2.2.5) can do at the anchor, and each aligns with a path and the player's accumulated Taint/Hollowing (§5, §8). The fiction below is canon.

**How the choice is offered & gated.** At the throne (beat 10), the binding lays all three before the player as *capabilities of what they are*, not as a menu the world endorses. **End it** and **Master it** are deliberate selections; **Be consumed** is reachable both *there* (fail or surrender the final trial) and *anywhere* in normal play (max Hollowing — the LOCKED soft-permadeath, §12). Systems-eligibility nudges but does not hard-lock the choice (illustrative): a low-Hollowing/Warded player gets the cleanest End-it; a deep-Tainted player is the only one who can *hold* Master-it; a player at the Brink risks Be-consumed regardless of intent. Exact gating thresholds are owned by §5/§12.

### 3.4.1 End it — the Pyre *(Warded-favoured; the merciful ending)*

The player ascends the Crown not to take it but to **unmake the anchor**: they offer their own threshold-soul as the reopened door. The deathlight they carry flares into a true sunrise-for-one-instant; the king's binding releases; **every trapped soul — the Wake, the Communed, the dead of the Reach, and the player — passes through at last.** The Long Dusk ends because the world finally, properly *dies*. The sun does not return; it simply *sets*, the way it should have generations ago.

*Epilogue:* ash, silence, a dawn that is also an ending — bittersweet, the most human. **Co-op:** all players pass together; the world they leave is at peace because it is empty (co-op canon — unanimity vs leader's choice — flagged §3.8).

*Systems tie (§5/§8/§12).* Cleanest for **low-Hollowing / Warded** players — the player must be "human enough" to be a clean door. Deep-Tainted players may face a harder trial or a corrupted variant. This is the payoff of holding the line: keeping the floor low and the Hollowing checked the whole game *buys* the merciful ending.

### 3.4.2 Master it — the Crown *(Tainted-favoured; the power ending)*

The player casts down the dead Sovereign and seats **their own soul as the new anchor**. The binding re-stabilizes around them — a living anchor at last. The world stops sliding toward collapse but does **not** heal: it remains the Long Dusk, now *theirs*. The Wake answer to them; the Blight is their dominion; they are the new **Hollow Crown** — immortal, sovereign, alone, having become the very thing that began this.

*Epilogue:* the player sits the throne, the rot stills around them, the Reach has a god-king again. Power at the price of becoming the eternal prison-warden of the dead — and the seed of a next cycle (one day even they may fail, and then…).

**The refuse-variant (canonical epilogue variant — NOT a fourth ending).** If the player reaches the Crown but **refuses** to seat their own soul as the anchor, the **Hollow Heir, Lysandra Vael**, seats hers and becomes the new Hollow Crown / tyrant. This triggers specifically when the player has reached the Crown (typically via the Communed/Tainted route) and declines the anchor at the final moment. Lysandra is the one other being lucid and Taint-saturated enough to hold the anchor, and she has shadowed the player's whole approach for exactly this contingency. **Thematic payload (write it in):** merely walking away does **not** save the world — it hands the Crown to someone worse. The *only* refusal that actually denies the Crown to a tyrant is **End it (the Pyre).** That asymmetry is what gives the Pyre its weight; keep it.

*Systems tie (§5/§8).* Requires having carried and mastered enough Taint to *hold* the anchor — **deep-Tainted builds** (the Hollowing-Ascendant archetype, §8). The Communed's victory.

### 3.4.3 Be consumed — the Hollowing *(the tragic / loss ending)*

Two routes: **(a)** reach the Crown but **fail or surrender** the final trial; **(b)** **max Hollowing anywhere in normal play** (the LOCKED soft-permadeath, §12). The player's soul dissolves into the web; their mind goes; they **turn** — and because their build/path shaped them, they are seeded into the Reach as a **named elite Wake (the Turned, §10)** wearing their own face and skills. The door stays shut; the world keeps rotting; the player is now part of the rot they fought.

*Epilogue:* the Reach is unchanged except that it now holds one more horror — and it is the player. This is **not a flat game-over**: the player's *specific way of living became the specific monster that haunts the world.* **Co-op:** the turned form can become a hostile, named encounter for the former allies (the world remembers your dead builds — §10, §13).

*Systems tie (§5/§12).* Driven by the Hollowing track maxing out; **always telegraphed** through the five stages and the Brink warning (§2.2.5). The whole game is the fight against this — which is what makes (b) land as tragedy rather than punishment.

**World-state persistence.** Settlement and world state persist across sessions for all three endings (concept bible §11; persistence model owned by §13/§16).

---

## 3.5 Side-Quest Patterns

Side content is authored from **repeatable templates**, not one-offs — designers generate instances from these patterns so every piece reinforces the corruption economy and the clock (principle §3.1.5). Each template states what it tests, its reward, and its failure-state.

| Template | Pattern | What it tests (pillar / economy facet) | Reward | Failure-state |
|---|---|---|---|---|
| **The Tended Flame** *(Warded-flavoured)* | Hold or relight a failing Hearth/settlement against an encroaching Tide (§6). | "Earn the Light" (pillar 4); the encroachment clock. | A forward **Hearth**; a Warded ally. | **The settlement falls if the player is too slow** — the clock has teeth. |
| **The Last Wish** *(mercy / moral miniature)* | A lucid half-turned NPC wants release. Grant mercy (a clean cremation — costs scarce **clean** resources; foreshadows the Pyre) **or** harvest them for Blight (costs humanity; foreshadows the Crown). | The corruption economy as a one-scene moral choice (bank-vs-purge, §5). | Clean-path: lore + a Warded token. Harvest-path: a Blight cache / Taint. | No hard fail; the choice itself is the content (and is remembered by factions/NPCs). |
| **The Ascension Bargain** *(Tainted-flavoured)* | A Communed offers a Taint-fuelled upgrade in exchange for something corrupting (feed a relic to a Blight-node; sacrifice a clean cache). | The bank-vs-purge seduction; raising the floor (§5, §8). | A Tainted ascension catalyst / upgrade. | Refusal closes the offer; accepting permanently raises the player's floor (the cost *is* the consequence). |
| **The Turned Acquaintance** | An NPC the player knew (e.g., **Coll**) reappears having **turned**; the player must put them down — or, rarely, find a way to save them. | Soft-permadeath dread made personal (§12); the turning fiction (§3.4.3). | Closure / a unique drop; rarely, a saved ally. | If ignored, the turned NPC roams as a recurring elite threat (§10). |
| **The Reliquary Delve** | A landmark dungeon (a **Reliquary**) holding a Communion-era secret + a build-defining reward. Risk scales with depth/decay (§11). | One concentrated dose of the central mystery (§3.6); risk-reward as geometry (§10). | A build-defining reward + relic-fragment(s) (§3.6). | The delve can be abandoned; deeper Tides make it harder, not impossible. |
| **The Encroachment** | A timed defense: a Tide is reclaiming held ground (§6); shore up Hearths or evacuate. | "The world is already dying" / "Die Forward" (pillars 2, 5). | Held ground; salvage; survivor NPCs. | **Ground (and people) are lost on failure** — a real, persistent setback. |

> **Design directive.** Every side-quest instance must answer one of: *light costs fuel, power costs humanity, standing still loses ground.* If an instance reinforces none of the three, it does not ship.

---

## 3.6 Environmental-Storytelling System

The cosmology (§2.2) is **delivered by place**, never by lecture (principle §3.1.2). Six authored mechanisms carry the story diegetically; spatial placement is owned by §11, audio execution (the Choir-Echo) by §15.

1. **The Tableau of the Last Moment.** Every ruin freezes the instant of the **Witherfall** (a family mid-meal, a market mid-trade, a deathbed where no one died). Because nothing could die, the world is a **museum of an interrupted death**; the player reads the catastrophe by reading frozen scenes. *Authoring rule:* each Tableau encodes one legible micro-story and one mood beat.
2. **The Decay Gradient as narrative.** A place's decay **state** (Lingering → Festering → Withering → Blooming → Terminal, §2.4.1) tells the player *how deep* and *how long-bound* they are. The further in, the more bodies and architecture are **fused** with Blight. **Place is a timeline the player walks through.**
3. **The Hearth-Scar.** A dead Hearth + the bodies around it = a survivor story told in objects (who held here, what they ran out of, who they failed to save). Relighting it **literally re-illuminates a lost story** and reclaims the ground (ties to the Tended Flame template and §7).
4. **The Blight-Halo.** The worst corruption pools where **grief was strongest** — a Communed bound a dead child to the land *here*. The richest, most dangerous Blight nodes are **emotionally legible**: high reward = deep grief. (Ties risk-reward geometry, §10, to fiction.)
5. **The Choir-Echo.** In deeper regions, surfaces still faintly carry the **Communion's song** (audio environmental storytelling — Choristers / Pale Cantor tie-in, §2.6). **The closer to the Crown, the louder the dead still sing.** Owned for execution by §15.
6. **Relic-fragments.** Scattered collectibles — **deathlight embers, Communion implements, journals/echoes** — that piece the mystery together across a playthrough. They **feed the lore, never dump it.**

### 3.6.1 The Relic-Fragment Drip (the mystery-delivery spine)

Relic-fragments are the explicit, trackable delivery system for §2.2. They fall into three classes, and their *distribution* is paced to the descent so the mystery resolves at roughly the rate the player approaches the Crown:

| Class | What it reveals | Where it concentrates |
|---|---|---|
| **Deathlight embers** | What the **Revenant** is; the sun-as-door; how Hearths work (the "self" thread). | Rim → mid (R1–R3); the Lamplighter's line. |
| **Communion implements** | How the rite was *sung*; the Choir; the **Fragment of the Song** (the "how" thread). | Mid (R3 Mourning Marsh, Reliquaries); the Pale Cantor. |
| **Journals / echoes** | The **Crowned Circle's** choices; the king's fear; the lock (the "who/why" thread). | Mid → heart (R4–R6); the named Wardens. |

> **Drip rule (illustrative — to tune).** Target ~60–70% of the core mystery resolvable before R6 from fragments alone, with the throne reveal (beat 10) confirming and completing it — so a thorough player arrives *understanding*, and a rushing player still gets the truth at the Crown. Exact counts and placement are owned by §11; total budget below (§3.7).

---

## 3.7 Quest & Narrative Content Budget

A content-pattern budget so the narrative is **implementable and scopeable**. All counts are **(illustrative — to tune)** and defer to the production scope in §18; this table sizes the *shape* of the content, not the final commitment.

| Content type | Target count (illustrative — to tune) | Notes |
|---|---|---|
| Main-quest beats | 11 (§3.2.1) | 3 set-pieces (Waking, Tide turns, the Crown). |
| Progression Wardens | 5 (R1–R5) | Gate the 5 ascension tiers (§8); stats §10. |
| Endgame bosses | 2 (Famished King → Hollow Crown) | R6, outside the tier gate. |
| Named NPCs (speaking roles) | 9 core (§3.3) | Plus minor Hearth/settlement NPCs as needed. |
| Side-quest instances | ~30–40 across the 6 templates (§3.5) | ~5–7 per template; biased toward time-pressure templates in mid/late regions. |
| Reliquaries | ~6–10 (≥1 per region) | Each = one concentrated mystery dose + a build-defining reward (§11). |
| Relic-fragments | ~40–60 total (§3.6.1) | Paced across the three classes / the descent. |
| Tableaux of the Last Moment | ~2–4 authored per region | Reusable set-dressing kit on top of the hero Tableaux. |

---

## 3.8 Open Questions

- **Co-op ending canon (route to §13 / tech-coop-expert).** Does a co-op **End it** require **unanimity** or a **leader's choice**? Are all party members threshold-souls/Revenants (working assumption: **yes**)? This changes how beat 10 and §3.4.1 are authored for multiplayer; flagged here and in §2.9.
- **"Save the Turned" rarity.** §3.5's Turned Acquaintance and §3.3's Coll allow a rare save-path. Whether a turned NPC can *ever* be restored (vs. only mercy-killed) is a narrative + systems sign-off, because it touches the soft-permadeath premise (§12) — keep the save-path *extremely* rare or purely fictional so it never undercuts the stakes.
- **Pyre eligibility for deep-Tainted players.** §3.4.1 notes a "harder trial or corrupted variant" of End-it for high-Hollowing players; the exact gate (can a maxed-Tainted player ever get a clean Pyre?) is owned by §5/§12 — flagged so the systems and narrative thresholds stay consistent.
