# 20. Appendices

> **Scope.** Reference matter for the whole document: (A) the **canonical glossary** — the concept
> bible §14 vocabulary expanded with every term the sections introduced (named Wardens, regions, decay
> states, factions, NPCs, mechanical terms); (B) the **references** — the art/audio/narrative
> touchstones and the real market-data source URLs; (C) the **consolidated open-questions register** —
> every section's "Open Questions" block collected into one prioritized table. Where a glossary term is
> owned by a section, the owning section is cited; this appendix never re-specifies a system.

---

## 20.A Canonical glossary

All writers and disciplines use these terms verbatim. Terms marked **(bible §14)** are the original
locked glossary; the rest were introduced and locked by the sections cited.

### 20.A.1 World, cosmology & the clock

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

### 20.A.2 The corruption economy (mechanical — §5)

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

### 20.A.3 Places — the six regions & landmarks (§2.4.2 / §11.3)

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

### 20.A.4 Factions & people

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

### 20.A.5 Enemies — the Wake & the Wardens (§10)

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

### 20.A.6 Systems — progression, combat, survival, building

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

### 20.A.7 Death, endings & co-op

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

## 20.B References

### 20.B.1 Creative touchstones (art / narrative / audio — concept bible §6, executed in §15)

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

### 20.B.2 Market & business sources (real URLs — preserved from §17.7)

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

## 20.C Consolidated open-questions register

Every section's "Open Questions" block, collected and prioritized. **P1** = affects the keystone economy
or a near-term gate (resolve by vertical slice / early EA); **P2** = affects EA-window content or
balance; **P3** = content-scope / polish / late-tuning. Cross-listed items are merged into one row.

### 20.C.1 Resolved during integration (closed — no longer open)

| Item | Was open in | Resolution |
|---|---|---|
| **Co-op ending canon** (unanimity vs leader's choice; are all party members Revenants?) | §2.9, §3.8 | **RESOLVED in §13.8** as the **Rite of the Crown** (Pyre = unanimity via the loose-anchor rule; Crown = individual seizable; Be-consumed = individual; all PCs are Revenants). Endorsed by narrative-world & tech-coop experts. |
| **"The Reach" / "the Witherreach" usage** | §2.9 | Reconciled (§2.4): "the Reach" = realm across time, "the Witherreach" = its rotted present; same basin, no conflict with the bible. Usage verified consistent across all sections. |
| **Stale `§2.11` cross-references** (in §11, §15) | integration finding | **FIXED** mechanically → `§3.6` (environmental-storytelling system) and `§3.5` (side-quest patterns); §2 ends at §2.9. |

### 20.C.2 Priority 1 — keystone / near-term gate

| # | Item | Owning / routed section(s) | Question | Suggested resolution |
|---|---|---|---|---|
| 1 | **Tempered-gear floor cap** | §5 / §7.11 / §8.10 | 6 tempered pieces at +15 each = +90 `T_floor`, but the archetype math budgets ~+15. Hard cap, highest-N-pieces, or diminishing curve? | Intent already locked with systems experts: gear floor is **capped/diminishing (~+15)**, not a naïve per-slot sum. Pick the exact rule in the EA balance pass. |
| 2 | **Per-node band vs archetype-anchor ratio** | §8.10 / §5 / §9 | Per-node `T_max` band doesn't sum to the locked Pure-Tainted anchor (210) by a naïve sum. | Keep low-edge node tuning so a *focused* allocation lands on the anchor; the anchors are binding. Revisit (soft `T_max` curve vs dedicated ceiling track) in the balance pass. |
| 3 | **Long Dusk clock anchoring** | §16.9 → §6 | Advance the clock on active-playtime only (recommended) vs ever offline? | Architecture supports either; **default active-time only** so a world never rots while no one plays. Design ratifies. |
| 4 | **Game-speed slowdown in co-op** *(cross-team)* | §19.4 / §19.8 ↔ §16.9 ↔ §13 | Game-speed can't apply per-player in a shared authoritative sim. | Ruling: **solo-only, or host/party-vote applying to the whole session** — never per-player. Tech to confirm the implementation at the vertical slice. |
| 5 | **R2 assist invariant — exact scalar floors** | §19.8 → §5 | The 0.5× Taint-gain bottom, `k_p ≥ 0.2` purge floor, and the Marked-threshold clamp on toggle *combinations*. | Confirm exact floors in the EA live-tuning pass; the **rulings are fixed**, only the scalars tune. |

### 20.C.3 Priority 2 — EA-window content & balance

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

### 20.C.4 Priority 3 — content-scope, polish & late tuning

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
