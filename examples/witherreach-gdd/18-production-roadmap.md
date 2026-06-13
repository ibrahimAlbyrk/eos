# 18. Production, Scope & Roadmap

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

## 18.1 Team composition (~18–28 core through EA)

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

## 18.2 Budget range (~$3–6M to EA [EST])

- **~$3–6M to EA launch [EST].** A team of 8–10 runs $150–500k/yr in the cited indie data; a 20+-person 3D
  survival-RPG of this ambition over 3–4 years lands at the **low end of "mid."** Lords of the Fallen's
  **$66M** is the AAA ceiling we explicitly avoid (§17.1).
- **The EA flywheel funds the rest.** EA revenue at the SOM floor (300–500k units ≈ **$6–10M net**, §17.2)
  should **self-fund the EA period and 1.0** — the classic survival-EA pattern. Console porting (§18.3) and
  upper-end team scaling are funded *from* EA revenue, not raised up front.
- **Break-even sits comfortably inside the floor** at the $29.99 EA price (§17.4).

---

## 18.3 Milestone roadmap (~5–6 years total)

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

## 18.4 Content scope (what ships when)

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

## 18.5 Risk register

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

## 18.6 Open Questions

- **[BUDGET → finance]** The $3–6M band is wide; tightening it requires the M1 vertical-slice actuals
  (team ramp curve, region-art cost per decay-state set). Re-baseline at the M1 gate.
- **[STAFFING → §16]** Exact split of the 1–2 netcode engineers vs. general gameplay engineering depends on
  how much of the root-motion prediction work (R4) proves bespoke vs. CharacterMovementComponent-native —
  confirm at M1.
- **[SCHEDULE → §17]** Console port start date within M4–M5: earlier de-risks cert but pulls EA-revenue
  forward into cost; pick once EA-Year-1 sales confirm the flywheel is funding it.
