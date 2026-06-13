# WITHERREACH — Game Design Document

**Working title:** WITHERREACH  
**Document type:** Game Design Document — **vision-stage GDD**  
**Genre / platform / scope:** Dark-fantasy survival-RPG · PC + Console, Steam-first · single-player & 2–4 co-op · Unreal Engine 5 · indie-to-mid budget  
**Version / date:** {{DATE}}  
**Status:** Vision-stage — built on the locked concept bible; all numbers illustrative (to tune).

> This master document concatenates the 20 GDD sections in order. Section bodies are authored
> by their owning writers and are reproduced here unchanged except for heading-level normalization
> and mechanical cross-reference fixes (logged in §20.C). The locked vocabulary is the glossary in §20.A.

---

## Table of Contents
1. [1. Executive Summary & Vision](#sec-1)
2. [2. Setting, World & Lore](#sec-2)
3. [3. Narrative & Quest Design](#sec-3)
4. [4. Core Gameplay Loops](#sec-4)
5. [5. The Corruption System](#sec-5)
6. [6. Survival Systems](#sec-6)
7. [7. Crafting, Building & Economy](#sec-7)
8. [8. RPG Progression & Character Systems](#sec-8)
9. [9. Combat Design](#sec-9)
10. [10. Enemies, the Wake & AI](#sec-10)
11. [11. World Structure, Biomes & Level Design](#sec-11)
12. [12. Death, Risk & Session Structure](#sec-12)
13. [13. Co-op & Multiplayer Design](#sec-13)
14. [14. UI/UX & Player Feedback](#sec-14)
15. [15. Art Direction & Audio](#sec-15)
16. [16. Technical Design & Tech Stack](#sec-16)
17. [17. Market Positioning & Business](#sec-17)
18. [18. Production, Scope & Roadmap](#sec-18)
19. [19. Accessibility & Difficulty Options](#sec-19)
20. [20. Appendices](#sec-20)

---

<a id="sec-1"></a>

## 1. Executive Summary & Vision

> **Scope.** This is the publisher-facing summary of WITHERREACH: the high concept, the five design
> pillars, the USPs and differentiation, the audience/platform/scope, the keystone
> corruption-as-currency thesis in brief, and the one-line business hook. It is a synthesis, not a
> recap — every claim here is specified in full downstream (the keystone economy in §5/§8, the
> market case in §17, the production plan in §18). Glossary terms (concept bible §14, restated in
> §20) are used verbatim.

---

### 1.1 High concept

**WITHERREACH is a dark-fantasy survival-RPG in a world that is actively rotting to death — where the
corruption killing the land is also the only source of your power.** Every meal, every spell, every
level pulls you closer to becoming the thing you are fighting.

You are a **Revenant** — one of the unburied dead, a soul the world's failed immortality rite snagged
but could not bind. The **Witherfall** ended creation generations ago and left it jammed in the
threshold between life and death: nothing can die, nothing can truly live, and a corrupting substance,
the **Blight**, bleeds from every wound in the world. To survive the endless rotting twilight (the
**Long Dusk**) you must scavenge power from that very Blight, hold a fragile **Hearth**-light against
the dark, and decide how much of your humanity to burn to push the world's death back by one more day.
Solo or with 2–3 others, you race a world that is dying with or without you toward the wound at its
heart — the **Hollow Crown** — and choose to end it, master it, or be consumed by it.

The fusion is the point: this is **Valheim's build-craft-and-boss loop and Dark Souls' weighty combat
and bonfire dread, set inside one unified corruption economy** that no competitor runs cleanly.

---

### 1.2 The five design pillars (LOCKED)

1. **One Meter, Two Masters.** Corruption is simultaneously your power source and your survival threat;
   every meaningful choice trades safety for strength or strength for safety. *(The keystone — §5/§8.)*
2. **The World Is Already Dying.** The environment is an active, decaying antagonist on a clock.
   Standing still loses ground; you hold back collapse, you never finally win it.
3. **Power Has a Body Count.** Character growth visibly marks, warps, and endangers you — the strongest
   builds live closest to death and to "turning." Build identity *is* corruption identity.
4. **Earn the Light.** Safety is constructed and maintained, never granted. Every Hearth is a held
   breath against the dark; the map is a tide you push back hearth by hearth.
5. **Die Forward.** Death feeds the world and your own hollowing; you lose ground and resources, not the
   story. Permadeath is a slow descent you fight, not a sudden wipe.

---

### 1.3 The corruption-as-currency thesis (in brief)

The genre's classic failure is that survival meters feel like orthogonal busywork while RPG growth
feels like a separate power treadmill. WITHERREACH collapses both into **one carried meter the player
constantly trades in two opposite directions**:

- **Taint** is your *current carried corruption* — at once the spendable currency for casting rot-magic,
  tempering gear, and ascending skills **and** your primary survival-threat meter. It rises from
  surviving the corrupted world and falls only by spending it or purging it at a Hearth.
- **Surviving generates power; carrying power generates danger.** Clean food is rare and weak; blighted
  food is plentiful but raises Taint; the dark raises Taint — so not-starving *is* the on-ramp to growth.
  But carrying high Taint to spend later festers wounds, rots supplies, and draws the **Wake** (the
  hunt), so banking power literally raises the difficulty in real time.
- **The recurring decision** at every Hearth — **bank** the Taint (keep it as power potential, accept
  the danger) or **purge** it (spend the safety, forfeit the power) — is the climax of every session.
  Neither is correct; that irreducible tension is the spine of the whole game.
- **Build = survival difficulty.** Your **Warded** (resist) / **Tainted** (embrace) path sets your
  baseline Taint floor, which sets which threat band you rest in. The skill tree *is* the difficulty
  slider — there is no separate one — and in co-op it self-organizes a party (a Warded anchor sheltering
  Tainted strikers, bound by Blight-transfer revive) with no class system at all.

---

### 1.4 Unique selling points & differentiation

**Top USPs:**

1. **Corruption-as-currency (the unified meter).** Survival pressure and RPG power are *one resource*
   pulling opposite ways — no orthogonal chore meters. This is the core innovation and the thing nothing
   else on the market does cleanly.
2. **A world dying on a clock, with or without you (the Long Dusk).** Reclaiming territory is real but
   **impermanent** unless maintained — the opposite of the static conquerable sandbox.
3. **Identity = your relationship to the rot.** Your build literally sets your survival difficulty;
   the strongest, most magical builds run the hottest Taint and live nearest to "turning."
4. **Mechanical soft-permadeath: Hollowing & turning.** Death and overexposure advance a permanent
   corruption track; max it and your character *turns* into a Wake-creature the world (and other
   players) may later face. Stakes without roguelike erasure.
5. **Blight-transfer revival.** Co-op revive is a literal sacrifice — you pour your banked power into a
   downed ally to stabilize them, trading your strength for their life.

**"We are X but Y":**

- **vs Valheim** — its build-craft-and-boss loop, *but* the world rots on a clock and your power is the
  corruption killing it; reclaiming land is a desperate, impermanent push, not a permanent victory.
- **vs V Rising** — its dark survival-ARPG fusion, *but* single-player-first and PvE, with feeding/blood
  generalized into a full corruption economy that governs your entire build and survival risk — no
  PvP-server dependency.
- **vs Dark Souls / Soulslikes** — their weighty combat, bonfire rhythm, and hollowing dread, *but*
  embedded in a persistent survival world: the bonfire is a Hearth you build and defend, the "souls" are
  literally your survival fuel, and hollowing is a long mechanical descent you co-op against.

The audience has demonstrably bought *every adjacent half* of this pitch (Valheim 17M, V Rising 6M,
Enshrouded 3M+, Elden Ring 30M+); WITHERREACH sells them the fusion they keep buying piecemeal (§17).

---

### 1.5 Target audience, platform & scope

- **Platform / scope:** PC + Console, **Steam-first**. Single-player **and** small-group co-op (**2–4**).
  Built in **Unreal Engine 5** (§16). **Indie-to-mid budget** (~$3–6M to Early Access, §18).
- **Primary audience:** PC/console players, **age 18–35 core**, who own *both* deep survival-craft
  (Valheim, V Rising) *and* RPG/Soulslike titles (Elden Ring, Lies of P) — comfortable with difficulty,
  scarcity, and consequence, and playing in a **2–4 friend co-op unit** (the buy-multiplier). Secondary:
  solo dark-fantasy RPG/Soulslike fans wanting a persistent world, and the survival-streamer ecosystem.
- **Closest comparables:** Valheim, V Rising, Enshrouded (the directly-comparable survival-EA winners),
  with Dark Souls / Lies of P as the combat-and-tone anchor.
- **Launch model:** premium one-time purchase via **Early Access at $29.99 → 1.0 at $34.99** (V Rising's
  proven ladder). **No F2P, no pay-to-win** (selling power or safety is *incoherent* here — it would
  collapse the keystone Taint tension); post-1.0 cosmetic-only monetization plus one paid narrative
  expansion (§17).

---

### 1.6 The business & positioning hook

**The survival-RPG where getting stronger is the same act as dooming yourself** — a positioning no
comparable can claim. In a crowded survival-EA field the strategy is to **out-distinct, not out-spend**:
ship a tight vertical slice of the one-meter economy, let Early Access fund and tune it live, and grow
content through the **Tides** (deepening Long Dusk eras) toward a 1.0 where the story can finally be
finished at the Hollow Crown.

---

<a id="sec-2"></a>

## 2. Setting, World & Lore

> **Scope.** This section is the canonical fiction of WITHERREACH: the cosmology (what the Witherfall was and why the world cannot die), the timeline, the geography of the Reach, the Long Dusk as a world-antagonist, the three-pole faction triangle, and the Hollow Crown at the heart. It is the ground truth every other section dresses. Where fiction names a mechanic, the mechanic itself is owned elsewhere — the Taint/Hollowing/Blight economy in §5, survival/light/clock in §6, Hearths and building in §7, the Warded/Tainted trees in §8, combat and rot-magic in §9, the Wake bestiary and Wardens in §10, the regional spatial layout and Reliquaries in §11. Glossary terms (concept bible §14) are used verbatim.

---

### 2.1 The World at a Glance (designer orientation)

For any reader who needs the setting in one screen, these are the load-bearing truths. Everything below elaborates them; nothing contradicts them.

1. **The world is jammed in the threshold between life and death.** A failed immortality rite — **the Communion** — bound every soul of a dying kingdom into a single web anchored to its king. The king died; the web locked. Now **nothing can die and nothing can truly live**. This is the **Witherfall**.
2. **The Blight is the leak.** The ceaseless pressure of millions of trapped dead, straining against a binding that will neither release nor renew them, vents into matter as the corrupting substance the player harvests, eats, and spends.
3. **The sun was the door.** The world's natural passage for the dead. The Communion deliberately severed it to *keep* souls; the sun guttered into the earth at the capital, and the **Long Dusk** — a single death-throe stretched to forever — fell.
4. **You are the aborted death, walking.** A **Revenant** is a soul the Communion snagged but could not bind, because it was already half-through the dying sun's door. You carry a fragment of that door — the **deathlight** — which is why you alone can kindle Hearths, purge corruption through yourself, and act on the anchor at the world's heart.
5. **The map is a tide, not a conquest.** The **Blight** bleeds outward from the **Hollow Crown** at the basin's centre; decay is worst at the heart and thins toward the rim. The player pushes **inward and downward** toward the source; the Long Dusk rises to meet them.
6. **The apocalypse's architect was afraid, not evil.** The dead god-king reached for the rite out of grief and terror of the dark. Grimdark, not nihilistic (concept bible §6): the dark exists to make the light cost something.

---

### 2.2 The Witherfall & the Communion — the Resolved Cosmology

The concept bible (§5) poses three questions the player unravels: *Why won't the world die? Can it be allowed to? What are you, really, that you can walk in the rot and bend it?* The answers below are **binding canon**. The player is never handed this section as exposition — it is delivered diegetically across a playthrough (see §3.6); but everything we author must be true to it.

#### 2.2.1 The Communion (what the rite was)

The Communion was a **soul-binding**. The order who designed and performed it — **the Choir**, priest-singers — *sang* every soul of the living kingdom into a single shared web: people, beasts, and the land itself, anchored to one living vessel at the centre, the king. (The rite is **sonic**; it was sung, which is why the dead still sing — see §2.6.3, and grounds the audio identity in §15.) The promised mechanism was **renewal**: when a body failed, its soul would return to the web and be re-clothed in new flesh. Immortality as an unbroken cycle.

#### 2.2.2 Why the world won't die (the lock)

The rite held for one breath. Then the anchor — the king's mortal body, already old (that is *why* he feared death and reached for the rite) — **died**. With no living vessel at the centre, **the web locked**:

- Souls can no longer **leave** (the binding holds them).
- Souls can no longer **return to flesh** (there is no living anchor to re-clothe them).

Creation is stuck in the threshold: **nothing can die, nothing can truly live.** Corpses walk, ruins fester, wounds will not close into death.

#### 2.2.3 Why the sun went out (the severed door)

The sun was the world's **natural door** — the passage souls took when they died (the psychopomp; the threshold itself). To *keep* souls and win immortality, the Communion deliberately **severed that door**. With no souls to carry and no role left, the sun **guttered out into the earth** — sinking, fittingly, at the exact spot where the rite was sung (the capital, now the Hollow Court).

This single metaphor grounds three systems at once (see §6): the sun *was* the world's natural purge; **Hearth-light is a salvaged, rekindled fragment of it**; the Long Dusk clock exists because the natural sink is gone and corruption now rises with nowhere to drain. "Earn the Light" (pillar 4) is the player manually doing what the dead sun once did for free.

#### 2.2.4 The Blight and the Long Dusk (the leak and the death-throe)

- **The Blight** is the *leak*: the pressure of the trapped dead venting into matter. It is not a pollutant introduced from outside — it is the world's own bound souls bleeding through the seams of a binding that will neither hold them gently nor let them go.
- **The Long Dusk** is the world's single death-throe **stretched to forever** — the permanent rotting twilight, and the global decay clock that deepens in **Tides** (§2.5, §6).

#### 2.2.5 What the Revenant is (and how it grounds every meter)

**Can the world be allowed to die?** Yes — but only by *reopening the door the king closed.* That requires something the binding can neither fully hold nor fully consume: **a soul standing in the threshold.** That is the player.

A **Revenant** is a **threshold-soul** — a soul the Communion's net snagged at the instant of binding but could not bind, because the player was already half-through the dying sun's door when it slammed shut. The player is caught in the gap: neither released into death nor woven into the web. That gap is both power and curse:

- The player can **walk in the rot** because the binding cannot grip a soul that was never cleanly caught — the player is *unbound dead*, not the web's property.
- The player can **bend it** because the player carries a fragment of the severed door itself — an ember of the guttered sun, the **deathlight**. It is why only a Revenant can kindle Hearths (relighting shards of the dead sun), why corruption can be purged *through* the player, and why only a Revenant can stand before the Hollow Crown and act on the anchor.
- The player is, in essence, **the world's aborted death, walking** — a piece of the door the king closed, looking for the lock.

The three endings (§3.4) are the three things a fragment-of-the-door can do at the centre: **open it** (End it), **become the new anchor and keep it shut** (Master it), or **dissolve into the web** (Be consumed).

**The fiction grounds the corruption economy on the player's body.** Each meter (owned mechanically by §5/§12) has an in-fiction reason it exists *on a Revenant*:

| Mechanic (owned in §5/§6/§12) | The fiction (this section) |
|---|---|
| **Taint** — carried corruption; spendable power *and* survival threat | Trapped-soul-pressure the player has taken *into* themselves by surviving the rot (blighted food, the dark, Wake essence). The web's substance, internalized. |
| **Spending Taint** — rot-magic, tempering, ascension | Venting the internalized rot back out as force. A rot-mage is a vessel saturated with rot who *expels* it — never channelling live through the body in the moment (see §9). |
| **Purging at a Hearth** | Feeding loose excess corruption into the Hearth's fragment of the sun-door, which **sequesters** it. It is paid for in clean fuel (rekindling the shard costs), and it cannot drop the player below their build's **floor** — the corruption woven into path, skills, and tempered gear is part of them now, not loose excess (see §5, §8). |
| **Hollowing** — permanent track; *turning* at max | The player's own soul being slowly overwritten and drawn into the web. Each death and each overflow ratchets them further in. At maximum, the web claims them — they **turn** (see §12). |
| **Greater Hearths roll back decay** | A Greater Hearth is a large sun-door fragment — a regional **corruption sink** that holds the local trapped-soul-pressure, pushing the decay state back a step. Let it go unfuelled and it can no longer hold what it has taken; it goes dark and the held rot floods back (see §6, §7). |
| **Light suppresses Taint / dark accelerates it** | Light is the presence of the cleansing the sun used to provide for free; dark is its absence (see §6). |
| **The Long Dusk / Tides clock** | The web straining harder as the binding degrades (the Thinning, §2.3); more minds dissolve into the Wake; the leak worsens; the basin drowns for lack of the lost door. |

> **The Hollowing as fiction — five visible stages over the mechanical track (§5/§12).** Author all marks, audio, and NPC reactions to these stages: **Stage 1, the Marking** (cosmetic ash-veins, dimming eyes, faint whispers as the web's trapped voices begin to reach the player); **Stage 2, the Souring** (Warded ways weaken, Tainted ways strengthen, the Wake grow *less* aggressive — the web "begins to recognize you as its own; you smell like them"); **Stage 3, the Pull** (involuntary twitches, vision corruption, living NPCs recoil — the player is being reeled in); **Stage 4, the Brink** (strong audiovisual telegraph; last-chance rites unlock — a Warded cleansing or a Communed vigil; in co-op the party is explicitly warned); **Stage 5, the Turning** (the soul joins the web; the player becomes a named Wake-creature — see §3.4.3, §10). The descent is **always telegraphed, never a surprise** (concept bible §11). Exact pip counts and rates are owned by §5/§12 (illustrative there: 10 pips, turn at max).

---

### 2.3 Timeline — the Six Eras

The dying-earth register avoids precise chronology; the world remembers in **eras**, not dates. The player lives in the sixth.

| # | Era | What happens | Why it matters to play |
|---|---|---|---|
| 1 | **The Long Noon** *(the age before)* | The Reach at its weary height under a visibly **waning** sun. Death is feared as an incoming tide. The Sovereign Vael — the Ever-King — is ancient and afraid. | Establishes that the kingdom *already* lived in twilight, so immortality felt like the only answer. The architect's fear is the tragedy's seed. |
| 2 | **The Sun's Bargain** | The Choir devises the Communion: bind all souls, sever the sun's door, win shared immortality. The **Crowned Circle** (the king's inner circle) undergo the rite first and most deeply. | These are the people who *did this* — they become the named, apex Wardens (§2.7, §10). |
| 3 | **The Witherfall** *(the Communion)* — **Time Zero** | The rite is sung across the Reach. It binds everything. It holds for a breath. The anchor (the king) dies. The web locks. The sun guts into the earth. The Long Dusk falls. | The single founding catastrophe (concept bible glossary, LOCKED). Every ruin in the game freezes *this* instant (§3.6). |
| 4 | **The First Dusk / the Drowning** | The dead do not pass; the living cannot be reborn; the Blight begins to leak. Society collapses. The first Wake rise (the minds that dissolved fastest). The Choir is scattered and drowned in the rising rot. The **Ashen Wardens** are founded by those who refused or repented the rite — salvaging sun-embers into the first Hearths and the lightcraft tradition. Soon after, the **Communed** coalesce: those who believe the rite was not *wrong* but *unfinished*. | The two living factions are born here, as opposite answers to the same horror. The Hearth tradition begins here. |
| 5 | **The Long Dusk** *(generations later)* | The Reach is now the **Witherreach**. Survivors cling to salvaged Hearth-light. The factions are entrenched. The Blight tide creeps up the basin; the **Tides** deepen. The Hollow Crown sits unmoving at the heart. | The steady-state world the player is born into. |
| 6 | **The Thinning** *(the player's "now")* | After generations, the locked binding is finally **degrading** — its grip slipping. This is *exactly why* threshold-souls (**Revenants**) are now waking loose across the rim. The world nears a tipping point: total collapse into the Wake, or a last window to act on the anchor. | **This is why the player exists now, and why the clock has teeth.** The urgency is diegetic, not arbitrary. |

---

### 2.4 The Reach — Geography & the Concentric Basin

**Naming (canonical usage).** *The Reach* names the place across time — the kingdom that was and the dead land that remains. *The Witherreach* names that same place in its rotted present (concept bible glossary: both terms point at the playable world). Use "the Reach" for the geography/realm and "the Witherreach / the Reach" for the present state; they are the same basin.

**Spatial logic.** The Witherreach is a **concentric basin** — a great caldera-valley. The Reach built its capital at the lowest, central point, and that is where the sun guttered into the earth. Therefore:

- **The Blight bleeds outward from the Hollow Crown at the centre.** Decay is **worst at the heart** and **thins toward the rim**.
- The player **starts at the rim** (where hope still clings) and pushes **inward and downward** toward the Crown. Descent is literal *and* thematic: into death, into the past, into the truth.
- The Long Dusk **Tide** (§2.5) is the Blight **rising up the basin walls** toward the rim over time. The world is closing on the player from below.

#### 2.4.1 The Decay-State Spectrum (the readable gradient)

A place's **decay state** tells the player how deep they are and how long since a Hearth held the ground. It is a five-step narrative spectrum, applied within and across regions. (It maps onto the *mechanical* three-tier zone-decay used by survival — fringe / decayed / blighted-core — see §6; this five-state spectrum is the world-readable, art- and writing-facing gradient.)

| Decay state | What the player sees | Roughly maps to (§6 zone tier) |
|---|---|---|
| **Lingering** | Recognizable architecture; the walking dead still wear who they were; twilight, not full dark. | Fringe |
| **Festering** | Blight pools; corpses fused to the ground; the rot has texture and smell. | Fringe → Decayed |
| **Withering** | Architecture and flesh begin to **merge**; the human shapes are going. | Decayed |
| **Blooming** | Rot-coral and Blight-blooms; barely-human forms; grotesque, alien beauty (the *Annihilation* register). | Decayed → Blighted core |
| **Terminal** | Not architecture anymore — a single rot-organism. The heart. | Blighted core |

> Kindling a **Greater Hearth** rolls a region **back one decay state** and pins it while fuelled; neglect lets it creep **forward** one step per Tide (the encroachment loop — §6, §7). The reclaimed map is therefore impermanent (USP #2). The decay-state labels **Withering** and **Blooming** were chosen specifically to avoid collision with the glossary terms *Hollowing* (the permanent track) and *Communed* (the faction caste) — they are not synonyms for those.

#### 2.4.2 The Six Regions (narrative map)

Six concentric rings, rim to heart. This table is the **narrative** map — what each region *means* and the story it tells. Spatial layout, blockout, traversal, and Reliquary level design are owned by §11; Warden encounter stats by §10. The structure is locked at **six regions, five progression Wardens (R1–R5) gating the five ascension tiers (§8), and R6 as the endgame** (the Famished King → the Hollow Crown), which sits outside the five-tier gate.

| Ring | Region | Biome (narrative) | Decay state | Who holds it | Warden (§10) | The chapter it tells |
|---|---|---|---|---|---|---|
| **R1** | **The Gloaming Marches** | Cold heath, mist-fens, dead heather, broken farmsteads; twilight not full dark | Lingering *(tutorial ring)* | Ashen Wardens; home hub **Ashfast**; the Lamplighter | **The Mire-Stag** *(apex corrupted beast)* | The frontier of hope — "this was a kingdom's edge, and the rot is coming for it too." |
| **R2** | **The Cinderwood** *(the Ashen Reaches)* | Vast dead, slow-burning forest; ash-fall, charcoal trees, embers in the dark; the Wardens' sacred cremation-grounds | Lingering → Festering | Contested: Warden ash-grounds vs encroaching Wake | **The Cinder-Alpha** *(apex corrupted beast)* | The human *response* to the Witherfall — how the living honoured death when death stopped working. Funereal grandeur. |
| **R3** | **The Mourning Marsh** *(the Drowned Reach)* | Rot-flooded lowland; black water, sunken hamlets, reed-choirs; the Blight pools in the water | Festering | The Drowned Choir's domain | **The Drowned Choir** *(Choir remnant)* | The *rite itself* — the machinery of the Witherfall, heard before it is understood. |
| **R4** | **The Hollowing Wastes** *(the Communed Marches)* | Mutated beauty-grotesque expanse; rot-coral, Blight-blooms, fused flesh-and-stone | Withering → Blooming | **The Communed**; their **Black Hearth** settlement; the Hollow Heir's seat | **The Communed champion** *(a high-Communed or turned former-Warded — the tragic mirror)* | The *alternative* — what embracing the rot looks like, made physical and seductive. (Region name echoes the faction's *Hollowing* pilgrimage — not the meter.) |
| **R5** | **The Cathedral of Ash** *(the Pale Reach)* | Ruined cathedral-complex in a bone-white ash-desert; eerily still, blanched, holy-and-wrong | Blooming *(near-Crown)* | Empty of the living — the corrupted First Warden and her failed pilgrimage's dead | **The Ashen Penitent** *(the First Warden — named Crowned-Circle figure)* | The *cost and limit of mercy* — the founder of resistance, corrupted by her own attempt to end it. |
| **R6** | **The Hollow Court** *(the Sunhold)* | The drowned capital at the basin's floor, where the sun guttered into the earth; fused into a single rot-organism around the Crown | Terminal | The dead — the Crowned Circle, the Famished King, the Hollow Crown | **The Famished King** → **The Hollow Crown** *(endgame, outside the five-tier gate)* | The *origin and the end* — where the Witherfall happened and where the choice is made. The bottom of the descent. |

---

### 2.5 The Long Dusk — the World as Antagonist on a Clock

The Long Dusk is both the *setting's permanent state* and the *game's escalation clock*. It is design pillar 2 made into world-fiction: **the world is already dying, on a clock, with or without the player** (concept bible §3).

- **Permanent rotting twilight, no day/night.** There is no sunrise to wait for — the sun is in the earth. The in-Expedition rhythm comes from **weather surges** (ashfall, Blight-storms), not from a sun (mechanics in §6).
- **The Tides — the macro clock.** The Long Dusk deepens in **Tides** (eras of escalating rot and tougher Wake). Each Tide raises ambient corruption, hardens the Wake, and speeds encroachment (cadence and exact multipliers owned by §6; ~5–6 Tides across a full playthrough, illustrative). The fiction: the web **straining harder** as its binding degrades (the Thinning), so more minds dissolve into the Wake and the leak worsens.
- **The map as a tide (encroachment).** Unheld regions worsen **one decay state per Tide** (§2.4.1). A lit **Greater Hearth** pins its region back one step while fuelled; if its fuel lapses or it falls, the held rot floods back. **Reclaiming territory is real but impermanent** — the opposite of the static conquerable sandbox (USP #2). The player pushes the dark back hearth by hearth and never finally wins it (pillar 4).
- **Why the clock has teeth *now*.** The Thinning (§2.3) means the binding is at last degrading — which is why Revenants wake, why the Wake is rising toward total collapse, and why the Crown can *finally* be reached and acted upon. Standing still is losing ground (pillar 2); the world will reach its own terminus whether or not the player acts.

---

### 2.6 The Faction Triangle

Three poles. **Two are factions of the living** with opposed answers to the same question — *resist the rot, or master it?* — and **the third is not a faction at all** but the tide both are losing to. Crucially, **the player's build and Taint-floor (§5, §8) are the physical expression of which pole they drift toward**: the fiction makes the systems' Warded/Tainted identity *legible*. Every faction interaction is also a referendum on the player's drift.

#### 2.6.1 The Ashen Wardens — Keepers of the Light *(allied to the Warded path)*

- **Belief.** The Communion was a sin against death itself. Salvation is to **resist** corruption, hold the light, honour the old human ways (names, faces, burial), and — for the most devout — find the way to let the world die *cleanly*. They **cremate their dead** — a defiant little mimicry of the lost sun-door, a tiny willed release; ash is sacred (hence **Ashen**).
- **Lightcraft.** The Wardens' magic (combat spec in §9): blessed-oil and hearth-fire weapon enchants, protective auras, a mobile mini-Hearth (**Warden's Aegis**), and field-purge — powered by **clean resources and hearth-fire, never Taint**. The Warded path is *not* purely martial: it wields a second magic whose fuel is the opposite of rot-magic's. Lightcraft burns the light; rot-magic burns the dark.
- **Internal fracture (quest fuel).** **Hearth-keepers** (pragmatists — just hold the light and survive; they fear that "ending it" is one more rite that will go wrong) vs **Pyre-tenders** (hardliners — the only mercy is to end the world; they seek the way to unbind everything). This split *is* the politics behind the End-it ending (§3.4.1).
- **Player hook.** Kindle Greater Hearths, push back the Dusk, and ultimately reach the Crown to **End it**. They teach Lightcraft (Warded, §8).
- **Holdfast & figures.** **Ashfast** — the great Hearth-hold and the player's first hub (R1). Key NPCs: **Hearthmother Vesna** (leader, primary Warded quest-giver), **Wren** (the young Warden, the path's hope-barometer), the **Lamplighter** (opening mentor), and the **First Warden / the Ashen Penitent** (their corrupted founder — §2.7, §3.3).

#### 2.6.2 The Hollowing / the Communed — Those Who Embraced the Blight *(allied to the Tainted path)*

- **Belief.** Purity is a death-wish; the Communion was not *wrong*, it was **unfinished** — it failed only because the anchor died before it stabilized. Salvation is **mastery**: take enough rot into yourself, ascend, and either *complete* the rite or *seize the anchor and rule*. Mortality is the disease; the Blight is the cure for those strong enough to hold it. They embrace mutation as **transfiguration** — "we are becoming what comes after."
- **Two castes.** The **Communed** proper — lucid high-sorcerers who keep their minds even at extreme Taint (aspiring god-kings) — and the **Hollowing** — pilgrims feeding themselves to the Blight, sliding toward the Wake in hope of ascension. A desperate folk-horror cult quality (*The VVitch* register, concept bible §6).
- **The Black Hearth.** Their anti-Hearth: a sink run *in reverse* that **feeds on** offered Taint rather than purging it — deepening rather than holding. Their settlements cluster around one (contrast with the Warded Hearth — §7).
- **Player hook.** Embrace the Tainted path, master the Blight, reach the Crown to **Master it**. The tension worth playing: do they want to *crown the player* — or use the player as the **key** and seat their own prophet on the anchor? (Resolved in the Master-it ending and its refuse-variant — §3.4.2.)
- **Figures.** **The Hollow Heir, Lysandra Vael** (the lucid prophet, primary Tainted quest-giver), **Coll** (a pilgrim who visibly turns over the game — §3.3), the **Pale Cantor** (a lucid Choir-defector who remembers the song — the single most important lore NPC), and the **Famished King** (the Circle-member who chose to *feed* — §2.7).

#### 2.6.3 The Wake — the Rising Tide *(not a faction with intent)*

The **Wake** are the bound dead whose minds have fully dissolved into the web's hunger. They are **not evil** — they are **grief made predatory**: each Wake is a trapped soul clawing to re-clothe itself in living flesh, hunting the warm and the unbound because that is the closest thing to the vessel the Communion promised and can never deliver. They cannot be reasoned with; the mind is gone, only the binding's hunger remains.

Their pressure scales with the player's **Taint** (a Taint-rich Revenant is the richest possible vessel) and with the **Tide** (the relationship is owned mechanically by §10). Their *form* records what they were in life; their *behaviour* is pure reclamation-hunger. The full bestiary, tiers, and AI live in §10; the canonical naming and origin-fiction are: **Husks** (the ordinary dead), **Gloamhounds & Mourncrows** (the bound beasts), **the Gravemade** and the **Swollen** sub-type (the most Blight-saturated dead), **the Choristers / the Keening Choir** (dissolved Choir-singers still singing the rite), **the Famished** (the elite hunters — the web's antibodies, drawn to high-Taint Revenants and threshold-souls), and **the Turned** (build-derived named elites — see §3.4.3, §10).

> **The triangle in play.** The two living poles (Wardens vs Communed) court the player for *opposite ends of the same journey* to the Crown; the Wake is the clock both are losing to and the fate the player personally races (Hollowing → turning). There is no neutral standing — the player's accumulating Taint and Hollowing are constantly answering, in the body, the question the factions argue with words.

---

### 2.7 The Hollow Crown — the Dead God-King at the Heart

At the basin's floor, in the drowned capital (the **Hollow Court / the Sunhold**), sits the **Hollow Crown**: **Sovereign Vael, the Ever-King** — the last king of the Reach and the **anchor of the web**. He is the source of the Blight and the rotting engine of the Long Dusk (concept bible §5), not because he wills it but because his dead body is the locked centre everything is bound to.

- **The Crowned Circle around him.** The king's inner circle underwent the Communion first and deepest, woven closest to the anchor. When the web locked, each met a different fate **by the choice they had made in life** — to rule, to feed, to atone. They are the **named, apex Wardens** (§2.6, §10): the **Famished King** (chose to *feed* — the penultimate gate, R6), the **Ashen Penitent** (chose to *atone* — and founded the Wardens before her corruption, R5), and others. The Circle personalizes the catastrophe: the late bosses are the people who *did this*. The king alone **chose nothing** — and so became the hollow anchor.
- **The voice of the Crown.** Sovereign Vael is not a conversational NPC until the very end. There he speaks in a **hollow choral voice** — the Choir's massed trapped souls speaking *through* him — delivers the mystery's final truth, and the binding lays the **three choices** before the player (the door-fragment frame — §2.2.5).
- **The choice (full expansion in §3.4).** Each ending is a thing a fragment-of-the-door can do at the anchor: **End it (the Pyre)** — offer the player's threshold-soul as the reopened door and let every trapped soul pass; **Master it (the Crown)** — seat the player's own soul as the new living anchor and become the new Hollow Crown; **Be consumed (the Hollowing)** — dissolve into the web and turn. The endings frame is LOCKED (concept bible §9); the fiction and triggers are detailed in §3.4.

---

### 2.8 Narrative Tone & Register (writing guidance)

This is the *writing* register for all in-game text, lore, and quest fiction. Art and audio execution are owned by §15; combat/AI flavour by §9/§10. The tonal rules below are binding on every writer who authors WITHERREACH fiction.

- **Grimdark, not nihilistic.** The dark exists to make the light cost something (concept bible §6). Hope is a **verb** — worked for, and losable. Never write despair as a flat fact; write it as a price.
- **The architect was afraid, not evil.** The Witherfall is a tragedy of grief and fear scaled to a god's power, not a villain's scheme. Keep this in every Crowned-Circle and king reveal — it is what makes the ending choice weigh.
- **The Wake is grief, not monstrosity.** Even the ambient enemies are *trapped people*. Dread should carry pity. (See §10 for how this reads in encounter design.)
- **The world is beautiful in its decay (melancholic awe).** The Blight is seductive — the *Annihilation* "Shimmer" register: alien, gorgeous, lethal. The deepest rot (the Blooming/Terminal states) should be the most beautiful and the most dangerous at once.
- **Dying-earth register, no precise chronology.** Time is told in eras and tides, not dates (§2.3). Names are weathered, liturgical, funereal.
- **Show, don't dump.** The cosmology of §2.2 is *never* delivered as a lecture. It is assembled by the player from places, relics, and people (the environmental-storytelling system — §3.6).

---

### 2.9 Open Questions

- **Co-op canon (route to §13 / tech-coop-expert).** Are all party members threshold-souls/Revenants (the working assumption is **yes**), and does a co-op "End it" require unanimity or a leader's choice? This affects the ending fiction in §3.4 and is flagged there too.
- **"The Reach" / "the Witherreach" usage.** The concept bible glossary treats both as the present playable world; this brief uses "the Reach" for the realm across time and "the Witherreach" for its rotted present (§2.4). The two are reconciled as the same basin and do **not** conflict with the bible — flagged here only so the integrator keeps the usage consistent across sections.

---

<a id="sec-3"></a>

## 3. Narrative & Quest Design

> **Scope.** This section is the implementable narrative spec: the design principles, the main-quest arc across three acts and five progression Wardens (plus the Crown), the three expanded endings, the key NPC roster, the repeatable side-quest patterns, the environmental-storytelling system, and a content budget. It builds directly on the cosmology and factions in §2 — read §2 first. Mechanics referenced here are owned elsewhere: the corruption economy in §5, survival/the Long Dusk clock in §6, Hearths in §7, the Warded/Tainted trees and ascension tiers in §8, combat/rot-magic/Lightcraft in §9, the Wake bestiary and Wardens in §10, regional spatial/level design and Reliquaries in §11, death/corpse-runs/turning in §12, co-op in §13. Glossary terms (concept bible §14) are used verbatim.

---

### 3.1 Narrative Design Principles

These are binding rules for every quest, line, and beat. They keep the story in lockstep with the pillars (concept bible §3) so the fiction *is* the systems, not a coat of paint over them.

1. **The player's relationship to the rot is the real arc.** The named plot is the spine; the *felt* story is the player watching themselves change. Build, Taint-floor, and Hollowing (§5, §8, §12) are characterization — the strongest characterization tools we have. Quests **react to the player's drift**, not the reverse.
2. **Show, never dump.** The cosmology (§2.2) is assembled from places, relics, and people across a whole playthrough (§3.6). No exposition NPC recites the mystery; the player earns it. The one exception is the Crown itself, where the truth is finally *spoken* — earned by the entire descent.
3. **The clock has teeth.** Quests can be **failed** by time and neglect (settlements fall, Hearths go dark, NPCs turn). Failure loses ground and people, not the story (pillar 5, "Die Forward"). At least the time-pressure side-quest templates (§3.5) must have real failure states.
4. **Grimdark, not nihilistic; the Wake is grief.** Every antagonist, including the ambient Wake and the god-king, is a *trapped person* (§2.8). Dread carries pity. The villain of WITHERREACH is a locked door, not a malevolence.
5. **Every meaningful quest is a referendum on bank-vs-purge / Warded-vs-Tainted.** Side content reinforces the keystone choice (concept bible §8): mercy costs scarce clean resources (and foreshadows the Pyre); power costs humanity (and foreshadows the Crown). No "filler" fetch quests that don't touch the economy.
6. **Diegetic delivery, minimal cinematics.** Favour in-world text, environmental tableaux, NPC dialogue at Hearths, and the Choir-Echo audio layer (§2.6.3, §15) over cutscenes. Reserve full cinematic weight for the three set-pieces that earn it: the Waking (opening), the Tide turns (Act II climax), and the Hollow Crown (the choice).

---

### 3.2 The Main Quest Arc

The arc is a literal and thematic **inward/downward spiral**: from the basin rim (least decayed, where hope clings) toward the sunken capital at the heart (Terminal decay, where the choice waits). Descent = into death, into the past, into the truth (§2.4).

**Structure (locked).** Six regions (§2.4.2). **Five progression Wardens, R1–R5**, each kill kindling a Greater Hearth and **unlocking one of the five ascension tiers (§8)** — this is the "5" the systems sections gate on, mapping 1:1 to the five tiers. **R6 (the Hollow Court) is the endgame, outside the five-tier gate**: the **Famished King** is a final-approach gauntlet boss, and the **Hollow Crown** is the ending encounter (the three-choice), not a progression Warden. The Long Dusk **Tides (§6)** pace the acts — the five ascension beats plus the final descent give ~6 escalation beats, satisfying survival's ~5–6 Tide cadence.

#### 3.2.1 Act → Beat Map

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

#### 3.2.2 Act Beats (prose)

**ACT I — THE WAKING** *(the rim; establish the loop and the stakes).* The Revenant wakes at the blighted rim of R1. The **Lamplighter** finds the player's unburied body, names what they are, gives them a Hearth, and tells them the truth they cannot outrun: *lie down and you will turn.* This is the tutorial of the corruption economy (blighted food → Taint; purge at the Hearth; light suppresses the rot — §5, §6). The player reaches **Ashfast** (the first Hearth-hold), meets **Hearthmother Vesna** and the Wardens, and learns the crisis: a Tide is deepening, Hearths are falling, and the Wardens need someone who can walk *deep* into the rot — a Revenant — to kindle Greater Hearths. Defeating the first Warden (**the Mire-Stag**) kindles the first Greater Hearth and rolls back local decay; the player feels the first taste of pushing the dark back, and the first relic-fragments begin hinting at the Crown.

**ACT II — THE DESCENT** *(inward; the factions pull; identity hardens; the mystery opens).* The **Communed** make contact (the Hollow Heir or her emissaries) with the *opposite* answer: don't resist — master. By now the player has felt the seduction of banking Taint, and their build/floor is visibly committing them; **the faction triangle activates**, and both poles react to the player's drift. Through the **Pale Cantor** and the First Warden's relics, the player learns the Communion was a soul-binding anchored to the king that *locked* when he died, and that the sun was the severed door — beginning to grasp *why the world won't die* and to suspect *what they are*. The deeper Wardens — the **Drowned Choir** (the rite's machinery; yields the **Fragment of the Song**) and the Communed heartland's **champion** (beauty-in-decay at its most seductive) — are each a deeper decay state and one chapter of the world's story. The act climaxes with **the Tide turns**: a scripted Long-Dusk escalation where the world visibly worsens, Hearths fall, and the Famished hunt hardens — and the player learns the binding is *degrading* (the Thinning), which is why threshold-souls wake now and why the Crown can at last be reached.

**ACT III — THE CROWN** *(the heart; the choice).* At the **Cathedral of Ash** (R5), the corrupted **Ashen Penitent / First Warden** delivers the keystone truth through her tragedy: a living human cannot be the door — only a Revenant can. The player now knows they are the key. The descent into the sunken capital (R6) brings both factions converging: the Wardens urge **End it**; the Hollow Heir reveals her true aim (use the player as the key, or take the anchor herself). The **Famished King** bars the throne and reveals the Crowned Circle's choices. At the throne, **Sovereign Vael** speaks in the Choir's massed voice, gives the mystery's last truth, and the binding lays the **three choices** (§3.4). The epilogue plays per ending; world-state persists across sessions.

---

### 3.3 Key NPC Roster

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

### 3.4 The Three Endings (expanded)

The endings **frame is LOCKED** (concept bible §9): **End it / Master it / Be consumed**. Each is a thing a fragment-of-the-door (the player's threshold-soul + deathlight, §2.2.5) can do at the anchor, and each aligns with a path and the player's accumulated Taint/Hollowing (§5, §8). The fiction below is canon.

**How the choice is offered & gated.** At the throne (beat 10), the binding lays all three before the player as *capabilities of what they are*, not as a menu the world endorses. **End it** and **Master it** are deliberate selections; **Be consumed** is reachable both *there* (fail or surrender the final trial) and *anywhere* in normal play (max Hollowing — the LOCKED soft-permadeath, §12). Systems-eligibility nudges but does not hard-lock the choice (illustrative): a low-Hollowing/Warded player gets the cleanest End-it; a deep-Tainted player is the only one who can *hold* Master-it; a player at the Brink risks Be-consumed regardless of intent. Exact gating thresholds are owned by §5/§12.

#### 3.4.1 End it — the Pyre *(Warded-favoured; the merciful ending)*

The player ascends the Crown not to take it but to **unmake the anchor**: they offer their own threshold-soul as the reopened door. The deathlight they carry flares into a true sunrise-for-one-instant; the king's binding releases; **every trapped soul — the Wake, the Communed, the dead of the Reach, and the player — passes through at last.** The Long Dusk ends because the world finally, properly *dies*. The sun does not return; it simply *sets*, the way it should have generations ago.

*Epilogue:* ash, silence, a dawn that is also an ending — bittersweet, the most human. **Co-op:** all players pass together; the world they leave is at peace because it is empty (co-op canon — unanimity vs leader's choice — flagged §3.8).

*Systems tie (§5/§8/§12).* Cleanest for **low-Hollowing / Warded** players — the player must be "human enough" to be a clean door. Deep-Tainted players may face a harder trial or a corrupted variant. This is the payoff of holding the line: keeping the floor low and the Hollowing checked the whole game *buys* the merciful ending.

#### 3.4.2 Master it — the Crown *(Tainted-favoured; the power ending)*

The player casts down the dead Sovereign and seats **their own soul as the new anchor**. The binding re-stabilizes around them — a living anchor at last. The world stops sliding toward collapse but does **not** heal: it remains the Long Dusk, now *theirs*. The Wake answer to them; the Blight is their dominion; they are the new **Hollow Crown** — immortal, sovereign, alone, having become the very thing that began this.

*Epilogue:* the player sits the throne, the rot stills around them, the Reach has a god-king again. Power at the price of becoming the eternal prison-warden of the dead — and the seed of a next cycle (one day even they may fail, and then…).

**The refuse-variant (canonical epilogue variant — NOT a fourth ending).** If the player reaches the Crown but **refuses** to seat their own soul as the anchor, the **Hollow Heir, Lysandra Vael**, seats hers and becomes the new Hollow Crown / tyrant. This triggers specifically when the player has reached the Crown (typically via the Communed/Tainted route) and declines the anchor at the final moment. Lysandra is the one other being lucid and Taint-saturated enough to hold the anchor, and she has shadowed the player's whole approach for exactly this contingency. **Thematic payload (write it in):** merely walking away does **not** save the world — it hands the Crown to someone worse. The *only* refusal that actually denies the Crown to a tyrant is **End it (the Pyre).** That asymmetry is what gives the Pyre its weight; keep it.

*Systems tie (§5/§8).* Requires having carried and mastered enough Taint to *hold* the anchor — **deep-Tainted builds** (the Hollowing-Ascendant archetype, §8). The Communed's victory.

#### 3.4.3 Be consumed — the Hollowing *(the tragic / loss ending)*

Two routes: **(a)** reach the Crown but **fail or surrender** the final trial; **(b)** **max Hollowing anywhere in normal play** (the LOCKED soft-permadeath, §12). The player's soul dissolves into the web; their mind goes; they **turn** — and because their build/path shaped them, they are seeded into the Reach as a **named elite Wake (the Turned, §10)** wearing their own face and skills. The door stays shut; the world keeps rotting; the player is now part of the rot they fought.

*Epilogue:* the Reach is unchanged except that it now holds one more horror — and it is the player. This is **not a flat game-over**: the player's *specific way of living became the specific monster that haunts the world.* **Co-op:** the turned form can become a hostile, named encounter for the former allies (the world remembers your dead builds — §10, §13).

*Systems tie (§5/§12).* Driven by the Hollowing track maxing out; **always telegraphed** through the five stages and the Brink warning (§2.2.5). The whole game is the fight against this — which is what makes (b) land as tragedy rather than punishment.

**World-state persistence.** Settlement and world state persist across sessions for all three endings (concept bible §11; persistence model owned by §13/§16).

---

### 3.5 Side-Quest Patterns

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

### 3.6 Environmental-Storytelling System

The cosmology (§2.2) is **delivered by place**, never by lecture (principle §3.1.2). Six authored mechanisms carry the story diegetically; spatial placement is owned by §11, audio execution (the Choir-Echo) by §15.

1. **The Tableau of the Last Moment.** Every ruin freezes the instant of the **Witherfall** (a family mid-meal, a market mid-trade, a deathbed where no one died). Because nothing could die, the world is a **museum of an interrupted death**; the player reads the catastrophe by reading frozen scenes. *Authoring rule:* each Tableau encodes one legible micro-story and one mood beat.
2. **The Decay Gradient as narrative.** A place's decay **state** (Lingering → Festering → Withering → Blooming → Terminal, §2.4.1) tells the player *how deep* and *how long-bound* they are. The further in, the more bodies and architecture are **fused** with Blight. **Place is a timeline the player walks through.**
3. **The Hearth-Scar.** A dead Hearth + the bodies around it = a survivor story told in objects (who held here, what they ran out of, who they failed to save). Relighting it **literally re-illuminates a lost story** and reclaims the ground (ties to the Tended Flame template and §7).
4. **The Blight-Halo.** The worst corruption pools where **grief was strongest** — a Communed bound a dead child to the land *here*. The richest, most dangerous Blight nodes are **emotionally legible**: high reward = deep grief. (Ties risk-reward geometry, §10, to fiction.)
5. **The Choir-Echo.** In deeper regions, surfaces still faintly carry the **Communion's song** (audio environmental storytelling — Choristers / Pale Cantor tie-in, §2.6). **The closer to the Crown, the louder the dead still sing.** Owned for execution by §15.
6. **Relic-fragments.** Scattered collectibles — **deathlight embers, Communion implements, journals/echoes** — that piece the mystery together across a playthrough. They **feed the lore, never dump it.**

#### 3.6.1 The Relic-Fragment Drip (the mystery-delivery spine)

Relic-fragments are the explicit, trackable delivery system for §2.2. They fall into three classes, and their *distribution* is paced to the descent so the mystery resolves at roughly the rate the player approaches the Crown:

| Class | What it reveals | Where it concentrates |
|---|---|---|
| **Deathlight embers** | What the **Revenant** is; the sun-as-door; how Hearths work (the "self" thread). | Rim → mid (R1–R3); the Lamplighter's line. |
| **Communion implements** | How the rite was *sung*; the Choir; the **Fragment of the Song** (the "how" thread). | Mid (R3 Mourning Marsh, Reliquaries); the Pale Cantor. |
| **Journals / echoes** | The **Crowned Circle's** choices; the king's fear; the lock (the "who/why" thread). | Mid → heart (R4–R6); the named Wardens. |

> **Drip rule (illustrative — to tune).** Target ~60–70% of the core mystery resolvable before R6 from fragments alone, with the throne reveal (beat 10) confirming and completing it — so a thorough player arrives *understanding*, and a rushing player still gets the truth at the Crown. Exact counts and placement are owned by §11; total budget below (§3.7).

---

### 3.7 Quest & Narrative Content Budget

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

### 3.8 Open Questions

- **Co-op ending canon (route to §13 / tech-coop-expert).** Does a co-op **End it** require **unanimity** or a **leader's choice**? Are all party members threshold-souls/Revenants (working assumption: **yes**)? This changes how beat 10 and §3.4.1 are authored for multiplayer; flagged here and in §2.9.
- **"Save the Turned" rarity.** §3.5's Turned Acquaintance and §3.3's Coll allow a rare save-path. Whether a turned NPC can *ever* be restored (vs. only mercy-killed) is a narrative + systems sign-off, because it touches the soft-permadeath premise (§12) — keep the save-path *extremely* rare or purely fictional so it never undercuts the stakes.
- **Pyre eligibility for deep-Tainted players.** §3.4.1 notes a "harder trial or corrupted variant" of End-it for high-Hollowing players; the exact gate (can a maxed-Tainted player ever get a clean Pyre?) is owned by §5/§12 — flagged so the systems and narrative thresholds stay consistent.

---

<a id="sec-4"></a>

## 4. Core Gameplay Loops

WITHERREACH runs on three nested loops at three timescales — **moment-to-moment** (seconds–minutes), the **Expedition** (one play session, 30–90 min), and the **meta** loop (tens of hours). They are not three separate games stitched together: the same corruption economy (see §5) is the engine of all three, so a decision made in a single fight ripples up to the session's climax and down from the long-term build you are committing to. This section specifies the loops and how they interlock; it references the Corruption System (§5) and Survival Systems (§6) for the underlying numbers rather than restating them.

The unifying tension, stated once and threaded through every loop: **surviving forces you to take on Taint; Taint is the only fuel for power; carrying Taint to spend later is what makes the world dangerous in real time.** Every loop below is a different-sized turn of that one wheel.

---

### 4.1 The three loops at a glance (loop diagram-in-text)

```
                          ┌─────────────────────────── META LOOP (tens of hours) ───────────────────────────┐
                          │                                                                                  │
                          │   Ascend a Path (Warded / Tainted) ──► raises build power AND sets T_floor       │
                          │            ▲                                          │                          │
                          │            │ spend banked Taint at Hearth             ▼                          │
                          │   Kindle Greater Hearths (defeat Wardens) ──► roll back the Long Dusk locally    │
                          │            ▲                                          │                          │
                          │            │                                          ▼                          │
                          │   Race the Tides ◄──────────────── the world decays whether you act or not       │
                          │            ▲                                          │ deepens every ~10h       │
                          │            │                                          ▼  out-in-the-Reach (§6)   │
                          │  ┌──────────────────────── EXPEDITION LOOP (30–90 min) ───────────────────────┐  │
                          │  │                                                                            │  │
                          │  │   Depart Hearth (Taint = T_floor) ──► push outward into more-decayed,      │  │
                          │  │            ▲                          Blight-encroached zones              │  │
                          │  │            │                                    │                          │  │
                          │  │   BANK / PURGE / INVEST   ◄── return ──┐        ▼                          │  │
                          │  │   (the session climax, §5.5)           │   ┌── MOMENT-TO-MOMENT LOOP ──┐   │  │
                          │  │            │                           │   │  Read gloom & decay state │   │  │
                          │  │            │                           │   │           ▼               │   │  │
                          │  │            ▼                           │   │  Manage light radius      │   │  │
                          │  │   Carry T_end home, weighed against    │   │           ▼               │   │  │
                          │  │   Taint band, light, hunger, nerve ────┘   │  Fight / avoid the Wake   │   │  │
                          │  │                                            │           ▼               │   │  │
                          │  │                                            │  Eat / cast / harvest     │   │  │
                          │  │                                            │  = every action moves Taint│  │  │
                          │  │                                            └───────────┬───────────────┘   │  │
                          │  │                                                        │ Taint rises        │  │
                          │  └────────────────────────────────────────────────────────┘                   │  │
                          │                                                                                  │
                          └──────────────────────────────────────────────────────────────────────────────────┘
```

Read it as: the **moment-to-moment** loop continuously pushes Taint up (and occasionally vents it through casting); the **Expedition** loop bounds one out-and-back trip and ends on the bank/purge/invest decision; the **meta** loop spends what you carried home as permanent build power and reclaimed ground, against a world-clock that never stops deepening.

---

### 4.2 Moment-to-moment loop (seconds–minutes)

This is the texture of play — what the hands do continuously while out in the Reach.

**The cycle:**
1. **Read the environment.** Light radius is finite; the gloom hides resource nodes (clean vs blighted), the Wake, and the zone's decay state (fringe / decayed / blighted core — see §11). Reading correctly is how you decide whether the next 30 seconds are a fight, a harvest, or a retreat.
2. **Manage light.** Light is the single thing that suppresses Taint gain (lit ×1 vs dark ×5 — §6.2). Torches and lantern oil are consumable and finite, so every step deeper trades light-budget for objective-progress. Running out of light mid-Expedition is the signature spike (Taint gain ×5) — the "closing dark."
3. **Engage or avoid the Wake.** Combat is deliberate and stamina-gated (§9). The Wake's hunt-pressure scales with your current Taint band and the Tide (§10), so the more power you are carrying, the more the world hunts you while you carry it.
4. **Transact in the corruption economy.** Every meaningful action moves Taint: eating blighted food fends off hunger but raises Taint (§6.1); casting rot-magic or using rot-infused weapon arts spends Taint as an in-field release valve (§5.4); harvesting blighted nodes splashes a little Taint on; taking a wound while Fevered/Brink festers more in. There is no neutral action — the meter is always moving.

**Net of the inner loop:** Taint trends **up** while you survive and explore, and dips **only** when you choose to spend it in a fight. You are constantly reading "how hot am I, how dark is it, how close is the Wake, how full is my pack" — four readouts that are all, ultimately, the one meter and its inputs (§5).

---

### 4.3 The Expedition loop (the session — 30–90 min)

An **Expedition** is one round trip out from and back to a **Hearth**. It is the unit of session structure (full death/respawn framing in §12).

**The arc:**
1. **Depart.** Leave the Hearth's safe radius at `Taint = T_floor` (your build's irreducible minimum — §5.6). Inside the Hearth light there is no passive Taint gain; the moment you step out, the ambient clock starts (§6.2).
2. **Push outward.** Travel into more-decayed, more-encroached zones toward an objective — a **Reliquary** landmark or a resource frontier (§11). Deeper zones pay better (blighted cores hold the richest Blight) and cost more (higher ambient Taint, tougher Wake, worse weather — §6.3).
3. **Sustain the trip.** Spend light fuel, eat to hold off hunger, fight or evade. Taint climbs across the bands (Lucid → Marked → Fevered → Brink — §5.2); each band you cross raises spoilage, festering, and hunt-pressure, so the deeper-and-longer you go, the steeper the real-time danger.
4. **Decide the turnaround.** The skill expression of the Expedition is judging the turnaround point: light remaining, Taint band, hunger, and distance home, weighed against what you still want to grab. Greed here is what feeds the death model (§12).
5. **Return and resolve — the session climax.** Back at the Hearth with carried `Taint = T_end`, you make the **bank / purge / invest** decision (full spec and cost formula in §5.5):
   - **Bank** — keep `T_end`; next Expedition starts hot (higher band from minute one, overflow-to-Hollowing risk). Power potential preserved.
   - **Purge** — dump to `T_floor` for Hearth fuel + clean materials; safe next run, the banked power is gone for good.
   - **Invest** — convert `T_end` into permanent build power now (ascend a node and/or temper gear), then purge the remainder; lock the value in as build rather than carry-risk.

**Net of the Expedition loop:** you leave safe, get progressively less safe as you accumulate the very thing you came for, and end on a single weighty choice about how much of that danger to keep. No option is correct — that irreducible tension is the session's payload.

---

### 4.4 The meta loop (tens of hours)

The long game spends what the Expeditions bring home, against a clock that deepens with or without you.

**The four meta drives:**
- **Ascend a Path.** Invest banked Taint at a Hearth into the **Warded** (resist) and/or **Tainted** (embrace) trees plus martial/craft skills (§8). Ascension is a Hearth transaction that spends Taint (§5.4); Tainted nodes raise both your ceiling and your survival difficulty (`T_floor` and `T_max`), Warded nodes lower your floor. **Choosing a build is choosing your survival mode** (§5.6) — there is no separate difficulty slider doing this work.
- **Temper gear.** Spend Taint + Blight materials to raise gear tiers (§7). Equipped tempered gear raises your `T_floor` — power is literally bought with permanent survival difficulty.
- **Reclaim the map.** Defeat region **Wardens** to kindle **Greater Hearths**, rolling the Long Dusk back locally and pinning a region's decay one step better while it stays fueled (§6.5, §11). The reclaimed map is **impermanent** — lapse the fuel or lose the Hearth and the rot creeps back. You hold ground hearth by hearth; you never finally win.
- **Fight the descent.** Death and Brink exposure ratchet **Hollowing**, the permanent soft-permadeath track (§5.7). The only reducer is the rate-limited Cleansing rite at a Greater Hearth. The strongest (Tainted) builds live closest to **turning** — the meta loop is partly a campaign to stave that off.

**Race the clock.** The global **Long Dusk** deepens in **Tides** roughly every ~10 hours of cumulative out-in-the-Reach time (§6.5). Each Tide raises ambient Taint, Wake spawn-pressure, and encroachment speed — so standing still at base loses ground. This is the pressure that keeps the meta loop moving toward the endgame.

**End the story.** The arc terminates at the **Hollow Crown** with the locked three-ending choice — **End it / Master it / Be consumed** (frame in concept bible §9; quest delivery in §3). Settlement and world state persist across sessions (§13 for the co-op/shared-world case).

---

### 4.5 How the loops interlock

The three loops are one wheel seen at three zoom levels, coupled by the corruption economy:

- **Up-coupling (inner → outer):** every moment-to-moment action moves Taint, so the inner loop *is* what produces the `T_end` that the Expedition climax decides on, which *is* the banked Taint the meta loop spends on Path and gear.
- **Down-coupling (outer → inner):** your meta-loop build sets `T_floor` and `T_max` (§5.6), which sets your resting threat band, which changes how dangerous the *very next* moment-to-moment second is. A Pure Tainted build starts every Expedition already in Marked/Fevered; a Pure Warded build starts deep in Lucid. The build you grind toward reaches back down and re-tunes the texture of play.
- **The clock couples everything:** the Long Dusk's Tides (§6.5) raise the ambient cost of the inner loop, shorten the safe window of the Expedition, and pressure the meta loop forward — the only loop with no "stand still" option.

**Illustrative full-wheel example (illustrative — to tune).** A Hybrid Revenant (`T_floor=20`, `T_max=100`) departs a Hearth at Taint 20 (meta-loop state). Over a 35-minute Expedition the moment-to-moment loop pushes Taint to 81 (Fevered) through dark travel, blighted meals, and a Wake fight partly vented by casting. At the climax they **invest** 50 into a Tainted ascension node (now `T_floor` rises toward a Heavy-Tainted profile) and purge the rest to floor. Next Expedition therefore *departs* hotter and hunts harder — the meta decision re-tuned the inner loop. Twelve hours of such Expeditions later, the world has advanced ~1 Tide; a kindled Greater Hearth has pinned one region back a step. The wheel has turned at all three scales, and every turn transacted in the same Taint.

> Cross-references: the corruption economy that powers all three loops is fully specified in §5; the survival inputs (hunger, light, weather, the Tide clock) in §6; crafting/Hearths/gear in §7; Paths/ascension in §8; combat in §9; the Wake/Wardens in §10; world structure and Reliquaries in §11; the death model and Expedition session structure in §12; co-op in §13.

---

<a id="sec-5"></a>

## 5. The Corruption System

> **Keystone specification.** This is the single most important system in WITHERREACH and the most rigorous section of this document. Everything else — survival (§6), crafting and Hearths (§7), RPG progression (§8), combat (§9), the Wake (§10), the death model (§12), and co-op (§13) — transacts in the economy defined here. The thesis (concept bible §8): **survival pressure and character power are the same resource — the Blight, carried as Taint — expressed through one meter the player must constantly trade in two opposite directions.** Survival meters are not chores bolted onto an RPG; they *are* the RPG economy.
>
> All numeric values are **illustrative — to tune**. They are a self-consistent starting set drawn verbatim from the survival-systems master spec, sufficient to build and balance against, not final.

---

### 5.1 The three quantities

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

### 5.2 The Taint meter — floor, ceiling, threat bands

#### Floor and ceiling

- **`T_floor`** — your build-set minimum Taint. **Neither purging nor casting can drop Taint below it.** This is the lever the concept bible calls "baseline Taint floor sets survival difficulty" (§8). Set **only** by **Path + slotted skills + equipped tempered gear** (plus Hearth upgrades for purge efficiency). The six character attributes (Vigor, Endurance, Might, Finesse, Attunement, Resolve) are derived-combat stats (§8) and **do not** touch the Taint economy — they never alter floor, ceiling, purge, or gain. *(One narrow combat-side exception: an Attunement-type attribute may modestly reduce rot-magic **cast cost** — a bounded, floor-capped modifier on the spend amount only, specified in §8/§9; it never alters floor/ceiling/purge/gain.)*
- **`T_max`** — your build-set carry ceiling. Tainted ascension raises it (hold more spendable danger); Warded keeps it low. Taint cannot exceed `T_max` (overflow rule below).

#### Threat bands (the survival readout)

Threat keys on the **fraction `f = Taint / T_max`**, so the bands auto-scale to any build — a build with a high floor *rests* in a higher band, which is exactly how "the strongest builds live one bad Expedition from turning" is expressed numerically.

| Band | `f` range | Survival meaning *(illustrative — to tune)* |
|---|---|---|
| **Lucid** | 0.00 – 0.35 | Baseline. Faint corruption glow. No penalties. |
| **Marked** | 0.35 – 0.60 | Carried food/supplies spoil ×1.5; minor Wake hunt-pressure (+1 tier); first cosmetic mutation. |
| **Fevered** | 0.60 – 0.85 | Wound **festering** (healing −40%, slow HP bleed if hit); spoilage ×2.5; Wake hunt-pressure +2 tiers; screen/audio corruption FX. |
| **Brink** | 0.85 – 1.00 | **Turning-risk.** Hollowing accrues **+1/min** while here (§5.7). Maximum Wake hunt-pressure. Hard telegraph — vignette, heartbeat, whispers (UI: §14). |

#### Overflow

Taint cannot exceed `T_max`. Any gain that would exceed it **spills into Hollowing at 50%** *(illustrative — to tune)*: 2 excess Taint ⇒ +1 Hollowing. Greed past the ceiling permanently costs you, and this hard-caps how hot you can bank.

---

### 5.3 Taint SOURCES (gain)

Surviving the corrupted world raises Taint. There are continuous (ambient, per-minute) and discrete (per-event) sources.

#### Ambient gain formula

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

#### Discrete sources (per event)

| Source | Taint | Notes |
|---|---|---|
| Eat **blighted** food | **+6 … +15** | Scales with satiation value (§6.1). The hunger on-ramp into the economy. |
| Eat **clean** food | **+0** | Rare, low satiation — the only Taint-free calories. |
| **Render** Blight resource → Taint | **+2 … +8** per unit | **Player-elected.** You may instead bank the raw material in your pack at no Taint cost. |
| Harvest a **blighted node** (raw) | **+1 … +3** | Small unavoidable splash while harvesting in the rot. |
| Take a wound while **Fevered/Brink** (festering) | **+1 … +3** per hit | Corruption enters the wound; couples combat risk to the meter. |
| **Death** | — | No Taint *gain*; death advances **Hollowing**, not Taint (§5.7, §12). |

---

### 5.4 Taint SINKS (loss)

Taint goes down **only** via these. **None is passive.** Sinks split into **in-field** spends (during an Expedition) and **Hearth transactions** (at the safe haven). Every in-field spend is **floor-capped** — it cannot drop Taint below `T_floor`.

#### In-field spends (Expedition)

| Sink | Taint | Rules | Owner |
|---|---|---|---|
| **Cast rot-magic** | **−4 … −12** (Lesser 4–6 / Standard 6–9 / Greater 9–12) | Floor-capped. A fight is also a *de-corruption*. Damage/scaling/cooldowns: §9. | cost here / effect §9 |
| **Rot-infused weapon arts** | **−2 … −8** each | Floor-capped. Kept in a small, repeatable band so the player can still read their band mid-fight. | cost here / effect §9 |
| **Ascendant Ultimate** | **−20 … −40** | Tainted-capstone climactic ability — **not** a repeatable cast. Charged/channelled, gated **≤1 per Expedition** (or Hearth-primed). Floor-capped: requires `Taint ≥ T_floor + cost` to fire. | cost here / effect §9 |

> **Mechanical role of the Ultimate:** a deliberate, rare panic-escape. A single Ult can yank a Tainted build out of **Brink** in one wind-up — e.g. 178 → 138 at `T_max = 210` ⇒ `f` 0.85 → 0.66 — halting Brink Hollowing-accrual. Because it is gated once/Expedition and floor-capped, it reinforces "turning is stave-off-able" without becoming a spammed dump; the player still climbs back up and still ratchets Hollowing through deaths and overflow.

> **The floor-cap is load-bearing:** because every in-field spend is floor-capped, a high-floor Tainted build literally **cannot cast/art/ult itself below its `T_floor`**. This is the mechanical reason the strongest builds rest in the danger bands and can never fully self-purge in the field — they must come home to a Hearth to get safe.

#### Hearth transactions

| Sink | Taint | Rules | Owner |
|---|---|---|---|
| **Temper gear** | **−20 … −50** + Blight materials | Per temper. Raises a gear piece's tier/stats. **Equipping tempered gear raises `T_floor`** — power literally buys survival difficulty (§7, §6.2). | cost here / gear §7 |
| **Ascend skills** | **−30 … −80** per node | Spends banked Taint (ruling A). Permanent build power. Tainted nodes raise `T_floor` and `T_max`; Warded nodes lower `T_floor` (and raise purge efficiency / cap `T_max`). Node effects: §8. | cost here / effect §8 |
| **Purge** (the safety valve) | drives Taint **down to `T_floor`** (never below) | Consumes **Hearth fuel + clean materials**, channelled ~10–30 s. Cost formula below. | here / Hearth §7 |
| **Death corpse-cache** | drop carried Taint **above `T_floor`** as a recoverable cache | Respawn at last lit Hearth at `T_floor`; retrieve the cache to recover the banked power, or lose it. Death also advances **Hollowing** (§5.7). Full death model: §12. | here / model §12 |

#### The purge cost curve

Purge is **always available, but its price climbs with Hollowing** — the descent has grip, but is never a dead end (guardrail, §5.8).

```
PurgeCost(fuel) = k_p × ΔTaint × (1 + Hollowing / 100)
ΔTaint = Taint − T_floor        k_p = 0.4   (illustrative — to tune)
```

- Purging **60 Taint at Hollowing 0** ⇒ `0.4 × 60 × 1.0` = **24 fuel**.
- The **same purge at Hollowing 50** ⇒ `0.4 × 60 × 1.5` = **36 fuel**.
- The more Hollowed you are, the more expensive escape becomes — but it stays finite at any Hollowing, so you are never structurally trapped. Hearth purge-efficiency upgrades lower `k_p` (§7).

---

### 5.5 The Hearth decision — bank / purge / invest

This is the session climax (the moment the Expedition loop in §4 turns on). At the Hearth with carried `Taint = T_end`, you split it three ways. **Three claimants compete for the same banked Taint — purge, temper, ascend.**

| Choice | What you do | Trade |
|---|---|---|
| **Bank (hold)** | Keep `T_end`. | Next Expedition starts hot — higher band from minute one ⇒ more festering, spoilage, hunt-pressure, and overflow-to-Hollowing risk. **Power potential preserved.** |
| **Purge** | Dump to `T_floor` for fuel + clean materials (cost curve above). | **Safe next run; the power you'd banked is gone for good.** |
| **Invest** | Convert `T_end` into permanent power now — ascend a node and/or temper gear — then purge the remainder. | **Locks the value in as build, not carry-risk.** Raises `T_floor` if Tainted/tempered. |

Neither is correct — that irreducible choice is the core tension of every session.

#### Worked Expedition *(illustrative — to tune)*

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

### 5.6 Build = survival difficulty (the Taint-floor model)

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

### 5.7 Hollowing — the soft-permadeath track

Hollowing is the permanent corruption ratchet you fight for the entire game (concept bible §11; full session/death model in §12). It is **not** roguelike erasure and **not** consequence-free — it is a slow, telegraphed, stave-off-able descent toward **turning**.

#### Hollowing gains *(illustrative — to tune)*

| Source | Hollowing |
|---|---|
| **Death** | **+5 base, + up to +5 scaled by banked-Taint fraction at death** (`+5 × f`). Dying *hot* hurts more ⇒ ~10–20 deaths to turn if you die cold, far fewer if you die at Brink. |
| **Brink exposure** | **+1 / min** while `f ≥ 0.85`. Leaving Brink stops it instantly. |
| **Overflow spill** | per §5.2 — 2 excess Taint over `T_max` ⇒ +1 Hollowing. |

Hollowing **cannot be purged by normal means.** It is a near-ratchet — a disciplined Warded player can hold the line indefinitely; a greedy Tainted player still ratchets toward turning, matching "the strongest builds live closest to turning."

#### The turning telegraph (10 pips — "telegraphed, not a surprise")

Hollowing reads as 10 pips of 10. Turning is never a silent wipe; it announces itself across the whole track:

| Pips | State |
|---|---|
| **0–3** | Cosmetic marks, faint whispers. |
| **4–6** | Stat drift: Warded skills weaken, Tainted strengthen; the Wake grows **less** aggressive (you begin to smell like them). |
| **7–8** | **"The Pull"** — periodic involuntary twitches, vision corruption, NPCs recoil. |
| **9** | **Brink of Turning** — strong audiovisual telegraph; last-chance rites unlocked; in co-op the party is explicitly warned. |
| **10 (= 100)** | **Turn** → the character becomes a Wake-creature (concept bible §9 "Be consumed"; turned entities populate the world / co-op — §10, §13). |

#### Stave-off (a fought descent, not a wipe)

- The **Cleansing rite** at a **Greater Hearth** removes **1 pip (−10 Hollowing)** for a large clean-resource cost, **rate-limited to ≤ once per Tide per Greater Hearth**. This is the **only** Hollowing reducer — extraordinary, not normal purge.
- A disciplined Warded player can hold indefinitely; a greedy Tainted player still trends toward turning. Turning is the survival-RPG's "real" death, and you fight it for the whole game.

---

### 5.8 The survival → power → risk loop (and guardrail compliance)

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

### 5.9 Cross-domain interfaces

This section owns the **Taint cost** of every transaction, the **threat bands**, the **floor/ceiling model**, **Hollowing**, and the **bank/purge/invest** decision. It does **not** own:

- **Rot-magic damage/scaling/cooldowns, weapon arts, the Ascendant Ultimate's effect, and the cast-cost-efficiency attribute modifier** — §9 (combat); ascension-node *effects* and the six attributes — §8 (RPG progression). This section provides only the Taint *cost* and the floor/ceiling deltas.
- **Hearths, base-building, gear tiers, tempering ingredients, fuel, and clean/blighted resource sourcing** — §7 (crafting, building & economy).
- **Survival inputs** that *drive* Taint gain — hunger, light/dark, weather, the Long Dusk clock & Tides — §6 (survival systems).
- **Wake hunt-pressure tiers and Wardens** keyed off Taint band and Tide — §10 (enemies & AI); region decay states — §11 (world structure).
- **The corpse-cache death model, respawn, and Expedition session structure** — §12; **co-op Blight-transfer revive** (reviver pays ~30 Taint, transferred to the revived ally) and shared-Hearth persistence — §13.
- **HUD readability** of the meter, bands, and Hollowing pips — §14.

---

<a id="sec-6"></a>

## 6. Survival Systems

> **Principle (concept bible §8):** survival pressure in WITHERREACH is **not** a stack of orthogonal chore-meters. Every survival pressure is expressed through the **one** corruption economy defined in §5 — either as a **Taint-rate** modifier (light, weather, shelter) or as a **Taint-supply** on-ramp (food). **There are no standalone temperature, sanity, or thirst bars.** The only extra visible need is **Hunger**, and even its sustainable answer routes through the Blight economy. This section specifies those survival inputs and the world-clock (the Long Dusk and its Tides) that scales them; it references §5 for the meter itself, §7 for crafting/Hearths/shelter construction, and §11 for region decay states.
>
> All values are **illustrative — to tune**, drawn from the survival-systems master spec.

---

### 6.1 Hunger — the Taint supply on-ramp

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

### 6.2 Light vs dark — warmth and shelter, folded into Taint-rate

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

### 6.3 Weather — Taint-pressure, not a separate stat

Weather is purely a **Taint-rate modulator and light suppressor** (`weather_mult` in §5.3). There is **no separate weather survival stat**; a storm hurts you only through the corruption economy.

| Event | `weather_mult` | Light radius | Duration / telegraph |
|---|---|---|---|
| **Clear** | ×1.0 | — | Default. |
| **Ashfall** | ×1.5 | −20% | Sustained. |
| **Blight-storm** | **×3.0** | **−50%** | 2–4 min, telegraphed **~30 s** out. |

- **Frequency rises with the Tide** (§6.5) — the deeper the Long Dusk, the more often storms hit.
- **Counterplay is base-building** (§7): shelter quality reduces a storm's `weather_mult`. A roofed, warded shelter turns a Blight-storm from **×3.0 → ≈×1.3**. This is *how* base-building earns its keep inside the corruption economy — it is shelter-against-Taint-rate, not "temperature shelter."

---

### 6.4 What is explicitly NOT a separate meter

For clarity to systems and UI (§14), the following are **deliberately not** modelled as standalone bars — each is folded into the one Taint economy:

| Classic survival meter | In WITHERREACH it is… |
|---|---|
| Temperature / cold | the **dark's Taint multiplier** (`light_mult ×5`, §6.2). |
| Exposure / weather | a **`weather_mult` on Taint gain** (§6.3), countered by shelter. |
| Sanity | a **band/Hollowing effect** — corruption FX and "The Pull" come from Taint band (§5.2) and Hollowing pips (§5.7), not a sanity bar. |
| Thirst | **not modelled** as a separate need. |

**Hunger is the one extra visible bar** (§6.1) — and its only sustainable answer is the Blight food economy. This is a core USP: one corruption economy instead of a chore-meter stack (concept bible §4, §8).

---

### 6.5 The Long Dusk — the decay clock and its Tides

The world is dying on a clock, with or without the player (design pillar 2). The macro pressure that pushes the meta loop (§4.4) forward is the **Long Dusk** and its **Tides**.

#### No day/night — permanent dusk

The Reach sits in permanent rotting twilight (concept bible §5). There is **no day/night cycle**; the in-Expedition rhythm comes from **weather surges** (§6.3), not sunrise. This keeps the only periodic environmental pressure tied to the corruption economy.

#### The macro clock — Tides (cadence)

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

#### Encroachment — the map as a tide

- Each region carries a **decay-state**: **fringe → decayed → blighted core** (full region/biome treatment in §11). These states drive the `base_zone` ambient Taint (§5.3).
- **Unheld regions worsen one decay step per Tide.** A lit **Greater Hearth rolls its radius back one step and pins it while fueled**; if its fuel lapses or it falls, decay creeps back in. The reclaimed map is therefore **impermanent** (USP #2) — "Earn the Light" is an ongoing maintenance cost, not a one-time conquest (pillar 4).

> Cross-references: the Taint meter, bands, and overflow that all of the above feed are specified in §5; Hearths, fuel, shelter-building, and the clean/blighted resource tracks in §7; the Wake spawn-pressure tiers and Wardens in §10; region decay states, biomes, and Reliquaries in §11; the death/respawn model in §12; HUD readouts for hunger, light, and weather in §14.

---

<a id="sec-7"></a>

## 7. Crafting, Building & Economy

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

### 7.1 The two ledgers (boundary statement)

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

### 7.2 Resource taxonomy — clean vs blighted (the two-track supply)

All harvesting and crafting draws from two opposed resource tracks. (Source table mirrors
survival economy; see §6 for where each is found, §5 for the Taint splash on blighted harvest.)

| | **Clean** | **Blighted** |
|---|---|---|
| Abundance | Scarce — only in held / Lucid zones and behind cleared **Wardens** | Plentiful — in decayed and blighted-core zones |
| Taint to harvest | 0 | +1–3 splash per node (see §5) |
| Used for | Hearth fuel, purge cost, **Cleansing rite**, clean (T1 Forged) gear, clean food, repair | Tempering, Tainted (T2/T3) gear, blighted food, **render → Taint** |
| Strategic role | The **safety** resource (gates purge, fuel, stave-off) | The **power** resource (gates the build) |

#### 7.2.1 Concrete resource roster (illustrative — to tune)

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

### 7.3 Crafting system

#### 7.3.1 Crafting stations

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

#### 7.3.2 Recipe format & sample recipes (illustrative — to tune)

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

### 7.4 Gear-tier system

Four tiers. The defining economic property — locked with the survival economy — is that **gear
power and survival difficulty are the same axis**: there is no "strong + safe" gear, only
"strong + hot" or "modest + stable."

| Tier | Source | Material track | Effect on the floor |
|---|---|---|---|
| **T0 Scavenged** | Found in the world | — | None; weak, no `T_floor` impact |
| **T1 Forged** | Crafted at Forge | **Clean** materials | Reliable; no / low `T_floor` impact — the Warded baseline |
| **T2 Tempered** | T1 + **temper** (§7.5) | Clean base + **Taint + Blight mats** | Stronger; **+`T_floor` per piece equipped** (§5/§8) |
| **T3 Ascended** | T2 + ascension node (§8) | + **Crown-shard / Warden relic** | Build-defining; largest `T_floor` / `T_max` shift (§8) |

#### 7.4.1 The two upgrade rails (mirrors the path tension)

Every weapon/armor line can be pushed up **one of two rails** — this is the gear-economy
expression of the Warded↔Tainted choice (§8):

- **Clean reinforcement** (Forge, **clean materials only**, a smith action — *no Taint cost*):
  raises physical stats, durability, and poise. **No `T_floor` change.** Lower ceiling. The
  **Warded** rail. Pairs with **Lightcraft** buffs (blessed oil, hearth-fire enchant — clean-fuelled
  anti-**Wake** damage; mechanics in §9).
- **Blight-tempering** (§7.5): higher ceiling, adds **Rot** scaling / innate Rot, **+`T_floor` per
  equipped piece**. The **Tainted** rail.

#### 7.4.2 Gear slots (illustrative)

6 equip slots feeding the `T_floor` total (§8 archetype math): main-hand, off-hand
(shield / catalyst / second weapon), head, chest, hands, legs. **Equip-load** (`EL%`, §8/§9) is
the second cost of armor weight; tempered plating is heavy *and* hot.

---

### 7.5 Tempering (the Taint + Blight-materials process)

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

### 7.6 The Hearth — build & upgrade tree

The **Hearth** is the spine of the game (§5/§6 keystone): a warded fire/shrine that is the **only**
place you **bank / purge / temper / ascend / Cleanse**, the **respawn** point (§12), and a **safe
radius** where ambient Taint gain is **0** (§5/§6). It must be **built and fuelled** — an unfuelled
Hearth goes dark: no safe radius, no respawn.

#### 7.6.1 Fuel model (locked anchors; burn rates illustrative — to tune)

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

#### 7.6.2 Upgrade categories & tree (illustrative — to tune)

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

### 7.7 The Greater Hearth — region-scale build tree

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

### 7.8 Base-building

Base-building is the constructed safety layer around a Hearth. It is **not** a separate survival
system — every structure feeds back into the Taint economy via **light**, **shelter (`weather_mult`)**,
and **station access**.

#### 7.8.1 Structure system (illustrative — to tune)

- **Snap-grid placement** of modular pieces (foundations, walls, roofs, doors, stairs) keyed to
  build materials: **Heartwood / Wardstone** (clean, durable) or **Rotwood** (blighted, cheap, but
  contributes a small ambient Taint near the structure — never build your safe-room from rot).
- **Shelter quality** is computed from enclosure (roof + walls + Wardstone warding) and feeds the
  **storm-shelter** reduction of `weather_mult` (§7.6.2 / §6). A fully enclosed, Wardstone-warded
  room reaches the ×1.3 floor; an open lean-to does not.
- **Functional placement:** crafting stations (§7.3.1), storage, and light sources are placed
  within the base; the Hearth's safe radius defines where they operate.

#### 7.8.2 Hearth defence vs the Wake (raid layer)

Hearth raids are **authored against hunt-pressure, not on a fixed timer**: a raid trigger keys off
the player's **Taint band + Long-Dusk Tide** (the §10 / §5 hunt-pressure model — *banking hot near
a Hearth invites a raid*). Defensive structures (palisades, warded stakes, blessed braziers — the
latter deal **Light/Cleansing** damage to the **Wake**, §9) let a player trade clean materials for
standing defence. **Wake raid behaviour and stats are owned by §10**; this section owns only the
*material cost* of defences and the *trigger coupling* to Taint/Tide.

> Design note: raids make "Earn the Light" spatial — a hot, under-defended Hearth in a late Tide is
> a liability, reinforcing the bank-or-purge tension at the base itself.

---

### 7.9 The economy — sources & sinks ledger

The **material/resource ledger** (this section). The **Taint-meter ledger** is §5 — cross-referenced,
never restated here as if owned.

#### 7.9.1 Resource SOURCES (material gain)

| Source | Yields | Track |
|---|---|---|
| Harvest clean nodes (held/Lucid zones) | Heartwood, Pale Tallow, Saltbone, Clearwater, Emberbark, Wardstone | **Clean** |
| Harvest blighted nodes (decayed/core) | Rotwood, Blightsap, Festered Hide/Chitin, Miasma Salts | **Blighted** (+Taint splash, §5) |
| Slay the **Wake** (§10) | Wake-essence, blighted meat | **Blighted** |
| Salvage T0/found gear | Scrap materials | Mixed |
| **Warden** kill cache (§10) | Clean-material cache + **Crown-shard** + Warden relic | **Clean + unique** |
| Greater-Hearth held region | Steady clean-node access (decay pinned back) | **Clean** |

#### 7.9.2 Resource SINKS (material spend)

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

#### 7.9.3 The central economic tension

The **clean track is the scarce one**, and it is spent in *competition*: every Emberbark burned to
hold the light is one not spent purging; every Saltbone in a Cleansing rite is one not in blessed
oil or repair. The **blighted track is abundant but always charges Taint** to use (harvest splash,
temper, render). This asymmetry is the engine of the keystone (§5): you are always slightly short
on the resource that keeps you *safe*, and always surrounded by the resource that makes you
*powerful-but-corrupt*. There is no equilibrium — only the recurring bank/purge/invest decision
(§5/§8) made concrete in materials.

---

### 7.10 Co-op economy notes

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

### 7.11 Open Questions

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

---

<a id="sec-8"></a>

## 8. RPG Progression & Character Systems

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

### 8.1 Progression architecture (not classes — four mixable lanes)

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

### 8.2 The six attributes

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

#### 8.2.1 Resolve — the spine stat of the corruption economy

**Resolve** is the one attribute with no melee/magic analog. It lets a character **carry**
corruption more safely and **shed** it more cheaply:

- **`T_max += 1.5·RSV`** — widens the spendable band before **Brink** (§5), letting you bank more.
- **Purge efficiency:** contributes to `k_p_effective` (§5 purge curve) — cheaper escape.
- **Reduces Taint-driven Wake aggro and Hollowing-on-death** (§5/§10).

> **Resolve never lowers `T_floor`** — it widens the *usable band above* the floor. It makes
> "play with fire safely" a real investment, not a free pass. Warded builds prioritise it; Tainted
> glass-cannons skimp on it and pay for it in instability.

#### 8.2.2 Derived stats (references — owned by §9)

`HP = 300 + 25·VGR` · `SP = 80 + 4·END` · `EL% = carriedWeight / (40 + 1.5·END)` ·
`Poise = armorPoise + 0.4·END` · `T_max += 1.5·RSV` (§5) · carry weight `= 50 + 2·MGT`. **See §9**
for the full combat derivation; **§5** for how `T_max` and purge efficiency enter the meter.

---

### 8.3 The Vital lane (path-neutral attributes)

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

### 8.4 The ascension transaction (Hearth spend, Warden-gated)

#### 8.4.1 Ascension is a Hearth transaction (locked)

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

#### 8.4.2 Ascension Tiers gate on Warden kills (progression cadence)

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

#### 8.4.3 Floor / ceiling budget (sums into the survival anchors)

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

### 8.5 The Martial lane (path-neutral weapons & combat)

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

### 8.6 The Warded tree (resist corruption)

Theme: holding the line — light, purity, endurance, protecting allies. **Lowers `T_floor`, raises
purge efficiency, caps `T_max`.** Lower damage ceiling, highest survivability and support. Its
magic is **Lightcraft** — protective / anti-**Wake**, **clean-fuelled (it does *not* spend Taint)** —
the path-identity counterpart to the Tainted's rot-magic (Lightcraft *mechanics* are §9). **Four
branches** (names locked): **Hearthkeeping · Bulwark · Cleansing · Beacon.**

> Warded floor deltas are **clamped at the innate ~5** — they cannot push a build below it. Their
> real work is to *claw back* floor added by tempered gear or hybrid Tainted dabbling, to cap
> `T_max`, and to stack purge efficiency. A pure-Warded build sits at the innate floor by virtue of
> taking *no* Tainted nodes/gear; Warded investment buys the *band control and purge* on top.

#### 8.6.1 Hearthkeeping (purge, banking, light economy)

| Node | Tier | Effect | Floor Δ | `T_max` Δ |
|---|---|---|---|---|
| **Tend the Flame** | I | +purge efficiency (−`k_p`), faster banking | −2 | −5 |
| **Wide Warding** | II | +Hearth safe radius, cheaper Cleansing contribution | −3 | −6 |
| **Frugal Light** | III | Light-fuel economy (sources burn slower) | −3 | −8 |
| **Everlight** | V (capstone) | Equipped light burns **50% slower**; its radius **suppresses *party* Taint gain** | −6 | −10 (cap) |

#### 8.6.2 Bulwark (poise, mitigation, festering resistance)

| Node | Tier | Effect | Floor Δ | `T_max` Δ |
|---|---|---|---|---|
| **Set Stance** | I | +poise, +guard stability | −2 | −5 |
| **Thick Skin** | II | Flat damage reduction | −3 | −6 |
| **Stalwart** | III | Festering resistance (synergy with VGR; §5/§9) | −4 | −8 |
| **Unbowed** | V (capstone) | Hyperarmor on guard; **cannot be staggered above X% stamina** (§9) | −7 | −10 (cap) |

#### 8.6.3 Cleansing (reduce Taint gain & Hollowing)

| Node | Tier | Effect | Floor Δ | `T_max` Δ |
|---|---|---|---|---|
| **Clear Mind** | I | Reduce personal Taint **gain rate** (a `light_mult`/zone discount, §5/§6) | −3 | −5 |
| **Slow the Rot** | II | Slow supply spoilage; reduce Hollowing-on-death (§5) | −4 | −6 |
| **Turn the Wound** | III | Convert a sliver of incoming **Rot** damage to stamina (§9) | −4 | −8 |
| **Hold the Line** | V (capstone) | Once/Expedition, **purge to floor in the field** (no Hearth) for a clean-material cost (§7) | −8 | −10 (cap) |

#### 8.6.4 Beacon (co-op / support)

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

### 8.7 The Tainted tree (embrace corruption)

Theme: rot-magic, mutation, glass-cannon power drawn from the carried meter. **Raises `T_floor`
AND `T_max`.** Highest ceiling in the game; lives in the danger bands at rest. The Tainted
**Rot-Sorcery** branch is **what unlocks rot-magic** (the spell schools and their **Taint-spending
cast mechanics are §9**). **Four branches** (names locked): **Rot-Sorcery · Mutation · Feral ·
Ascendant.**

#### 8.7.1 Rot-Sorcery (the spell school — unlocks rot-magic; mechanics §9)

Unlocks/empowers spells, adds spell-slots (`slots = 2 + floor(ATN/12) + Rot-Sorcery nodes`, §9),
shifts cast cost toward the cheap end of the −4…−12 band (§5), +Attunement synergy. The five
schools (Affliction, Wrack, Miasma, Carrion, Bloodrot) and their costs/effects are **owned by §9**.

| Node | Tier | Effect | Floor Δ | `T_max` Δ |
|---|---|---|---|---|
| **Blightcaller** | I | Unlock **Lesser** rot-magic + 1 spell slot | +5 | +12 |
| **Festermind** | II | Unlock **Standard** spells, +1 slot | +7 | +14 |
| **Plaguewright** | III | Unlock **Greater** spells, +spell potency | +12 | +22 |
| **Plaguelord** | V (Ascendant capstone) | Unlock an **Ascendant Ultimate** (charged/gated, −20…−40 Taint; §5/§9) | +18 | +30 |

#### 8.7.2 Mutation (passive body-warping — names locked: Claws / Carapace / Blightveins / Gorge)

Each mutation is a passive buff that raises the floor.

| Node | Tier | Effect | Floor Δ | `T_max` Δ |
|---|---|---|---|---|
| **Claws** | I | Natural slash weapon, **scales ATN** (§9) | +4 | +12 |
| **Carapace** | II | Innate armor / poise, **no equip-load cost** (§9) | +6 | +14 |
| **Gorge** | II | **Blighted food also heals HP** (§5/§6) | +5 | +12 |
| **Blightveins** | III | A % of your **carried Taint adds to weapon damage** — power scales with how corrupted you are (§9) | +13 | +24 |
| **Wakeform** | V (Ascendant capstone) | Transformation: trade Hollowing-risk for a burst of stats (§5/§9) | +20 | +36 |

#### 8.7.3 Feral / Wake-kinship (names locked: Carrion Feast / Frenzy / Shroud)

Predator traits; the deepest nodes invert the hunt (the camouflage payoff, §10).

| Node | Tier | Effect | Floor Δ | `T_max` Δ |
|---|---|---|---|---|
| **Carrion Feast** | I | Lifesteal vs the **Wake** (§9/§10) | +4 | +10 |
| **Frenzy** | II | Attack speed **scales with Taint band** — strongest at Fevered/Brink (§5/§9) | +7 | +16 |
| **Shroud** | III | At high Taint, low-tier Wake **stop aggroing** — you read as one of them (§10) | +11 | +22 |
| **One of the Tide** | V (Ascendant capstone) | Full **Wake-camouflage** among all but elites while at **Brink** (§10) | +22 | +40 |

#### 8.7.4 Ascendant (the ceiling branch — where 90→210 and "nearest turning" are bought)

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

### 8.8 Build archetypes — build = survival difficulty

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

#### 8.8.1 Worked floor accounting (illustrative — to tune)

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

#### 8.8.2 The Ascendant Ultimate as a Brink escape (cross-ref)

A **Plaguelord / Ascendant Crown** build's once-per-Expedition **Ascendant Ultimate** (−20…−40 Taint,
floor-capped; mechanics §9, cost §5) doubles as a deliberate **Brink** panic-escape: one charged ult
can yank a deep-Tainted build out of turning-risk in a single wind-up, halting Brink Hollowing-accrual
(§5). Because it is gated once/Expedition and floor-capped, it **reinforces** "turning is
stave-off-able" without becoming a Hollowing dump — the player still climbs back up afterward.

---

### 8.9 Turning & the progression endgame (cross-references)

- **Turning** (§5/§12): a character who maxes **Hollowing** turns into a **Wake**-creature. The
  progression hook is that the **build seeds the turned entity's kit** (§10) — a turned **Rotcaller**
  becomes a caster-Wake, a turned **Ash-Knight** a poise-brute. This makes the deepest-Tainted builds
  (§8.8) both the strongest *and* the most consequential when they fall.
- **Endgame choice** (§3 / bible §9): a deep **Tainted** / **Hollowing-Ascendant** build is the
  natural fit for the **"Master it (the Crown)"** ending; a disciplined **Warded** build can hold the
  line for **"End it (the Pyre)"**; maxing Hollowing reaches **"Be consumed."** Progression and the
  narrative ending are the same axis — **the floor you chose is the ending you trend toward.**

---

### 8.10 Open Questions

- **Per-node band vs archetype-anchor ratio.** The §8.4.3 Tainted `T_max` band (≈2× the floor delta)
  and the locked Pure-Tainted anchor (floor +70 → `T_max` +110, ≈1.57×) do not reconcile by a naïve
  per-node sum. Resolved here by tuning node `T_max` deltas toward the **low edge** of band so a
  *focused* allocation lands on the **210** ceiling. Flagged for the §5/§9 balance pass — whether to
  (a) keep low-edge tuning, (b) add a soft `T_max` diminishing curve, or (c) split a dedicated
  ceiling-only node track. The **anchors are binding**; this is a path-to-anchor question only.
- **Tempered-gear floor cap (shared with §7).** Six tempered pieces at +15 would overshoot the
  ~+15 gear budget in §8.8.1. Intent: gear floor is capped/diminishing, not a per-slot sum. Exact
  rule is a §5/§7/§8 balance-pass decision (also flagged in §7).

---

<a id="sec-9"></a>

## 9. Combat Design

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

### 9.1 Combat philosophy — deliberate, committed, stamina-gated

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

### 9.2 Stamina economy

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

### 9.3 Attacks & motion values (committed)

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

### 9.4 Poise, stagger & criticals (the stagger economy)

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

### 9.5 The guard layer — block & parry

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

### 9.6 The damage model

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

### 9.7 The damage-type triangle (path choice = effectiveness vs. enemy type)

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

### 9.8 Weapon archetypes

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

### 9.9 Weapon Arts & the two upgrade rails

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

### 9.10 Rot-magic — the bridge (full spec)

Rot-magic is the **mechanical bridge between combat and the corruption economy**: it is powered by
**spending Taint straight off the carried meter** (§5.4), so **casting in-field lowers your survival
threat** in the moment — the **in-field release valve**. But you must have *carried* the Taint to cast
it, and your **`T_floor` caps how far casting can bring you down** (a deep Tainted build can never cast
itself safe — §5.6). Mid-Expedition this loops the caster through the economy: **cast (shed danger +
deal damage) → re-gather Taint (blighted food, darkness) → cast again.**

#### 9.10.1 Casting framework

- A **Catalyst** (rot-staff / bone-relic) must be in hand.
- Spells are equipped into **Attunement slots**: `slots = 2 + floor(ATN/12) + Rot-Sorcery nodes` (§8).
- **Spell power** scales with **Attunement** (and the **Blightveins** mutation adds a % of *carried
  Taint* to it — §8). **Cast speed** scales with FIN/ATN.
- Casts have **commitment**: a windup and a recovery, dodge-cancellable only after recovery begins.
  **Weighty, not spammy** — a cast is a committed attack like any heavy swing (§9.3).

#### 9.10.2 Spell tiers → Taint cost (locked inside §5's −4…−12 band)

| Tier | Taint cost | Role |
|---|---|---|
| **Lesser** | **−4…−6** | Spammy bolts, single Rot-applicators, utility. |
| **Standard** | **−6…−9** | Bread-and-butter: bursts, cones, short DoT clouds. |
| **Greater** | **−9…−12** | Nukes, big AoE, summons — the top of *repeatable* casting. |
| **Ascendant Ultimate** | **−20…−40** (charged / channelled, gated **≤1 per Expedition**) | **Not a normal cast.** Floor-capped activation: requires `Taint ≥ T_floor + cost`. Doubles as a **Brink panic-escape** (one ult yanks a deep build out of turning-risk — §5/§8.8.2). |

Every in-field cast is **floor-capped** — it can never drop Taint below `T_floor`. This is the
load-bearing reason the strongest builds rest in the danger bands and must come home to a Hearth to
get truly safe (§5.6).

#### 9.10.3 The five schools (within the Tainted **Rot-Sorcery** branch, §8)

| School | Role | Signature |
|---|---|---|
| **Affliction** | **Rot** DoT | Hits apply **Rot stacks**; at threshold the target **festers** — a burst + lingering DoT (mechanically twins survival's festering, §5/§9.13). |
| **Wrack** | Single-target burst | The boss-killer school — high Rot vs. living **cores** (§10 Warden phase-2). |
| **Miasma** | AoE / zone control | Rot clouds, slows, area denial. |
| **Carrion** | Summons | Animate Wake fragments from corpses as temporary minions — corpses are ammo, an action-economy school. |
| **Bloodrot** | Self-buff | Convert carried Taint into a weapon **rot-enchant**, **lifesteal**, or **Frenzy** — the hybrid-melee caster's bridge; vents a chunk of Taint up front into a damage window. |

#### 9.10.4 The Ascendant Ultimate (the gated climax)

Tainted-capstone abilities (unlocked by **Plaguelord** / **Ascendant Crown**, §8) — charged or
channelled, **once per Expedition** (or Hearth-primed). They are the only ≥20-Taint in-field sink and
are gated precisely so they don't break the "fire several casts per fight, band-readable" rule. Their
**effects** (e.g. a screen-clearing miasma detonation, a self-transformation *Wakeform* trading
Hollowing-risk for stats) are §9-owned; their cost and Brink-escape role are §5/§8.

---

### 9.11 Ranged combat

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

### 9.12 Lightcraft — the Warded counterpart

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

### 9.13 Status effects

| Status | Applied by | Effect |
|---|---|---|
| **Rot** | Rot-magic, blight-tempered weapons, blight-bombs | Builds **Rot stacks**; at threshold the target **festers** — a damage burst + a lingering DoT. On the *player*, festering ties to the §5 Fevered/Brink bands (healing −40%, HP-bleed-if-hit). |
| **Sear** | Lightcraft, oil/light bombs, hearth-fire | The **anti-Wake** status — burns through the Wake's rot-saturation; strong vs. the Hollowed; interrupts Carrion summons. |
| **Stagger** | Poise depletion (§9.4) | ~2 s open window; enables a critical. |
| **Festering (player-side)** | Owned by §5 | The survival readout of Fevered/Brink; couples combat wounds to the meter (a hit while Fevered adds **+1…+3 Taint**, §5.3). |
| **Bleed / Frost / etc.** | (Reserved) | Additional physical sub-statuses are a balance-pass addition, not core to launch. |

---

### 9.14 Master combat constants *(illustrative — to tune)*

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

### 9.15 Open Questions

- **Lightcraft fuel economy seam (§7).** Lightcraft is specified as clean-fuelled (no Taint cost); the
  exact charge/fuel currency (hearth-fuel vs. a dedicated "light charge") is a §7 crafting decision.
  Flagged so the Warded Path never accidentally acquires a Taint cost.
- **Status roster scope (§18).** Bleed/Frost and other physical sub-statuses are reserved, not specced
  — a content-scope call for the production roadmap.

---

<a id="sec-10"></a>

## 10. Enemies, the Wake & AI

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

### 10.1 Design philosophy — the Wake is dread and attrition

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

### 10.2 ThreatLevel — the spawn & hunt-pressure model

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

### 10.3 The Wake bestiary (six classes)

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

### 10.4 AI behavior framework

#### 10.4.1 Sensory model (three senses)

| Sense | Trigger | Counterplay |
|---|---|---|
| **Sight** | **Light-gated** — your lantern/torch reveals you; in the dark you are hard to see (but the dark raises Taint ×5, §6 — the trade). | Move dark *and* low-Taint; break line of sight. |
| **Sound** | Sprinting, combat, breaking nodes. | Crouch-walk; fight quickly and move on. |
| **Corruption-scent** | **Taint draws them** — high Taint = you "glow" to the Wake **regardless of light**. The unique sense that makes carrying power dangerous. | Lower your band (cast/purge); Beacon auras (§8/§13) suppress party scent. |

> **Stealth = low light + low Taint + crouch. It is impossible at Brink** — a Brink Revenant cannot
> hide; the corruption-scent overwhelms every other input. The deepest builds buy their way *around*
> this only with the camouflage inversion (§10.4.4).

#### 10.4.2 Group tactics & local alert

- Fodder **swarm/surround**; skirmishers **flank and bait** dodges; brutes **anchor**; afflicters
  **hang back** — the pack composition enforces spacing and target priority (§10.3).
- **Local alert / horde-build:** sustained noise/Taint in an area raises a **local alert level** that
  **pulls in more Wake** over time. Camping a rich node farms a horde down on yourself — the built-in
  "keep moving" pressure that mirrors the §6 clock.

#### 10.4.3 Hunters — the persistent elite

**Hunters (Stalkers)** are dispatched by high TL (§10.2) and run a **search → track → ambush** state
machine, **persisting for the whole Expedition**. They do not patrol a fixed leash — they hunt *you*,
re-acquiring across zones, ambushing at chokes and in the dark. A Hunter on your trail is the signal
that you are carrying too much Taint for the region and the Tide; **the answer is to vent, reach
light, or reach the Hearth** — you rarely simply out-DPS a Hunter while still hot.

#### 10.4.4 The camouflage inversion (Tainted Feral payoff)

At high Taint with **Wake-kinship** mutations (**Shroud** / **One of the Tide**, §8), low-tier Wake
**stop aggroing** — the deepest-Tainted builds, who suffer the worst hunt-pressure by default, can buy
the ability to **walk through the tide unseen by all but elites.** Thematically: *the closer you are to
turning, the more the Wake mistakes you for kin.* The riskiest builds get the strongest horde-stealth —
but **Hunters, Brutes, and Wardens still see them**, and the inversion fails the moment they attack.

---

### 10.5 The five progression Wardens

Each **Warden** is a biome's **apex corruption** — a multi-phase Soulslike set-piece that **gates a
Greater Hearth** (rolls back local decay, §6/§7) **and unlocks the next ascension Tier** (§8). There
are **five progression Wardens, R1–R5**, mapping 1:1 to the five ascension tiers (§8.4.2). Names are
narrative canon (§3); the **fight design** is here.

#### 10.5.1 The Warden design template (every Warden)

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

#### 10.5.2 The roster

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

### 10.6 The Hollow Court — the endgame bosses (R6)

R6 (**Hollow Court / Sunhold**) sits **outside** the five-tier gate (§3.2). It holds two bosses:

#### 10.6.1 The Famished King — the gauntlet gate

A final-approach **gauntlet boss** barring the throne (Crowned Circle's member who chose to *feed*,
§3). **Economy hook: he feeds on your Taint.** A high-Taint / banked player **empowers him** in real
time — his damage and aggression scale with the carried Taint of whoever he is fighting. This is the
capstone lesson of the curriculum: **purge before the gate.** A greedy glass-cannon who arrives
banked-hot fights a far stronger King; a player who purged down arrives to a beatable one. He is
**fixed** (not a progression Warden), Tide-scaled, and drops the approach to the Crown.

#### 10.6.2 The Hollow Crown (Sovereign Vael) — the ending encounter

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

### 10.7 Turned players & NPCs — the emergent elite tier

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

### 10.8 Encounter & threat design (for level writers, §11)

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

### 10.9 Master enemy constants *(illustrative — to tune)*

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

### 10.10 Open Questions

- **Communed Champion epithet (§3/narrative).** I use **the Communed Champion** (the "tragic mirror")
  with an illustrative working epithet ("the Blooming Penitent"); the final canon name is
  narrative-owned (§3) — flagged so it is named once, consistently.
- **Tide-variant content budget (§18).** The per-Tide enemy variants (§10.3) are the difficulty-over-
  time lever; their count is a production-scope call.
- **Hunter leash vs. true persistence (perf, §16/tech).** Hunters are specced as Expedition-persistent
  trackers; the server-side cost of true cross-zone persistence vs. a soft re-acquire is a profiling
  call — flagged to tech.

---

<a id="sec-11"></a>

## 11. World Structure, Biomes & Level Design

> **Scope.** This section turns the fiction of §2 (Setting, World & Lore) into *playable space*: the concentric-basin layout, the five-state decay spectrum as a level-design grammar, the six regions as built environments, the design of **Reliquaries**, the principles of exploration and navigation in the gloom, how the **Long Dusk** encroachment physically reshapes the map over **Tides**, and the **Greater Hearth** reclaim loop expressed spatially. It owns *space and blockout intent*. It does **not** own: the Taint/Hollowing/Blight economy (§5), survival rates and the decay clock's numbers (§6), Hearth/base-building rules (§7), the ascension trees (§8), combat (§9), or the Wake bestiary and Warden encounter stats (§10) — those are referenced, never re-specified. The world's *meaning* (what each region tells) is fixed in §2.4; this section builds the rooms that story happens in. Glossary terms (concept bible §14) are used verbatim. All illustrative numbers are marked **(illustrative — to tune)**.

---

### 11.1 Spatial thesis — the basin, the descent, the rising tide

The **Witherreach** is a single **concentric basin** — a great caldera-valley with the drowned capital at its lowest, central point, where the sun guttered into the earth (§2.4). Three locked spatial truths follow, and every level-design decision serves them:

1. **Decay radiates from the centre.** The **Blight** bleeds outward from the **Hollow Crown** at the basin floor. Decay is **worst at the heart, thinnest at the rim**. A player can read their depth — how far from the heart, how deep into the truth — purely from the decay state of the ground under their feet (§11.2).
2. **Progress is inward *and* downward.** The player starts at the rim (R1) and pushes toward the centre (R6). Descent is literal elevation loss *and* thematic descent — into death, into the past, into the truth. **Every region transition trends downhill**; the silhouette of the world is a funnel, and the camera should always be able to find the centre by looking *down-valley*.
3. **The map is a tide, not a conquest.** The **Long Dusk** rises up the basin walls over time (§2.5, §6). Held ground is impermanent: a region you cleared at one decay state will, untended, sink back. The player is never finally finished with a region — they are holding a line against water.

This is the spatial expression of design pillars 2 (*The World Is Already Dying*) and 4 (*Earn the Light*). The world is not a sandbox to conquer; it is a basin filling with rot, and the player's whole campaign is a fighting descent toward the drain.

---

### 11.2 The decay-state spectrum as a level-design grammar

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

### 11.3 The six regions

The structure is **locked at six concentric rings**, with **five progression Wardens (R1–R5)** gating the five ascension tiers (§8), and **R6 as the endgame** (the Famished King → the Hollow Crown), which sits outside the five-tier gate (§2.4.2). The narrative meaning of each region is fixed in §2.4.2 and is not re-litigated here; below is the **level-design** treatment — biome identity, the decay states it spans, blockout intent, its hub/landmark, its Warden arena, and its Reliquary.

#### 11.3.1 Region summary

| Ring | Region | Decay span | Hub / key landmark | Warden (§10) | Reliquary | Spatial signature |
|---|---|---|---|---|---|---|
| **R1** | **The Gloaming Marches** | Lingering | **Ashfast** (home Hearth-hold) | The Mire-Stag *(beast)* | A fallen border-shrine | Open cold heath & mist-fens; the legible tutorial bowl. |
| **R2** | **The Cinderwood** | Lingering → Festering | The Wardens' cremation-grounds | The Cinder-Alpha *(beast)* | The **Pyre-cairns** | Vertical burning forest; ash-fall and ember-light. |
| **R3** | **The Mourning Marsh** | Festering | The reed-choir flats | The Drowned Choir *(Choir remnant)* | A sunken Communion-chapel | Black-water labyrinth; the floor is water and rot. |
| **R4** | **The Hollowing Wastes** | Withering → Blooming | The **Black Hearth** (Communed seat) | The Communed champion | A Communed ascension-vault | The Shimmer expanse; beauty-grotesque, disorienting. |
| **R5** | **The Cathedral of Ash** | Blooming *(near-Crown)* | The cathedral nave | The Ashen Penitent *(named)* | The cathedral itself | Bone-white ash-desert; still, blanched, holy-and-wrong. |
| **R6** | **The Hollow Court** | Terminal | The Sunhold throne-floor | The Famished King → the Hollow Crown | — *(this is the endgame)* | The buried-sun caldera; the city is one body. |

#### 11.3.2 R1 — The Gloaming Marches *(Lingering)*

The **frontier of hope** and the game's teaching ground. A cold heath of mist-fens, dead heather, and broken farmsteads under a low twilight that is *not* full dark — the only region where the player can routinely see without the deathlight, so they learn the world before they learn the dark. Blockout is an **open, legible bowl**: long sightlines, intact roads, the silhouette of **Ashfast** (the home Hearth-hold and first hub) visible from much of the region as a fixed wayfinding anchor, and the basin's down-valley pull always readable on the horizon. The Festering inner edge introduces the first Blight pools and the first detours. The Warden, **the Mire-Stag**, lives in a flooded fen-arena and teaches the meta-loop (kill → kindle → roll back). The Reliquary is a **fallen border-shrine** — the introductory delve that seeds the first relic-fragments of the mystery. *Teaching goals: light radius, clean-vs-blighted nodes, reading decay state, the Hearth loop.*

#### 11.3.3 R2 — The Cinderwood *(Lingering → Festering)*

The **human response to the Witherfall**: a vast dead, slow-burning forest that is also the Ashen Wardens' sacred cremation-grounds. This is the region of **funereal grandeur** — charcoal cathedrals of trees, ash falling like snow, embers glowing in the dark like a field of small graves. Blockout introduces **verticality**: the forest is layered (canopy walkways, root-hollows, ravines), so traversal becomes three-dimensional and the deathlight's radius matters more (ember-glow gives false comfort but does not suppress Taint — only true light does, §6). Ash-fall is a recurring weather surge that cuts light radius and raises Taint-rate (§6), so the Cinderwood teaches **weather as a spatial pressure**. The Warden, **the Cinder-Alpha**, gates the sacred ash-grounds. The Reliquary, **the Pyre-cairns**, is a Warded burial-vault carrying the founding lore and Lightcraft rewards.

#### 11.3.4 R3 — The Mourning Marsh *(Festering)*

The **rite itself, heard before it is understood.** A rot-flooded lowland where the **floor is water** — black, Blight-pooled, sound-carrying water — and the architecture is sunken hamlets and reed-choirs that still faintly carry the Communion's song (the Choir-Echo, §15). Blockout is a **labyrinth of black water and causeways**: navigation is governed by what is wadeable vs drowning-deep, and the Blight pools *in the water itself*, so the player is wading through the Taint supply. This is where the **dark's breath and the Choir-Echo** first become navigational instruments (§11.5) — you hear the rite getting louder as you near its machinery. The Warden, **the Drowned Choir**, floods its arena with rot. The Reliquary is a **sunken Communion-chapel** holding the Fragment of the Song — the single most important mystery delve in the mid-game.

#### 11.3.5 R4 — The Hollowing Wastes *(Withering → Blooming)*

The **alternative made physical** — the Communed heartland, and the game's beauty-in-decay at its most seductive and most lethal. A mutated beauty-grotesque expanse of rot-coral, Blight-blooms, and fused flesh-and-stone (the **Shimmer** peak, §2.8, §15). Blockout deliberately **breaks legibility**: landmarks mutate, the ground undulates, and the iridescent soul-glow is bright enough to navigate by but bright in *all the wrong directions* — the region is designed to disorient, so the player must lean on the deathlight and held landmarks rather than the gorgeous, lying glow of the rot. The Communed settlement clusters around a **Black Hearth** (their anti-Hearth — §7) and the Hollow Heir's seat, the one inhabited place this deep. The Warden is the **Communed champion** — the tragic mirror of what the player could become. The Reliquary is a **Communed ascension-vault** (Tainted rewards, the "unfinished rite" gospel).

#### 11.3.6 R5 — The Cathedral of Ash *(Blooming, near-Crown)*

The **cost and limit of mercy.** A ruined cathedral-complex set in a bone-white ash-desert — eerily still, blanched, holy-and-wrong. Empty of the living: only the corrupted **First Warden** (the Ashen Penitent) and her failed pilgrimage's dead remain. Blockout is a **monumental, vertical interior** — a single great structure the player ascends and descends through (nave, crypts, bell-towers, ossuaries), in deliberate contrast to the open earlier regions; the space is claustrophobic and reverent, a held breath. The ash-desert approach is a near-featureless white plain that makes the cathedral's silhouette the only landmark for a long, dread-building traverse. The cathedral **is** the Reliquary — the End-it keystone, where the player learns a living human could not be the door. The Warden, **the Ashen Penitent**, has a clean/light-only core (§10).

#### 11.3.7 R6 — The Hollow Court / the Sunhold *(Terminal)*

The **origin and the end.** The drowned capital at the basin floor, where the sun guttered into the earth — fused into a single rot-organism around the **Hollow Crown**. This is not navigated like a place but **passed through like an interior of a living thing**: the city *is* a body, the streets are vessels, and a sick parody of dawnlight leaks *upward from below the ground* (a false sunrise from a grave — §15). Blockout is the **bottom of the funnel** — every prior descent has pointed here. There is no ambient-tide pacing; R6 is an authored endgame sequence: the approach, the **Famished King** (penultimate gate), and the **Hollow Crown** (the final encounter and the three-ending choice, §3.4). R6 has no Reliquary because the whole region is the final Reliquary.

---

### 11.4 Reliquaries — landmark dungeon design

A **Reliquary** is a landmark dungeon in the wilds: a self-contained delve that holds **one concentrated dose of the central mystery** *and* **one build-defining reward**, with risk scaling to its depth and decay state. Reliquaries are the optional-but-rewarding spine of exploration — the reason to leave the critical path — and each is authored to the §2 environmental-storytelling patterns (the Tableau of the Last Moment, the Hearth-Scar, the Blight-Halo).

#### 11.4.1 The Reliquary contract (every Reliquary delivers all four)

1. **A mystery payload.** Exactly one piece of the cosmology (§2.2), delivered diegetically — relic-fragments, a frozen tableau, a Choir-Echo, a journal. Never an exposition dump; a Reliquary *shows*, the player assembles (§2.8).
2. **A build-defining reward.** One catalyst, weapon, tempered-gear schematic, or ascension catalyst worth the risk (effects owned by §7/§8). The reward is **legible from the entrance** as a goal — the player can see the prize they are descending toward.
3. **A risk gradient that matches the basin.** A Reliquary's interior is its own miniature decay slope: it deepens in decay state from threshold to core, so the delve *is* a compressed descent (the macro structure in microcosm). The deeper room is the more-decayed, higher-Threat-Level room (§10), and the reward sits at the deepest, hottest point.
4. **A return problem.** Like the basin itself, a Reliquary is a **round trip** under the Expedition clock (§4, §12): the player must carry their accumulated Taint, depleting light, and (often) a fragile objective *back out*. Souls-style **loop-back shortcuts** (a deep door that opens back toward the entrance) are the standard structural device — they reward reaching the core by collapsing the return, and they re-connect the Reliquary to the Hearth network (§11.8).

#### 11.4.2 Reliquary archetypes

To keep the ~one-per-region set distinct (and to give the team reusable kits), Reliquaries come in three structural archetypes:

| Archetype | Structure | Example | Design intent |
|---|---|---|---|
| **The Vault** | A descending spiral or shaft — one deepening route to a single core chamber. | R4 Communed ascension-vault | The purest "compressed descent"; teaches the basin's shape in 20 minutes. |
| **The Warren** | A branching, looping network with multiple cores and a central shortcut hub. | R1 border-shrine; R3 sunken chapel | Exploration and choice; the Hearth-Scar and Tableau patterns thrive here. |
| **The Ascent** | An *upward* climb (a tower, a cathedral) inverting the descent — the reward is at the top, the dread is the height. | R5 Cathedral of Ash *(region-scale)* | A deliberate change of rhythm; verticality as the threat. |

#### 11.4.3 Reliquaries and the clock

A Reliquary's decay state advances with the **Tides** like any unheld ground (§11.6) — a Reliquary cleared early at Festering may be Withering on a return visit, with a denser Wake and a harder return. This makes the *timing* of a delve a strategic choice, not just its existence, and keeps optional content alive across a playthrough rather than checkbox-dead.

---

### 11.5 Exploration & navigation in the gloom

The core navigation constraint of WITHERREACH is the **finite light radius** (§6): the player can only reliably see, and only suppress Taint, inside their carried light. Therefore **the dark is the real fog-of-war** — not a UI overlay, but the literal unlit world. Every navigation system is built around this.

**Locked navigation principles:**

- **Landmark wayfinding, not minimap omniscience.** There is no top-down satellite minimap. The player navigates by *silhouettes against the dark* — the down-valley pull of the basin, a Hearth's gold pool, a Greater Hearth's false dawn, a Warden's glowing core, a Reliquary's distant landmark. Level design is responsible for placing **readable, decay-aware landmarks** that survive (or visibly corrupt with) the region's decay state. The map/compass UI that supports this is specified in §14.8 (a diegetic hand-map that fills in only what the player has lit and seen; a deathlight-needle compass).
- **The deathlight is a navigation budget.** Because light is finite and fueled (§6), *how far you can see* and *how far you can safely go* are the same resource. Pushing past your light into the dark to reach a node is the moment-to-moment risk of exploration; the dark spikes Taint-rate ×5 (§6) and unmasks the Wake's corruption-scent (§10). Designers place reward against this: **the richest Blight nodes sit in the darkest, highest-decay pockets** — you trade light, safety, and Taint for power.
- **Audio is a navigation instrument.** The **dark's breath** (the web straining, with whispers) intensifies with darkness and with the player's Taint, and the **Choir-Echo** (the Communion's song) grows louder toward the Crown and near Choristers (§15). Both are *directional, diegetic cues*: the player learns to navigate by sound — toward or away from the breathing dark, toward the rising song to find a Reliquary's core. This is the audio environmental-storytelling of §3.6 made into a wayfinding system.
- **Verticality means descent.** Traversal trends downhill across the campaign and within most Reliquaries (§11.4). Climbing is the exception (R5, the Ascent archetype) and is used deliberately for tonal contrast. The player should always be able to *feel* which way is deeper.
- **Reclaimed ground is the safe network.** Lit Hearths and rolled-back regions form a shrinking-and-growing **safe graph** the player traverses between (§11.8); exploration is the act of pushing the frontier of that graph outward into the dark, knowing the tide pushes it back (§11.6).

---

### 11.6 The Long Dusk encroachment — the map as a tide

The **Long Dusk** is the map's antagonist on a clock (§2.5, §6). Spatially, it expresses as **encroachment**: unheld ground sinks one decay state deeper each **Tide** (§6), and the Blight rises up the basin walls toward the rim. This is the spatial face of design pillar 2 — *standing still loses ground.*

**How encroachment reshapes space (all driven by the region decay scalar — §16):**

- **The decay state advances.** A Lingering fringe becomes Festering; a Festering marsh becomes Withering. The *same geometry* re-dresses: material parameters rot, fog thickens and lowers visibility, lighting drops colder and dimmer, **prop sets swap** (clean props out, rot-growth in), and **navmesh changes** — new Blight pools and rot-growth block old paths, while collapse opens new ones. A route that was open at one Tide may be drowned at the next.
- **Encounter density rises.** Because decay state feeds the Wake's Threat Level (§10), an encroached region is denser and tougher without re-authoring a single spawn — the zone is a budget the player's Taint and the Tide spend up (§10.9 in the combat brief).
- **The rim drowns over a playthrough.** The Tide rises up the basin walls, so the early regions the player "finished" are visibly worse on a late return: Ashfast's Lingering Marches, untended, slide toward Festering and beyond. The world the player leaves behind is sinking behind them as they descend — a constant, legible reminder that the clock has teeth and that reclaiming is not winning (USP #2).
- **The encroachment front is a place.** Where held ground meets rising rot, there is a **visible front** — a line of advancing fog and rot-growth, the literal edge of the tide. This front is an authored, dynamic location: defense side-quests (the Encroachment / the Tended Flame patterns, §3.5) happen *here*, and the player can watch the line move. The front is where "the world is already dying" stops being a stat and becomes a horizon.

The macro cadence, multipliers, and the active-playtime clock anchoring are owned by §6 (and the technical anchoring by §16); this section owns only how that clock *looks and plays as space*.

---

### 11.7 The Greater Hearth reclaim spatial loop

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

### 11.8 Level-design authoring principles

Binding guidance for anyone building WITHERREACH space:

- **Author with Threat-Level budgets, not fixed spawn placements.** A zone is a budget the player's Taint band and the current Tide spend up (§10.9 in the combat brief). Hand-place set-pieces (Wardens, Reliquary cores, scripted tableaux); let the ambient Wake tide be authored as density budgets keyed to decay state, so a space scales with the player's corruption and the clock without re-authoring.
- **The Hearth network is the spatial spine.** The map is a graph of safe nodes (Hearths, Greater Hearths) connected by dangerous edges (the dark wilds). Design every region so the player's mental model is "how far is the next light." Souls-style loop-back shortcuts (§11.4) re-stitch the frontier to the spine so a hard push out always shortens into a fast way home.
- **Decay-state-author once, dress N times.** Because decay is a scalar over authored geometry (§16), build a space at its *base* legible form and author the decay-state dressings (material/fog/light/prop/navmesh sets) as data on the same blockout. Never design a route that *only* exists at one decay state unless the navmesh change is intentional and reversible.
- **Pace tension as oscillation, with a built-in "keep moving."** Quiet traversal → ambush → respite, but lingering steadily worsens Threat Level (Taint accrual + local alert build, §10) — so the level itself pressures the player onward. Risk-reward is spatial: the prize is always deeper, darker, hotter.
- **Make depth and danger redundant.** Decay state, fog density, light scarcity, audio (the breath, the song), and Wake density should all rise together toward the heart, so the player reads danger from many channels at once and never *only* from an enemy already on top of them.
- **Respect the respawn resolver.** A player respawns at their last lit Hearth; if that Hearth's region has gone dark to the Long Dusk, the resolver falls back to the nearest lit/Greater Hearth (§16). Design Hearth placement and region adjacency so this fallback is never a soft-lock or a punishing teleport across the whole basin.

---

### 11.9 Open Questions

- **Region count vs the five-tier gate.** The structure is locked at six regions / five progression Wardens (R1–R5) + endgame R6 (§2.4.2). The basin's continuous-gradient design (§11.2) scales cleanly to five regions if production scope demands a cut (the natural candidates are R2 or R4, per the narrative brief's own note) — flagged for production/scope (§18), not decided here.
- **Hearth raid/defense as authored space.** The survival brief leaves Hearth raid/defense vs the Wake unlocked (§6); if authored, the encroachment front (§11.6) is its natural spatial home and its trigger should ride the Threat-Level model (§10). Routed to §6/§10 and production for a go/no-go.
- **Reliquary count per region.** This section assumes ~one signature Reliquary per region (plus R5/R6 being region-scale Reliquaries). Whether secondary minor Reliquaries populate each region is a content-scope decision for §18.

---

<a id="sec-12"></a>

## 12. Death, Risk & Session Structure

> **Scope.** This section owns the **death model** (respawn, the **corpse-cache** and corpse-run,
> the respawn resolver), the **soft-permadeath** track as it is *driven by death* (the **Hollowing**
> gain on death, the **turning** event and its 10-pip telegraph, the **Cleansing rite** stave-off),
> and the **Expedition** session structure under the Long Dusk. It is the §11-death-model the bible
> §11 locks.
>
> **Cross-references (read, do not duplicate):** §5 owns the **Hollowing track itself** (the meter,
> the pip table, the gain numbers, the Cleansing-rite rate-limit) — this section restates the
> death-relevant figures as references and owns how *death* feeds them. §13 owns **co-op death**
> (the Blight-transfer revive transaction, corpse-cache ownership in a party, the turned-player
> propagation); §10 owns the **turned-entity kit** the turning spawns; §6 owns the Long Dusk / Tides;
> §7 owns the **Hearth** as a built object; the tech model (downed-state, server authority,
> persistence) is the tech brief / §16.
>
> **Number status:** every value is **(illustrative — to tune)**, drawn from the §5 economy and the
> tech brief's death/respawn model.

---

### 12.1 The death model — two tiers, "Die Forward"

WITHERREACH death is **neither roguelike permadeath nor consequence-free respawn** (concept bible
§11, pillar 5 "Die Forward"). It is a **two-tier** model that feeds back into the corruption economy:

| Tier | What it is | Cost |
|---|---|---|
| **Tier 1 — ordinary death** | Respawn at your last lit **Hearth**; drop your banked Taint as a recoverable **corpse-cache** (Souls-style corpse-run). | You lose **ground and carried power potential**, never the story. Each death advances **Hollowing** one step. |
| **Tier 2 — turning (soft-permadeath)** | When **Hollowing** maxes, the character **turns** into a Wake-creature (§10.7). | The survival-RPG's "real" death — a **telegraphed, stave-off-able descent** you fight the whole game, not a surprise wipe. |

**Death feeds the world and your own hollowing.** You lose resources and position; you ratchet a
permanent meter; you do **not** restart the run. This is the spine of the bible's "permadeath is a
slow descent you fight, not a sudden wipe."

---

### 12.2 Downed & the revive window (co-op)

In co-op, HP→0 does **not** mean immediate death. The player enters a server-owned **DOWNED** state
(ragdoll/crawl + a **revive-window** timer), replicated to allies as a revive prompt:

- An ally can **revive within the window** by channelling a **Blight-transfer** — sacrificing their
  own banked Taint to stabilize the downed player. The full transaction (reviver pays ~30 Taint,
  transferred to the revived ally; Beacon-node speed/efficiency; the disconnect refund edge case) is
  owned by **§13.5**.
- If the window **expires** (or no ally is in reach) → **DEATH proper** (§12.3).
- **Solo play has no downed tier** — HP→0 is DEATH proper directly. The downed state exists only to
  make co-op revive possible.

*(Downed players are excluded from the co-op ending rite's eligible set — §13.8 — because they have
not "offered.")*

---

### 12.3 Death proper — respawn, the corpse-cache, Hollowing

On **DEATH proper**, the server resolves three things, atomically and authoritatively:

1. **Drop a corpse-cache.** A **corpse-cache** actor spawns at the death location holding your
   **carried Taint above `T_floor`** (and, per the §12.4 knob, optionally some gear). It is a
   persistent, owner-tagged, recoverable world object — **dormant when no one is near** (cheap to
   keep around). You **cannot** drop below your `T_floor` (it is build-set, §5.6), so the cache holds
   exactly `Taint_at_death − T_floor`.
2. **Advance Hollowing.** **+5 base, + up to +5 scaled by your banked-Taint fraction at death**:

   ```
   ΔHollowing = 5 + 5 · f        where f = Taint_at_death / T_max   (§5)
   ```

   **Dying *hot* hurts more.** Dying cold (low `f`) → ~+5; dying at Brink (`f ≈ 1`) → ~+10. So a
   disciplined player needs **~10–20 deaths to turn**; a greedy Tainted player banking hot turns far
   faster. This is the mechanical face of "the strongest builds live closest to turning" (§5.7).
3. **Respawn at the last lit Hearth.** You re-form at your last-bound lit **Hearth** (the shared
   Hearth in co-op, §13.3) at **`Taint = T_floor`** — clean down to your floor, with your power
   potential lying out in the world as the cache.

> **Death never gains Taint** — it advances **Hollowing**, not Taint (§5.3). The carried Taint you
> lose becomes the cache; the *permanent* cost is the Hollowing step.

---

### 12.4 The corpse-run — retrieval rules

Recovering a corpse-cache is the **Souls-style corpse-run**: go back out, reach the spot, reclaim your
banked power — or lose it.

| Rule | Decision *(illustrative — to tune)* |
|---|---|
| **Retrieval** | Reach the cache → its **Taint transfers back onto your meter** (subject to `T_max`; overflow spills to Hollowing per §5.2, so retrieving a huge cache while already near-ceiling is itself a risk), the cache despawns, world save updates. |
| **Cache count on multi-death (the tech knob)** | **Default: single Souls-style cache.** A **second death forfeits the first cache** (it despawns; that power is gone for good). Configurable to **N** caches as a world/difficulty setting — the tech supports it; the default keeps the stakes sharp. |
| **Decay / persistence** | The cache **does not time out** — it persists in the world save until reclaimed or forfeited by a second death. (A decaying-world flourish — caches slowly sinking into Blight — is a flagged option, §12.11, deliberately off by default so the run is never lost to a timer the player can't see.) |
| **Co-op ownership** | Owned by **§13** — default **owner-only** retrieval (your banked Taint is yours; allies can guard the run but only you reclaim), with a **party-open** world setting. See §13.5. |

The corpse-run is the bible's "lose ground and resources, not the story" made literal: the *power* is
recoverable if you fight back to it, but the **Hollowing** step (§12.3) is **not** — that is the part
of death that always sticks.

---

### 12.5 The respawn resolver — when your Hearth goes dark

Respawn targets your **last-bound lit Hearth**. But the world decays (§6.5) — your Hearth's region can
go dark or be lost to the Long Dusk. The server's **respawn resolver** handles this explicitly (it is
a real state, not an assumption):

1. **Last-bound lit Hearth** — the normal case.
2. If that Hearth is **unlit / its region has gone dark** → **nearest lit Hearth** the player has
   bound.
3. If none → **nearest lit Greater Hearth** (Greater Hearths are the most durable, region-scale, §7).
4. The starting Hearth (Ashfast, R1, §3) is the **guaranteed floor** — it cannot be permanently lost
   as a respawn anchor, so the resolver always terminates.

> "Your Hearth went out" is a designed setback, not a soft-lock — losing a forward Hearth costs you
> distance on the next corpse-run and a foothold against encroachment (§6.5), reinforcing the
> "maintain or lose the map" tide (pillar 4). Coordinate fallback order with §11 (region adjacency).

---

### 12.6 Hollowing — the soft-permadeath track (death's contribution)

**Hollowing** is the permanent corruption ratchet you fight for the whole game (the **meter, pip
table, and full gain list are §5.7**). This section owns only how the **death model feeds it**:

| Death-model Hollowing source | Amount | Where |
|---|---|---|
| **Death** | `+5 + 5·f` (§12.3) | here |
| **Brink exposure** | `+1 / min` while `f ≥ 0.85` (§5.7) | §5 |
| **Overflow spill** (incl. over-retrieving a cache past `T_max`) | 2 excess Taint ⇒ +1 Hollowing (§5.2) | §5 |

Hollowing **cannot be purged** by normal means (§5.7); the **only** reducer is the Cleansing rite
(§12.8). A disciplined Warded player can hold the line indefinitely; a greedy Tainted player still
trends toward turning — the descent has grip but is never a dead end.

---

### 12.7 Turning — the 10-pip telegraph & the TURN event

**Turning is never a silent wipe.** Hollowing reads as **10 pips of 10** (§5.7); the descent
announces itself the whole way down. The server drives escalating, replicated status/VFX/debuffs at
each stage (the tech brief's "telegraphed, never a surprise"):

| Pips | State *(decay-stage language is §5/§3 — not the world decay spectrum)* |
|---|---|
| **0–3** | Cosmetic marks, faint whispers. |
| **4–6** | Stat drift: Warded skills weaken, Tainted strengthen; the Wake grows **less** aggressive (you begin to smell like them — §10.4.4). |
| **7–8** | **"The Pull"** — periodic involuntary twitches, vision corruption, NPCs recoil (§3.3). |
| **9** | **Brink of Turning** — strong audiovisual telegraph; **last-chance rites unlocked**; in **co-op the party is explicitly warned** (§13.7). |
| **10 (= 100)** | **TURN.** |

**The TURN event** (server-authoritative):

1. The character is **retired** — the "tragic / loss" reset (concept bible §9 "Be consumed"; §3.4.3).
   Per the tech model this is a **narrative retirement**, not save-destruction grief: the character is
   removed from play and credited a "consumed" outcome, **not** roguelike-erased (§13.9 / tech brief).
2. The server spawns a persistent **turned-entity** Wake actor into **world state**, seeded from the
   character's **build, name, and gear silhouette** (the kit is §10.7) — a named elite that haunts the
   Reach and, in co-op, the former allies (§13.7).
3. In co-op, allies present **witness the turn as a set-piece**.

Turning is reachable two ways (§3.4.3): **(a)** maxing Hollowing **anywhere** in normal play (this
death model), or **(b)** failing/surrendering the final trial at the Hollow Crown (§10.6 / §13.8).
Both routes are the same soft-permadeath; (a) is the one this section governs.

---

### 12.8 The Cleansing rite — the only stave-off

Turning is a **fought** descent, not an inevitability. The **Cleansing rite** is the only thing that
reduces Hollowing (§5.7):

- Performed at a **Greater Hearth**; removes **1 pip (−10 Hollowing)** for a **large clean-resource
  cost**, **rate-limited to ≤ once per Tide per Greater Hearth** (§5.7 owns the rate-limit; §7 owns
  the resource cost).
- It is **extraordinary, not ordinary purge** — purge (§5.4) lowers *Taint*; the Cleansing rite is the
  only lever on *Hollowing*, and it is slow and expensive by design.
- The **last-chance rites** unlocked at pip 9 (§12.7) are the Brink-of-Turning emergency form — a
  player at the edge always has *a* move, but a costly one.

A disciplined Warded player can hold indefinitely with the rite; a greedy Tainted player out-paces it
and trends toward turning anyway (§5.7). This is the whole-game fight the bible promises.

---

### 12.9 Expedition session structure — under the Long Dusk

Play is organized as **Expeditions**: a **round trip out from and back to a Hearth** (concept bible
§11; the loop is §4; the clock is §6). The death model is the *risk floor* under that loop.

#### 12.9.1 The Expedition arc (one session, ~30–90 min)

| Phase | What happens | Death-model stake |
|---|---|---|
| **Outfit (at the Hearth)** | Spend the last session's banked Taint (bank / purge / invest, §5.5); repair/temper (§7); stock light + food (§6). | You set your **`T_floor`** and your starting band — your survival difficulty for the run (§5.6). |
| **Push out** | Travel into more-decayed, higher-TL zones (§10.2); manage light, hunger, Taint; gather; advance an objective (a Reliquary / resource frontier, §11). | **Distance from the Hearth = corpse-run length** if you die. Going deep is going far from your respawn. |
| **The objective / fight** | The richest reward sits in the highest-TL dark (§10.8); fights vent Taint (casters) or accrue it (festering wounds, §5.3). | Dying here drops the cache **far out**, in hostile ground. |
| **The return** | Race your Taint, light, supplies, and nerve back before they run out. | A death on the way home is the classic "so close" loss — and the return trip itself accrues ambient Taint (§5). |
| **The Hearth decision** | Bank / purge / invest the run's Taint (§5.5) — the session climax. | Banking hot means **next** Expedition starts in a higher band, hunted from minute one (§10.2) and dying hotter (§12.3). |

#### 12.9.2 The session under the Tide

- The Long Dusk advances in **Tides** on **cumulative out-in-the-Reach time** (~10 h/Tide,
  Expedition-time only — §6.5). Idling at the Hearth does **not** advance it; you **cannot out-grind
  the clock at base**, but slow/co-op players are not punished by wall-clock.
- Each Tide raises ambient Taint, Wake spawn-pressure (+1 `TideTier`, §10.2), encroachment speed, and
  unlocks tougher Wake variants (§10.3) — so **the same Expedition route gets deadlier over the
  campaign**, and your accumulated **Hollowing** (which never resets) means late-game deaths land on a
  character already part-way to turning.
- **Greater Hearths** (won from Wardens, §10.5) roll back local decay and host the Cleansing rite —
  the only way to *push the death-clock back* locally, never globally (pillar 2).

#### 12.9.3 Persistence

The **world and settlement persist across sessions** (concept bible §11). The death model's durable
state — **corpse-caches, turned-entities, Hearth bindings, the Hollowing track** — persists per the
Character⟂World save split (§13.9 / tech brief): **Hollowing + carried/banked Taint → character save;
corpse-caches + turned-entities + Hearth state → world save.** An Expedition can therefore be
**interrupted and resumed** without losing the run's stakes.

---

### 12.10 The risk ledger — what you keep, lose, and ratchet

The whole model in one table — the precise answer to "what does death cost me?":

| On a death you… | Outcome |
|---|---|
| **Keep** | Your character, build, skills, gear, **and your `T_floor`** (you respawn *at* the floor). The story. |
| **Drop (recoverable)** | Carried **Taint above `T_floor`**, as a corpse-cache — reclaim it on the corpse-run, or forfeit it to a second death (§12.4). |
| **Ratchet (permanent)** | **Hollowing `+5 + 5·f`** (§12.3) — never recovered except by the rate-limited Cleansing rite (§12.8). |
| **Risk over many deaths** | **Turning** at max Hollowing (§12.7) — the soft-permadeath you fight the whole game. |

> The design contract: **power is recoverable, position is losable, Hollowing is the part that
> sticks.** That asymmetry is what makes every death matter without ever being a run-ending wipe.

---

### 12.11 Open Questions

- **Cache decay flourish (§6/§11).** A "caches slowly sink into Blight" timer is specced **off by
  default** (§12.4). Whether the decaying world should ever consume an un-recovered cache is a
  survival/world-design call — flagged so it is never silently lost to an invisible timer.
- **Multi-death cache count default vs. setting (§13/§18).** Default is single-cache (second death
  forfeits); exposing N-caches as a difficulty option interacts with co-op (§13.5) and difficulty
  presets (§19) — flagged for the options pass.
- **Pyre eligibility for high-Hollowing players (§3/§5).** Whether a near-turning player can still
  take the clean **End it** ending, or only a corrupted variant, is the §3.4.1 / §5 threshold flagged
  in narrative — it lands partly here because it is the death track that gates it.

---

<a id="sec-13"></a>

## 13. Co-op & Multiplayer Design

> **Scope.** This section owns **2–4 player co-op**: the session/host model, the **shared Hearth**,
> the **role structure** the corruption economy forces, **Blight-transfer revive**, **party Taint /
> difficulty scaling**, **turned-player persistence**, the **netcode & persistence implications**,
> and the **resolved co-op ending canon** at the Hollow Crown (the §3.8 open item assigned here).
>
> **Cross-references (read, do not duplicate):** §5 owns the Taint meter and the Blight-transfer
> *cost* (reviver pays ~30 Taint, transferred to the revived ally); §8 owns the Warded **Beacon**
> support branch; §9 owns the **physical / rot / light** damage triangle the roles are built on; §10
> owns the **ThreatLevel** model this section scales and the **turned-entity kit**; §12 owns the
> single-player death model this extends; §3 owns the **endings fiction** this section resolves for
> co-op; the netcode/persistence/host model is the tech brief / §16 (this section states the design
> requirements those satisfy).
>
> **Number status:** every value is **(illustrative — to tune)**, aligned with the tech brief and the
> §5 economy.

---

### 13.1 Pillars & scope

Co-op is **2–4 players** (locked, concept bible §0/§12), PvE, drop-in to a friend's world. The design
target (bible §2, USP #5) is **desperate interdependence**: survival forces specialization, and
players **literally bleed power into each other to stay alive**. Three pillars:

1. **The corruption economy creates roles for free.** Build = survival difficulty (§5.6) means a
   party self-organizes into a **Warded anchor** sheltering **Tainted strikers**, with **Blight-
   transfer** support binding them — no class system needed (§13.4).
2. **One player's heat is everyone's danger.** The Wake hunts the party at the **hottest** Revenant's
   pressure (§13.6) — so managing a glass-cannon's Taint is a *party* problem, the mechanical root of
   interdependence.
3. **Co-op deepens the stakes, never removes them.** Revive is a sacrifice (§13.5); a fallen ally can
   **turn** into a named elite you later fight (§13.7); the ending is a collective reckoning (§13.8).
   Co-op makes the descent *shared*, not *safe*.

---

### 13.2 Session & host model

The model is the proven Valheim/Enshrouded pattern, decided in the tech brief (§16):

| Decision | Co-op consequence |
|---|---|
| **Listen-server default + dedicated-server binary from day one** | 2–4 friends host for free (one player's client is the authority); groups wanting a 24/7 persistent world run the dedicated binary. |
| **Server-authoritative, client-predicted** | All shared state — Taint, Hollowing, decay, the Wake, Hearths, corpse-caches, turned-entities, revives, the ending rite — is **server-owned**; clients predict for feel only. The corruption economy is the win/loss surface and is never client-trusted. |
| **Character save ⟂ World save** | Your **Revenant is portable** (path, skills, Hollowing, carried/banked Taint, gear) — you bring it to any friend's world. The **world** (the Long Dusk clock, region decay, Hearths, settlement, corpse-caches, turned-entities, Warden/Reliquary flags) belongs to the host/server. |
| **No host migration in v1** | A host drop ends the session; **no one loses their character** (it's portable); the world resumes from the last autosave + an on-disconnect save when the host returns. The **dedicated server is the host-independence answer.** |

**Settlement is world state, not character state** (tech §3.1): guests **bring their Revenant** but
**build in the host's world**. Co-op and settlement design (§7) must honour this — there is one shared
base per world, not per player.

**Playable-ping cap** on join/matchmaking keeps the Soulslike combat fair under lag-compensated hit
resolution (§13.9 / tech §2.2).

---

### 13.3 The shared Hearth

In co-op the **Hearth is shared** (concept bible §11) — a single, persistent, server-owned safe haven
the party returns to. It is **world state** (persists to the world save, §13.9).

| Shared-Hearth facet | Decision |
|---|---|
| **Safe radius** | Ambient Taint gain **0.0** inside it (§6) for **everyone** — the party's collective held breath against the dark. |
| **Bank ledger** | **Per-character.** Each player's banked Taint is their own ledger entry on the Hearth — **you cannot spend a teammate's banked power.** Bank/purge/invest (§5.5) are private transactions; the Hearth is the shared *place*, not a shared *wallet*. |
| **Upgrades & fuel** | **Shared.** Hearth tier, purge efficiency, safe radius, and **fuel** are common property (§7) — the party invests in the haven together, and a Hearth running out of fuel goes dark for everyone (§12.5). |
| **Cleansing rite (Greater Hearths)** | **Per-character, rate-limited per Hearth.** Each player cleanses their *own* Hollowing (§12.8); the **≤ once-per-Tide-per-Greater-Hearth** limit (§5.7) is shared — the party competes for the same rite slots, a real scarcity in a Hollowing-heavy group. |
| **Respawn anchor** | Death respawns a player at the **shared** lit Hearth (§12.5). |

> Designing the bank ledger per-character is load-bearing: it keeps each player's bank/purge/invest
> decision (§5.5) **their own moral choice**, so co-op never collapses the keystone tension into a
> party pool. You shelter together; you choose alone.

---

### 13.4 Role structure — the damage-triangle interdependence

The §9 damage triangle (**physical / rot / light**) plus build = survival difficulty (§5.6) produce a
self-organizing party structure **without any class lock**:

| Role | Build (§8) | Combat job (§9) | Survival job |
|---|---|---|---|
| **Warded anchor** | Pure/lean Warded (Lantern-Warden, Ash-Knight) | **Light/Cleansing** damage — clears the **Wake** and the Hollowed (the swarm answer); tanks/poise-breaks | Runs **cold** (low `T_floor`); projects **Beacon** auras that lower **party** Taint gain and Wake aggro (§8); carries the revive-reserve (§13.5). The party's safety. |
| **Tainted striker(s)** | Heavy Tainted (Rotcaller, Hollowing-Ascendant, Bloodletter) | **Rot** damage — shreds **Wardens' living cores**, brutes, Warden cores (§9.7/§10.5) | Runs **hot** (high `T_floor`, rests in Marked/Fevered); the party's burst, and its biggest liability — its heat raises the party's TL (§13.6). |
| **Blight-transfer support** | Warded **Beacon** (often the anchor doubles here) | Mending light; battlefield revives | The medic — **sacrifices banked Taint to revive** (§13.5); the binding that lets strikers live near Brink. |

**Why both Paths want each other (the interdependence, made mechanical):** a Tainted striker **cannot
clear the Wake** (rot bounces off it, §9.7) and **lives near turning**; a Warded anchor **lacks the
burst** for a Warden's living core and **runs cold**. Each covers exactly the other's gap. A solo
player must cover *both* gaps with consumables and a second weapon rail (§9.11); a party covers it by
**fielding both Paths** — and a party of all-Tainted strikers will be **swarmed**, while a party of
all-Warded will **stall on boss cores.** The triangle is the co-op balance lever.

---

### 13.5 Blight-transfer revive

The signature co-op mechanic (concept bible §4, USP #5): **you pour your banked power into a downed
ally to stabilize them — trading your strength for their life.**

#### 13.5.1 The flow

1. An ally hits HP→0 and enters the server-owned **DOWNED** state with a **revive-window** timer
   (§12.2), replicated as a revive prompt.
2. A living ally **channels a Blight-transfer** on the downed player (a GAS ability, server-validated
   for range + window + sufficient Taint; predicted channel-start on the reviver for instant feel).
3. On completion, the server **atomically**: decrements the **reviver's banked Taint by ~30** (§5;
   floor-capped — see below) and **transfers it onto the revived ally**, stabilizing them **in place**
   at their current position.

#### 13.5.2 The corruption cost — revive *transfers danger*

This is the part that makes revive a real sacrifice, not a free pickup:

- **The reviver loses ~30 Taint** (floor-capped per §5.4 — a reviver at their `T_floor` **cannot
  revive**; they must carry a **revive-reserve** above floor). So the cold Warded medic must carry *a
  little* danger specifically to save others — *the medic bleeds to mend.* **Beacon** nodes (§8) lower
  the cost and speed the channel, letting a Warded anchor sustain revives without running hot.
- **The revived ally gains that ~30 Taint** — they come back **hotter**, pushed up their bands toward
  their own **Brink** (§5.2). Each revive corrupts the revived a little more; **a player revived
  repeatedly is being pushed toward turning** (§12.7). The revive *avoids* the full-death penalty (no
  corpse-cache, no Hollowing step, no respawn-at-Hearth) but *spends* the party's collective safety to
  do it.
- **The choice at the window:** **revive** (stay in the fight, but the reviver is −30 and the revived
  is +30 and hotter) vs. **let it expire** → full death (§12.3): corpse-cache out in the field, a
  **Hollowing** step, respawn at the shared Hearth at floor. Neither is free — the desperate-
  interdependence calculus the bible promises.

#### 13.5.3 Corpse-cache ownership in co-op (the tech open item, resolved)

When a co-op death goes to **DEATH proper** (window expired), the dropped corpse-cache (§12.3/§12.4)
is, by default, **owner-only** to retrieve — **your banked Taint is yours**; allies can **escort and
guard** the corpse-run but **only you reclaim** the cache. A **party-open** retrieval mode is a
**world/difficulty setting** (the tech supports either, tech §6). Default owner-only because banked
Taint is the player's private moral stake (§13.3) and party-open invites grief; the setting exists for
groups who want pure shared-loot co-op.

#### 13.5.4 Edge case — reviver disconnects mid-channel

Per the tech model (§2.3.1): the server **aborts and refunds** the reviver's Taint — **no silent
loss**. The downed ally stays downed (window continues); another ally may attempt the revive.

---

### 13.6 Party Taint & difficulty scaling

Co-op must scale **without** flattening the corruption economy's "your heat is everyone's danger"
truth. Two levers, both feeding the §10.2 **ThreatLevel**:

1. **`TaintBandTier` = the hottest present Revenant's band.** A shared encounter reads the **highest**
   band among nearby party members for its `TaintBandTier` input (§10.2). One Brink glass-cannon raises
   the hunt **for the whole party** — so keeping the strikers' Taint manageable (anchor auras, timely
   vents) is a collective objective, not a personal one. This is the mechanical heart of
   interdependence (§13.1, pillar 2).
2. **Spawn budget scales with party size — sub-linearly.** Each present, alive player adds to the
   encounter spawn budget at **~+60–75% per extra player** *(illustrative — to tune)*, **not** +100% —
   so co-op is meaningfully easier per-capita (the fantasy of fighting together) but **never trivial**
   (the swarm still grows). A 4-player party in a blighted core in a late Tide with a Brink striker
   faces a genuinely overwhelming TL.

**Warden & boss scaling.** Wardens (§10.5) scale HP/poise and add-density to party size (Tide scaling
is on top, §10.5.1); their **economy hooks are unchanged** — e.g. the Famished King (§10.6) feeds on
**each** engaged player's Taint, so a banked-hot party empowers him far more than a purged one. The
hooks teach the same lessons at any party size.

**No difficulty menu.** As in solo (§5.6/§8.8), **the party's composite build is the difficulty
slider** — an all-Tainted party *chose* a brutal run. The §19 accessibility options are the only
separate knobs.

---

### 13.7 Turned-player persistence

When a co-op player maxes **Hollowing** and **turns** (§12.7), the descent is a **shared** event:

- **The party is warned.** At Hollowing pip 9 ("Brink of Turning", §12.7) the whole party is
  **explicitly warned** — a teammate's turning is never a surprise to the group either.
- **The turn is a set-piece.** Allies present **witness** the turn (tech §5); the character is retired
  (§12.7).
- **The turned ally persists as a named elite in the shared world.** The server spawns the **turned-
  entity** Wake actor (kit seeded from that player's build, §10.7) into **world state** — so the
  fallen friend becomes a **hostile, named elite the former allies may later face**, wearing their own
  face and skills. "The world remembers your dead builds" (§10.7). On a dedicated/shared world it
  persists for everyone; on a listen-server world it lives in that world's save (§13.9).
- **The retired player rejoins with a new (or another) Revenant.** Because characters are portable
  (§13.2), a turned player is not locked out of the session — they bring a different Revenant into the
  same world (and may, hauntingly, end up fighting their own former character).

This makes the soft-permadeath **co-op-relevant**: turning costs the group a member *and* arms the
world against them — the stakes are social, not just personal.

---

### 13.8 The co-op ending canon — the Rite of the Crown (RESOLVED)

> **Assigned open item (§3.8):** does a co-op ending at the **Hollow Crown** require **unanimity** or
> a **leader's choice**? **Resolved below as the "Rite of the Crown."** Consulted and endorsed by the
> **narrative-world-expert** (canon) and the **tech-coop-expert** (implementability/persistence);
> both rulings are folded in. The solo endings frame is §3.4 (LOCKED); this resolves only the
> **multiplayer** resolution.

**Premise (hard canon, confirmed by narrative-world-expert).** **Every player character is a
Revenant / threshold-soul** — there is no non-Revenant player character (concept bible §2). Therefore
**every living party member present at the Crown is, by definition, eligible to choose** — only a
threshold-soul can walk the Terminal blight and touch the anchor at all. A party member who has
already **turned / been consumed** (§12.7) is out of the choice; the bound NPC **Lysandra Vael** is
the sole non-Revenant who can *hold* the anchor, and even she **cannot reach the Crown without a
Revenant opening the way** (§3.4.2).

The three fates resolve in co-op as follows:

#### 13.8.1 End it (the Pyre) — requires UNANIMITY

**Every living, present party member must offer their threshold-soul together.** If even one player
declines, the Pyre **cannot fire**.

- **Fictional reason (corrected by narrative-world-expert — the "loose-anchor" rule):** when the door
  reopens, **no loose threshold-soul may remain in the room** — any Revenant who stays *unbound*
  becomes a fresh, living-enough anchor that the releasing web **lunges for and re-grips, slamming the
  door shut.** Solo satisfies this trivially (no one else is there — the single Revenant's door
  releases the entire web, §3.4.1); **co-op requires unanimity** because every unbound soul present
  would re-anchor the collapse. *(This replaces the earlier "one door is too small" reasoning, which
  contradicted solo canon.)*
- **Outcome:** all who offer **pass together**; the Long Dusk ends because the world finally,
  properly dies (§3.4.1). **There are no non-choosing survivors of a fired Pyre** — by definition it
  only fires when all chose it.

#### 13.8.2 Master it (the Crown) — INDIVIDUAL & seizable

**Any single player can seat their own soul as the new anchor** — there is **one throne, one anchor,
one sovereign**, claimed by the **first to commit** (a server-arbitrated atomic claim, §13.9). No
party consent is required, **because it does not end the others.**

- **Guardrail (load-bearing, from narrative-world-expert — MUST be honoured):** the new sovereign
  commands **the bound** — the Wake, the Blight, the dead — but **NOT fellow Revenants**, who are
  *outside* the web by definition (that is what a threshold-soul is). **A player-sovereign cannot
  control or enslave their teammates.** Non-choosing players **persist as free, unbound Revenants** in
  the new sovereign's Long Dusk; the world continues (it never healed — Master-it doesn't release the
  web).
- **The refuse-variant** (§3.4.2): if **no** party member seats the anchor (all refuse at the
  throne), **Lysandra Vael takes it** and becomes the new Hollow Crown / tyrant — she has shadowed the
  approach for exactly this contingency.

#### 13.8.3 Be consumed (the Hollowing) — INDIVIDUAL

Unchanged from §12.7: a player at **max Hollowing turns anywhere** (or surrenders the final trial).
It is per-character; the turned form becomes a named elite for the others (§13.7); the world is
otherwise unchanged.

#### 13.8.4 The resulting multiplayer dynamic (why this ruling)

The ruling **preserves and sharpens the §3.4.2 asymmetry — "the only refusal that actually denies the
Crown to a tyrant is the Pyre"** — in multiplayer terms:

- **The Pyre is FRAGILE:** it needs **everyone** to agree (and to give up everything). Collective
  mercy is hard.
- **The Crown is SEIZABLE:** it needs **only one** committed soul. Individual power-grab is easy.
- **So a single Tainted defector can ALWAYS deny the party's Pyre** — and, per the loose-anchor rule,
  a Revenant who refuses the Pyre **becomes the very anchor the collapsing web seizes**, so *refusing
  the Pyre and taking the Crown are nearly the same act*. The defector either takes the Crown
  themselves or, by refusing everything, hands it to Lysandra.

This is the keystone choice (bank-vs-purge, Warded-vs-Tainted, §3.4) rendered as a **multiplayer
social reckoning**: the merciful ending demands trust and unanimity; the power ending rewards the one
who breaks ranks. It is the most thematically faithful possible co-op finale — and (§13.9) it costs
**zero new persistence machinery**.

#### 13.8.5 Resolution rules (the rite, concretely)

| Aspect | Ruling |
|---|---|
| **Who can drive the rite** | **Any** living, present party member — **not** necessarily the host. The server arbitrates; the ending is **never hostage to who happens to be hosting** (tech-coop-expert confirmed sound). |
| **Eligible set** | Server-defined: **every currently-alive, present** party member. **Downed players are excluded** (they have not "offered" — §12.2) — the Pyre needs all *alive-and-present* to confirm. |
| **Pyre commit** | Server aggregates a **per-player consent boolean**; fires only when **all eligible confirm**. Pure runtime state; **only the outcome persists** (like Blight-transfer, §13.9). |
| **Crown commit** | Server-arbitrated **atomic compare-and-set** on the single `worldSovereign` anchor; **first-to-commit wins**; simultaneous-commit tie-break is netcode/design (e.g. lowest latency / earliest server-stamp), **not** lore. |
| **Abort safety** | The rite is **runtime state until the single atomic commit**, so a host-drop mid-rite (no migration, §13.2) can **never leave a half-applied ending** — an abort just means "re-form and redo," never a corrupted world. |

---

### 13.9 Netcode & persistence implications

The co-op systems above impose concrete requirements on the server-authoritative model (tech brief
§2/§3/§5). Summary of **what replicates and what persists**:

| System | Replication | Persistence |
|---|---|---|
| **Taint / Hollowing / bands** | Server-owned attributes (GAS); replicated to the owning client + party HUD (§14). | **Character save** (carried/banked Taint, Hollowing track). |
| **Shared Hearth** | Persistent world actor; **relevancy-gated** (only nearby clients update); bank/purge are server transactions. | **World save** (lit/fuel/tier/upgrades/radius + **per-character bank ledger** entries). |
| **Blight-transfer revive** | GAS channel; predicted start on reviver, server-confirmed; meter changes replicated to all. | **Not independently persisted** — a live transaction; only the resulting Taint/Hollowing values persist (character save). Disconnect → abort + refund (§13.5.4). |
| **Corpse-cache** | Owner-tagged world actor, **dormant when no one is near** (cheap). | **World save** (owner-id, contents, recoverable flag). Ownership/party-open per §13.5.3. |
| **Turned-entity (turned player/NPC)** | Spawned as a normal AI Wake actor; replicates like any elite. | **World save**, **decoupled from the retired character** (§12.7/§13.7). |
| **World decay / Long Dusk** | Server `WorldDecaySubsystem`; slow tick; replicates a **compact region-state delta** clients reproduce locally. | **World save** (region-state vector + Long Dusk clock). |
| **The ending (Rite of the Crown)** | Runtime consent/claim state until a **single atomic commit** (§13.8.5). | **Two flags, no new machinery** (tech-coop-expert): a **world-level ending field** (`none / Pyre / Crown` + participant char-ids + `worldSovereign` anchor-id) and a **per-character "completed ending X @ world Y"** flag. |

**Ending persistence outcomes** (tech-coop-expert rulings):

- **End it (Pyre):** **end the WORLD, KEEP the characters.** Set `worldEnding = Pyre` (+ timestamp +
  participant ids) — the world is **flagged-complete** (same shape as Warden/Reliquary completion
  flags). **Do NOT delete the participating character saves** (that would be the roguelike erasure the
  bible rejects, §12.1) — credit each with a `completed: Pyre @ world <id>` flag and keep it; the "you
  die too" beat is a **narrative epilogue, not save destruction**. Each friend keeps their portable
  Revenant (free to carry to other worlds or seed NG+); the shared world is archived/epilogue per
  design.
- **Master it (Crown):** **world CONTINUES.** Store `worldSovereign = <anchorCharId>` (a world-state
  singleton); the world is **not** retired — it stays a persistent, playable post-ending Long Dusk.
  The anchor character keeps its portable save + an `isSovereignOf: <worldId>` flag; the **other
  players' characters are untouched and fully playable** in the now-post-ending world.
- **Be consumed:** per §12.7 — character retired, turned-entity to world save; others and world
  unaffected.

**Reused patterns (no new primitives):** Pyre unanimity = the same **result-only-persistence** as
Blight-transfer; Crown first-to-claim = the same **atomic compare-and-set** as corpse-cache ownership
and the atomic Taint decrement. The whole co-op layer rides the **server-authoritative atomic-
transaction + result-only-persistence** model the rest of the death/co-op system already uses.

---

### 13.10 Open Questions

- **Corpse-cache party-open default vs. owner-only (§12/§19).** Defaulted **owner-only** (§13.5.3);
  whether some difficulty presets ship party-open is an options-pass call (interacts with §12.4's
  cache-count knob).
- **Spawn-budget per-player coefficient (§10/§18 balance).** The ~+60–75%/extra-player scaling
  (§13.6) is the co-op difficulty dial — must be confirmed by playtest against the hottest-band TL
  rule, so 4-player groups are hard-but-fair, not trivial or oppressive.
- **Cross-progression of shared world unlocks (§7/§16).** Whether guests carry *world*-side unlocks
  (Reliquary rewards earned in a host's world) back to their own world is a persistence/design seam
  flagged to tech & economy — the **character** is portable; which **world** flags travel with it is
  not yet specced.
- **Simultaneous-Crown-commit tie-break (§16).** The atomic claim guarantees one winner; the exact
  tie-break heuristic (server-stamp vs. lowest-latency) is a netcode-design detail flagged to tech.

---

<a id="sec-14"></a>

## 14. UI/UX & Player Feedback

> **Scope.** This section specifies how the player *reads the game* — above all, how the **corruption economy** (§5) is made instantly legible, because that is the single hardest and most important readability problem in WITHERREACH. It covers the diegetic-vs-HUD stance, the keystone corruption readout (the **Taint** meter, the threat bands **Lucid / Marked / Fevered / Brink**, the **Hollowing** pips), the full HUD layout, combat feedback, map and compass in the dark, inventory, and the **Hearth** transaction interface (bank / purge / temper / ascend). It owns *presentation and feedback*. It does **not** own the systems it displays: the Taint/Hollowing/Blight economy and its numbers (§5), survival rates (§6), Hearths and gear (§7), ascension (§8), combat math (§9), the Wake (§10), the death model (§12), or co-op mechanics (§13). **Fine accessibility options (colorblind modes, scalable text, input remapping, difficulty assists) are owned by §19** — this section states only the load-bearing readability principles that §19 must not be allowed to be the *only* line of defense for. Glossary terms (concept bible §14) are used verbatim. Illustrative values are marked **(illustrative — to tune)**.

---

### 14.1 UX pillars & the keystone readability problem

The corruption economy makes one demand of the UI that no other survival-RPG has to meet: **a single carried meter is simultaneously the player's power reserve and their survival-threat readout, and the player must be able to answer four questions at a glance, at all times:**

1. **How much Taint am I carrying?** (my spendable power *and* my danger)
2. **What threat band am I in?** (Lucid / Marked / Fevered / Brink — what penalties and hunt-pressure are live right now)
3. **How close am I to *turning*?** (my permanent Hollowing — the soft-permadeath track)
4. **How hot is the world around me?** (the dark, the decay state, the Wake closing in)

If the player cannot answer these reflexively, the keystone loop (§5.8) — *survive → take on Taint → spend for power → but carrying it raises real-time danger* — collapses into confusion. **Making corruption instantly readable is the central UX task of the entire game.**

**UX pillars (binding):**

- **Corruption is read on the body and the world first, the HUD second.** The fiction grounds every meter on the Revenant's own soul (§2.2.5), so the primary readout is *diegetic* — what the player sees happening to their character and their surroundings. The HUD is the precise, glanceable confirmation of what the world is already telling them.
- **One meter, one home on screen.** Taint, its bands, and Hollowing live in a single, fixed **corruption cluster** the eye always knows where to find. Power and danger share a readout because they share a system.
- **Quiet at rest, loud at risk.** The HUD is minimal and recedes when the player is safe (Lucid, lit, fed); it escalates — visually and audibly — precisely as danger rises. The interface's *volume* is itself a threat readout.
- **Redundant channels, never color alone.** Every critical state is signaled by at least two of {shape, position, motion, audio, world-state} so it survives a dropped color channel, a dark scene, or a player not looking at the HUD. (§19 owns the *options*; this pillar owns the *floor* — see §14.12.)
- **No surprises.** *Turning* is always telegraphed across the whole Hollowing track (§5.7); the UI's job is to make the descent impossible to not see coming (concept bible §11).

---

### 14.2 The diegetic-vs-HUD stance

WITHERREACH is **diegetic-first, HUD-confirmed.** The split is deliberate and load-bearing, and it is also a performance win (§14.13): the body/world channels are mesh/material/audio effects (cheap), and the HUD stays small.

**Carried diegetically (on the character & the world):**

| Channel | What it reads | Tied to |
|---|---|---|
| **Corruption-glow on the Revenant** | Current Taint band — a spectral soul-glow that rises from faint (Lucid) to bright, veined, mutating (Brink), in the Blight's iridescent palette (§15). | Taint band (§5.2) |
| **The carried deathlight dimming** | Hollowing progress — the player's salvaged-sun ember *gutters and dims* as the soul is drawn into the web (§15). A free, always-on Hollowing telegraph. | Hollowing (§5.7) |
| **The dark's breath & whispers** | Ambient danger + Taint — the unlit dark audibly breathes and whispers, intensifying with darkness *and* the player's Taint (the web recognizing you); whispers resolve from ambient to *directed* as Hollowing deepens (§15). | Taint + dark + Hollowing |
| **Cosmetic mutations & body marks** | Long-term Taint exposure and Hollowing stage — ash-veined skin, dimming eyes, twitches, vision corruption (§5.7, §15). | Hollowing stages |
| **The Wake's density** | The externalized threat readout — high Taint and high Tide visibly draw more Wake; *casting or purging visibly calms the tide around you* (§10). | Threat Level (§10) |
| **The decay state of the ground** | How deep and dangerous the current space is, read from environment art before any UI (§11.2). | Zone tier (§6/§11) |

**Carried on the HUD (precise, glanceable):**
The **corruption cluster** (Taint arc + Hollowing pips, §14.3/§14.5), **Hunger**, on-use **Health/Stamina**, **light-fuel**, the **compass ribbon**, the **objective hint**, and transient **band-transition / overflow / Brink** alerts. Everything else (full meters, inventory, map, the Hearth transaction) is summoned, not persistent.

**The principle:** if the player turned the HUD entirely off, the *world and body* should still let an experienced player survive — the HUD makes it precise and fast, it is not the only source of truth.

---

### 14.3 The corruption readout — the keystone HUD

This is the most important UI element in the game. It must show, in one fixed, glanceable cluster: **current Taint, the build floor it can never drop below, the carry ceiling, and which of the four threat bands the player is in** — all auto-scaling to any build (because the bands key on the fraction `f = Taint / T_max`, §5.2, so a Pure Tainted build at floor *rests* in a high band, and the UI must show that as the build's normal resting state, not an alarm).

#### 14.3.1 The Taint arc (the design)

The Taint readout is a **vertical crucible/arc** (a contained vessel of soul-light, diegetically the Taint held in the Revenant), placed in a fixed corner anchor (§14.6). It is a **single small shader-driven widget** (tech-confirmed cheap, §14.13) rendering:

- **Fill = current Taint**, from `0` at the base to `T_max` at the top. The fill is the Blight's spectral soul-glow, rising in luminosity/saturation with the band (§15).
- **The floor line (`T_floor`)** — a hard, distinct etched line on the crucible marking the build's irreducible minimum. **The fill never drops below it.** This line is the single most important teaching element of the build = survival-difficulty model (§5.6): the player *sees* that their floor sits a quarter-to-half up the vessel on a Tainted build, so they *rest* in a danger band by design.
- **The band thresholds** — three subtle tick marks at `f = 0.35 / 0.60 / 0.85` dividing the crucible into the four bands, each band shaded with its color *and* a distinct edge texture/pattern (so the band is read by region shape, not color alone).
- **The ceiling (`T_max`)** — the rim of the crucible; the closer the fill is to the rim, the closer to overflow.

#### 14.3.2 The four threat bands

The bands are the survival readout. Each has a locked **identity across color + position + texture + the body/world FX it triggers** so it reads redundantly. Penalties are owned by §5.2; here is the *presentation*:

| Band | `f` | HUD treatment | Body/world FX (diegetic) |
|---|---|---|---|
| **Lucid** | 0.00–0.35 | Crucible calm, low glow; HUD at rest. | Faint corruption-glow; clean screen. |
| **Marked** | 0.35–0.60 | Fill crosses the first tick; arc brightens; first subtle alert on entry. | First cosmetic mutation; glow strengthens; spoilage begins (inventory readout, §14.9). |
| **Fevered** | 0.60–0.85 | Fill in the upper band; arc pulses slowly; **festering icon** appears near the health readout. | Screen-rot creep + chromatic edge begins (combined post-process, §14.4); audio corruption; the Wake press in. |
| **Brink** | 0.85–1.00 | Crucible near-full, hard-telegraphed; **turning-risk** banner; Hollowing-accrual indicator ticks. | Full Brink telegraph — vignette, heartbeat pulse, loud whispers (§14.4); maximum Wake hunt-pressure; co-op party warned (§14.11). |

#### 14.3.3 Spend & gain feedback

Because Taint is *both* mana and danger, the player must feel every transaction:

- **Casting / weapon-arts / the Ultimate (spends, §5.4):** the crucible fill **drops visibly and immediately** with each cast, accompanied by an exhale-of-soul-light VFX off the Revenant — the player *sees their danger drop as they fight* (the in-field release valve, §5.8). The fill animates down to, and **stops hard at, the floor line** — teaching the floor-cap viscerally (a Tainted build watches its casts bottom out above the floor and cannot get safe in the field, §5.4).
- **Ambient gain (the dark, blighted food, §5.3):** the fill **creeps up**, faster in the dark (the ×5 rate is *felt* as a visibly quicker climb), with the corruption-glow brightening in step.
- **Overflow warning (§5.2):** as the fill nears the ceiling, the rim flares and a distinct **overflow-imminent** cue fires — any gain past `T_max` spills to Hollowing (a permanent cost), so this warning must be unmissable *before* the spill, not after.

This element is a small custom-material widget — well within the HUD GPU budget (§14.13).

---

### 14.4 Threat-band escalation feedback (the corruption post-process)

The whole-screen escalation that sells *Fevered* and *Brink* is delivered as **one combined post-process material** (vignette + chromatic aberration + screen-rot creep in a single shader pass), **escalation-gated** so it is near-zero cost at low Taint and reaches full strength only at the top bands (tech-confirmed; do **not** spec an always-on multi-pass stack — §14.13). The design is also the cheap path: the heaviest effect only exists when the player is actually in danger.

| Band | Screen treatment | Audio treatment |
|---|---|---|
| **Lucid** | None — clean frame. | Calm ambient; the dark quiet. |
| **Marked** | A barely-there warm-cold tension at the frame edge. | First whispers thread in. |
| **Fevered** | Screen-rot *creeps inward* from the edges; light chromatic fringe; desaturation toward the Blight palette. | Audio corruption; the breath deepens; festering "wet" cues on hits. |
| **Brink** | Full vignette closing in; a **heartbeat pulse** (specced as an animated vignette + chromatic-aberration scale, **not** a true full-screen blur, so it stays cheap on Series S / Steam Deck — §14.13); the world reads as actively claiming the player. | Whispers swell to near-words and turn *directed*; the breath becomes a near-inhale; a low choral pressure. |

**Counterplay readability:** the moment the player drops out of Brink (an Ultimate, a purge, fleeing to light), the post-process **recedes immediately** — so the player learns that *they* control the screen-state by controlling their Taint. The interface's intensity is a closed feedback loop with the corruption economy.

---

### 14.5 The Hollowing pips — the permanent track

Hollowing (§5.7) is the soft-permadeath ratchet — permanent, un-purgeable except by the rate-limited Cleansing rite, and the thing the player fights for the whole game. It is read as **10 pips of 10**, sitting **inside the corruption cluster, beneath the Taint crucible** (permanent below, volatile above — a spatial metaphor: Hollowing is the floor the Taint meter stands on).

**Design rules:**

- **Always visible, always quiet — until it isn't.** The pips are present at all times (the stakes are never hidden) but visually subdued in the early stages; they escalate their own prominence as they fill, mirroring the 5 fiction stages (§5.7, §2.2.5):

| Pips | Stage (§5.7) | Pip readout & cues |
|---|---|---|
| **0–3** | The Marking | Pips fill quietly; faint whispers (diegetic). Cosmetic body marks. |
| **4–6** | The Souring | Pips take on the Tainted hue; a subtle "stat drift" tooltip is available; the Wake grow *less* aggressive (a readable behavioral cue — §10). |
| **7–8** | The Pull | Pips pulse; **involuntary twitches, vision-corruption flickers, NPC recoil** (diegetic). Whispers turn directed. |
| **9** | Brink of Turning | The pip cluster hard-telegraphs; a persistent **Brink-of-Turning** warning; **last-chance rites surfaced** in the world (a Warded Last Rite / a Communed vigil, §3); in co-op the **party is explicitly warned** (§14.11). |
| **10 (=100)** | The Turning | The turn sequence fires — a telegraphed set-piece, never a silent wipe (§12). |

- **Death and overflow feedback.** On death, the relevant pip(s) advance with a distinct, heavy cue (dying *hot* advances more — §5.7), so the player connects death and Hollowing directly. Overflow spill (§5.2) advances a pip with the same cue, reinforcing that greed past the ceiling costs permanently.
- **The Cleansing rite** (the only reducer, §5.7) reads at a Greater Hearth as a pip *un-filling* — a rare, hard-won, visibly extraordinary act, surfaced in the Hearth interface (§14.10).

---

### 14.6 Full HUD layout

The HUD is minimal, fixed-anchor, and recessive. Persistent elements are few; everything else is on-demand. (Exact safe-zone placement and scaling are §19's to tune; the *information architecture* is locked here.)

```
┌─────────────────────────────────────────────────────────────┐
│ [compass ribbon — diegetic, only what's been seen]          │  top: wayfinding (§14.8)
│                                                             │
│                                                             │
│                                                             │
│                                                             │
│                        (clean center —                      │
│                      diegetic world is                      │
│                       the main readout)                     │
│                                                             │
│                                                  ┌────────┐ │
│                                                  │ Taint  │ │  right: the CORRUPTION
│                                                  │ crucible│ │  CLUSTER (§14.3, §14.5)
│                                                  │ ▓▓▓——  │ │  - Taint arc + floor line
│                                                  │ ●●●○○○ │ │  - Hollowing pips beneath
│                                                  └────────┘ │
│ [HP][Stamina]  on-use only        [Hunger] [light-fuel]     │  bottom: needs & on-use vitals
└─────────────────────────────────────────────────────────────┘
```

| Element | Persistence | Notes |
|---|---|---|
| **Corruption cluster** (Taint crucible + Hollowing pips) | **Always on** | The one fixed home for power+danger (§14.3, §14.5). The single most-glanced element. |
| **Hunger** | Always on (recessive) | The one extra survival bar (§6); its only sustainable answer routes through the Blight, so it sits *near* the corruption cluster to make that coupling spatial. |
| **Light-fuel** | Always on (recessive) | Remaining burn on the carried light (§6) — a navigation/safety budget (§11.5). Flares when low (the "closing dark"). |
| **Health & Stamina** | **On-use** | Appear on damage/exertion, fade when safe (Soulslike restraint, weighty combat — §9). Stamina shows during combat/sprint; health on hit/heal. |
| **Compass ribbon** | On-demand / contextual | Diegetic wayfinding (§14.8); fades during combat. |
| **Objective hint** | On-demand | A single, dismissible current-objective line; never a quest-log overlay on the play screen. |
| **Transient alerts** | Event-driven | Band-transition, overflow-imminent, Brink, Hollowing-advance, Wake-hunter-dispatched — brief, distinct, redundant (icon + motion + audio). |

The center screen is kept clean on purpose: the **world is the main readout** (§14.2).

---

### 14.7 Combat feedback

Combat is deliberate, stamina-gated, weighty (Soulslike, §9). The UI's job is to make the three-layer model (Stamina / Poise→stagger / Health) and the **damage-type triangle** readable without clutter. (Combat math is §9's; this is presentation.)

- **Telegraphs first.** Enemy attacks are read primarily from **animation tells and audio** (Soulslike fundamentals, §9/§10), not HUD warnings. The HUD adds only a lock-on reticle and, for off-screen threats, a directional damage/aggro indicator.
- **Stamina is the action-economy readout.** The stamina bar (on-use, §14.6) is the player's tempo gauge — empty-stamina guard-break is signaled by a distinct stagger cue. Regen-delay is felt through the bar's behavior, not a number.
- **Poise / stagger.** Landing poise damage gives escalating impact feedback; an enemy reaching 0 poise reads as a clear **stagger window** (a flash/posture-break + audio sting) inviting the critical (riposte/visceral/backstab, §9). The player's own hyperarmor during heavy swings is read through the lack of a stagger reaction.
- **The damage-type triangle must be legible** (physical / **rot** / **light/cleansing**, §9.7-equivalent / combat brief §7.3) — this is a *build-and-encounter* readability problem as much as a combat one:
  - **Rot** damage (Tainted) reads in the Blight's iridescent palette; **strong vs living tissue / Warden cores**, **weak vs the already-rotted Wake** — hit feedback (effective/ineffective "thunk") tells the player when their rot is being shrugged off by the rot-saturated.
  - **Light/cleansing** damage (Warded, hearth-fire, blessed oil) reads in warm pale-gold; **strong vs the Wake and the Hollowed** — visibly *burns* the rot.
  - Effective vs resisted hits are distinguished by hit-VFX color/intensity and an audio cue, so the player *learns the triangle by playing it*, not by reading a table.
- **Rot-magic as visible Taint drain.** Casting is the bridge to the corruption economy (§9/§5.8): each cast drains the Taint crucible (§14.3.3) with an exhale-of-soul-light off the caster — the player *sees* combat lowering their danger. Cast commitment (windup/recovery) is read through animation weight.
- **Co-op friendly-vs-foe.** Turned players/NPCs and the Wake must be instantly distinguishable from allies in the dark (§14.11) — allies carry the warm deathlight; the Wake glow cold-spectral with eyes-in-the-dark (§15).

---

### 14.8 Map & compass in the darkness

There is **no omniscient minimap.** Wayfinding is built around the core constraint that **the dark is the fog-of-war** (§11.5).

- **The diegetic hand-map.** A summoned (not persistent) map is a **hand-drawn chart that fills in only what the player has lit and seen** — a literal record of the Revenant's own exploration, with the dark left blank. Reclaimed regions (rolled-back decay, §11.7) redraw clearer; encroached regions (§11.6) corrupt and blur on the chart. The map is never a satellite view; it is a memory.
- **Markers, not waypoints-everywhere.** The map shows the **Hearth network** (the safe graph, §11.8) — Hearths as pale-gold points, Greater Hearths as small false-dawns — plus the current objective and discovered Reliquaries. It does **not** mark resource nodes or enemies; those are found by exploring the dark (§11.5).
- **The compass ribbon = a deathlight needle.** The persistent-on-demand compass is diegetically the carried ember leaning toward kindled light: it points reliably to **Hearths/Greater Hearths and the current objective**, and toward the basin's heart (down-valley) as a constant orientation. It does *not* point at loot. In deep regions where the rot lies (R4 Blooming, §11.3.5), the needle's reliability is itself a tether against the disorienting glow.
- **Audio wayfinding is part of navigation, not the map.** The **dark's breath** (danger/Taint direction) and the **Choir-Echo** (louder toward the Crown / near Choristers) are directional diegetic cues the player learns to navigate by (§11.5, §15) — the UI does not duplicate them as HUD arrows.

---

### 14.9 Inventory & gear

The inventory serves the corruption economy first: it must make the **clean-vs-blighted** two-track supply (§6/§7) and the **gear = floor** trade (§5.6/§8) immediately legible.

- **Clean vs blighted tagging.** Every consumable, resource, and gear piece is tagged by track — **clean** (warm pale-gold iconography; the *safety* resource: purge fuel, light fuel, clean food, Cleansing materials) vs **blighted** (cold iridescent; the *power* resource: tempering, render-to-Taint, blighted food). The player sorts strategy by color *and* a distinct icon frame (redundant — §14.12).
- **Render decision surfaced.** Raw Blight resources carry no Taint until rendered (§5.1); the inventory shows **render → Taint** as an explicit, player-elected action with its Taint cost previewed, so the player chooses *when* to take on the danger (never an accidental gain).
- **Spoilage readout tied to the band.** Carried food/supplies spoil faster at higher Taint bands (×1.5 Marked, ×2.5 Fevered — §5.2/§6). Each perishable shows a freshness state that visibly *accelerates* when the player is in a danger band — coupling "carrying power" to "your supplies rot" in the inventory itself.
- **Gear shows its floor impact.** Equipping or tempering a piece previews its **`T_floor` change** (§5.6/§8) — the player sees, before committing, that the stronger tempered piece *raises their resting danger*. The two upgrade rails (clean reinforcement = no floor change / Blight-tempering = +floor, §8) are shown as the explicit power-for-difficulty trade. **There is no "strong + safe" gear**, and the UI must never imply one (§5.6).
- **Weight / equip-load** reads as a roll-tier indicator (fast/normal/fat, §9), not a raw number, keeping the Soulslike feel.

---

### 14.10 The Hearth interface — bank / purge / temper / ascend

The Hearth is where the **session-climax decision** happens (§5.5) — the second keystone UI after the corruption readout. At the Hearth, the player's carried Taint (`T_end`) has **three competing claimants for the same banked Taint: purge, temper, ascend** (§5.5, §8). The interface's entire job is to make that trade's *consequences* legible *before* the player commits.

#### 14.10.1 The transaction screen

A single calm screen (the Hearth is the safe place — the HUD escalation drops away, the post-process clears, the breath quiets) presenting the carried `T_end` and the three claimants, each with a **forward preview**:

| Action | What it does (§5/§7/§8) | The preview the UI must show |
|---|---|---|
| **Bank (hold)** | Keep `T_end` into the next Expedition. | **Next-run resting band preview** — "you will start in *Fevered*"; the projected hunt-pressure, spoilage, and overflow-risk of starting hot. Power potential preserved. |
| **Purge** | Drive Taint down to `T_floor` for clean fuel + materials. | The **purge cost** (climbs with Hollowing, §5.4) and the forfeited power ("61 Taint of potential lost"). Safe next run. |
| **Temper gear** | Raise a piece's tier for Taint + Blight materials. | The stat gain **and the `T_floor` increase** (power buys difficulty, §5.6/§8) — shown on the crucible as the floor line *rising*. |
| **Ascend a node** | Buy permanent build power for Taint (+ node materials). | The node effect (§8) **and** its floor/ceiling change: Tainted nodes raise the floor line *and* the ceiling; Warded nodes *lower* the floor and raise purge efficiency. Shown live on the crucible. |

**Design intent:** the crucible from the HUD (§14.3) is the live model in this screen — the player drags their `T_end` between claimants and *watches the floor line and the resting band move* before confirming. The irreducible choice (§5.5 — none is correct) is made by showing the real trade, not by hiding it. After investing, the remainder can be purged in the same flow.

#### 14.10.2 The Greater Hearth additions

A **Greater Hearth** (§7) adds two extraordinary actions to the interface:

- **The Cleansing rite** — the *only* Hollowing reducer (−1 pip), rate-limited (≤ once per Tide per Greater Hearth, §5.7). Surfaced as a rare, gated, visibly momentous action: it costs a large clean-resource sum and **un-fills a Hollowing pip** (§14.5). The UI makes its rarity and cost unmistakable so the player treats it as the lifeline it is.
- **Region reclaim status** — the Greater Hearth's fuel level and the **decay state it is pinning** (§11.7), with a warning if fuel is lapsing (let it go dark and the held rot floods back). This ties the session-climax screen to the macro map-as-a-tide.

#### 14.10.3 Fuel & maintenance readout

Because a Hearth must be **fueled** to keep its safe radius (§6/§7), the interface shows fuel as the standing cost of safety — and surfaces the desperate stopgap of **blighted fuel** (keeps the flame lit but degrades the Hearth so its radius stops suppressing Taint, §6) as a clearly-marked dangerous option, never a neutral one.

---

### 14.11 Co-op UI

Co-op (§13) layers a party readout onto the same diegetic-first stance, focused on the corruption economy's shared stakes.

- **Party corruption at a glance.** Each ally shows a compact **band + Hollowing-stage** readout (not a full crucible) — so the party can see who is running hot, who is near the Brink, and who can afford to spend. Role structure (Warded anchor / Tainted strikers) falls out of these readouts (§13/§5).
- **The downed & Blight-transfer prompt.** A downed ally (§12/§13) shows a **revive window** timer and a **Blight-transfer** prompt to nearby allies: reviving costs the reviver **~30 Taint, transferred to the revived** (§5/§13) — the UI shows *both* meters changing, so the sacrifice (you spend your corruption to save them; they come up carrying it) is legible on both sides. A predicted channel-start gives the reviver instant feedback (§16).
- **The turning warning.** When any party member reaches Hollowing pip 9 (Brink of Turning, §14.5), **the whole party is explicitly warned** — turning a co-op ally into a hostile Wake-elite (§10/§12/§13) is a shared catastrophe and must never surprise the group.
- **Shared Hearth ledger.** The Hearth interface (§14.10) shows the **shared Hearth** state and **per-character bank ledger** (banked Taint, caches, and Cleansing-rite cooldowns are per-player; the Hearth/fuel/decay-rollback are shared — §13/§16), so no player is confused about what's theirs vs the world's.

---

### 14.12 Accessibility — the load-bearing floor (fine detail deferred to §19)

**Full accessibility options are owned by §19** (colorblind palettes, text scaling, input remapping, audio/visual assist toggles, difficulty assists). This section locks only the **readability floor** that the rest of the UI is built on, so that §19's options are *enhancements*, never the *only* thing standing between a player and an unreadable corruption state:

- **No critical state depends on color alone.** Threat bands, clean-vs-blighted tagging, the damage-type triangle, and friend-vs-foe are each carried by **≥2 of {shape, position, motion, audio, world-state}** (§14.1). The diegetic-first stance is itself an accessibility asset — corruption is shown through the deathlight's brightness, the screen post-process, body marks, the dark's breath, and Wake density, not a single colored bar.
- **The four channels are independently sufficient-ish.** A player relying primarily on audio (the breath, whispers, the song, hit cues) or primarily on the body/world (glow, deathlight dimming, mutations) can still read their corruption state; the HUD makes it precise, it is not a single point of failure.

These are requirements on §14's design; §19 owns the tunable options that extend them.

---

### 14.13 UI/UX performance constraints (confirmed with tech)

Budgeted to **Xbox Series S (10GB) / Steam Deck at 60fps** (§16). Confirmed with the tech-coop expert:

- **HUD GPU budget:** keep total HUD under **~0.5–1ms** of the 16.6ms frame. The minimal diegetic plan fits comfortably. The killer is **overdraw**, not draw calls — **no full-screen translucent stacks**; keep translucency to small regions; wrap static HUD elements in **UMG Invalidation Panels** so they don't repaint every frame. The shader-driven Taint crucible is a **small** custom-material widget = negligible; **never** a full-screen material widget or a full-screen Retainer Box.
- **The corruption post-process (§14.4):** spec as **one combined post-process material** (vignette + chromatic aberration + screen-rot in a single pass), **escalation-gated** (near-zero at low Taint, full only at Fevered/Brink) — budget ~**1–1.5ms** on Series S. The **Brink heartbeat** must be an animated vignette + chromatic-aberration scale, **not** a true full-screen blur (the priciest element on Deck); a lighter Brink variant ships on Deck. Quality-scale on low-end.
- **The corruption-glow on the character** is a mesh/material effect (cheap), not HUD — it carries readability load off the framebuffer.

The design and the budget align: the heaviest feedback only exists when the player is in real danger.

---

### 14.14 Open Questions

- **Crucible vs arc form factor.** The corruption readout is specced as a vertical crucible (§14.3.1); the alternative (a radial arc around a corner) is a visual-design A/B for the art/UX pass — both satisfy the floor-line + band + ceiling requirements. Flagged for the UI art pass, not a systems decision.
- **Map persistence in co-op.** Whether the diegetic hand-map's "seen" state is per-player or shared in co-op (§14.8) interacts with the character/world save split (§16) — routed to §13/§16 for confirmation; default assumption is per-player exploration memory.
- **Diegetic-off as an explicit mode.** §14.2 claims the world/body are sufficient to survive HUD-off; whether to ship a curated "HUD-minimal/diegetic-only" mode (vs leaving it to §19's toggles) is a §19 + UX-pass decision.

---

<a id="sec-15"></a>

## 15. Art Direction & Audio

> **Scope.** This section is the visual and sonic execution spec for WITHERREACH: the art pillars, the master palette/lighting axis, light-vs-dark rendering, the five **decay states** visualized, the character/creature visual language (the **Revenant**, the **Wake**, the **Wardens**, the **Hollow Crown**, the factions), environment art, and the audio direction (drones, funeral-folk instrumentation, the dark's "breath," and adaptive music tied to **Tides** and threat band). It executes the fiction of §2 and the tone of concept bible §6; it dresses the systems owned elsewhere (corruption §5, survival/light §6, Hearths §7, combat §9, the Wake/Wardens §10, world/regions §11) and renders the readouts specified in §14. Engine, rendering tech, and performance budgets are owned by §16 — referenced here, not re-decided. The visual & audio **canon** below was locked with the narrative-world expert (their brief §14) and is binding. Glossary terms (concept bible §14) are used verbatim. Illustrative values are marked **(illustrative — to tune)**.

---

### 15.1 Art pillars

The bible's tone (concept bible §6) is **oppressive, melancholic, and beautiful-in-decay — folk-horror crossed with funereal grandeur; grimdark, not nihilistic.** Five pillars execute it:

1. **Beautiful-in-decay.** The rot is *seductive*, not merely gross. The deepest corruption is the most gorgeous (the *Annihilation* "Shimmer" register, §2.8) — so the world tempts the player toward the very thing killing it. Horror carries awe; awe carries pity.
2. **Funereal grandeur.** Everything is a monument to an interrupted death (§3.6). Scale is solemn and liturgical — ruined cathedrals, cremation-forests, drowned capitals. The world mourns at the scale of a civilization.
3. **Folk-horror austerity.** Against the grandeur, an intimate, grounded, human texture — the *The VVitch* / *The Road* register (concept bible §6): worn cloth, hand-tools, burial rites, small mercies. The dread is domestic before it is cosmic.
4. **The dark costs the light.** "Earn the Light" (pillar 4) is an *art* pillar: light is precious because it is scarce and salvaged. Every gold pool of Hearth-light is a held breath against an overwhelming dark.
5. **Melancholic awe / hope as a verb.** Never despair as a flat fact — despair as a *price* (§2.8). The art finds the fragile-beautiful in the bleak so that pushing the dark back, even briefly, lands as earned.

**Reference touchstones (concept bible §6):** Bloodborne / Dark Souls (gothic decay, weighty silhouettes, the hollowing register), Don't Starve (light-vs-dark survival dread, silhouette horror — but grimmer, grounded, 3D), *Annihilation* (the Shimmer — corruption as seductive alien beauty), *Princess Mononoke* (rot-gods, nature corrupted, the dignity of the dying world), *The Road* (scarcity, tenderness, bleak palette), *The VVitch* (folk-horror austerity).

---

### 15.2 The master palette & lighting axis (THE rule)

Every space, faction, meter, creature, and ending reads on **one opposed two-pole axis** (locked canon):

> **Warm pale-gold = release.** The sun, the door, the **Hearth**, the **deathlight**, the **Warded**, mercy. The light that lets souls *pass*.
>
> **Cold iridescent spectral = capture.** The **Blight**, the web, the trapped souls, the **Tainted**. The light that *holds* souls in.

This is not a mood board — it is a *legibility system*. Because the whole game reads on this single axis, the player parses safety/danger, Warded/Tainted, mercy/mastery, and life/un-death from color-temperature and light-quality alone, everywhere. The two poles are kept distinct in **temperature *and* quality**: gold is warm, low, tired, *passing*; iridescent is cold, glowing, restless, *clinging*. The heart of the basin (R6, §11.3.7) is where the two poles **collide** — the dramatic and chromatic climax of the entire palette.

> **Critical correction (canon):** the Blight's iridescence is **spectral soul-glow** — ghostlight, will-o'-wisp, funereal — **not** chemical or radioactive. It is leaking trapped souls. Keep it *haunting*, never sci-fi-toxic.

---

### 15.3 Light-vs-dark rendering

Light is the game's central art-and-gameplay resource (§6, §11.5). The rendering of light and dark is therefore a load-bearing system, not a lighting pass.

#### 15.3.1 The deathlight hierarchy

All "safe" light in the world is **salvaged sun** — a fragment of the guttered, *waning* late sun (§2.2.3), rendered as **pale gold → bone-white, low and tired, never campfire-orange** (it is the door-light, not fire). It comes in a strict hierarchy the player reads as a safety scale:

| Light source | Read | Rendering |
|---|---|---|
| **The carried deathlight** (the Revenant's ember) | Personal, fragile safety; a navigation budget (§11.5). | Faint, guttering pale-gold; small radius. **Dims as the player Hollows** (the diegetic Hollowing telegraph, §14.2). |
| **The Hearth** | A held safe haven (Taint-gain 0, §6). | A steady pale-gold *pool*; the calm centre of a space. |
| **The Greater Hearth** | Region-scale reclaim (§11.7). | A **small false dawn** over a region — the closest thing to a sunrise the world still has. The reclaim-wave source (§15.3.3). |

#### 15.3.2 The dark as a presence

The unlit dark is **not the absence of light — it is the presence of the un-suppressed web** (§2.2, §15.7). It is rendered and *scored* as an active thing: a thick, fog-bound, soul-pressured dark that **breathes** (§15.7). Visually, the dark is where the Blight's spectral glow is unmasked — eyes and rot-light hang in it (§15.5.2). This is the survival-horror core of the art: stepping past your light is stepping into something *occupied*.

#### 15.3.3 The reclaim light-wave (and the encroachment inverse)

The single most cathartic art beat is the **Greater Hearth reclaim** (§11.7), authored exactly as tech confirms is both cheap and dramatically correct (§16):

- **Cross-fade the cheap channels:** a wave of pale-gold light, clearing fog, and *healing* material sweeps the region in real time — a single region `decayBlend` scalar (Material Parameter Collection) lerps fog density, light color/intensity, exposure, and material params over a few seconds. This **is** the visible reclaim wave: the light physically pushing the dark back.
- **Hard-swap the geometry behind the front:** prop/spawn/navmesh changes pop in **out-of-view, behind the advancing light front**, with only a few **hero props** near the player dither-fading during the blend window. Cross-fading full mesh sets is forbidden (it doubles geometry cost — §16).
- **Encroachment (§11.6) is the same system in reverse:** the Tide advances the scalar the other way — gold drains, fog thickens, material rots, the dark reclaims the front. The map is a literal tug-of-war over one scalar, rendered as a moving light line.

#### 15.3.4 Rendering approach (per §16)

The "rotting-gorgeous at indie-mid headcount" pillar rides **UE5 Nanite + Lumen + the Fab/Quixel pipeline** (§16). Light discipline is **mandatory, not optional** (Series S is on *software* Lumen). The binding rule, confirmed with tech:

- **Shadow-casting is a hero-light privilege.** The Hearth and the player's carried light cast **real dynamic shadows** — that is what sells "safety has a shape." Budget **single-digit shadow-casters in view** on Series S.
- **All ambient small lights are emissive/non-shadowed** and effectively unlimited and near-free: the Wake's eyes, distant lantern-glows, Hearth embers, the Blight's soul-glow — all emissive material + bloom. The "many small lights in the dark" fantasy is fully deliverable as glows.
- **Megalights** (hundreds of shadow-casters at ~fixed cost) is a later opt-in **[VERIFY on Series S/Deck]** (§16) — do **not** hard-promise dozens of shadow-casters until profiled. The hero-light spec degrades gracefully with zero change to the art read if Megalights underperforms.

---

### 15.4 The five decay states visualized (the keystone art table)

The five **decay states** (§2.4.1, §11.2) are the core environment-art production spec. Each is a complete, authored "dressing" of base geometry, driven by the region decay scalar (§16) — geometry is built once, dressed N times (§11.8). The ramp is the master palette axis (§15.2) in motion: **luminosity and saturation rise inward**, so the rot becomes *more beautiful and more lethal* toward the heart.

| Decay state | Geometry / form | Material & surface | Fog & light | Palette | Props & set-dress | Audio signature (§15.7) |
|---|---|---|---|---|---|---|
| **Lingering** | Recognizable architecture and roads intact; the walking dead still wear who they were. | Weathered but readable; rot is incidental. | Thin twilight fog; the world is dim but visible without the deathlight. | **Grey, near-untinted** — drained, ashen, faintly cold. | Intact human places — homes, tools, the frozen Tableaux of the Last Moment (§15.6). | Quiet wind; faint, distant breath; sparse drone. |
| **Festering** | Forms intact but the rot has *texture* — pools, fused corpses, growth at the edges. | Wet, blistered, blighted patches; first soul-glow seeps from cracks. | Fog thickens in low ground; light radius starts to matter. | **First violet bruising** over the grey. | Blight pools, fused bodies, rot-growth beginning to block paths. | The breath audible; first whispers; wet rot foley. |
| **Withering** | Architecture and flesh **merge** — walls become ribcages, doors become mouths; human shapes going. | Fused stone-and-flesh; surfaces glow from within along seams. | Dense fog; the dark thickens; legibility drops. | **Deep purples**; the soul-glow strengthens. | Corrupted landmarks, collapse, fusion-monuments; navmesh shifts. | The breath deepens; directed whispers possible; bowed-metal unease. |
| **Blooming** | Rot-coral, Blight-blooms, barely-human forms — **the Shimmer peak: most beautiful, most lethal.** | Iridescent bloom; alive-looking, gorgeous, glowing surfaces. | Bright in the *wrong* directions — the rot's glow lights the space and lies (§11.3.5). | **Full iridescent bloom + teal soul-glow** — the *Annihilation* Shimmer. | Blight-blooms, rot-coral cathedrals, the Communed's works, Blight-Halos (§15.6). | The breath loud; the Choir-Echo bleeds in; haunting, near-melodic dread. |
| **Terminal** | Not architecture — **a single rot-organism.** The heart. The ground breathes. | The city *is* a body; surfaces are tissue. | Oversaturated, **near-blinding spectral light**; the buried sun leaks false dawn upward (§15.5.4). | The two poles **collide**: cold-spectral shot through with corrupted false-gold. | No human places — only the fused interior of a living catastrophe. | The breath + the full Choir Song (§15.7); the climax soundscape. |

**Production rules:** (1) author each state as material/fog/light/prop/navmesh data on shared blockout (§11.8, §16); (2) transitions between states are the cross-fade-cheap-channels / hard-swap-geometry pattern (§15.3.3); (3) the ramp is continuous across regions (§11.2) — the basin is one gradient, and a region spans a *range* of states (§11.3), so the art must blend, not step, between adjacent states within a region.

---

### 15.5 Character & creature visual language

#### 15.5.1 The Revenant (the player)

The player is a **threshold-soul** carrying the **deathlight** (§2.2.5) — *the world's aborted death, walking.* Visual language:

- **The carried ember.** The Revenant always carries the deathlight (§15.3.1) — the one warm thing on them, and a live readout: it **dims as they Hollow** (§14.2).
- **Build = corruption identity, made visible** (pillar 3). The body is the build. **Warded** progression keeps the Revenant *human* — armor, cloth, ash, warm-gold trim, intact silhouette. **Tainted** progression visibly **warps** them — mutations (claws, carapace, blightveins glowing with carried Taint), cold-iridescent glow, a silhouette drifting toward the Wake (§8 mutations). A glance at another player in co-op reads their path.
- **The corruption-glow** (the §14 diegetic Taint readout) rises on the body from faint (Lucid) to bright/veined/mutating (Brink) in the Blight palette — a mesh/material effect (cheap, §15.3.4 / §14.13).
- **The Hollowing marks (5 stages, §2.2.5/§5.7),** authored to the track: **Marking** (ash-veins, dimming eyes), **Souring** (the glow turns the body's iconography Tainted), **Pull** (twitches, vision-corruption, the body fighting itself), **Brink** (full telegraph — the player half-claimed by the web), **Turning** (the set-piece). The Revenant's whole appearance is a slow, legible slide toward becoming a Wake.

#### 15.5.2 The Wake

The Wake is **grief made predatory** (§2.6.3) — not evil, *trapped people clawing to re-clothe themselves in flesh.* The art rule: **their form records what they were in life; their behavior is pure reclamation-hunger; dread must carry pity** (§2.8). Shared signature: **cold-spectral soul-glow at the core, eyes-in-the-dark** (emissive, non-shadowed — §15.3.4). The six tiers (§10) read as distinct silhouettes:

| Tier (§10) | Visual identity |
|---|---|
| **Husks** | The ordinary dead, minds long gone; recognizable human remnants — the funereal mass. Dread of *numbers*, pity of *recognition*. |
| **Gloamhounds & Mourncrows** | The bound beasts (animals had souls too); swift, sharpened, predatory silhouettes — ground-hounds and carrion-birds, the rot wearing an animal. |
| **The Gravemade & the Swollen** | The most Blight-saturated dead — bloated, calcified, armored in fused grave-goods and hardened rot; the **Swollen** rupture into rot-gas (a readable death-tell, §10). |
| **The Choristers / Keening Choir** | Dissolved Choir-singers still *singing the rite* — liturgical remnants, mouths open in the unending song; the Choir-Echo localizes to them (§15.7). |
| **The Famished** | Elite hunters — the web's antibodies, sharpened by hunger; lean, fast, *fixated*; dispatched at high Taint, they read as **personally hunting you** (§10). |
| **The Turned** | Build-derived named elites wearing a former Revenant's/NPC's face and skills (§10/§12) — the most personal horror; a turned ally is a hostile elite in your friend's silhouette. |

#### 15.5.3 The Wardens

Locked canon: **a shared signature *and* two distinct classes.**

- **Shared signature:** every Warden is grown around a **blazing core of concentrated trapped-soul-light** — the apex node of corruption, and the combat weak-point (§10; e.g. the Ashen Penitent's clean/light-only core). This is the unifying motif marking a Warden as a biome's apex corruption.
- **Beast-Wardens** (the **Mire-Stag**, the **Cinder-Alpha**) — the Blight wearing a **mutated animal**: nature corrupted, *no human regalia*, the *Princess Mononoke* rot-god register. Read as "this is the rot."
- **Named Crowned-Circle Wardens** (the **Ashen Penitent**, the **Famished King**) — the Blight wearing a **person who *chose* this**: retain human/regal/ceremonial iconography — **Communion vestments, the Choir's regalia, feast/funeral trappings** — fused into monuments to their choice. Read as "someone *did* the rot." The player should distinguish the two classes at a glance.
- **Named-tier sub-motif:** fragments of the **sun-regalia / the Crown** mark the named Wardens as "of the Crown" — a visual through-line from the rim's beast-Wardens to the Hollow Crown itself.

#### 15.5.4 The Hollow Crown & the Sunhold (R6, Terminal)

Locked canon for the endgame's look (§2.7, §11.3.7):

- **"Where the sun guttered into the earth"** = a sunken caldera-floor where the dead sun is **buried**, leaking a **sick parody of dawnlight *upward from below the ground*** — a false sunrise from a grave, corrupted by the soul-pressure pooled there. This inverts every prior light cue (light has always come from above/around; here it bleeds up from the dead).
- **The throne-city is fused into one rot-organism** — *the city is a body* (§11.3.7).
- **Sovereign Vael / the Hollow Crown** reads **not as a standing boss but as the load-bearing keystone of the whole web** — a withered king grown into the throne and the buried sun, **threads of soul-light running *out* of him into the world.** He speaks in the Choir's massed voice — many faces and voices straining at the surface of one still figure.
- **The Crown** itself = the sun-king's regalia, **hollow/empty**, a circlet of the guttered sun gone **cold-grey** — the literal **broken door** (Master-it = donning the broken door; the Pyre = *becoming* the door it failed to be — §3.4).
- **Palette:** the two poles **collide** — blinding cold-spectral soul-glow shot through with the buried sun's corrupted false-gold. The chromatic climax of the master axis (§15.2).

#### 15.5.5 The factions

- **The Ashen Wardens** (Warded — §2.6.1): warm pale-gold, ash, cloth, hand-tools, burial iconography; **human** above all. Their holdfast **Ashfast** and their Hearths are the warmest, most legible spaces in the game — islands of the human against the dark.
- **The Communed / the Hollowing** (Tainted — §2.6.2): cold-iridescent, transfigured, beautiful-grotesque; mutation worn as *transfiguration* ("becoming what comes after"). Folk-horror cult austerity (§15.1). Their **Black Hearth** is the anti-Hearth — a sink run in reverse, glowing cold and *feeding* on offered Taint (§7); render it as the dark mirror of a Hearth's gold pool: an iridescent maw where the Warded have a warm hearth.

---

### 15.6 Environment art & storytelling

The environment carries the story (§3.6). Three authored patterns are art-production set-pieces:

- **The Tableau of the Last Moment.** Every ruin freezes the instant of the **Witherfall** — a family mid-meal, a market mid-trade, a deathbed where no one died (§3.6). Because nothing could die, the world is a museum of an interrupted death. These are hand-authored hero-tableaux, densest in Lingering/Festering space where the human forms still read.
- **The Hearth-Scar.** A dead Hearth and the bodies around it — a survivor story told in objects (who held here, what they ran out of, who they failed to save). Relighting it re-illuminates a lost story and reclaims the ground — the micro version of the reclaim-wave (§15.3.3).
- **The Blight-Halo.** The worst, richest, most beautiful corruption pools where grief was strongest (a Communed bound a dead child to the land here, §3.6). The most luminous Blooming set-dress sits at these emotionally-legible nodes — high reward = deep grief, rendered as the most gorgeous and most dangerous art in the space.

**Region architecture** follows §11.3 (cold heath farmsteads → burning cremation-forest → drowned chapels → Shimmer-coral → ash-cathedral → the body-city), each at its decay-state range (§15.4). **Nanite** carries the geometric density of fused, rotted, detail-rich decay (§16); the decay-state dressing system (§15.4) keeps it all data-driven over shared blockout.

---

### 15.7 Audio direction

Audio is **load-bearing fiction**, not ambience — the Communion was **sung** (§2.2.1), so sound *is* the rite, and the dark *is* an audible presence. The soundscape executes concept bible §6: **sparse low drones, funeral-folk instrumentation (cello, bowed metal, ritual percussion), long silences broken by the dark's "breath."**

#### 15.7.1 The two diegetic audio entities (locked canon)

Two distinct diegetic sound-beings, not mere atmosphere:

1. **The Breath** — *everywhere in the dark.* The unlit dark is un-suppressed soul-pressure (§15.3.2), so it **audibly breathes**: a vast, slow inhale/exhale of the web — millions of held dead straining — under **whispers** (individual trapped voices). Its intensity **scales with darkness *and* the player's Taint** (high Taint = the web recognizing you) — a **readable diegetic Taint/dark telegraph** (§14.2). As the Revenant Hollows, the whispers resolve from **ambient → directed** (Stage 3, "the Pull," §5.7) — the dead begin speaking *to* the player. The Breath is the survival-horror spine of the soundscape.
2. **The Song (the Choir-Echo)** — the structured *song of the Communion itself*, localized to **Choristers** and **loudest near the Crown** (§3.6, §11.3.4). Where the Breath is the unstructured ambient web, the Song is the *rite* — the machinery of the Witherfall, heard before it is understood. It is a wayfinding instrument (§11.5) and the lore's audible thread, building toward R6 where it becomes the climax soundscape.

#### 15.7.2 The palette of instruments & textures

- **Drones:** sparse, low, sub-bass — the world's held breath under everything. Long silences are *composed*, not empty.
- **Funeral-folk:** **cello** (the human, mournful voice), **bowed metal** (the wrong, the corrupted), **ritual percussion** (the rite, the heartbeat of the dead). Grounded, austere, hand-played (folk-horror, §15.1) — never orchestral bombast.
- **The Choir:** human voices — the Choristers' unending rite — are the game's signature timbre, from a single broken voice in the marsh to the massed voice of the Hollow Crown (§15.5.4). The Choir is the **leitmotif of the whole game** (§15.8).
- **The deathlight & Hearth:** a warm, low, *tired* hum — the salvaged sun's quiet — that suppresses the Breath inside its radius (light silences the dark, the audio inverse of §6's Taint-suppression). A Greater Hearth's kindling is a swell of that hum into something near a dawn-chord (the reclaim cue, §15.8).
- **Combat:** weighty, Soulslike — impactful hitstop, the wet foley of festering, the distinct "burn" of light/cleansing vs the shrug of rot-on-rot (the damage-triangle made audible, §14.7). Rot-magic casts exhale soul-light with a tonal *release* (the in-field Taint-vent, §14.3.3).

#### 15.7.3 Spatial & diegetic discipline

The Breath, the Song, the Hearth-hum, the Wake's vocalizations, and the deathlight are **spatialized diegetic sources** the player navigates by (§11.5) — the UI does not duplicate them as HUD cues (§14.8). Audio is a primary readability channel and an accessibility asset (§14.12): a player can read corruption, danger, and direction substantially by ear.

---

### 15.8 Adaptive music

The score is **tied to the two clocks the player lives under: the Long Dusk Tide (macro) and the threat band (moment-to-moment)** — so the music is, like everything else, a readout of the corruption economy.

- **Tide-deepening (macro, §6/§11.6).** Each **Tide** the score sinks deeper: the drones lower, the Choir grows, the funeral-folk thins toward bleakness. The world *sounds* like it is dying faster as the Long Dusk deepens — the audible face of "standing still loses ground" (pillar 2). ~5–6 Tides of escalation across a playthrough (§6).
- **Threat-band layering (moment-to-moment, §5.2/§14.4).** The music layers up with the Taint band: **Lucid** (sparse drone, near-silence) → **Marked** (a tension enters) → **Fevered** (the Breath bleeds into the score, rhythm tightens) → **Brink** (the Choir swells, a heartbeat under everything — synced to the §14.4 visual pulse). Casting/purging out of a band drops the layers back — the player *hears* themselves regain control.
- **The Hearth respite.** Entering a Hearth's radius resolves the score to the warm deathlight-hum and a moment of human quiet — the held breath, the earned rest (pillar 4). The single recurring "safe" theme; its scarcity is what makes it land.
- **The reclaim cue.** Kindling a Greater Hearth (§11.7/§15.3.3) triggers the score's one moment of something like *hope* — the deathlight-hum swelling into a dawn-chord as the light-wave sweeps the region. The closest the game comes to a major key, and deliberately fragile (it can be lost again — §11.7).
- **Warden music.** Multi-phase, economy-hooked (§10): each Warden's theme carries its corruption-hook (the Drowned Choir floods the mix with the Song; the Famished King's theme *hungers*); the named Crowned-Circle Wardens' themes carry human/liturgical motifs (they *chose* this — §15.5.3), the beast-Wardens' do not.
- **The Choir as the through-line.** The Communion's Song is the game's core motif — introduced as a haunting fragment in R3, recurring in every Chorister, and resolving into the massed voice of the Hollow Crown at R6 (§15.5.4). The endings are scored as the three fates of that Song: **End it** (the Song finally *resolves and ceases* — the long-delayed final cadence), **Master it** (the Song re-stabilizes around a new anchor — it continues, now the player's), **Be consumed** (the player's own voice joins the Song — they become part of the rite). The whole score is a single piece of music waiting generations to end.

---

### 15.9 Production & tech notes (per §16)

- **Engine/pipeline:** UE5 Nanite + Lumen + Megalights + Fab/Quixel (§16) deliver "rotting-gorgeous" at indie-mid headcount — *with* mandatory light/scalability discipline (Series S is software Lumen).
- **Decay as data, not deformation:** all five decay states are material/fog/light/prop/navmesh dressings on shared geometry driven by the region decay scalar (§15.4, §11.8) — a **state machine over authored geometry, not voxel terrain** (§16). Art may **not** promise terrain deformation.
- **Light discipline:** hero-lights cast shadows (Hearth, player light); ambient small lights are emissive/non-shadowed; dozens of *glows* are free, shadow-casters are budgeted (§15.3.4). Megalights for many shadow-casters is **[VERIFY]** on Series S/Deck (§16).
- **Decay transitions:** cross-fade cheap channels (material/fog/light via one scalar lerp), hard-swap geometry behind the light front (§15.3.3) — the reclaim/encroachment wave is cheap *and* correct.
- **The corruption post-process** (the §14.4 screen FX) is **one combined, escalation-gated pass** (~1–1.5ms Series S), with a lighter Brink variant on Deck (§14.13/§16) — never an always-on multi-pass stack.
- **Budget to Series S (10GB) / Steam Deck**, scale up (§16); the diegetic-first design (corruption shown on body/world/audio, §14.2) deliberately moves readability load off the framebuffer and onto cheap mesh/material/audio channels.

---

### 15.10 Open Questions

- **Megalights on low-end** ([VERIFY], §16): whether the "many small *shadow-casting* lights" fantasy survives Series S/Deck profiling. The art read is safe either way (hero-shadows + emissive ambient — §15.3.4); flagged so the lighting team doesn't over-author shadow-casters before the vertical-slice profile.
- **Decay-state count vs art-production cost** (§18): five fully-authored decay-state dressings per region kit is the spec; if production scope tightens, the natural compression is to author the *endpoints* (Lingering, Blooming, Terminal) fully and treat Festering/Withering as blends — routed to §18.
- **Licensed vs original Choir vocals.** The Choir leitmotif (§15.8) is the game's signature audio identity; whether it is composed-original or uses a recorded ensemble is a §18/audio-production decision with budget implications — flagged, not decided.

---

<a id="sec-16"></a>

## 16. Technical Design & Tech Stack

> **Scope.** This section fixes the engine, the netcode authority model, the co-op hosting topology,
> the save/persistence architecture, the performance/platform targets, and the technical model behind
> death/turning — everything the rest of the GDD assumes a machine can actually do. It is the
> implementation contract for the keystone: the corruption economy (**Taint** / **Hollowing** /
> **Blight**, §5) and the decaying world (**the Long Dusk**, §6/§11) are only as good as the systems
> that replicate and persist them. Each decision below is one **decided** option with rationale, not a
> menu.
>
> **Cross-references (read, do not duplicate):** §5 owns the corruption meter and its rules; §6 the
> survival inputs and the Long Dusk clock; §7 the Hearths and base-building; §9 the combat model; §10
> the **Wake** and **Wardens**; §11 the regions and their decay states; §12 the death/Expedition model;
> §13 co-op and **Blight-transfer** revive; §14 HUD readability; §17 the business case; §18 the
> production plan; §19 difficulty/accessibility.
>
> Values flagged **[VERIFY]** are starting targets to confirm by profiling the **vertical slice**
> (§18) or against platform cert docs — not contractual specs.

---

### 16.1 Decided stack at a glance

| Decision area | Decision | One-line why |
|---|---|---|
| **Engine** | **Unreal Engine 5** (develop on latest stable 5.6/5.7; **version-lock at vertical-slice sign-off**) | Replication + GAS + animation + Nanite/Lumen give an indie-mid team the netcode, weighty combat, and decay visuals off the shelf. |
| **Combat framework** | **Gameplay Ability System (GAS)** | Replicated, prediction-ready abilities/attributes/costs/cooldowns map 1:1 onto **Taint**, stamina, poise, rot-magic, **Hollowing**, **Blight-transfer**. |
| **Authority model** | **Server-authoritative, client-predicted** | The corruption economy is the win/loss surface — it must never desync or be client-cheatable; Soulslike feel needs prediction on top. |
| **Hosting topology** | **Listen-server default + dedicated-server binary from day one** | 2–4 friends host free (Valheim/Enshrouded pattern); the dedicated binary *is* the persistence/host-independence answer and forces clean server-authority. |
| **Transport / online** | **EOS (Epic Online Services) relay + sessions, with Steam sockets integration** | Free, NAT punchthrough, Steam-first now, console-ready later. |
| **Decay representation** | **State-based region decay** (material/fog/lighting/prop/spawn-table/navmesh driven by a per-region decay-stage scalar) — **NOT** voxel terrain | Stays in UE5's wheelhouse; persists and replicates as a tiny state vector, never a voxel grid. |
| **Save model** | **Character save (per-player, portable) ⟂ World save (per-world)** | Proven Valheim/Enshrouded split; makes co-op portable and persistence coherent. |
| **Host migration** | **None in v1.** Character/World split + frequent autosave cover host drop; dedicated server is the persistence path. | Seamless authority handoff is AAA-budget; dedicated delivers the same user value at a fraction of the risk. |
| **Framerate target** | **60fps Performance on all platforms incl. Series S** + optional 30fps Fidelity on PS5/Series X; Steam Deck 30fps Verified | Latency-sensitive combat is tuned at 60; 30 is a fidelity toggle, not the floor. |

---

### 16.2 Engine choice — Unreal Engine 5

**WITHERREACH is built in Unreal Engine 5.** Develop on the latest stable release (5.6/5.7 as of mid-2026)
and **lock the engine version at vertical-slice sign-off** (§18) — never chase point releases
mid-production.

#### 16.2.1 Why UE5 — the four load-bearing reasons

1. **Networking you don't have to invent.** UE5 ships a mature actor-replication model (relevancy, net
   priority, **dormancy**, RPCs, client prediction). At 2–4 players the player count is trivial; the real
   replication load is *world actor count* — the **Wake** tide, decay props, the settlement — which
   dormancy + relevancy gating handle directly. Every shipped survival-co-op comp on Unity (Valheim,
   V Rising, Enshrouded, Palworld) shipped *custom or third-party* netcode; the engine did **not** give
   it to them for free. Writing authoritative netcode from scratch is the single largest schedule risk
   this project could take on, and UE5 removes it.
2. **Soulslike combat is a solved pipeline.** GAS is a replicated, prediction-aware framework for
   abilities, attributes, costs, cooldowns, and status effects that maps almost 1:1 onto this game's spec
   (§16.3). Add Motion Matching / Control Rig / Chaos for weighty, frame-data melee with hitstop and
   root-motion (§9). This is months of bespoke systems obtained off the shelf.
3. **"Rotting-gorgeous" at indie-mid headcount.** Nanite + Lumen + Megalights + the Fab/Quixel pipeline
   deliver the art pillar (§15, bible §6 "beautiful-in-decay") without a large rendering team — with the
   explicit caveat that these are the **Series S / Steam Deck** pain point (§16.6); scalability discipline
   is mandatory, not optional.
4. **Console certification is a trodden path.** UE5's PS5/Xbox Series backends are mature and certified,
   and Epic abstracts most platform plumbing — de-risking the hardest part of "Console, Steam-first" for a
   small team (console port timed to 1.0, §17/§18).

#### 16.2.2 Why not Unity, why not custom

- **Not Unity.** Unity suits smaller-scope, lower-fidelity, or 2D games — not weighty 3D combat +
  persistent decay visuals + console parity. Its first-party netcode is still maturing for authoritative,
  physics-heavy combat at world-persistence scale; there is no GAS equivalent (you build the
  ability/poise/frame-data layer yourself); and the 2023 runtime-fee episode is a real predictability risk
  over a multi-year project. The comps that won on Unity did so by *replacing* Unity's defaults — that is
  the tell.
- **Not a custom engine.** The hard constraint is **indie-to-mid budget** (§18). Custom means building
  renderer, netcode, physics, animation, tools, *and* console ports — exactly where Valheim (custom) and
  Enshrouded (custom "Holistic" engine) sank deep specialist effort. A team that must ship Soulslike combat
  + Nanite-grade decay + console parity cannot also afford an engine.

#### 16.2.3 The one UE5 caveat — and the design boundary that resolves it

UE5 terrain/streaming is **not voxel-native.** If "the world is actively decaying" were specced as
Enshrouded-style fully-deformable/destructible voxel terrain, the project would fight World Partition the
whole way.

**Locked tech-and-design boundary (binding on §6/§11): the Long Dusk decay is a per-region STATE
machine, not voxel terrain deformation.** A region's decay stage drives material parameters, fog and
lighting, prop and spawn-table swaps, and navmesh — *visible, dramatic rot expressed as state over
authored geometry.* This keeps decay inside UE5's strengths and makes it cheap to replicate and persist
(a small region-state vector, never a voxel grid). World/Survival design builds within this; do not
promise terrain deformation the tech won't cheaply give.

> **Iris note.** UE5's next-gen Iris replication is still *Experimental* in 5.7. **Ship on the proven
> generic replication system; treat Iris as a later, profiled opt-in** only if measured world-actor
> counts demand it. It is **not** a launch dependency.

---

### 16.3 Combat & systems framework — GAS

The **Gameplay Ability System** is the backbone for every gameplay-relevant value, because it gives
replicated attributes + predicted abilities + server authority for free. The mapping:

| Game concept (owning section) | GAS construct | Notes |
|---|---|---|
| **Taint**, current carried (§5) | Replicated **Attribute** (server-authoritative) | Spend = ability cost; gain = `GameplayEffect`; `T_floor`/`T_max` as clamp metadata. Never client-reported. |
| **Hollowing**, permanent (§5/§12) | Replicated **Attribute**, persisted to character save | Drives the turning telegraph as escalating GEs (§16.7). |
| Stamina / poise / HP (§9) | **Attributes** | Standard Soulslike combat economy. |
| Melee strings, rot-magic, weapon arts (§9) | **Gameplay Abilities** | Built-in prediction-key system → predicted execution + server authority. |
| **Blight-transfer** revive (§13) | Channelled **Gameplay Ability** on a downed ally | Server-validated atomic transaction (§16.4.3). |
| Mutations, festering, light suppression, status FX (§5/§6) | **GameplayEffects** (timed / infinite / periodic) | Stacking + replicated cosmetic cues. |

Because Taint and Hollowing are GAS attributes owned by the server, "a client must never be trusted to
report its own corruption" is enforced by construction, not by ad-hoc checks.

---

### 16.4 Co-op networking model

**Player count: 2–4 (locked, bible §0/§12).** A small player count is a major simplifier — no relevancy
sharding, no large-scale player replication. **The networking challenge is world state, not players.**

#### 16.4.1 Authority & hosting

- **Server-authoritative, client-predicted.** Exactly one authoritative simulation owns *all* gameplay
  state: Taint / Hollowing / Blight values, region decay state, **Hearth** state, the Wake spawns + AI,
  loot, corpse-caches, turned-entities. Clients predict locally for feel; the server is truth.
- **Listen-server is the default** — one player's client is authority + host: zero hosting cost, matches
  every comp, NAT-traversed via EOS relay / Steam sockets.
- **A dedicated-server binary is built from day one.** UE5 makes this nearly free (same codebase,
  `-server` target). It serves three purposes: (a) always-on persistent/joinable worlds; (b) QA
  automation; (c) — most important — building dedicated-capable *forces* clean server-authority
  separation, the very discipline that makes the listen-server robust and uncheatable. **Do not bolt
  dedicated on later.**
- **Transport: EOS** (Online Subsystem EOS) for relay, NAT punchthrough, and sessions, with Steam sockets
  integration for the Steam-first launch — free, cross-platform, and keeps the console path open.

#### 16.4.2 Combat netcode (latency matters — §9)

- **Movement:** client-side prediction + server reconciliation via UE5's CharacterMovementComponent. The
  hard case is **weighty root-motion attacks** (root-motion is prediction-hostile). Budget custom work:
  predict the acting player's own attack locomotion/animation for responsiveness, then reconcile.
- **Hit resolution: server-authoritative with lag compensation (server rewind).** The attacker sees an
  immediate predicted swing; the server validates hits against rewound target positions
  (~200–250ms rewind window **[VERIFY against playtest ping]**); damage, poise, and stamina are applied
  server-side and replicated back — *favor the attacker's feel, validate on the server.* Trade-off: rare
  "I hit but no damage" at high ping → mitigate with forgiving melee hit windows/capsules (Soulslike
  hitboxes are already generous, §9) and a **playable-ping cap** on matchmaking/join.
- **Everything combat-relevant is a Gameplay Ability** (§16.3) — predicted execution + server authority
  for free.
- **Tick budget:** ~30–60Hz server tick for active combatants; the world (decay props, distant Wake,
  settlement) rides heavy net-update throttling + **dormancy** so it costs near-zero bandwidth when
  unchanged.

#### 16.4.3 The four signature systems — replication & persistence

1. **Blight-transfer revive (§13, bible §11).** A GAS ability the reviver channels on a **DOWNED** ally
   inside the revive window. Server validates: reviver has enough banked Taint, both in range, target still
   within window; then *atomically* decrements reviver Taint, stabilizes the target, replicates the channel
   VFX + meter changes. Predicted channel-start on the reviver for instant feedback; server confirms
   completion. **Not independently persisted** — a live transaction; only the resulting Taint/Hollowing
   values persist via the normal character save. **Edge case (spec it):** reviver disconnects mid-channel →
   server aborts and **refunds** the Taint (no silent loss).
2. **Shared Hearth (§7/§13).** A persistent server-owned world actor: state = lit/unlit, fuel,
   tier/upgrades, bound players, **per-character bank ledger**, decay-rollback radius. Relevancy-gated
   replication (only nearby clients get updates). Bank/purge are server transactions. **Persists to the
   WORLD save**, with banked-Taint balances as per-character ledger entries on it. A **Greater Hearth**
   additionally writes a region-decay-rollback flag into world decay state (item 3).
3. **World decay / the Long Dusk (§6/§11).** A server-owned **WorldDecaySubsystem.** The world is
   partitioned into regions; each holds a decay-stage scalar advanced by the global Long Dusk clock
   (deepening in **Tides**) and rolled back locally by lit Greater Hearths. It ticks slowly (decay is
   minutes/hours-scale, not per-frame); on a stage change it updates that region's material params / fog /
   lighting / navmesh / spawn tables and replicates a **compact region-state delta** — clients reproduce
   the thousands of resulting visual/spawn changes *locally from the scalar.* Bandwidth-trivial precisely
   because decay is state-based, not voxel. **Persists:** the region-state vector + the global Long Dusk
   clock value, to the world save.
4. **Turned-player entities / turned NPCs (§10, bible §10).** When a character fully **Hollows** and
   *turns*, the server spawns a persistent **Wake**-creature actor seeded from that character's identity
   (name, build, gear silhouette) at a location and writes it into **world state.** It replicates as a
   normal AI Wake actor and is encounterable later. The turned entity is **world data, decoupled from the
   retired character save**; on a dedicated/shared world it persists for everyone, on solo/listen-server it
   persists in that world's save.

---

### 16.5 Save & world-persistence architecture

#### 16.5.1 The core split — Character save ⟂ World save (decided)

| Save | Owner | Holds |
|---|---|---|
| **Character save** (per-player, **portable** — travels to any world) | The player | **Revenant** identity, **Warded/Tainted** path + skills, the **Hollowing** track, carried/banked **Taint**, inventory/gear, the six attributes (§8). |
| **World save** (per-world, owned by host/server) | The host/world | The Long Dusk clock + per-region decay state, all **Hearths** (incl. **Greater Hearths** + the decay-rollback map), **settlement/base structures**, corpse-caches lying in the world, turned-entities, Wake/world spawn state, **Reliquary**/**Warden** completion flags, resource-node depletion. |

**Settlement is World state, not Character state.** This resolves "per-player settlement" + "world state
persists": in single-player the player owns one world (their settlement lives in it); in co-op the *shared
world* holds the shared Hearth/settlement, and guests bring their **Revenant** but build in the host's
world (the Valheim model — characters portable, bases belong to worlds). §7/§13 design around this.

#### 16.5.2 Storage, integrity, and the decaying-world problem

- **Format:** structured binary via UE SaveGame / a custom serializer — snapshot-based, not a live DB, at
  the 2–4 scale. A dedicated/shared persistent world MAY later back the world save with an embedded
  **SQLite** store if region/entity counts grow; file-snapshot is sufficient at launch.
- **A continuously-mutating decaying world demands disciplined save cadence:** periodic **autosave** (every
  few minutes **[VERIFY cadence vs world size/IO]**) + **on-meaningful-event** saves (Hearth lit, Warden
  killed, region Tide advance, host exit) + **crash-safe atomic writes** (write-temp → fsync → rename) +
  **rolling backups** (keep N). Rolling backups are table stakes — survival players lose worlds to
  corruption, and Valheim and Enshrouded both ship them for exactly this reason.
- **Schema versioning + migration from day one.** The world persists for the life of the project; the
  decay-state and entity schemas *will* change. Bake a version field + migration path in now.
- **Long Dusk clock anchoring.** Advance the Long Dusk on **world-active playtime** (accumulated ticks
  persisted in the world save), **not** real-world wall-clock — a world should not rot while no one plays
  (resumes deterministically across sessions). The architecture supports either; the recommended default is
  **active-time only**. *(Confirmation owned by §6 — see Open Questions.)*

#### 16.5.3 Host migration — none in v1 (decided)

Seamless mid-session authority handoff is expensive and fragile, and the comps don't do it for
listen-server. **Do not build it for v1.** Instead:

- **Character/World separation** means a host drop costs *no one* their character.
- The world belongs to the host; on host disconnect the session ends, the **last autosave + an
  on-disconnect save** preserve world state, and players rejoin when the host returns. Frequent autosave
  bounds the loss.
- **The dedicated server IS the host-independence answer.** Authority on a machine no one is "playing on"
  lets any player leave/join freely with a 24/7 persistent world. Groups who want host-independence are
  routed to dedicated, not to fragile P2P authority handoff.

This is the deliberate indie-mid call: seamless migration is AAA-budget; the dedicated path delivers the
same user value (persistent, joinable world) at a fraction of the cost and risk.

---

### 16.6 Performance & platform targets

Steam-first means PC + Steam Deck + Steam Machine are first-class, alongside PS5 / Xbox Series. The binding
constraints are **Xbox Series S (10GB shared RAM, weak GPU)** and **Steam Deck** — budget *to them*, scale
*up* for everyone else. **Never treat Series S as "Series X minus."**

#### 16.6.1 Framerate / mode targets

| Platform | Target |
|---|---|
| **PS5 / Xbox Series X** | **60fps Performance** (≈1440p-class, dynamic resolution + temporal upscaling) — the mode the combat is tuned around. **Optional 30fps Fidelity** (≈4K-class) for screenshot/immersion players. |
| **Xbox Series S** | **60fps Performance** at ≈1080p-class with **software Lumen or baked/limited GI**, reduced Nanite density, aggressive World Partition streaming. **Budget this as its own line item.** |
| **PC** | Uncapped, fully scalable Low→Ultra. |
| **Steam Deck** | **30fps Verified** at ≈800p, Low–Medium, FSR — a launch goal. **Steam Machine Verified** bar is 1080p/30; targeting Deck typically satisfies it. |

Rationale: latency-sensitive Soulslike combat strongly favors 60 — make 60 the baseline the netcode +
combat are tuned at, and offer 30 as a fidelity *toggle*, not the floor.

#### 16.6.2 PC spec targets **[VERIFY by vertical-slice profiling — depends on final fidelity]**

| Tier | Target | Approx spec |
|---|---|---|
| **Minimum** | 1080p / 30, Low, FSR Performance | ≈GTX 1070 / RX 5500 XT 8GB · 4c/8t (i5-8400 / Ryzen 5 2600) · 16GB RAM · **SSD required** |
| **Recommended** | 1440p / 60, High, upscaling Quality | ≈RTX 3060 Ti / RX 6700 XT · 6–8c (Ryzen 5 5600 / i5-12400) · 16–32GB RAM · **NVMe SSD** |

#### 16.6.3 Hard technical budgets handed to the team

- **SSD is a hard minimum** (a real decision, not boilerplate): World Partition streaming + continuous
  decay-state churn + corpse-cache/turned-entity persistence make HDD non-viable.
- **Memory is budgeted to Series S (10GB shared):** set texture/streaming-pool budgets to Series S and
  scale up; it is the binding memory constraint.
- **Frame budget @60fps = 16.6ms:** reserve a *strict* slice for replication + AI. The Wake tide (spawn
  pressure scaling with Taint and Tide, §10) and the WorldDecaySubsystem are the CPU risks — keep decay on
  a slow tick and the Wake under a server-side budget / LOD-AI cap.

---

### 16.7 Death, respawn, turning & corpse-cache — technical model

All server-authoritative; predicted only where it improves feel (the acting player's own revive channel).
Persistence follows the §16.5 split: **Hollowing + banked Taint → character save; corpse-caches +
turned-entities + Hearth state → world save.** Game-design rules are §12; this is the implementation.

**Downed → death (co-op, bible §11):**
1. Server detects HP→0. In co-op the player enters a server-owned **DOWNED** state (ragdoll/crawl +
   revive-window timer), replicated; allies see a revive prompt.
2. **Blight-transfer** revive (§16.4.3) can interrupt and stabilize within the window.
3. If the window expires (or in solo play) → **DEATH proper.**

**On DEATH proper:**
1. Server spawns a **corpse-cache** actor at the death location holding the dropped **banked Taint** (and,
   per §12 design, possibly some gear) — a persistent world actor with owner-id + recoverable flag, written
   to the **world save**, **dormant when no one is near** (cheap).
2. Server advances **Hollowing** by one step (writes the **character save**).
3. Server respawns the player at their last-bound lit **Hearth** (the shared Hearth in co-op).
4. All of it replicates to clients.

**Corpse-cache retrieval (Souls-style corpse-run):** server validates proximity + ownership (or
party-open, per §13 design), transfers Taint back, despawns the cache, updates the world save. Whether a
second death forfeits the first cache is a **§12 design knob**; the tech supports N caches — default to a
single recoverable cache (configurable).

**Turning (soft-permadeath, bible §10/§11):**
- **Hollowing** is a server-authoritative GAS attribute. As it nears max, the server drives **escalating,
  telegraphed** replicated status/VFX/debuffs (mutation visuals, raised Wake aggro) — never a surprise
  (the 10-pip telegraph is §5.7).
- At max Hollowing the server triggers **TURN**: the character save is retired (the "tragic" reset, bible
  §9), and the server spawns a persistent **turned-entity** Wake actor into world state seeded from the
  character (name, build, gear silhouette, location). In co-op, allies present witness the turn as a
  set-piece. The turned entity is decoupled from the now-gone character and is encounterable later
  (§16.4.3 item 4).

**Respawn resolver (interacts with decay):** respawn at the last-bound lit **Hearth**; **if that Hearth's
region has gone dark or been lost to the Long Dusk**, the server falls back to the nearest lit / Greater
Hearth. "Your Hearth went out" is a real state the resolver must handle — fallback order is coordinated
with §6/§11/§12.

---

### 16.8 What this section owns vs. references

This section owns the **engine**, the **authority/hosting/transport model**, the **GAS framework mapping**,
the **save split + persistence cadence**, the **performance/platform targets**, and the **technical**
death/turning model. It does **not** own:

- The **rules and numbers** of the corruption meter (floor/ceiling, bands, purge curve, Hollowing gains) —
  §5; the survival inputs that drive Taint and the Long Dusk clock's *design* — §6.
- The **Hearth**, base-building, gear/tempering, and resource economy — §7; **RPG progression** — §8.
- The **combat** feel/damage/abilities the netcode carries — §9; the **Wake**/**Wardens** AI — §10.
- The **regions and decay states** the WorldDecaySubsystem drives — §11.
- The **death/Expedition session design** and corpse-run rules — §12; **co-op design** and the
  Blight-transfer *design* — §13.
- **HUD/readability** of meters and bands — §14; **art/audio** the renderer serves — §15.
- The **business and production** framing of these targets (console-at-1.0, dedicated-netcode staffing) —
  §17/§18; **difficulty/accessibility** toggles' technical hooks (incl. the **game-speed-in-co-op** caveat,
  §19) — §19.

---

### 16.9 Open Questions

- **[DESIGN → §6]** Long Dusk clock: advance on active-playtime only (recommended default) vs. ever
  offline. The architecture supports either; the design pick is Survival/World's.
- **[DESIGN → §12]** Corpse-cache count on multi-death (single Souls-style cache default vs. N) and
  **[→ §13]** co-op cache ownership (owner-only vs. party-open retrieval).
- **[VERIFY — vertical slice]** PC min/rec specs, autosave cadence, lag-compensation rewind window, and
  server tick rate — all confirmed by profiling, not assumed.
- **[CROSS-TEAM → §19]** **Game-speed slowdown in co-op:** it cannot apply per-player in a shared
  authoritative sim. Decision: solo-only, or host/party-vote applying to the whole session. Routed here
  from §19's combat-assist ruling; resolve with §13.

---

<a id="sec-17"></a>

## 17. Market Positioning & Business

> **Scope.** This section sets the commercial frame: the comparable-market read, the audience and its
> sizing, the positioning statement, the pricing and Early-Access plan, and the monetization stance. Every
> figure here is sourced to a real URL (preserved in §17.7); figures synthesized rather than reported are
> tagged **[EST]**. The production plan that spends against this case is §18; the accessibility commitments
> the market now demands are §19.
>
> **Locked rulings (binding, do not re-open):** premium one-time purchase; **no F2P**; **no pay-to-win**
> (selling power or safety would collapse the keystone **Taint** tension, §5/§8 — P2W is *incoherent*
> here); post-1.0 **cosmetic-only** monetization plus **one** paid narrative expansion. Engine is **Unreal
> Engine 5** (§16).
>
> **Cross-references:** bible §4/§12 for the USP and comparables; §5/§8 for why P2W is incoherent; §18 for
> team/budget/roadmap; §19 for accessibility-as-table-stakes.

---

### 17.1 Comparable market analysis (figures + sources)

| Game | Type | EA launch → 1.0 | Price (EA → 1.0) | Lifetime sales | Peak CCU (Steam) | What drove the result |
|---|---|---|---|---|---|---|
| **Enshrouded** | Dark-fantasy survival-RPG co-op (16p) | Jan 2024 → still EA (1.0 ~2026) | **$29.99** | **3M+** (Aug 2024, ~8 mo) | **160,405** | Closest twin: voxel build + ARPG combat + dark fantasy. 1M in 4 days. 2nd-best 2024 Steam launch behind Palworld. |
| **V Rising** | Dark survival-ARPG (vampire) | May 2022 → May 2024 (~2 yr) | **$19.99 → $34.99** | **6M** (late 2025); 5M Jan 2025; 3.9M Feb 2024 | **150,563** | Gothic ARPG/survival fusion, PvE+PvP, PS5 port at 1.0. Price hike landed at full launch. |
| **Valheim** | Viking survival-craft co-op (10p) | Feb 2021 → 1.0 **Sept 9 2026** (~5.5 yr) | **$19.99** (never raised) | **17M** lifetime (12M Nov 2023; 10M Apr 2022) | **501,804** | The outlier breakout: 5-person team, viral co-op, honest brutal combat, atmosphere. PS5/Switch 2 at 1.0. |
| **Don't Starve Together** | Co-op survival (roguelike-ish) | 2016 (DS 2013) | **$14.99** | **~9.5M [EST]**, ~$94M gross [EST] | 72,629 | Singular art identity, years of free updates, low price, 95% review score over 530k+ reviews. |
| **Project Zomboid** | Isometric zombie survival sim | 2013 → **still EA (13 yr)** | **$19.99** | **~15M [EST]** (GameDiscoverCo) | ~80k **[EST]** (Build41 co-op spike) | Deep simulation, co-op streamability, perpetual-EA longevity. Proof EA "graduation" is not required to win. |
| **Conan Exiles** | Open-world survival (PvP-heavy) | 2017 → 2018 (~1.5 yr) | **$29.99 → ~$39.99** | **1.4–1.5M+** at 1.0 (multi-M since) | ~124k **[EST]** | Funcom's biggest title; pivoted **DLC → seasonal Battle Pass + cosmetic Bazaar** (Age of Sorcery, 2022). |
| **Lies of P** | Dark-fantasy Soulslike (premium) | Sept 2023 (full launch) | **$59.99** | **4M** (Mar 2026); 3M Jun 2025 | — | Premium Soulslike ceiling. Notably **added difficulty options** (Overture) — accessibility pressure even at the hardcore end. |
| **Lords of the Fallen** | Dark-fantasy Soulslike (premium) | Oct 2023 (full launch) | **$59.99** | **2.04M** | — | **$66M budget** (CI Games' most expensive). Rocky launch → recovered via patches. Cautionary: high budget, modest multiple. |
| **Elden Ring** | Dark-fantasy ARPG (AAA anchor) | Feb 2022 | **$59.99** | **30M+** (Apr 2025) | — | Genre ceiling; mainstreamed dark fantasy. Not a comp to match — the proof the *audience appetite* is enormous. |

#### 17.1.1 What actually drove success vs. failure (the five reads)

1. **The $20–30 survival-co-op band is the proven sweet spot.** Every survival breakout (Valheim,
   V Rising, Enshrouded, Zomboid) launched at **$15–30**, not $40–60. Low entry + co-op = friends buy in
   packs of 2–4 (our exact co-op unit). Premium Soulslikes sit at $60 but sell on single-player polish, not
   viral group buy-in. WITHERREACH is survival-co-op first → **price in the survival band, not the Soulslike
   band.**
2. **Early Access is the dominant — and winning — launch path for this genre.** Valheim, V Rising,
   Enshrouded, Conan, Zomboid all used EA. In 2024, **28% of Steam's top-grossing new releases were EA
   titles** despite EA being ~14% of releases — EA over-indexes among winners. EA funds the build *and*
   de-risks the hardest design problem: the keystone corruption economy needs live tuning (§5).
3. **Co-op + streamability is the growth multiplier.** Enshrouded (160k peak), Valheim (502k peak),
   Zomboid's Build41 co-op spike — the concurrent-player explosions all rode co-op + Twitch/YouTube. Our
   2–4 co-op with built-in role structure (**Warded** anchor / **Tainted** strikers / **Blight-transfer**
   revive, §13) is *natively streamable interdependence.*
4. **Failure mode = scope creep and budget mismatch.** Lords of the Fallen burned **$66M** for ~2M sales.
   Survival-crafting is the canonical scope-creep genre. Defense: ship a tight vertical slice of the
   one-meter economy, expand in EA, never gold-plate (§18).
5. **Free updates build the long tail; monetization comes later and stays cosmetic.** DST and Valheim
   sustained years on free updates. Conan only added monetization (Battle Pass / cosmetic Bazaar)
   *post-launch* and kept it strictly **non-power** (recipes, not items). That is the safe template
   (§17.5).

---

### 17.2 Target audience & sizing

**Primary persona — "The Hardcore Survivalist-RPG fan" (bible §12):** PC/console players, **age 18–35
core**, who own *both* deep survival-craft (Valheim, V Rising) *and* RPG/Soulslike titles (Elden Ring, Lies
of P). Comfortable with difficulty, scarcity, permadeath-adjacent stakes. Plays in a **2–4 friend co-op
unit** (the buy-multiplier). Steam-first, controller-friendly.

**Secondary:** solo dark-fantasy RPG/Soulslike fans who want a persistent world (the Elden-Ring-curious who
don't normally touch survival), and the survival-streamer/content ecosystem.

**Sizing (top-down, real overlap):**

| Tier | Band | Basis |
|---|---|---|
| **TAM** (genre appetite) | **8–15M [EST]** addressable intersection | Survival-craft *and* dark-fantasy-ARPG audiences each measure in the tens of millions (Valheim 17M, Zomboid ~15M, DST ~9.5M, V Rising 6M; dark-fantasy ceiling Elden Ring 30M, Dark Souls trilogy ~35M). The bullseye is the *intersection* — owners of a survival-craft **and** a Soulslike. |
| **SAM** (reachable in ~3 yr) | **3–6M** | Where directly-comparable EA-survival winners cluster (Enshrouded 3M, V Rising 6M) — the realistic band for a well-executed, well-marketed entrant with a genuine USP. |
| **SOM — Floor / break-even** | **300–500k units** in EA Year 1 | At $29.99 net (~$18–20 after Steam's 30% + VAT/refunds) ⇒ **~$6–10M net** — covers the $3–6M build (§18) with margin. |
| **SOM — Base case** | **1–3M lifetime** over 2–3 yr | The Enshrouded trajectory. Net **~$25–60M**. |
| **SOM — Breakout** | **5M+** | V Rising / lower-Valheim tier. Requires a viral co-op moment + sustained free updates. |

**Why this audience is reachable now:** the corruption-as-currency USP (carried as **Taint**) is the one
thing none of the comps do cleanly (bible §4). The audience has demonstrably bought *every adjacent half*
of the pitch — we are selling them the fusion they keep buying piecemeal.

---

### 17.3 Positioning — "we are X but Y"

WITHERREACH is positioned as **a survival-craft co-op game with genuine RPG build-depth and weighty
Soulslike combat, built around one differentiating idea: the corruption killing the world is also the only
source of your power.** The elevator differentiation (bible §4/§12), carried verbatim into marketing:

- **vs Valheim** — *we are Valheim's build-craft-and-boss-progression loop, but the world rots on a clock
  and your power comes from the same corruption that's killing it; reclaiming land (kindling **Greater
  Hearths**) is a desperate, impermanent push, not a permanent victory.*
- **vs V Rising** — *we are V Rising's dark survival-ARPG fusion, but single-player-first and PvE-focused,
  with the blood/feeding tension generalized into a full corruption economy that governs your entire build
  and survival risk — no PvP-server dependency.*
- **vs Dark Souls / Soulslikes** — *we are a Soulslike's weighty combat, bonfire rhythm, and hollowing
  dread, but embedded in a persistent survival world: the bonfire is a **Hearth** you build and defend, the
  "souls" are literally your survival fuel (**Taint**), and **Hollowing** is a long mechanical descent you
  co-op against.*

**The one-line market hook:** *the survival-RPG where getting stronger is the same act as dooming
yourself* — a positioning no comp can claim, and the spine of every marketing beat (do not out-spend the
crowded field; **out-distinct** it, §17.6).

---

### 17.4 Pricing & Early-Access plan (decided)

#### 17.4.1 Price ladder — V Rising's proven exact ladder, anchored one tier above Valheim

| Milestone | Price | Rationale |
|---|---|---|
| **Early-Access launch** | **$29.99** | Matches Enshrouded (our twin) and the upper survival band. Above Valheim's $20 because 3D weighty Soulslike combat + RPG build depth + a narrative arc cost materially more to build and justify the value signal. |
| **1.0 launch** | **$34.99** | The V Rising move — raise at full release to capture value and reward early adopters. **Announce the hike weeks ahead** (V Rising did; it converts fence-sitters). |

- **No launch discount below $29.99.** First seasonal sale no earlier than ~3 months post-EA, **≤15%**.
- **Regional pricing + co-op-friendly:** no official multi-pack needed (Steam gifting covers the 2–4 unit),
  but keep price low enough that a 4-friend buy-in is an easy ~$120 group decision.

#### 17.4.2 Early-Access plan

- **Duration: ~18–24 months.** Long enough to tune the keystone corruption economy with real telemetry;
  short enough to avoid Zomboid-style perpetual-EA fatigue (acceptable, not the goal). Faster than Valheim's
  5.5-yr outlier; on par with V Rising (2 yr) and Conan (1.5 yr).
- **EA scope at launch (the vertical slice that must be true):** the full **one-meter loop** (Taint
  bank/purge at the Hearth, §5), 1 weighty combat triangle (melee / ranged / rot-magic, §9), **2–3
  regions** with decay states (§11), **1–2 Wardens** (§10), both **Warded/Tainted** path skeletons (§8),
  **2–4 co-op** with Blight-transfer revive (§13), soft-permadeath / **Hollowing** (§12). **The corruption
  economy must feel complete on day one even if content is thin — the USP is the meter, not the map.**
- **Content cadence: ~quarterly major drops, 4–5 across EA**, themed as **Tides** (deepening Long Dusk eras
  — a built-in narrative wrapper for content patches). Each Tide adds a region + **Warden** + path skills +
  **Wake** variants.
- **EA → 1.0 graduation = the Hollow Crown endgame + all regions + the three endings.** 1.0 is when the
  *story can be finished* (bible §9). (Detailed milestone roadmap: §18.3.)

---

### 17.5 Monetization stance (decided)

**Premium one-time purchase, full stop, for launch. Cosmetic-only monetization after 1.0. One paid
narrative expansion.** The rationale, tied to comps and design:

- **F2P is wrong for this game.** F2P demands retention-grind loops and aggressive hooks that fight our
  melancholic, finite, narrative-driven design. **None** of our successful comps are F2P. **Rejected.**
- **Pay-to-win is doubly forbidden — and incoherent here.** The core resource, **Taint**, *is* both power
  and survival risk (§5/§8, bible §8). Selling power or safety would collapse the keystone tension; there
  is no coherent "win" to sell. Conan is the lesson: monetization is **recipes and cosmetics, never
  items/stats.**
- **No DLC during EA.** Players paying to beta-test should never be asked to also buy content mid-EA. All
  EA content is **free** (matches Valheim / Enshrouded / V Rising).
- **Post-1.0 cosmetic layer (optional, non-power):** **Hearth** skins, armor/weapon transmogs,
  **Wake**/**Revenant** cosmetic variants, ritual emotes. Dark-fantasy cosmetics fit thematically — a
  **Tainted** player *wants* to show their warping (the seduction of corruption made visible). Conan's
  Bazaar template, kept strictly cosmetic.
- **One paid narrative expansion ~12–18 months post-1.0:** a new region + **Warden** + a slice of the
  **Hollow Crown** mythos, **$14.99–$19.99** (Elden Ring's Shadow of the Erdtree proved expansions extend
  the tail and re-spike sales). Free updates continue alongside (DST/Valheim long-tail model).

**Net revenue shape:** strong premium launch + sustained free-update goodwill + modest cosmetic trickle +
one expansion spike. Predictable, on-brand, low-risk.

---

### 17.6 Key business risks (summary — full register in §18.5)

| Risk | One-line mitigation |
|---|---|
| **Scope creep** (genre-canonical, the #1 budget threat) | Vertical-slice-then-**Tides** discipline; push every "more biomes / more systems" impulse into EA Tides. |
| **USP doesn't land in playtesting** | The one-meter economy is unproven — this is *why* EA exists: tune live before the 1.0 price hike. |
| **Co-op netcode cost** for a persistent 2–4 world | Fund dedicated netcode engineering from day one (§16/§18); under-resourcing it kills the buy-multiplier. |
| **Crowded survival-EA field** | Differentiate hard on the corruption USP + grimdark tone in every beat; **out-distinct, do not out-spend.** |
| **Perpetual-EA drift** (the Zomboid path) | Set the 18–24-month 1.0 target publicly; acceptable but not the plan. |

---

### 17.7 Sources

- Valheim 12M (Nov 2023): https://www.gamedeveloper.com/business/-i-valheim-i-has-crafted-12-million-sold-copies · 10M (Apr 2022): https://www.pcgamer.com/valheim-has-sold-over-10-million-copies/ · 17M lifetime + 1.0 Sept 9 2026 + 5-person team + $20: https://www.windowscentral.com/valheims-dev-team-expand-following-games-explosive-success · https://wccftech.com/valheim-1-0-release-date-september-2026/ · peak 501,804 CCU: https://steambase.io/games/valheim/steam-charts
- V Rising 3.9M (Feb 2024): https://gameworldobserver.com/2024/02/02/v-rising-sales-3-9-million-copies-vs-other-survival-games · 5M (Jan 2025) + 6M (late 2025): https://www.gematsu.com/2025/01/v-rising-sales-top-five-million · EA $19.99 → 1.0 $34.99 (May 8 2024, ~2 yr EA): https://blog.stunlock.com/v-rising-early-access-price-last-chance/ · https://www.pcgamesn.com/v-rising/price-increase · peak 150,563 CCU: per tracker.gg/Steambase
- Don't Starve Together ~9.5M / ~$94M gross [EST] + peak 72,629: https://gamerevenuedata.com/games/dont-starve-together/ · price $14.99 / 95% reviews: https://raijin.gg/app/322330/Dont_Starve_Together
- Conan Exiles 1.4–1.5M at 1.0: https://www.gamedeveloper.com/business/-i-conan-exiles-i-tops-1-4m-sales-to-become-best-selling-title-in-funcom-history · Battle Pass / cosmetic Bazaar (Age of Sorcery): https://www.conanexiles.com/blog/battle-pass-and-bazaar-full-overview-in-age-of-sorcery/ · https://massivelyop.com/2022/07/14/conan-exiles-deep-dives-its-planned-battlepass-monetization-system/
- Project Zomboid ~15M [EST] + $20: https://newsletter.gamediscover.co/p/how-project-zomboid-just-kept-selling · https://levvvel.com/project-zomboid-statistics/
- Enshrouded 3M+ (Aug 2024), 1M in 4 days, peak 160,405, $29.99, Keen Games 58 staff: https://gameworldobserver.com/2024/08/09/enshrouded-3-million-players-on-steam-since-january · https://gameworldobserver.com/2024/01/29/enshrouded-hits-1-million-players-steam-keen-games · https://steambase.io/games/enshrouded/price
- Lies of P 4M (Mar 2026), 3M (Jun 2025), $59.99, difficulty options added: https://www.gematsu.com/2026/03/lies-of-p-sales-top-four-million · https://www.videogameschronicle.com/news/lies-of-p-is-getting-difficulty-options-to-make-the-soulslike-more-accessible/
- Lords of the Fallen 2.04M + $66M budget: https://www.tweaktown.com/news/107323/lords-of-the-fallen-breaks-2-million-sales-shortly-before-sequel-announcement/index.html · https://gameworldobserver.com/2023/10/24/lords-of-the-fallen-budget-66-million-most-expensive-ci-games
- Elden Ring 30M+ (Apr 2025), Dark Souls trilogy ~35M: https://www.videogameschronicle.com/news/elden-ring-has-sold-over-30-million-copies-fromsoftware-says/
- Steam Early Access 2024: 2,897 EA releases (~14% of releases), 28% of top-grossing new releases were EA, >50% exit EA in <12 mo: https://wnhub.io/news/stores-and-publishing/item-47434 · https://newsletter.gamediscover.co/p/the-state-of-steam-early-access-graduates
- Indie dev budgets/team/timeline (8–10 team = $150–500k/yr; 18–24 mo 3D; survival = scope-creep risk): https://www.steampageanalyzer.com/blog/indie-game-development-costs · https://vsquad.art/blog/indie-game-budgets-what-it-really-costs-to-build-a-game
- Soulslike accessibility trend (Another Crab's Treasure assist mode; late-2025 accessibility rise): https://www.inverse.com/gaming/another-crabs-treasure-makes-a-case-for-difficulty-options-in-soulslikes

---

<a id="sec-18"></a>

## 18. Production, Scope & Roadmap

> **Scope.** This section is the build plan that spends against the business case (§17): the team
> composition, the budget range, the milestone roadmap from prototype to post-launch, the content scope at
> each gate, and the risk register. It is grounded in the **Enshrouded / V Rising production class** — *not*
> the 5-person Valheim outlier (do not plan for the miracle). Every dollar and headcount figure is **[EST]**
> per the market brief.
>
> **The single governing principle:** the keystone is the **one-meter corruption economy** (§5), not
> breadth. Ship a narrow, deep vertical slice; let Early Access fund expansion; push every "more"
> impulse into the **Tides** cadence. Scope discipline is the #1 business risk (§18.5).
>
> **Cross-references:** §16 for the technical targets being staffed against; §17 for the pricing/EA plan
> these milestones deliver; §19 for the accessibility scope that ships at EA launch; §5–§13 for the systems
> each milestone builds.

---

### 18.1 Team composition (~18–28 core through EA)

A 3D, weighty-combat, RPG-deep, co-op-networked, narrative survival game is a **20-ish-person** undertaking.
Indicative split (scale toward the upper end *during* EA as revenue lands — Valheim and Keen both scaled
*after* the hit, not before):

| Discipline | Headcount | Why this size |
|---|---|---|
| **Engineering** | **5–7** (incl. **1–2 dedicated to co-op netcode**) | The dedicated netcode line is **non-negotiable** for a persistent 2–4 co-op world (§16) — under-resourcing it kills the buy-multiplier (§17.6). |
| **Environment / world art** | **4–6** | The **state-based decay pipeline** (§11/§16) is art-heavy — every region needs authored decay-stage material/prop/lighting sets. |
| **Combat / animation** | **2–3** | Soulslike-weight melee, frame data, root-motion, the rot-magic VFX language (§9/§15). |
| **Systems / design** | **3–4** (incl. a **live-tuning analyst in EA**) | The corruption economy (§5) needs dedicated owners and telemetry-driven balancing through EA. |
| **Narrative** | **2** | The Witherfall lore, the **Hollow Crown** arc, the three endings, environmental storytelling (§2/§3). |
| **Audio** | **1–2** | Funereal score + the dark's "breath" sound design (§15). |
| **Production / QA / community** | **2** | Including EA community management — the EA feedback loop is a production function, not a side task. |

---

### 18.2 Budget range (~$3–6M to EA [EST])

- **~$3–6M to EA launch [EST].** A team of 8–10 runs $150–500k/yr in the cited indie data; a 20+-person 3D
  survival-RPG of this ambition over 3–4 years lands at the **low end of "mid."** Lords of the Fallen's
  **$66M** is the AAA ceiling we explicitly avoid (§17.1).
- **The EA flywheel funds the rest.** EA revenue at the SOM floor (300–500k units ≈ **$6–10M net**, §17.2)
  should **self-fund the EA period and 1.0** — the classic survival-EA pattern. Console porting (§18.3) and
  upper-end team scaling are funded *from* EA revenue, not raised up front.
- **Break-even sits comfortably inside the floor** at the $29.99 EA price (§17.4).

---

### 18.3 Milestone roadmap (~5–6 years total)

The arc: **~3–4 years to EA launch → ~18–24 months in EA → 1.0**, then a sustained post-launch tail.
Comparable to V Rising's ~5 years of dev. Aggressive-but-real **only if scope stays disciplined.**

| # | Milestone | Duration (cumulative) | Exit gate (what must be true) | Maps to |
|---|---|---|---|---|
| **M0** | **Pre-production / Prototype** | ~6–9 mo (Y0–Y1) | The **one-meter loop** proven on paper + grey-box: bank/purge at a Hearth *feels* like a real dilemma in a single test zone. Engine + GAS spine stood up. | §5 keystone |
| **M1** | **Vertical Slice** | ~Y1.5 | **Engine version-locked (§16.2).** One region with live decay states, one full combat triangle (melee/ranged/rot-magic), one **Warden** + **Greater Hearth**, **Warded/Tainted** path skeletons, soft-permadeath/**Hollowing**, **2–4 co-op on listen-server** with **Blight-transfer** revive. The slice is *fun and complete-feeling at small scope* — the green-light gate. | §5–§13, §16 |
| **M2** | **Production / Alpha** | ~Y2.5–Y3 | Content built out to **EA scope**: 2–3 regions, both path trees fleshed to playable depth, dedicated-server binary hardened, save/persistence + rolling backups shipped (§16.5), accessibility/assist layer in (§19), perf converging on the Series S / Steam Deck budget (§16.6). Feature-complete-for-EA, content-thin. | §16, §19 |
| **M3** | **Early-Access Launch ($29.99)** | ~Y3–Y4 | The vertical slice of the *economy* at scale, live and stable for 2–4 co-op. Telemetry + live-tuning loop running. Steam-first (bible §0). | §17.4 |
| **M4** | **EA content — the Tides** | ~18–24 mo in EA | **4–5 quarterly major drops**, each a **Tide** (deepening Long Dusk era) = +1 region + **Warden** + path skills + **Wake** variants. The corruption economy tuned to feel right *before* the price hike. All EA content **free** (§17.5). | §11, §10, §8 |
| **M5** | **1.0 Launch ($34.99)** | ~Y5–Y6 | **The story can be finished:** the **Hollow Crown** endgame + all regions + the **three endings** (End it / Master it / Be consumed, bible §9). **Console port ships at 1.0** (V Rising playbook), funded from EA revenue. Price hike announced weeks ahead (§17.4). | §3, §9, §17 |
| **M6** | **Post-launch tail** | 1.0+ | Continued **free** content updates (DST/Valheim long-tail) + **cosmetic-only** monetization layer + **one paid narrative expansion ~12–18 mo post-1.0** (new region + Warden + Hollow Crown mythos, $14.99–$19.99). | §17.5 |

> **Console is a 1.0 deliverable, not an EA one.** Steam-first EA (bible §0); the PS5/Xbox Series port is
> timed to 1.0. It widens the breakout ceiling but adds cert + netcode cost — fund it from EA revenue, not
> the build budget.

---

### 18.4 Content scope (what ships when)

The scope contract, stated as "deep-not-wide at every gate":

- **EA-launch content (M3) — the binding minimum (§17.4.2):** the full Taint bank/purge loop; 1 combat
  triangle; **2–3 regions** with decay states; **1–2 Wardens**; both path *skeletons*; 2–4 co-op +
  Blight-transfer; soft-permadeath. **The corruption economy must feel complete on day one even if the map
  is thin** — the USP is the meter, not the map.
- **EA expansion (M4) — Tides:** each Tide is the unit of content growth — a region + Warden + path-tier
  unlocks + Wake variants, wrapped in the canonical deepening-**Long Dusk** narrative. This is where every
  "more biomes / more systems" impulse is *scheduled*, never gold-plated into pre-EA.
- **1.0 content (M5):** all regions, the **Hollow Crown**, the three endings, full both-path trees, console
  parity.
- **Post-1.0 (M6):** free updates + cosmetics + the single paid expansion (§17.5). **No DLC during EA**
  (§17.5).

---

### 18.5 Risk register

Severity = Likelihood × Impact on shipping the disciplined plan.

| # | Risk | Likelihood / Impact | Mitigation | Primary owner |
|---|---|---|---|---|
| R1 | **Scope creep** (genre-canonical; the #1 budget killer) | High / High | Structural defense: keystone is the one-meter economy, not breadth. Ship the M1 slice; gate all expansion behind **Tides** (M4). Every pre-EA "more" impulse is pushed to a Tide. | Production / Design lead |
| R2 | **USP doesn't land in playtesting** (the one-meter economy is unproven) | Med / High | This is *why EA exists* (§17.4). Tune live with telemetry + the live-tuning analyst through M4 before the 1.0 price hike. M0/M1 also de-risk it early on grey-box. | Systems design |
| R3 | **Co-op netcode cost** for a persistent 2–4 world | Med / High | Fund 1–2 dedicated netcode engineers from day one (§18.1/§16). Build the dedicated-server binary from M1 to *force* clean server-authority. | Engineering |
| R4 | **Root-motion combat prediction** is prediction-hostile (§16.4.2) | Med / Med | Budget bespoke prediction/reconciliation work for the acting player's own attack locomotion; validate in the M1 slice against real ping data. | Engineering |
| R5 | **Series S / Steam Deck performance** (the binding 60fps + 10GB constraint) | Med / High | Budget *to* Series S as its own line item from M2 (§16.6); scalability discipline is mandatory, not optional. Profile continuously, not at cert. | Engineering / Tech art |
| R6 | **Save corruption in a continuously-mutating world** | Med / High | Rolling backups + atomic writes + schema versioning from M2 (§16.5.2) — table stakes for survival players. | Engineering |
| R7 | **Crowded survival-EA field** (Enshrouded, Palworld-likes, V Rising sequels) | High / Med | Out-distinct, don't out-spend (§17.6): the corruption USP + grimdark tone in every marketing beat. | Marketing / Creative |
| R8 | **Perpetual-EA drift** (the Zomboid path) | Med / Med | Publicly commit to the 18–24-month 1.0 target; treat M4 Tides as a finite runway to M5, not an open-ended EA. | Production |
| R9 | **Engine-version churn** mid-production | Low / Med | Lock the UE5 version at the M1 vertical-slice gate (§16.2); never chase point releases in production. | Engineering |
| R10 | **Budget mismatch / over-ambition** (the Lords of the Fallen lesson) | Low / High | Stay at the low end of "mid"; self-fund EA→1.0 from EA revenue; scale team upward only *after* the EA hit lands (§18.1/§18.2). | Production / Studio lead |

---

### 18.6 Open Questions

- **[BUDGET → finance]** The $3–6M band is wide; tightening it requires the M1 vertical-slice actuals
  (team ramp curve, region-art cost per decay-state set). Re-baseline at the M1 gate.
- **[STAFFING → §16]** Exact split of the 1–2 netcode engineers vs. general gameplay engineering depends on
  how much of the root-motion prediction work (R4) proves bespoke vs. CharacterMovementComponent-native —
  confirm at M1.
- **[SCHEDULE → §17]** Console port start date within M4–M5: earlier de-risks cert but pulls EA-revenue
  forward into cost; pick once EA-Year-1 sales confirm the flywheel is funding it.

---

<a id="sec-19"></a>

## 19. Accessibility & Difficulty Options

> **Scope.** This section specifies the difficulty model and the accessibility feature set WITHERREACH
> ships **at launch** (EA, §17/§18). Two facts frame it. First, accessibility and difficulty/assist options
> are now **table-stakes, not optional** — even the gold-standard premium Soulslike (Lies of P) added
> difficulty options, and granular assist modes that *don't touch story or achievements* (Another Crab's
> Treasure) are the expected pattern (§17.6). Second — and unique to this game — **difficulty is already
> partly a build choice:** your **Warded/Tainted** path sets your **Taint** floor, and the floor sets your
> survival difficulty (§5/§8). So WITHERREACH has *two* difficulty axes — the built-in build dial and an
> explicit assist layer on top — and §19 specifies how they coexist without collapsing the keystone.
>
> **Cross-references (read, do not duplicate):** §5 owns the corruption meter (the **Taint** floor/ceiling,
> the **Lucid / Marked / Fevered / Brink** bands, the purge curve, the **Hollowing** track); §8 owns the
> **Warded/Tainted** build = difficulty model; §9 owns the combat model these assists scale; §10 owns
> **Wake** hunt-pressure and **Wardens**; §12 the death/turning model; §13 co-op + **Blight-transfer**; §14
> owns HUD readability (the corruption-readability requirements below are an accessibility *constraint on*
> §14, not a redesign of it); §16 the technical hooks (incl. the co-op game-speed caveat).
>
> Numbers are **(illustrative — to tune)**; only exact scalar ranges are tunable, the rulings are fixed.

---

### 19.1 Design principles (the non-negotiables)

1. **Non-stigmatized by construction.** Assists carry **zero mechanical penalty, zero locked content, no
   "you used assists" asterisk.** **No assist setting gates any achievement or any of the three endings**
   (End it / Master it / Be consumed, bible §9) — all are reachable at every setting (§19.6).
2. **The Soulslike identity lives in commitment + spacing + timing, not raw numbers.** Reading a tell,
   timing a dodge, managing stamina, and punishing — that is the skill loop (§9). Assists that **widen the
   margin for error preserve the identity**; assists that **remove the timing/commitment challenge erode
   it**, so the latter live only at the explicit "story" extreme, never in the default or mid presets.
3. **Assists soften pressure, not structure.** This is the keystone invariant (§19.3): an assist may make
   the corrupted world *gentler*, but may never dismantle the bank/purge decision, the Taint on-ramp, or
   (on the standard ladder) the **turning** stake.
4. **Two axes, kept independent.** The **build dial** (Warded↔Tainted, §8) is player *identity*; the
   **assist layer** is a world-pressure multiplier on top. They stack orthogonally — see §19.3.3.

---

### 19.2 Axis 1 — the built-in difficulty dial (build = survival difficulty)

This game's first difficulty control is **the skill tree, not a slider** (§5.6/§8.8). Your **Path** +
slotted skills + tempered gear set `T_floor` (resting danger) and `T_max` (carry ceiling); the floor sets
which threat band you *rest* in, and the band is your moment-to-moment difficulty.

| Build (anchor, §8.8) | `T_floor` | Resting band (§5) | Self-selected difficulty |
|---|---|---|---|
| **Lantern-Warden** (pure Warded) | ~5 | deep **Lucid** | Easiest — the party anchor; lowest hunt-pressure, best purge & Blight-transfer. |
| **Ash-Knight** (Warded-lean) | ~15 | low **Lucid** | Moderate. |
| **Bloodletter** (hybrid Tainted) | ~35 | **Marked/Fevered** | Hard. |
| **Rotcaller** (heavy Tainted) | ~50 | **Fevered** | Very hard — glass cannon, needs a Warded anchor in co-op. |
| **Hollowing-Ascendant** (pure Tainted) | ~90 | **Fevered/Brink** | Brutal — lives one bad **Expedition** from **turning**. |

A player who finds the default too punishing can **build toward Warded** to lower their floor and their
hunt-pressure *without ever opening a menu* — and a player who wants more can build hotter. This dial is
free, diegetic, and always present; the explicit assist layer (§19.3–§19.5) sits on top of *whatever build
the player chose.*

---

### 19.3 Axis 2 — the assist layer and the corruption economy (the keystone invariant)

The explicit assist toggles must coexist with the keystone economy (§5) without breaking it. The three
binding rulings (synthesized with the survival-systems and rpg-combat owners; carried in the
survival-systems master brief §13):

#### 19.3.1 R1 — World-pressure toggles soften the meter; the standard ladder never touches Hollowing

The **standard difficulty ladder** — the presets (§19.5) and the individual **world-pressure toggles**:
Taint-gain rate, light-fuel drain, **Wake** hunt-pressure, **Blight-transfer** revive window — softens
**only the moment-to-moment Taint pressure.** It leaves the **Hollowing / turning** soft-permadeath track
**untouched.** Turning stays a real stake across the entire normal spectrum (bible pillars 3 "Power Has a
Body Count" and 5 "Die Forward"). **Assists soften the meter, not the soft-permadeath track.**

A single, separate, explicitly-labelled opt-in **"Assist Mode"** (the Celeste model) MAY touch the
permadeath track — reduce Hollowing-on-death (e.g. 50% or 0), slow **Brink** accrual (+1/min → +0.5/min),
or disable turning entirely — but **only behind a clear "this changes the core stakes / intended
experience" notice**, never silently folded into a Normal/Hard preset. It serves players for whom a
permadeath descent is a genuine accessibility barrier (motor / cognitive / anxiety) without diluting the
stake for everyone else.

#### 19.3.2 R2 — The Marked-floor invariant (the loop must survive at every difficulty)

There is a floor below which softening Taint-gain *kills* the bank/purge decision: if gain is so low you
arrive at the **Hearth** sitting near `T_floor`, there is nothing to bank-or-purge. The binding invariant:

> **No assist setting — individual toggle or preset — may reduce the expected end-of-Expedition carried
> Taint below the Marked threshold (`f ≥ 0.35`) for a baseline build (`T_floor 20`, `T_max 100`) on a
> nominal ~30–45 min Expedition, and purge must stay costly (`k_p ≥ 0.2`).**

Implications (illustrative — to tune): the **Taint-gain-rate toggle bottoms out at ~0.5× baseline**, and
any *combination* of toggles that would undershoot **Marked** is clamped. **Critical corollary — assist
softens pressure, not structure:** an assist must **never make clean food abundant or clean fuel free**, or
the Taint on-ramp (§5.3/§6) — and with it the whole loop — collapses. The bank/purge decision survives at
every difficulty *by construction.*

#### 19.3.3 R3 — Assists stack orthogonally on the build; they never nudge the player toward Warded

The assist layer is a **pressure-multiplier applied on top of the chosen build.** It scales the **world**
(gain / light / hunt / revive), leaving the build's **relative** floor/ceiling identity intact: a **Tainted**
glass-cannon on maximum assist is still "the hot build relative to **Warded**," just in a gentler world.

**Difficulty presets may exist as curated bundles of these orthogonal world-pressure toggles (bounded by
R2), but a preset never auto-reassigns or nudges the player's Path.** Forcing assist players toward Warded
would deny the Tainted power-fantasy to exactly the players who most need accessibility help. The build
dial (§19.2) and the assist layer are **two independent axes that multiply.**

---

### 19.4 Combat assist toggles

Granular combat toggles (default = 100% / off unless noted). Each preserves the deliberate combat identity
(§19.1.2) by widening the margin for error rather than removing the timing challenge.

| Toggle | Range | Ship? | Identity note |
|---|---|---|---|
| **Enemy damage** | **50%–150%** | **Yes** | The single most useful forgiveness dial — you still must engage correctly; mistakes just cost less. |
| **Enemy health** | **70%–130%** | **Yes** | Shortens fights (fatigue / cognitive accessibility) without touching timing. |
| **Enemy poise** | **80%–120%** (or folded into a combined "enemy toughness") | **Narrow only** | Heavy poise reduction trivializes the stagger/crit game, which *is* the skill loop (§9) — keep it modest so stagger stays earned. |
| **Dodge i-frame window** | **+0…+50%** (one-way widen) | **Yes** | Forgiveness for motor timing; preserves the dodge skill. |
| **Stamina-drain rate** | **100% → 50% drain** | **Yes** (mid ~75%) | Keeps the stamina economy intact with margin. **Infinite stamina** is allowed *only* at the extreme story end — it erases the stamina-economy identity — never in default/mid presets. |
| **Parry / riposte window** | **+0…+50%** (one-way widen) | **Yes** | Identity-safe. |
| **Lock-on stickiness** | default + "sticky" | **Yes** | Pure QoL/accessibility, zero identity cost. |
| **Game-speed slowdown** | **100% → 50%** | **Yes** | The **strongest single accessibility option** for a Soulslike (motor + cognitive). Identity-*preserving* because it slows the whole sim — every timing relationship is intact, just at a slower clock. **Co-op caveat below.** |

> **Game-speed in co-op (routed to §16).** Game-speed cannot apply per-player in a shared authoritative
> simulation. Ruling: **solo-only, or host/party-vote applying to the whole session.** This is the one
> genuinely cross-team combat-assist item — its technical resolution is an §16 Open Question.

---

### 19.5 Difficulty presets

Ship curated presets **on top of** the granular toggles; **every toggle stays individually editable after
picking one** (a preset is a starting bundle, never a lock). All bundles are bounded by the R2 invariant
(§19.3.2). Illustrative bundles:

| Preset | Intent | Bundle (illustrative — to tune) |
|---|---|---|
| **Revenant** (default / intended) | The deliberate experience. | All values 100% / default. |
| **Survivor** (mild assist) | Forgiving but full-strength. | Enemy damage 80% · stamina drain 85% · i-frames +20% · lock-on sticky. |
| **Wanderer** (story / full assist) | The world and narrative without the combat wall. | Enemy damage 60% · enemy HP 80% · stamina drain 70% · i-frames +35% · parry window +35% · lock-on sticky · game-speed 80% available · corruption-FX intensity reduced · (optional) dodge assist. |
| **Withered** (optional harder) | Replay / challenge — *not* accessibility, included because it's cheap and good for positioning. | Enemy damage 130% · tighter windows. |

Presets bundle **combat** assists and **world-pressure** assists alike, but — per R1 — none of the
**Survivor / Wanderer / Withered** standard presets touch the **Hollowing/turning** track; only the
separate, explicitly-labelled **Assist Mode** (§19.3.1) may.

> **Note on "Be consumed."** The third ending is reached by **maxing Hollowing — a player choice** (bible
> §9). Because assists reduce *accidental* death and turning (not the deliberate path to it), turning
> becomes **opt-in rather than a difficulty-wall accident** at lower difficulties. That is intended, not a
> loophole.

---

### 19.6 Accessibility features (beyond difficulty)

#### 19.6.1 Must-ship at launch

| Feature | Requirement |
|---|---|
| **Colorblind-safe corruption readability** *(the #1 item — non-negotiable; a constraint on §14)* | The entire core loop is **reading your Taint band** (Lucid / Marked / Fevered / Brink, §5.2) and **clean-vs-blighted** resources/nodes (§5.3/§6). If that is color-only, the game is **unplayable** for colorblind players. **Pair color with shape / icon / texture + a numeric and/or SFX cue on *every* corruption readout.** Ship deuteranopia / protanopia / tritanopia palettes + a high-contrast corruption mode. §14 implements; §19 requires. |
| **Corruption screen-FX intensity slider** | The **Fevered/Brink** turning telegraph (§5.2/§5.7) uses heavy screen distortion + vignette + audio corruption FX — a photosensitivity / nausea / migraine risk. The slider must **keep the telegraph legible at every setting** (0% must not hide the warning) while reducing the visual assault. Also: reduce-shake, motion-blur off. |
| **Audio cues for attack tells** | Every visual tell (§9) paired with a distinct audio cue; plus an optional **telegraph assist** that highlights big / unblockable attacks. Helps low-vision players and everyone. |
| **Full input remap** (controller + KB/M) | Table-stakes. |
| **Hold-vs-toggle** for every hold action | Sprint, block, aim, lantern, crouch — cheap, high motor-accessibility impact. |
| **Subtitles** | Speaker names + adjustable size / background — table-stakes for a narrative game (§3). |

#### 19.6.2 Should-ship at launch

| Feature | Note |
|---|---|
| **Aim assist for ranged** | **Recommended yes** — ammo is scarce *by design* (§9); players shouldn't whiff scarce shots to motor difficulty. |
| **Dodge / auto-dodge assist** | Offer **only** as an extreme toggle (it erodes the core defensive skill) — bundled in **Wanderer** (§19.5), never default. |
| **One-handed / simplified control scheme** | Nice-to-have, scope-permitting. |

---

### 19.7 What this section owns vs. references

This section owns the **difficulty model** (the two axes and how they coexist), the **assist-vs-economy
invariants** (R1–R3), the **combat assist toggle set**, the **presets**, and the **accessibility feature
list**. It does **not** own:

- The corruption meter, bands, purge curve, or Hollowing rules the toggles scale — **§5**.
- The **Warded/Tainted** build = difficulty model the dial rests on — **§8**.
- The combat model the combat toggles modify — **§9**; **Wake** hunt-pressure / **Wardens** — **§10**;
  death/turning — **§12**; co-op / Blight-transfer — **§13**.
- The **HUD/readability implementation** the colorblind-safe and FX-intensity requirements constrain —
  **§14**; art/audio of the corruption FX — **§15**.
- The **technical hooks** (and the co-op game-speed resolution) — **§16**.

---

### 19.8 Open Questions

- **[CROSS-TEAM → §16/§13]** Game-speed slowdown in co-op: solo-only vs. host/party-vote for the whole
  session (§19.4). Technical resolution is an §16 Open Question; the design ruling here is "one or the
  other, never per-player."
- **[BALANCE → §5]** Exact scalar floors for the R2 invariant (the 0.5× Taint-gain bottom, the `k_p ≥ 0.2`
  purge-cost floor, the Marked-threshold clamp on toggle *combinations*) confirmed in the EA live-tuning
  pass (§18), not pre-EA.
- **[SCOPE → §18]** The separate opt-in **Assist Mode** that may touch Hollowing (§19.3.1): confirm it
  ships at EA launch vs. is added during EA — recommended **at launch**, as accessibility is table-stakes
  (§17.6), pending production load at M2.

---

<a id="sec-20"></a>

## 20. Appendices

> **Scope.** Reference matter for the whole document: (A) the **canonical glossary** — the concept
> bible §14 vocabulary expanded with every term the sections introduced (named Wardens, regions, decay
> states, factions, NPCs, mechanical terms); (B) the **references** — the art/audio/narrative
> touchstones and the real market-data source URLs; (C) the **consolidated open-questions register** —
> every section's "Open Questions" block collected into one prioritized table. Where a glossary term is
> owned by a section, the owning section is cited; this appendix never re-specifies a system.

---

### 20.A Canonical glossary

All writers and disciplines use these terms verbatim. Terms marked **(bible §14)** are the original
locked glossary; the rest were introduced and locked by the sections cited.

#### 20.A.1 World, cosmology & the clock

- **Witherreach / the Reach** — the playable dead-kingdom world (bible §14). *Usage:* "the Reach" names
  the realm across time; "the Witherreach" names its rotted present — the same concentric basin (§2.4).
- **the Witherfall** — the cataclysm: a failed immortality rite that broke the world; **Time Zero** of
  the timeline (bible §14, §2.3).
- **the Communion** — the soul-binding rite itself: the **Choir** *sang* every soul of the kingdom into
  one web anchored to the living king; it locked when he died (§2.2.1).
- **the Choir** — the order of priest-singers who designed and performed the Communion (§2.2.1). Their
  dissolved remnants are the **Choristers / Keening Choir** (§2.6.3).
- **the Long Dusk** — the permanent rotting twilight; also the global decay clock that deepens in
  **Tides** (bible §14, §2.5, §6.5). No day/night cycle.
- **the Tides** — eras of escalating rot; the macro clock advances **one Tide per ~10 h of cumulative
  out-in-the-Reach (Expedition) time**, ~5–6 Tides per playthrough (§6.5).
- **the Thinning** — the sixth/current era: the locked binding is finally degrading, which is why
  Revenants now wake and why the Crown can at last be reached (§2.3).
- **the Blight** — the corrupting substance bleeding from the world (the leak of trapped-soul pressure);
  the world-side resource that feeds corruption (bible §14, §2.2.4).
- **the deathlight** — a fragment of the severed, guttered sun-door that a Revenant carries; why only a
  Revenant can kindle Hearths, purge corruption through themselves, and act on the anchor (§2.2.5).
- **threshold-soul** — what a Revenant *is*: a soul caught half-through the dying sun's door at the
  instant of binding, neither released into death nor woven into the web (§2.2.5).

#### 20.A.2 The corruption economy (mechanical — §5)

- **Taint** — current carried corruption; one meter `0…T_max`, simultaneously the spend currency
  (cast / temper / ascend) and the primary survival-threat readout. Rises from surviving the rot; falls
  only by spending or purging; never decays passively (bible §14, §5.1).
- **Hollowing** — permanent accumulated corruption, `0…100` read as **10 pips of 10**; the
  soft-permadeath track. Rises on death, Brink exposure, and overflow; reduced only by the Cleansing
  rite; at max ⇒ **turning** (bible §14, §5.7).
- **turning** — a character fully consumed by Hollowing becomes a **Wake**-creature (the **Turned**)
  (bible §14, §12.7).
- **`T_floor` / `T_max`** — the build-set minimum / carry-ceiling of Taint. Floor sets the resting
  threat band (= survival difficulty); ceiling sets how much spendable danger can be banked (§5.2/§5.6).
- **threat bands** — **Lucid** (`f` 0–0.35) → **Marked** (0.35–0.60) → **Fevered** (0.60–0.85) →
  **Brink** (0.85–1.00), where `f = Taint / T_max` (§5.2).
- **Blight (resource) / render** — raw Blight carried as a material at no Taint cost; **rendering** it at
  a bench converts it into Taint (the player-elected on-ramp) (§5.1, §7.2).
- **bank / purge / invest** — the Hearth session-climax decision: keep carried Taint as power potential,
  spend it down to floor for safety, or convert it into permanent build power (§5.5).
- **purge / the purge curve** — driving Taint down to `T_floor` for clean fuel + materials; cost climbs
  with Hollowing but stays finite (`k_p ≥ ~0.2`) (§5.4).
- **the Cleansing rite** — the **only** Hollowing reducer: −1 pip (−10 Hollowing) at a Greater Hearth for
  a large clean-resource cost, ≤ once per Tide per Greater Hearth (§5.7, §12.8).

#### 20.A.3 Places — the six regions & landmarks (§2.4.2 / §11.3)

- **the concentric basin** — the Reach's caldera-valley: decay worst at the heart, thinnest at the rim;
  the player descends inward/downward (§2.4, §11.1).
- **the decay states** — the five-step readable spectrum: **Lingering → Festering → Withering →
  Blooming → Terminal** (§2.4.1). Maps onto the mechanical three-tier zone decay **fringe / decayed /
  blighted-core** used by the survival economy (§6).
- **R1 — the Gloaming Marches** *(Lingering; tutorial ring)* — cold heath & mist-fens; home hub
  **Ashfast** (the first Hearth-hold); Warden **the Mire-Stag** (§2.4.2, §11.3.2).
- **R2 — the Cinderwood** *(the Ashen Reaches; Lingering→Festering)* — burning cremation-forest; Warden
  **the Cinder-Alpha** (§11.3.3).
- **R3 — the Mourning Marsh** *(the Drowned Reach; Festering)* — black-water labyrinth; Warden **the
  Drowned Choir** (yields the **Fragment of the Song**) (§11.3.4).
- **R4 — the Hollowing Wastes** *(the Communed Marches; Withering→Blooming)* — Shimmer expanse; the
  Communed seat **the Black Hearth**; Warden **the Communed Champion** (§11.3.5).
- **R5 — the Cathedral of Ash** *(the Pale Reach; Blooming, near-Crown)* — ash-desert cathedral; Warden
  **the Ashen Penitent** (§11.3.6).
- **R6 — the Hollow Court / the Sunhold** *(Terminal; endgame)* — the drowned capital where the sun
  guttered into the earth; the **Famished King** → the **Hollow Crown** (§11.3.7).
- **the Hearth** — a warded fire/shrine: safe haven (ambient Taint gain 0), respawn point, the place you
  bank/purge/temper/ascend/Cleanse; must be built and fuelled (bible §14, §7.6).
- **Greater Hearth** — region-scale Hearth, kindled by defeating a Warden; rolls local decay back one
  step and pins it while fuelled; hosts the Cleansing rite; gates the next ascension Tier (bible §14, §7.7).
- **the Black Hearth** — the Communed anti-Hearth: a sink run in reverse that *feeds on* offered Taint
  rather than purging it (§2.6.2, §7).
- **Reliquaries** — landmark dungeons in the wilds; each holds one concentrated mystery dose + one
  build-defining reward (bible §14, §11.4).
- **Expedition** — one play session: a round trip out from and back to a Hearth, 30–90 min (bible §14, §4.3).

#### 20.A.4 Factions & people

- **the Ashen Wardens** — survivors who **resist** corruption: keepers of Hearths, lightcraft, and the
  old human ways; allied to the **Warded** path. They cremate their dead (hence *Ashen*) (bible §14, §2.6.1).
- **the Communed** — lucid high-sorcerers who **embraced** the Blight to master it (aspiring god-kings);
  allied to the **Tainted** path (§2.6.2).
- **the Hollowing** *(faction caste)* — Communed pilgrims feeding themselves to the Blight, sliding toward
  the Wake in hope of ascension. *(Distinct from **Hollowing** the mechanical track.)* (§2.6.2).
- **the Crowned Circle** — the king's inner circle, bound first and deepest; they became the named, apex
  Wardens (§2.7).
- **Pyre-tenders / Hearth-keepers** — the Ashen Wardens' internal fracture: end the world cleanly vs just
  hold the light and survive (§2.6.1).

**Named NPCs (speaking roles, §3.3):**
- **the Lamplighter** — opening mentor & conscience; finds the player and names what they are.
- **Hearthmother Vesna** — leader of Ashfast; primary **Warded** quest-giver.
- **Wren** — a young Warden the player can mentor; barometer of the Warded path.
- **the Hollow Heir, Lysandra Vael** — the Communed's lucid prophet; primary **Tainted** quest-giver; the
  sole non-Revenant who can seat the anchor in the **refuse-variant** ending (§3.4.2, §13.8).
- **Coll** — a Communed pilgrim who visibly **turns** over the game (the Turned Acquaintance, §3.5).
- **the Pale Cantor** — half-turned former Choir-singer who **remembers how the Communion was sung**; the
  single most important lore NPC.
- **the First Warden / the Ashen Penitent** — the Wardens' repentant Crowned-Circle founder, now the
  corrupted R5 Warden; her failure teaches "only a Revenant can be the door."
- **Sovereign Vael, the Ever-King / the Hollow Crown** — the dead god-king; the **anchor** of the web and
  source of the Blight; site of the endgame choice (bible §14, §2.7).

#### 20.A.5 Enemies — the Wake & the Wardens (§10)

- **the Wake** — the ambient antagonist tide: corrupted dead and beasts; **grief made predatory**, not
  evil. Hunt-pressure scales with the player's **Taint** and the **Tide** (bible §14, §2.6.3, §10).
- **Wake bestiary — six mechanical classes (§10.3):** **Fodder (Husks)** · **Skirmishers** · **Brutes**
  (incl. the **Swollen**, which burst rot-gas) · **Afflicters** · **Hunters/Stalkers** (the elite
  **Famished**) · **the Turned**.
- **Wake — named/origin types (§2.6.3, §15.5.2):** **Husks** (the ordinary dead), **Gloamhounds &
  Mourncrows** (the bound beasts), **the Gravemade & the Swollen** (the most Blight-saturated dead), **the
  Choristers / Keening Choir** (dissolved Choir-singers still singing the rite), **the Famished** (elite
  hunters — the web's antibodies), **the Turned** (build-derived named elites).
- **Wardens** — region boss-guardians, each a biome's apex corruption, gating a Greater Hearth and the
  next ascension Tier (bible §14, §10.5).
- **the five progression Wardens (R1–R5):** **the Mire-Stag** (R1, Tier I) · **the Cinder-Alpha** (R2, II)
  · **the Drowned Choir** (R3, III) · **the Communed Champion** (R4, IV; final epithet TBD — see register)
  · **the Ashen Penitent** (R5, V) (§10.5).
- **the Hollow Court — endgame bosses (R6, outside the five-tier gate):** **the Famished King** (gauntlet
  gate; feeds on your Taint) → **the Hollow Crown** (the ending encounter and the three-choice) (§10.6).
- **ThreatLevel (TL)** — the spawn/hunt-pressure model: `ZoneTier + TaintBandTier + TideTier`, cap 8 (§10.2).

#### 20.A.6 Systems — progression, combat, survival, building

- **Paths: the Warded** (resist corruption — stable, lower ceiling, anchor/support; lowers `T_floor`) vs
  **the Tainted** (embrace corruption — high power, high instability; raises `T_floor`/`T_max`) (bible §14, §8).
- **the four ascension lanes** — **Vital · Martial · Warded · Tainted**; freely mixable, all paid for in
  Taint at a Hearth (§8.1).
- **the six attributes** — **Vigor (VGR) · Endurance (END) · Might (MGT) · Finesse (FIN) · Attunement
  (ATN) · Resolve (RSV)** (§8.2).
- **ascension** — buying a permanent build node at a Hearth by spending banked Taint; gated on Warden
  kills (the five Tiers) (§8.4).
- **tempering** — raising a gear piece to T2 (Taint + Blight materials); equipping tempered gear raises
  `T_floor` (the Tainted gear rail) (§7.5, §9.9). **Gear tiers:** T0 Scavenged / T1 Forged / T2 Tempered /
  T3 Ascended (§7.4).
- **rot-magic** — the Tainted Path's magic, powered by **spending Taint** off the meter (the in-field
  release valve); five schools: **Affliction · Wrack · Miasma · Carrion · Bloodrot** (§8.7.1, §9.10).
- **the Ascendant Ultimate** — the Tainted capstone ability (−20…−40 Taint, ≤1/Expedition); doubles as a
  Brink panic-escape (§9.10.4).
- **Lightcraft** — the Warded Path's **clean-fuelled** (no Taint) magic: protective / anti-Wake; the
  mirror of rot-magic (§9.12).
- **the damage triangle** — **Physical** (always available) · **Rot** (strong vs living/Warden cores, weak
  vs the Wake) · **Light/Cleansing** (strong vs the Wake & Hollowed) (§9.7).
- **Weapon Arts** — special moves unlocked per weapon family; rot-infused arts cost a small Taint sliver
  (§9.9).
- **Hunger** — the one extra visible survival bar; its only sustainable answer routes through the Blight
  food economy (the Taint supply on-ramp). No standalone temperature/sanity/thirst bars (§6.1, §6.4).

#### 20.A.7 Death, endings & co-op

- **Die Forward** — the death model (pillar 5): you lose ground and recoverable power, not the story
  (§12.1).
- **corpse-cache / the corpse-run** — on death you drop carried Taint above `T_floor` as a recoverable
  cache; retrieve it (Souls-style) or forfeit it to a second death. Death also advances Hollowing (§12.3).
- **DOWNED / Blight-transfer revive** — in co-op, HP→0 enters a revive window; an ally can sacrifice
  ~30 banked Taint to stabilize them (the reviver loses it, the revived gains it and comes back hotter)
  (bible §14 USP, §13.5).
- **the three endings (LOCKED frame):** **End it (the Pyre)** — offer your threshold-soul as the reopened
  door and let the world die (merciful; Warded-favoured); **Master it (the Crown)** — seat your soul as
  the new anchor and rule the rot (power; Tainted-favoured); **Be consumed (the Hollowing)** — turn
  (tragic; also reachable by maxing Hollowing in play) (bible §14, §3.4).
- **the Rite of the Crown** — the **resolved co-op ending canon** (§13.8): the Pyre requires **unanimity**
  (the loose-anchor rule), the Crown is an **individual seizable** claim, Be-consumed is individual.
- **the Fragment of the Song** — the relic from the Drowned Choir (R3) that records how the Communion was
  sung — and so how it might be unsung (End it) or re-sung with a new anchor (Master it) (§3.2.1, §3.3).
- **environmental-storytelling patterns (§3.6):** **the Tableau of the Last Moment** (every ruin freezes
  the instant of the Witherfall), **the Hearth-Scar**, **the Blight-Halo** (richest Blight where grief was
  strongest), **the Choir-Echo** (the Communion's song, louder toward the Crown), **relic-fragments**.

---

### 20.B References

#### 20.B.1 Creative touchstones (art / narrative / audio — concept bible §6, executed in §15)

- **Games:** *Bloodborne* / *Dark Souls* (gothic decay, weighty combat, the hollowing register),
  *Don't Starve* (light-vs-dark survival dread, silhouette horror — but grimmer and grounded),
  *Sunless Sea* (textual dread, a hostile dark), *Diablo* (oppressive gloom), *Darkwood* (folk-horror
  survival). *(Market comparables — Valheim, V Rising, Enshrouded, etc. — are in §17, not creative
  touchstones.)*
- **Film:** *Annihilation* (the Shimmer = the Blight's seductive, alien beauty/horror), *The VVitch*
  (folk-horror austerity), *Princess Mononoke* (rot-gods, nature corrupted), *The Road* (survival
  bleakness and tenderness).
- **Books:** Gene Wolfe, *The Book of the New Sun* (dying-earth, the Long Dusk register); Jeff VanderMeer,
  *Annihilation* (corruption as transformation); Mark Lawrence (grimdark voice); Cormac McCarthy,
  *The Road* (scarcity, moral weight).
- **Audio direction:** sparse low drones; funeral-folk instrumentation (cello, bowed metal, ritual
  percussion); long silences broken by the dark's "breath." The Communion was *sung*, so the Choir is the
  game's signature timbre and leitmotif (§15.7–§15.8).

#### 20.B.2 Market & business sources (real URLs — preserved from §17.7)

- **Valheim** — 12M (Nov 2023): https://www.gamedeveloper.com/business/-i-valheim-i-has-crafted-12-million-sold-copies · 10M (Apr 2022): https://www.pcgamer.com/valheim-has-sold-over-10-million-copies/ · 17M lifetime + 1.0 Sept 9 2026 + 5-person team + $20: https://www.windowscentral.com/valheims-dev-team-expand-following-games-explosive-success · https://wccftech.com/valheim-1-0-release-date-september-2026/ · peak 501,804 CCU: https://steambase.io/games/valheim/steam-charts
- **V Rising** — 3.9M (Feb 2024): https://gameworldobserver.com/2024/02/02/v-rising-sales-3-9-million-copies-vs-other-survival-games · 5M (Jan 2025) + 6M (late 2025): https://www.gematsu.com/2025/01/v-rising-sales-top-five-million · EA $19.99 → 1.0 $34.99 (May 8 2024, ~2 yr EA): https://blog.stunlock.com/v-rising-early-access-price-last-chance/ · https://www.pcgamesn.com/v-rising/price-increase · peak 150,563 CCU: per tracker.gg / Steambase
- **Don't Starve Together** — ~9.5M / ~$94M gross [EST] + peak 72,629: https://gamerevenuedata.com/games/dont-starve-together/ · price $14.99 / 95% reviews: https://raijin.gg/app/322330/Dont_Starve_Together
- **Conan Exiles** — 1.4–1.5M at 1.0: https://www.gamedeveloper.com/business/-i-conan-exiles-i-tops-1-4m-sales-to-become-best-selling-title-in-funcom-history · Battle Pass / cosmetic Bazaar (Age of Sorcery): https://www.conanexiles.com/blog/battle-pass-and-bazaar-full-overview-in-age-of-sorcery/ · https://massivelyop.com/2022/07/14/conan-exiles-deep-dives-its-planned-battlepass-monetization-system/
- **Project Zomboid** — ~15M [EST] + $20: https://newsletter.gamediscover.co/p/how-project-zomboid-just-kept-selling · https://levvvel.com/project-zomboid-statistics/
- **Enshrouded** — 3M+ (Aug 2024), 1M in 4 days, peak 160,405, $29.99, Keen Games 58 staff: https://gameworldobserver.com/2024/08/09/enshrouded-3-million-players-on-steam-since-january · https://gameworldobserver.com/2024/01/29/enshrouded-hits-1-million-players-steam-keen-games · https://steambase.io/games/enshrouded/price
- **Lies of P** — 4M (Mar 2026), 3M (Jun 2025), $59.99, difficulty options added: https://www.gematsu.com/2026/03/lies-of-p-sales-top-four-million · https://www.videogameschronicle.com/news/lies-of-p-is-getting-difficulty-options-to-make-the-soulslike-more-accessible/
- **Lords of the Fallen** — 2.04M + $66M budget: https://www.tweaktown.com/news/107323/lords-of-the-fallen-breaks-2-million-sales-shortly-before-sequel-announcement/index.html · https://gameworldobserver.com/2023/10/24/lords-of-the-fallen-budget-66-million-most-expensive-ci-games
- **Elden Ring** — 30M+ (Apr 2025), Dark Souls trilogy ~35M: https://www.videogameschronicle.com/news/elden-ring-has-sold-over-30-million-copies-fromsoftware-says/
- **Steam Early Access 2024** — 2,897 EA releases (~14% of releases), 28% of top-grossing new releases were EA, >50% exit EA in <12 mo: https://wnhub.io/news/stores-and-publishing/item-47434 · https://newsletter.gamediscover.co/p/the-state-of-steam-early-access-graduates
- **Indie dev budgets / team / timeline** (8–10 team = $150–500k/yr; 18–24 mo 3D; survival = scope-creep
  risk): https://www.steampageanalyzer.com/blog/indie-game-development-costs · https://vsquad.art/blog/indie-game-budgets-what-it-really-costs-to-build-a-game
- **Soulslike accessibility trend** (Another Crab's Treasure assist mode; late-2025 accessibility rise):
  https://www.inverse.com/gaming/another-crabs-treasure-makes-a-case-for-difficulty-options-in-soulslikes

---

### 20.C Consolidated open-questions register

Every section's "Open Questions" block, collected and prioritized. **P1** = affects the keystone economy
or a near-term gate (resolve by vertical slice / early EA); **P2** = affects EA-window content or
balance; **P3** = content-scope / polish / late-tuning. Cross-listed items are merged into one row.

#### 20.C.1 Resolved during integration (closed — no longer open)

| Item | Was open in | Resolution |
|---|---|---|
| **Co-op ending canon** (unanimity vs leader's choice; are all party members Revenants?) | §2.9, §3.8 | **RESOLVED in §13.8** as the **Rite of the Crown** (Pyre = unanimity via the loose-anchor rule; Crown = individual seizable; Be-consumed = individual; all PCs are Revenants). Endorsed by narrative-world & tech-coop experts. |
| **"The Reach" / "the Witherreach" usage** | §2.9 | Reconciled (§2.4): "the Reach" = realm across time, "the Witherreach" = its rotted present; same basin, no conflict with the bible. Usage verified consistent across all sections. |
| **Stale `§2.11` cross-references** (in §11, §15) | integration finding | **FIXED** mechanically → `§3.6` (environmental-storytelling system) and `§3.5` (side-quest patterns); §2 ends at §2.9. |

#### 20.C.2 Priority 1 — keystone / near-term gate

| # | Item | Owning / routed section(s) | Question | Suggested resolution |
|---|---|---|---|---|
| 1 | **Tempered-gear floor cap** | §5 / §7.11 / §8.10 | 6 tempered pieces at +15 each = +90 `T_floor`, but the archetype math budgets ~+15. Hard cap, highest-N-pieces, or diminishing curve? | Intent already locked with systems experts: gear floor is **capped/diminishing (~+15)**, not a naïve per-slot sum. Pick the exact rule in the EA balance pass. |
| 2 | **Per-node band vs archetype-anchor ratio** | §8.10 / §5 / §9 | Per-node `T_max` band doesn't sum to the locked Pure-Tainted anchor (210) by a naïve sum. | Keep low-edge node tuning so a *focused* allocation lands on the anchor; the anchors are binding. Revisit (soft `T_max` curve vs dedicated ceiling track) in the balance pass. |
| 3 | **Long Dusk clock anchoring** | §16.9 → §6 | Advance the clock on active-playtime only (recommended) vs ever offline? | Architecture supports either; **default active-time only** so a world never rots while no one plays. Design ratifies. |
| 4 | **Game-speed slowdown in co-op** *(cross-team)* | §19.4 / §19.8 ↔ §16.9 ↔ §13 | Game-speed can't apply per-player in a shared authoritative sim. | Ruling: **solo-only, or host/party-vote applying to the whole session** — never per-player. Tech to confirm the implementation at the vertical slice. |
| 5 | **R2 assist invariant — exact scalar floors** | §19.8 → §5 | The 0.5× Taint-gain bottom, `k_p ≥ 0.2` purge floor, and the Marked-threshold clamp on toggle *combinations*. | Confirm exact floors in the EA live-tuning pass; the **rulings are fixed**, only the scalars tune. |

#### 20.C.3 Priority 2 — EA-window content & balance

| # | Item | Owning / routed section(s) | Question | Suggested resolution |
|---|---|---|---|---|
| 6 | **Pyre eligibility for deep-Tainted / high-Hollowing players** | §3.8 / §12.11 → §5 | Can a near-turning player ever take the clean **End it**, or only a corrupted variant? | Set the Hollowing threshold in §5/§12 to keep narrative and systems consistent; lean toward a *harder/corrupted* Pyre rather than a hard lock. |
| 7 | **Multi-death corpse-cache count** | §12.11 / §16.9 → §12 | Default single Souls-style cache (second death forfeits) vs configurable N. | Ship **single-cache default** (sharp stakes); expose N as a world/difficulty setting (tech supports it). |
| 8 | **Co-op corpse-cache ownership** | §13.10 / §12.4 → §13 / §19 | Owner-only retrieval vs party-open? | **Owner-only default** (banked Taint is a private moral stake); party-open as a world/difficulty setting. |
| 9 | **Co-op spawn-budget per-player coefficient** | §13.10 → §10 / §18 | Confirm the ~+60–75%/extra-player sub-linear scaling against the hottest-band TL rule. | Playtest-tune so 4-player groups are hard-but-fair, not trivial or oppressive. |
| 10 | **Separate opt-in Assist Mode (may touch Hollowing)** | §19.8 → §18 | Ship the permadeath-softening Assist Mode at EA launch or add during EA? | **Recommended at launch** (accessibility is table-stakes), pending M2 production load. |
| 11 | **Lightcraft fuel economy seam** | §9.15 → §7 | The exact clean-fuel currency for Lightcraft (hearth-fuel vs a dedicated "light charge"). | A §7 crafting decision; whatever is chosen, Lightcraft must **never acquire a Taint cost**. |
| 12 | **Region count vs the five-tier gate** | §11.9 → §18 | Six regions / five Wardens locked; scope cut to five if needed (candidates R2 or R4)? | Decide at the production scope gate; the continuous-gradient design absorbs a cut cleanly. |
| 13 | **Cross-progression of shared-world unlocks** | §13.10 → §7 / §16 | Do guests carry host-world Reliquary rewards back to their own world? Characters are portable; which world-flags travel? | Spec the persistence seam in §16; default characters-portable, world-flags stay with the world. |
| 14 | **Map persistence in co-op** | §14.14 → §13 / §16 | Is the diegetic hand-map's "seen" state per-player or shared? | Default **per-player exploration memory**; confirm against the character/world save split. |
| 15 | **Save/verify targets** | §16.9 (VERIFY) → §18 | PC min/rec specs, autosave cadence, lag-comp rewind window, server tick rate. | Confirm all by **vertical-slice profiling**, not assumption. |

#### 20.C.4 Priority 3 — content-scope, polish & late tuning

| # | Item | Owning / routed section(s) | Question | Suggested resolution |
|---|---|---|---|---|
| 16 | **Communed Champion epithet** | §10.10 → §3 | The R4 "tragic mirror" Warden's final canon name (working: "the Blooming Penitent"). | Name once, narrative-owned; keep distinct from the R5 **Ashen Penitent**. |
| 17 | **"Save the Turned" rarity** | §3.8 → §12 | Can a turned NPC ever be restored, or only mercy-killed? | Keep any save-path **extremely rare or purely fictional** so it never undercuts the soft-permadeath stake. |
| 18 | **Tide-variant enemy content budget** | §10.10 → §18 | How many per-Tide Wake variants (the difficulty-over-time lever)? | Production-scope call sized in the roadmap. |
| 19 | **Hunter true persistence vs soft re-acquire** | §10.10 → §16 | Server cost of cross-zone Expedition-persistent Hunters. | Profiling call; soft re-acquire if true persistence is too costly. |
| 20 | **Status roster scope** | §9.15 → §18 | Bleed/Frost and other physical sub-statuses — in or out at launch? | Reserved, not core to launch; a content-scope call. |
| 21 | **Blighted-fuel degradation curve** | §7.11 → §6 | Instant vs ramped radius degradation; does it also disable banking/respawn? | Tuning decision; conservatively specced as "radius stops suppressing Taint." |
| 22 | **Cache decay flourish** | §12.11 → §6 / §11 | Should the decaying world ever consume an un-recovered cache? | **Off by default** so a cache is never lost to an invisible timer; optional flag. |
| 23 | **Hearth raid/defense as authored space** | §11.9 → §6 / §10 | Go/no-go on Wake raids against Hearths; trigger on the TL model. | Production go/no-go; if built, the encroachment front is its spatial home. |
| 24 | **Reliquary count per region** | §11.9 → §18 | One signature Reliquary per region, or also secondary minor ones? | Content-scope decision. |
| 25 | **Crucible vs arc HUD form factor** | §14.14 | Vertical crucible vs radial corner arc for the Taint readout. | UI-art-pass A/B; both satisfy the floor-line + band + ceiling requirements. |
| 26 | **Diegetic-off as an explicit mode** | §14.14 → §19 | Ship a curated "HUD-minimal/diegetic-only" mode vs leave it to §19 toggles? | §19 + UX-pass decision. |
| 27 | **Megalights on low-end** *(VERIFY)* | §15.10 → §16 | Does the "many small shadow-casting lights" fantasy survive Series S / Deck? | Profile at the vertical slice; the art read is safe either way (hero-shadows + emissive ambient). |
| 28 | **Decay-state count vs art-production cost** | §15.10 → §18 | Five fully-authored decay dressings per region, or author endpoints and blend the middle? | If scope tightens, author **Lingering / Blooming / Terminal** fully and treat Festering/Withering as blends. |
| 29 | **Licensed vs original Choir vocals** | §15.10 → §18 | The signature Choir leitmotif — composed-original or recorded ensemble? | Audio-production / budget decision. |
| 30 | **Simultaneous-Crown-commit tie-break** | §13.10 / §13.8.5 → §16 | The heuristic when two players commit the Crown at once. | Netcode-design detail (server-stamp vs lowest-latency); the atomic claim already guarantees one winner. |
| 31 | **Budget-band tightening** | §18.6 → finance | The $3–6M band is wide. | Re-baseline at the M1 vertical-slice actuals. |
| 32 | **Netcode vs general-gameplay engineering split** | §18.6 → §16 | Exact 1–2 netcode engineers vs general gameplay, pending root-motion prediction cost. | Confirm at M1. |
| 33 | **Console port start date (M4–M5)** | §18.6 → §17 | Earlier de-risks cert but pulls EA revenue forward into cost. | Pick once EA-Year-1 sales confirm the flywheel funds it. |

> **Integrator's note.** No *unflagged* substantive contradiction was found across the sections. The two
> numeric tensions that touch the keystone economy (items 1–2) are already flagged **consistently** in
> every owning section (§5/§7/§8) with an agreed intent, and deferred to the EA balance pass — they are
> reconciled-in-intent, not contradictory. The co-op game-speed item (item 4) is a properly-coordinated
> cross-team open question (§16↔§19↔§13), not a conflict.
