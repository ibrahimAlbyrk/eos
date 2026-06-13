# 14. UI/UX & Player Feedback

> **Scope.** This section specifies how the player *reads the game* — above all, how the **corruption economy** (§5) is made instantly legible, because that is the single hardest and most important readability problem in WITHERREACH. It covers the diegetic-vs-HUD stance, the keystone corruption readout (the **Taint** meter, the threat bands **Lucid / Marked / Fevered / Brink**, the **Hollowing** pips), the full HUD layout, combat feedback, map and compass in the dark, inventory, and the **Hearth** transaction interface (bank / purge / temper / ascend). It owns *presentation and feedback*. It does **not** own the systems it displays: the Taint/Hollowing/Blight economy and its numbers (§5), survival rates (§6), Hearths and gear (§7), ascension (§8), combat math (§9), the Wake (§10), the death model (§12), or co-op mechanics (§13). **Fine accessibility options (colorblind modes, scalable text, input remapping, difficulty assists) are owned by §19** — this section states only the load-bearing readability principles that §19 must not be allowed to be the *only* line of defense for. Glossary terms (concept bible §14) are used verbatim. Illustrative values are marked **(illustrative — to tune)**.

---

## 14.1 UX pillars & the keystone readability problem

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

## 14.2 The diegetic-vs-HUD stance

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

## 14.3 The corruption readout — the keystone HUD

