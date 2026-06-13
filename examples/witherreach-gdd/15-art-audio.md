# 15. Art Direction & Audio

> **Scope.** This section is the visual and sonic execution spec for WITHERREACH: the art pillars, the master palette/lighting axis, light-vs-dark rendering, the five **decay states** visualized, the character/creature visual language (the **Revenant**, the **Wake**, the **Wardens**, the **Hollow Crown**, the factions), environment art, and the audio direction (drones, funeral-folk instrumentation, the dark's "breath," and adaptive music tied to **Tides** and threat band). It executes the fiction of §2 and the tone of concept bible §6; it dresses the systems owned elsewhere (corruption §5, survival/light §6, Hearths §7, combat §9, the Wake/Wardens §10, world/regions §11) and renders the readouts specified in §14. Engine, rendering tech, and performance budgets are owned by §16 — referenced here, not re-decided. The visual & audio **canon** below was locked with the narrative-world expert (their brief §14) and is binding. Glossary terms (concept bible §14) are used verbatim. Illustrative values are marked **(illustrative — to tune)**.

---

## 15.1 Art pillars

The bible's tone (concept bible §6) is **oppressive, melancholic, and beautiful-in-decay — folk-horror crossed with funereal grandeur; grimdark, not nihilistic.** Five pillars execute it:

1. **Beautiful-in-decay.** The rot is *seductive*, not merely gross. The deepest corruption is the most gorgeous (the *Annihilation* "Shimmer" register, §2.8) — so the world tempts the player toward the very thing killing it. Horror carries awe; awe carries pity.
2. **Funereal grandeur.** Everything is a monument to an interrupted death (§3.6). Scale is solemn and liturgical — ruined cathedrals, cremation-forests, drowned capitals. The world mourns at the scale of a civilization.
3. **Folk-horror austerity.** Against the grandeur, an intimate, grounded, human texture — the *The VVitch* / *The Road* register (concept bible §6): worn cloth, hand-tools, burial rites, small mercies. The dread is domestic before it is cosmic.
4. **The dark costs the light.** "Earn the Light" (pillar 4) is an *art* pillar: light is precious because it is scarce and salvaged. Every gold pool of Hearth-light is a held breath against an overwhelming dark.
5. **Melancholic awe / hope as a verb.** Never despair as a flat fact — despair as a *price* (§2.8). The art finds the fragile-beautiful in the bleak so that pushing the dark back, even briefly, lands as earned.

**Reference touchstones (concept bible §6):** Bloodborne / Dark Souls (gothic decay, weighty silhouettes, the hollowing register), Don't Starve (light-vs-dark survival dread, silhouette horror — but grimmer, grounded, 3D), *Annihilation* (the Shimmer — corruption as seductive alien beauty), *Princess Mononoke* (rot-gods, nature corrupted, the dignity of the dying world), *The Road* (scarcity, tenderness, bleak palette), *The VVitch* (folk-horror austerity).

---

## 15.2 The master palette & lighting axis (THE rule)

Every space, faction, meter, creature, and ending reads on **one opposed two-pole axis** (locked canon):

> **Warm pale-gold = release.** The sun, the door, the **Hearth**, the **deathlight**, the **Warded**, mercy. The light that lets souls *pass*.
>
> **Cold iridescent spectral = capture.** The **Blight**, the web, the trapped souls, the **Tainted**. The light that *holds* souls in.

This is not a mood board — it is a *legibility system*. Because the whole game reads on this single axis, the player parses safety/danger, Warded/Tainted, mercy/mastery, and life/un-death from color-temperature and light-quality alone, everywhere. The two poles are kept distinct in **temperature *and* quality**: gold is warm, low, tired, *passing*; iridescent is cold, glowing, restless, *clinging*. The heart of the basin (R6, §11.3.7) is where the two poles **collide** — the dramatic and chromatic climax of the entire palette.

> **Critical correction (canon):** the Blight's iridescence is **spectral soul-glow** — ghostlight, will-o'-wisp, funereal — **not** chemical or radioactive. It is leaking trapped souls. Keep it *haunting*, never sci-fi-toxic.

---

## 15.3 Light-vs-dark rendering

Light is the game's central art-and-gameplay resource (§6, §11.5). The rendering of light and dark is therefore a load-bearing system, not a lighting pass.

### 15.3.1 The deathlight hierarchy

All "safe" light in the world is **salvaged sun** — a fragment of the guttered, *waning* late sun (§2.2.3), rendered as **pale gold → bone-white, low and tired, never campfire-orange** (it is the door-light, not fire). It comes in a strict hierarchy the player reads as a safety scale:

| Light source | Read | Rendering |
|---|---|---|
| **The carried deathlight** (the Revenant's ember) | Personal, fragile safety; a navigation budget (§11.5). | Faint, guttering pale-gold; small radius. **Dims as the player Hollows** (the diegetic Hollowing telegraph, §14.2). |
| **The Hearth** | A held safe haven (Taint-gain 0, §6). | A steady pale-gold *pool*; the calm centre of a space. |
| **The Greater Hearth** | Region-scale reclaim (§11.7). | A **small false dawn** over a region — the closest thing to a sunrise the world still has. The reclaim-wave source (§15.3.3). |

### 15.3.2 The dark as a presence

The unlit dark is **not the absence of light — it is the presence of the un-suppressed web** (§2.2, §15.7). It is rendered and *scored* as an active thing: a thick, fog-bound, soul-pressured dark that **breathes** (§15.7). Visually, the dark is where the Blight's spectral glow is unmasked — eyes and rot-light hang in it (§15.5.2). This is the survival-horror core of the art: stepping past your light is stepping into something *occupied*.

### 15.3.3 The reclaim light-wave (and the encroachment inverse)

The single most cathartic art beat is the **Greater Hearth reclaim** (§11.7), authored exactly as tech confirms is both cheap and dramatically correct (§16):

- **Cross-fade the cheap channels:** a wave of pale-gold light, clearing fog, and *healing* material sweeps the region in real time — a single region `decayBlend` scalar (Material Parameter Collection) lerps fog density, light color/intensity, exposure, and material params over a few seconds. This **is** the visible reclaim wave: the light physically pushing the dark back.
- **Hard-swap the geometry behind the front:** prop/spawn/navmesh changes pop in **out-of-view, behind the advancing light front**, with only a few **hero props** near the player dither-fading during the blend window. Cross-fading full mesh sets is forbidden (it doubles geometry cost — §16).
- **Encroachment (§11.6) is the same system in reverse:** the Tide advances the scalar the other way — gold drains, fog thickens, material rots, the dark reclaims the front. The map is a literal tug-of-war over one scalar, rendered as a moving light line.

### 15.3.4 Rendering approach (per §16)

The "rotting-gorgeous at indie-mid headcount" pillar rides **UE5 Nanite + Lumen + the Fab/Quixel pipeline** (§16). Light discipline is **mandatory, not optional** (Series S is on *software* Lumen). The binding rule, confirmed with tech:

- **Shadow-casting is a hero-light privilege.** The Hearth and the player's carried light cast **real dynamic shadows** — that is what sells "safety has a shape." Budget **single-digit shadow-casters in view** on Series S.
- **All ambient small lights are emissive/non-shadowed** and effectively unlimited and near-free: the Wake's eyes, distant lantern-glows, Hearth embers, the Blight's soul-glow — all emissive material + bloom. The "many small lights in the dark" fantasy is fully deliverable as glows.
- **Megalights** (hundreds of shadow-casters at ~fixed cost) is a later opt-in **[VERIFY on Series S/Deck]** (§16) — do **not** hard-promise dozens of shadow-casters until profiled. The hero-light spec degrades gracefully with zero change to the art read if Megalights underperforms.

---

## 15.4 The five decay states visualized (the keystone art table)

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

## 15.5 Character & creature visual language

### 15.5.1 The Revenant (the player)

The player is a **threshold-soul** carrying the **deathlight** (§2.2.5) — *the world's aborted death, walking.* Visual language:

- **The carried ember.** The Revenant always carries the deathlight (§15.3.1) — the one warm thing on them, and a live readout: it **dims as they Hollow** (§14.2).
- **Build = corruption identity, made visible** (pillar 3). The body is the build. **Warded** progression keeps the Revenant *human* — armor, cloth, ash, warm-gold trim, intact silhouette. **Tainted** progression visibly **warps** them — mutations (claws, carapace, blightveins glowing with carried Taint), cold-iridescent glow, a silhouette drifting toward the Wake (§8 mutations). A glance at another player in co-op reads their path.
- **The corruption-glow** (the §14 diegetic Taint readout) rises on the body from faint (Lucid) to bright/veined/mutating (Brink) in the Blight palette — a mesh/material effect (cheap, §15.3.4 / §14.13).
- **The Hollowing marks (5 stages, §2.2.5/§5.7),** authored to the track: **Marking** (ash-veins, dimming eyes), **Souring** (the glow turns the body's iconography Tainted), **Pull** (twitches, vision-corruption, the body fighting itself), **Brink** (full telegraph — the player half-claimed by the web), **Turning** (the set-piece). The Revenant's whole appearance is a slow, legible slide toward becoming a Wake.

### 15.5.2 The Wake

The Wake is **grief made predatory** (§2.6.3) — not evil, *trapped people clawing to re-clothe themselves in flesh.* The art rule: **their form records what they were in life; their behavior is pure reclamation-hunger; dread must carry pity** (§2.8). Shared signature: **cold-spectral soul-glow at the core, eyes-in-the-dark** (emissive, non-shadowed — §15.3.4). The six tiers (§10) read as distinct silhouettes:

| Tier (§10) | Visual identity |
|---|---|
| **Husks** | The ordinary dead, minds long gone; recognizable human remnants — the funereal mass. Dread of *numbers*, pity of *recognition*. |
| **Gloamhounds & Mourncrows** | The bound beasts (animals had souls too); swift, sharpened, predatory silhouettes — ground-hounds and carrion-birds, the rot wearing an animal. |
| **The Gravemade & the Swollen** | The most Blight-saturated dead — bloated, calcified, armored in fused grave-goods and hardened rot; the **Swollen** rupture into rot-gas (a readable death-tell, §10). |
| **The Choristers / Keening Choir** | Dissolved Choir-singers still *singing the rite* — liturgical remnants, mouths open in the unending song; the Choir-Echo localizes to them (§15.7). |
| **The Famished** | Elite hunters — the web's antibodies, sharpened by hunger; lean, fast, *fixated*; dispatched at high Taint, they read as **personally hunting you** (§10). |
| **The Turned** | Build-derived named elites wearing a former Revenant's/NPC's face and skills (§10/§12) — the most personal horror; a turned ally is a hostile elite in your friend's silhouette. |

### 15.5.3 The Wardens

Locked canon: **a shared signature *and* two distinct classes.**

- **Shared signature:** every Warden is grown around a **blazing core of concentrated trapped-soul-light** — the apex node of corruption, and the combat weak-point (§10; e.g. the Ashen Penitent's clean/light-only core). This is the unifying motif marking a Warden as a biome's apex corruption.
- **Beast-Wardens** (the **Mire-Stag**, the **Cinder-Alpha**) — the Blight wearing a **mutated animal**: nature corrupted, *no human regalia*, the *Princess Mononoke* rot-god register. Read as "this is the rot."
- **Named Crowned-Circle Wardens** (the **Ashen Penitent**, the **Famished King**) — the Blight wearing a **person who *chose* this**: retain human/regal/ceremonial iconography — **Communion vestments, the Choir's regalia, feast/funeral trappings** — fused into monuments to their choice. Read as "someone *did* the rot." The player should distinguish the two classes at a glance.
- **Named-tier sub-motif:** fragments of the **sun-regalia / the Crown** mark the named Wardens as "of the Crown" — a visual through-line from the rim's beast-Wardens to the Hollow Crown itself.

### 15.5.4 The Hollow Crown & the Sunhold (R6, Terminal)

Locked canon for the endgame's look (§2.7, §11.3.7):

- **"Where the sun guttered into the earth"** = a sunken caldera-floor where the dead sun is **buried**, leaking a **sick parody of dawnlight *upward from below the ground*** — a false sunrise from a grave, corrupted by the soul-pressure pooled there. This inverts every prior light cue (light has always come from above/around; here it bleeds up from the dead).
- **The throne-city is fused into one rot-organism** — *the city is a body* (§11.3.7).
- **Sovereign Vael / the Hollow Crown** reads **not as a standing boss but as the load-bearing keystone of the whole web** — a withered king grown into the throne and the buried sun, **threads of soul-light running *out* of him into the world.** He speaks in the Choir's massed voice — many faces and voices straining at the surface of one still figure.
- **The Crown** itself = the sun-king's regalia, **hollow/empty**, a circlet of the guttered sun gone **cold-grey** — the literal **broken door** (Master-it = donning the broken door; the Pyre = *becoming* the door it failed to be — §3.4).
- **Palette:** the two poles **collide** — blinding cold-spectral soul-glow shot through with the buried sun's corrupted false-gold. The chromatic climax of the master axis (§15.2).

### 15.5.5 The factions

- **The Ashen Wardens** (Warded — §2.6.1): warm pale-gold, ash, cloth, hand-tools, burial iconography; **human** above all. Their holdfast **Ashfast** and their Hearths are the warmest, most legible spaces in the game — islands of the human against the dark.
- **The Communed / the Hollowing** (Tainted — §2.6.2): cold-iridescent, transfigured, beautiful-grotesque; mutation worn as *transfiguration* ("becoming what comes after"). Folk-horror cult austerity (§15.1). Their **Black Hearth** is the anti-Hearth — a sink run in reverse, glowing cold and *feeding* on offered Taint (§7); render it as the dark mirror of a Hearth's gold pool: an iridescent maw where the Warded have a warm hearth.

---

## 15.6 Environment art & storytelling

The environment carries the story (§3.6). Three authored patterns are art-production set-pieces:

- **The Tableau of the Last Moment.** Every ruin freezes the instant of the **Witherfall** — a family mid-meal, a market mid-trade, a deathbed where no one died (§3.6). Because nothing could die, the world is a museum of an interrupted death. These are hand-authored hero-tableaux, densest in Lingering/Festering space where the human forms still read.
- **The Hearth-Scar.** A dead Hearth and the bodies around it — a survivor story told in objects (who held here, what they ran out of, who they failed to save). Relighting it re-illuminates a lost story and reclaims the ground — the micro version of the reclaim-wave (§15.3.3).
- **The Blight-Halo.** The worst, richest, most beautiful corruption pools where grief was strongest (a Communed bound a dead child to the land here, §3.6). The most luminous Blooming set-dress sits at these emotionally-legible nodes — high reward = deep grief, rendered as the most gorgeous and most dangerous art in the space.

**Region architecture** follows §11.3 (cold heath farmsteads → burning cremation-forest → drowned chapels → Shimmer-coral → ash-cathedral → the body-city), each at its decay-state range (§15.4). **Nanite** carries the geometric density of fused, rotted, detail-rich decay (§16); the decay-state dressing system (§15.4) keeps it all data-driven over shared blockout.

---

## 15.7 Audio direction

Audio is **load-bearing fiction**, not ambience — the Communion was **sung** (§2.2.1), so sound *is* the rite, and the dark *is* an audible presence. The soundscape executes concept bible §6: **sparse low drones, funeral-folk instrumentation (cello, bowed metal, ritual percussion), long silences broken by the dark's "breath."**

### 15.7.1 The two diegetic audio entities (locked canon)

Two distinct diegetic sound-beings, not mere atmosphere:

1. **The Breath** — *everywhere in the dark.* The unlit dark is un-suppressed soul-pressure (§15.3.2), so it **audibly breathes**: a vast, slow inhale/exhale of the web — millions of held dead straining — under **whispers** (individual trapped voices). Its intensity **scales with darkness *and* the player's Taint** (high Taint = the web recognizing you) — a **readable diegetic Taint/dark telegraph** (§14.2). As the Revenant Hollows, the whispers resolve from **ambient → directed** (Stage 3, "the Pull," §5.7) — the dead begin speaking *to* the player. The Breath is the survival-horror spine of the soundscape.
2. **The Song (the Choir-Echo)** — the structured *song of the Communion itself*, localized to **Choristers** and **loudest near the Crown** (§3.6, §11.3.4). Where the Breath is the unstructured ambient web, the Song is the *rite* — the machinery of the Witherfall, heard before it is understood. It is a wayfinding instrument (§11.5) and the lore's audible thread, building toward R6 where it becomes the climax soundscape.

### 15.7.2 The palette of instruments & textures

- **Drones:** sparse, low, sub-bass — the world's held breath under everything. Long silences are *composed*, not empty.
- **Funeral-folk:** **cello** (the human, mournful voice), **bowed metal** (the wrong, the corrupted), **ritual percussion** (the rite, the heartbeat of the dead). Grounded, austere, hand-played (folk-horror, §15.1) — never orchestral bombast.
- **The Choir:** human voices — the Choristers' unending rite — are the game's signature timbre, from a single broken voice in the marsh to the massed voice of the Hollow Crown (§15.5.4). The Choir is the **leitmotif of the whole game** (§15.8).
- **The deathlight & Hearth:** a warm, low, *tired* hum — the salvaged sun's quiet — that suppresses the Breath inside its radius (light silences the dark, the audio inverse of §6's Taint-suppression). A Greater Hearth's kindling is a swell of that hum into something near a dawn-chord (the reclaim cue, §15.8).
- **Combat:** weighty, Soulslike — impactful hitstop, the wet foley of festering, the distinct "burn" of light/cleansing vs the shrug of rot-on-rot (the damage-triangle made audible, §14.7). Rot-magic casts exhale soul-light with a tonal *release* (the in-field Taint-vent, §14.3.3).

### 15.7.3 Spatial & diegetic discipline

The Breath, the Song, the Hearth-hum, the Wake's vocalizations, and the deathlight are **spatialized diegetic sources** the player navigates by (§11.5) — the UI does not duplicate them as HUD cues (§14.8). Audio is a primary readability channel and an accessibility asset (§14.12): a player can read corruption, danger, and direction substantially by ear.

---

## 15.8 Adaptive music

The score is **tied to the two clocks the player lives under: the Long Dusk Tide (macro) and the threat band (moment-to-moment)** — so the music is, like everything else, a readout of the corruption economy.

- **Tide-deepening (macro, §6/§11.6).** Each **Tide** the score sinks deeper: the drones lower, the Choir grows, the funeral-folk thins toward bleakness. The world *sounds* like it is dying faster as the Long Dusk deepens — the audible face of "standing still loses ground" (pillar 2). ~5–6 Tides of escalation across a playthrough (§6).
- **Threat-band layering (moment-to-moment, §5.2/§14.4).** The music layers up with the Taint band: **Lucid** (sparse drone, near-silence) → **Marked** (a tension enters) → **Fevered** (the Breath bleeds into the score, rhythm tightens) → **Brink** (the Choir swells, a heartbeat under everything — synced to the §14.4 visual pulse). Casting/purging out of a band drops the layers back — the player *hears* themselves regain control.
- **The Hearth respite.** Entering a Hearth's radius resolves the score to the warm deathlight-hum and a moment of human quiet — the held breath, the earned rest (pillar 4). The single recurring "safe" theme; its scarcity is what makes it land.
- **The reclaim cue.** Kindling a Greater Hearth (§11.7/§15.3.3) triggers the score's one moment of something like *hope* — the deathlight-hum swelling into a dawn-chord as the light-wave sweeps the region. The closest the game comes to a major key, and deliberately fragile (it can be lost again — §11.7).
- **Warden music.** Multi-phase, economy-hooked (§10): each Warden's theme carries its corruption-hook (the Drowned Choir floods the mix with the Song; the Famished King's theme *hungers*); the named Crowned-Circle Wardens' themes carry human/liturgical motifs (they *chose* this — §15.5.3), the beast-Wardens' do not.
- **The Choir as the through-line.** The Communion's Song is the game's core motif — introduced as a haunting fragment in R3, recurring in every Chorister, and resolving into the massed voice of the Hollow Crown at R6 (§15.5.4). The endings are scored as the three fates of that Song: **End it** (the Song finally *resolves and ceases* — the long-delayed final cadence), **Master it** (the Song re-stabilizes around a new anchor — it continues, now the player's), **Be consumed** (the player's own voice joins the Song — they become part of the rite). The whole score is a single piece of music waiting generations to end.

---

## 15.9 Production & tech notes (per §16)

- **Engine/pipeline:** UE5 Nanite + Lumen + Megalights + Fab/Quixel (§16) deliver "rotting-gorgeous" at indie-mid headcount — *with* mandatory light/scalability discipline (Series S is software Lumen).
- **Decay as data, not deformation:** all five decay states are material/fog/light/prop/navmesh dressings on shared geometry driven by the region decay scalar (§15.4, §11.8) — a **state machine over authored geometry, not voxel terrain** (§16). Art may **not** promise terrain deformation.
- **Light discipline:** hero-lights cast shadows (Hearth, player light); ambient small lights are emissive/non-shadowed; dozens of *glows* are free, shadow-casters are budgeted (§15.3.4). Megalights for many shadow-casters is **[VERIFY]** on Series S/Deck (§16).
- **Decay transitions:** cross-fade cheap channels (material/fog/light via one scalar lerp), hard-swap geometry behind the light front (§15.3.3) — the reclaim/encroachment wave is cheap *and* correct.
- **The corruption post-process** (the §14.4 screen FX) is **one combined, escalation-gated pass** (~1–1.5ms Series S), with a lighter Brink variant on Deck (§14.13/§16) — never an always-on multi-pass stack.
- **Budget to Series S (10GB) / Steam Deck**, scale up (§16); the diegetic-first design (corruption shown on body/world/audio, §14.2) deliberately moves readability load off the framebuffer and onto cheap mesh/material/audio channels.

---

## 15.10 Open Questions

- **Megalights on low-end** ([VERIFY], §16): whether the "many small *shadow-casting* lights" fantasy survives Series S/Deck profiling. The art read is safe either way (hero-shadows + emissive ambient — §15.3.4); flagged so the lighting team doesn't over-author shadow-casters before the vertical-slice profile.
- **Decay-state count vs art-production cost** (§18): five fully-authored decay-state dressings per region kit is the spec; if production scope tightens, the natural compression is to author the *endpoints* (Lingering, Blooming, Terminal) fully and treat Festering/Withering as blends — routed to §18.
- **Licensed vs original Choir vocals.** The Choir leitmotif (§15.8) is the game's signature audio identity; whether it is composed-original or uses a recorded ensemble is a §18/audio-production decision with budget implications — flagged, not decided.
