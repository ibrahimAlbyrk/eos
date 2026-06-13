# 19. Accessibility & Difficulty Options

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

## 19.1 Design principles (the non-negotiables)

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

## 19.2 Axis 1 — the built-in difficulty dial (build = survival difficulty)

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

## 19.3 Axis 2 — the assist layer and the corruption economy (the keystone invariant)

The explicit assist toggles must coexist with the keystone economy (§5) without breaking it. The three
binding rulings (synthesized with the survival-systems and rpg-combat owners; carried in the
survival-systems master brief §13):

### 19.3.1 R1 — World-pressure toggles soften the meter; the standard ladder never touches Hollowing

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

### 19.3.2 R2 — The Marked-floor invariant (the loop must survive at every difficulty)

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

### 19.3.3 R3 — Assists stack orthogonally on the build; they never nudge the player toward Warded

The assist layer is a **pressure-multiplier applied on top of the chosen build.** It scales the **world**
(gain / light / hunt / revive), leaving the build's **relative** floor/ceiling identity intact: a **Tainted**
glass-cannon on maximum assist is still "the hot build relative to **Warded**," just in a gentler world.

**Difficulty presets may exist as curated bundles of these orthogonal world-pressure toggles (bounded by
R2), but a preset never auto-reassigns or nudges the player's Path.** Forcing assist players toward Warded
would deny the Tainted power-fantasy to exactly the players who most need accessibility help. The build
dial (§19.2) and the assist layer are **two independent axes that multiply.**

---

## 19.4 Combat assist toggles

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

## 19.5 Difficulty presets

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

## 19.6 Accessibility features (beyond difficulty)

### 19.6.1 Must-ship at launch

| Feature | Requirement |
|---|---|
| **Colorblind-safe corruption readability** *(the #1 item — non-negotiable; a constraint on §14)* | The entire core loop is **reading your Taint band** (Lucid / Marked / Fevered / Brink, §5.2) and **clean-vs-blighted** resources/nodes (§5.3/§6). If that is color-only, the game is **unplayable** for colorblind players. **Pair color with shape / icon / texture + a numeric and/or SFX cue on *every* corruption readout.** Ship deuteranopia / protanopia / tritanopia palettes + a high-contrast corruption mode. §14 implements; §19 requires. |
| **Corruption screen-FX intensity slider** | The **Fevered/Brink** turning telegraph (§5.2/§5.7) uses heavy screen distortion + vignette + audio corruption FX — a photosensitivity / nausea / migraine risk. The slider must **keep the telegraph legible at every setting** (0% must not hide the warning) while reducing the visual assault. Also: reduce-shake, motion-blur off. |
| **Audio cues for attack tells** | Every visual tell (§9) paired with a distinct audio cue; plus an optional **telegraph assist** that highlights big / unblockable attacks. Helps low-vision players and everyone. |
| **Full input remap** (controller + KB/M) | Table-stakes. |
| **Hold-vs-toggle** for every hold action | Sprint, block, aim, lantern, crouch — cheap, high motor-accessibility impact. |
| **Subtitles** | Speaker names + adjustable size / background — table-stakes for a narrative game (§3). |

### 19.6.2 Should-ship at launch

| Feature | Note |
|---|---|
| **Aim assist for ranged** | **Recommended yes** — ammo is scarce *by design* (§9); players shouldn't whiff scarce shots to motor difficulty. |
| **Dodge / auto-dodge assist** | Offer **only** as an extreme toggle (it erodes the core defensive skill) — bundled in **Wanderer** (§19.5), never default. |
| **One-handed / simplified control scheme** | Nice-to-have, scope-permitting. |

---

## 19.7 What this section owns vs. references

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

## 19.8 Open Questions

- **[CROSS-TEAM → §16/§13]** Game-speed slowdown in co-op: solo-only vs. host/party-vote for the whole
  session (§19.4). Technical resolution is an §16 Open Question; the design ruling here is "one or the
  other, never per-player."
- **[BALANCE → §5]** Exact scalar floors for the R2 invariant (the 0.5× Taint-gain bottom, the `k_p ≥ 0.2`
  purge-cost floor, the Marked-threshold clamp on toggle *combinations*) confirmed in the EA live-tuning
  pass (§18), not pre-EA.
- **[SCOPE → §18]** The separate opt-in **Assist Mode** that may touch Hollowing (§19.3.1): confirm it
  ships at EA launch vs. is added during EA — recommended **at launch**, as accessibility is table-stakes
  (§17.6), pending production load at M2.