This is the most important UI element in the game. It must show, in one fixed, glanceable cluster: **current Taint, the build floor it can never drop below, the carry ceiling, and which of the four threat bands the player is in** — all auto-scaling to any build (because the bands key on the fraction `f = Taint / T_max`, §5.2, so a Pure Tainted build at floor *rests* in a high band, and the UI must show that as the build's normal resting state, not an alarm).

### 14.3.1 The Taint arc (the design)

The Taint readout is a **vertical crucible/arc** (a contained vessel of soul-light, diegetically the Taint held in the Revenant), placed in a fixed corner anchor (§14.6). It is a **single small shader-driven widget** (tech-confirmed cheap, §14.13) rendering:

- **Fill = current Taint**, from `0` at the base to `T_max` at the top. The fill is the Blight's spectral soul-glow, rising in luminosity/saturation with the band (§15).
- **The floor line (`T_floor`)** — a hard, distinct etched line on the crucible marking the build's irreducible minimum. **The fill never drops below it.** This line is the single most important teaching element of the build = survival-difficulty model (§5.6): the player *sees* that their floor sits a quarter-to-half up the vessel on a Tainted build, so they *rest* in a danger band by design.
- **The band thresholds** — three subtle tick marks at `f = 0.35 / 0.60 / 0.85` dividing the crucible into the four bands, each band shaded with its color *and* a distinct edge texture/pattern (so the band is read by region shape, not color alone).
- **The ceiling (`T_max`)** — the rim of the crucible; the closer the fill is to the rim, the closer to overflow.

### 14.3.2 The four threat bands

The bands are the survival readout. Each has a locked **identity across color + position + texture + the body/world FX it triggers** so it reads redundantly. Penalties are owned by §5.2; here is the *presentation*:

| Band | `f` | HUD treatment | Body/world FX (diegetic) |
|---|---|---|---|
| **Lucid** | 0.00–0.35 | Crucible calm, low glow; HUD at rest. | Faint corruption-glow; clean screen. |
| **Marked** | 0.35–0.60 | Fill crosses the first tick; arc brightens; first subtle alert on entry. | First cosmetic mutation; glow strengthens; spoilage begins (inventory readout, §14.9). |
| **Fevered** | 0.60–0.85 | Fill in the upper band; arc pulses slowly; **festering icon** appears near the health readout. | Screen-rot creep + chromatic edge begins (combined post-process, §14.4); audio corruption; the Wake press in. |
| **Brink** | 0.85–1.00 | Crucible near-full, hard-telegraphed; **turning-risk** banner; Hollowing-accrual indicator ticks. | Full Brink telegraph — vignette, heartbeat pulse, loud whispers (§14.4); maximum Wake hunt-pressure; co-op party warned (§14.11). |

### 14.3.3 Spend & gain feedback

Because Taint is *both* mana and danger, the player must feel every transaction:

- **Casting / weapon-arts / the Ultimate (spends, §5.4):** the crucible fill **drops visibly and immediately** with each cast, accompanied by an exhale-of-soul-light VFX off the Revenant — the player *sees their danger drop as they fight* (the in-field release valve, §5.8). The fill animates down to, and **stops hard at, the floor line** — teaching the floor-cap viscerally (a Tainted build watches its casts bottom out above the floor and cannot get safe in the field, §5.4).
- **Ambient gain (the dark, blighted food, §5.3):** the fill **creeps up**, faster in the dark (the ×5 rate is *felt* as a visibly quicker climb), with the corruption-glow brightening in step.
- **Overflow warning (§5.2):** as the fill nears the ceiling, the rim flares and a distinct **overflow-imminent** cue fires — any gain past `T_max` spills to Hollowing (a permanent cost), so this warning must be unmissable *before* the spill, not after.

This element is a small custom-material widget — well within the HUD GPU budget (§14.13).

---

## 14.4 Threat-band escalation feedback (the corruption post-process)

The whole-screen escalation that sells *Fevered* and *Brink* is delivered as **one combined post-process material** (vignette + chromatic aberration + screen-rot creep in a single shader pass), **escalation-gated** so it is near-zero cost at low Taint and reaches full strength only at the top bands (tech-confirmed; do **not** spec an always-on multi-pass stack — §14.13). The design is also the cheap path: the heaviest effect only exists when the player is actually in danger.

| Band | Screen treatment | Audio treatment |
|---|---|---|
| **Lucid** | None — clean frame. | Calm ambient; the dark quiet. |
| **Marked** | A barely-there warm-cold tension at the frame edge. | First whispers thread in. |
| **Fevered** | Screen-rot *creeps inward* from the edges; light chromatic fringe; desaturation toward the Blight palette. | Audio corruption; the breath deepens; festering "wet" cues on hits. |
| **Brink** | Full vignette closing in; a **heartbeat pulse** (specced as an animated vignette + chromatic-aberration scale, **not** a true full-screen blur, so it stays cheap on Series S / Steam Deck — §14.13); the world reads as actively claiming the player. | Whispers swell to near-words and turn *directed*; the breath becomes a near-inhale; a low choral pressure. |

**Counterplay readability:** the moment the player drops out of Brink (an Ultimate, a purge, fleeing to light), the post-process **recedes immediately** — so the player learns that *they* control the screen-state by controlling their Taint. The interface's intensity is a closed feedback loop with the corruption economy.

---

## 14.5 The Hollowing pips — the permanent track

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

## 14.6 Full HUD layout

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

## 14.7 Combat feedback

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

## 14.8 Map & compass in the darkness

There is **no omniscient minimap.** Wayfinding is built around the core constraint that **the dark is the fog-of-war** (§11.5).

- **The diegetic hand-map.** A summoned (not persistent) map is a **hand-drawn chart that fills in only what the player has lit and seen** — a literal record of the Revenant's own exploration, with the dark left blank. Reclaimed regions (rolled-back decay, §11.7) redraw clearer; encroached regions (§11.6) corrupt and blur on the chart. The map is never a satellite view; it is a memory.
- **Markers, not waypoints-everywhere.** The map shows the **Hearth network** (the safe graph, §11.8) — Hearths as pale-gold points, Greater Hearths as small false-dawns — plus the current objective and discovered Reliquaries. It does **not** mark resource nodes or enemies; those are found by exploring the dark (§11.5).
- **The compass ribbon = a deathlight needle.** The persistent-on-demand compass is diegetically the carried ember leaning toward kindled light: it points reliably to **Hearths/Greater Hearths and the current objective**, and toward the basin's heart (down-valley) as a constant orientation. It does *not* point at loot. In deep regions where the rot lies (R4 Blooming, §11.3.5), the needle's reliability is itself a tether against the disorienting glow.
- **Audio wayfinding is part of navigation, not the map.** The **dark's breath** (danger/Taint direction) and the **Choir-Echo** (louder toward the Crown / near Choristers) are directional diegetic cues the player learns to navigate by (§11.5, §15) — the UI does not duplicate them as HUD arrows.

---

## 14.9 Inventory & gear

The inventory serves the corruption economy first: it must make the **clean-vs-blighted** two-track supply (§6/§7) and the **gear = floor** trade (§5.6/§8) immediately legible.

- **Clean vs blighted tagging.** Every consumable, resource, and gear piece is tagged by track — **clean** (warm pale-gold iconography; the *safety* resource: purge fuel, light fuel, clean food, Cleansing materials) vs **blighted** (cold iridescent; the *power* resource: tempering, render-to-Taint, blighted food). The player sorts strategy by color *and* a distinct icon frame (redundant — §14.12).
- **Render decision surfaced.** Raw Blight resources carry no Taint until rendered (§5.1); the inventory shows **render → Taint** as an explicit, player-elected action with its Taint cost previewed, so the player chooses *when* to take on the danger (never an accidental gain).
- **Spoilage readout tied to the band.** Carried food/supplies spoil faster at higher Taint bands (×1.5 Marked, ×2.5 Fevered — §5.2/§6). Each perishable shows a freshness state that visibly *accelerates* when the player is in a danger band — coupling "carrying power" to "your supplies rot" in the inventory itself.
- **Gear shows its floor impact.** Equipping or tempering a piece previews its **`T_floor` change** (§5.6/§8) — the player sees, before committing, that the stronger tempered piece *raises their resting danger*. The two upgrade rails (clean reinforcement = no floor change / Blight-tempering = +floor, §8) are shown as the explicit power-for-difficulty trade. **There is no "strong + safe" gear**, and the UI must never imply one (§5.6).
- **Weight / equip-load** reads as a roll-tier indicator (fast/normal/fat, §9), not a raw number, keeping the Soulslike feel.

---

## 14.10 The Hearth interface — bank / purge / temper / ascend

The Hearth is where the **session-climax decision** happens (§5.5) — the second keystone UI after the corruption readout. At the Hearth, the player's carried Taint (`T_end`) has **three competing claimants for the same banked Taint: purge, temper, ascend** (§5.5, §8). The interface's entire job is to make that trade's *consequences* legible *before* the player commits.

### 14.10.1 The transaction screen

A single calm screen (the Hearth is the safe place — the HUD escalation drops away, the post-process clears, the breath quiets) presenting the carried `T_end` and the three claimants, each with a **forward preview**:

| Action | What it does (§5/§7/§8) | The preview the UI must show |
|---|---|---|
| **Bank (hold)** | Keep `T_end` into the next Expedition. | **Next-run resting band preview** — "you will start in *Fevered*"; the projected hunt-pressure, spoilage, and overflow-risk of starting hot. Power potential preserved. |
| **Purge** | Drive Taint down to `T_floor` for clean fuel + materials. | The **purge cost** (climbs with Hollowing, §5.4) and the forfeited power ("61 Taint of potential lost"). Safe next run. |
| **Temper gear** | Raise a piece's tier for Taint + Blight materials. | The stat gain **and the `T_floor` increase** (power buys difficulty, §5.6/§8) — shown on the crucible as the floor line *rising*. |
| **Ascend a node** | Buy permanent build power for Taint (+ node materials). | The node effect (§8) **and** its floor/ceiling change: Tainted nodes raise the floor line *and* the ceiling; Warded nodes *lower* the floor and raise purge efficiency. Shown live on the crucible. |

**Design intent:** the crucible from the HUD (§14.3) is the live model in this screen — the player drags their `T_end` between claimants and *watches the floor line and the resting band move* before confirming. The irreducible choice (§5.5 — none is correct) is made by showing the real trade, not by hiding it. After investing, the remainder can be purged in the same flow.

### 14.10.2 The Greater Hearth additions

A **Greater Hearth** (§7) adds two extraordinary actions to the interface:

- **The Cleansing rite** — the *only* Hollowing reducer (−1 pip), rate-limited (≤ once per Tide per Greater Hearth, §5.7). Surfaced as a rare, gated, visibly momentous action: it costs a large clean-resource sum and **un-fills a Hollowing pip** (§14.5). The UI makes its rarity and cost unmistakable so the player treats it as the lifeline it is.
- **Region reclaim status** — the Greater Hearth's fuel level and the **decay state it is pinning** (§11.7), with a warning if fuel is lapsing (let it go dark and the held rot floods back). This ties the session-climax screen to the macro map-as-a-tide.

### 14.10.3 Fuel & maintenance readout

Because a Hearth must be **fueled** to keep its safe radius (§6/§7), the interface shows fuel as the standing cost of safety — and surfaces the desperate stopgap of **blighted fuel** (keeps the flame lit but degrades the Hearth so its radius stops suppressing Taint, §6) as a clearly-marked dangerous option, never a neutral one.

---

## 14.11 Co-op UI

Co-op (§13) layers a party readout onto the same diegetic-first stance, focused on the corruption economy's shared stakes.

- **Party corruption at a glance.** Each ally shows a compact **band + Hollowing-stage** readout (not a full crucible) — so the party can see who is running hot, who is near the Brink, and who can afford to spend. Role structure (Warded anchor / Tainted strikers) falls out of these readouts (§13/§5).
- **The downed & Blight-transfer prompt.** A downed ally (§12/§13) shows a **revive window** timer and a **Blight-transfer** prompt to nearby allies: reviving costs the reviver **~30 Taint, transferred to the revived** (§5/§13) — the UI shows *both* meters changing, so the sacrifice (you spend your corruption to save them; they come up carrying it) is legible on both sides. A predicted channel-start gives the reviver instant feedback (§16).
- **The turning warning.** When any party member reaches Hollowing pip 9 (Brink of Turning, §14.5), **the whole party is explicitly warned** — turning a co-op ally into a hostile Wake-elite (§10/§12/§13) is a shared catastrophe and must never surprise the group.
- **Shared Hearth ledger.** The Hearth interface (§14.10) shows the **shared Hearth** state and **per-character bank ledger** (banked Taint, caches, and Cleansing-rite cooldowns are per-player; the Hearth/fuel/decay-rollback are shared — §13/§16), so no player is confused about what's theirs vs the world's.

---

## 14.12 Accessibility — the load-bearing floor (fine detail deferred to §19)

**Full accessibility options are owned by §19** (colorblind palettes, text scaling, input remapping, audio/visual assist toggles, difficulty assists). This section locks only the **readability floor** that the rest of the UI is built on, so that §19's options are *enhancements*, never the *only* thing standing between a player and an unreadable corruption state:

- **No critical state depends on color alone.** Threat bands, clean-vs-blighted tagging, the damage-type triangle, and friend-vs-foe are each carried by **≥2 of {shape, position, motion, audio, world-state}** (§14.1). The diegetic-first stance is itself an accessibility asset — corruption is shown through the deathlight's brightness, the screen post-process, body marks, the dark's breath, and Wake density, not a single colored bar.
- **The four channels are independently sufficient-ish.** A player relying primarily on audio (the breath, whispers, the song, hit cues) or primarily on the body/world (glow, deathlight dimming, mutations) can still read their corruption state; the HUD makes it precise, it is not a single point of failure.

These are requirements on §14's design; §19 owns the tunable options that extend them.

---

## 14.13 UI/UX performance constraints (confirmed with tech)

Budgeted to **Xbox Series S (10GB) / Steam Deck at 60fps** (§16). Confirmed with the tech-coop expert:

- **HUD GPU budget:** keep total HUD under **~0.5–1ms** of the 16.6ms frame. The minimal diegetic plan fits comfortably. The killer is **overdraw**, not draw calls — **no full-screen translucent stacks**; keep translucency to small regions; wrap static HUD elements in **UMG Invalidation Panels** so they don't repaint every frame. The shader-driven Taint crucible is a **small** custom-material widget = negligible; **never** a full-screen material widget or a full-screen Retainer Box.
- **The corruption post-process (§14.4):** spec as **one combined post-process material** (vignette + chromatic aberration + screen-rot in a single pass), **escalation-gated** (near-zero at low Taint, full only at Fevered/Brink) — budget ~**1–1.5ms** on Series S. The **Brink heartbeat** must be an animated vignette + chromatic-aberration scale, **not** a true full-screen blur (the priciest element on Deck); a lighter Brink variant ships on Deck. Quality-scale on low-end.
- **The corruption-glow on the character** is a mesh/material effect (cheap), not HUD — it carries readability load off the framebuffer.

The design and the budget align: the heaviest feedback only exists when the player is in real danger.

---

## 14.14 Open Questions

- **Crucible vs arc form factor.** The corruption readout is specced as a vertical crucible (§14.3.1); the alternative (a radial arc around a corner) is a visual-design A/B for the art/UX pass — both satisfy the floor-line + band + ceiling requirements. Flagged for the UI art pass, not a systems decision.
- **Map persistence in co-op.** Whether the diegetic hand-map's "seen" state is per-player or shared in co-op (§14.8) interacts with the character/world save split (§16) — routed to §13/§16 for confirmation; default assumption is per-player exploration memory.
- **Diegetic-off as an explicit mode.** §14.2 claims the world/body are sufficient to survive HUD-off; whether to ship a curated "HUD-minimal/diegetic-only" mode (vs leaving it to §19's toggles) is a §19 + UX-pass decision.
