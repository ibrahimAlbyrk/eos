# 4. Core Gameplay Loops

WITHERREACH runs on three nested loops at three timescales — **moment-to-moment** (seconds–minutes), the **Expedition** (one play session, 30–90 min), and the **meta** loop (tens of hours). They are not three separate games stitched together: the same corruption economy (see §5) is the engine of all three, so a decision made in a single fight ripples up to the session's climax and down from the long-term build you are committing to. This section specifies the loops and how they interlock; it references the Corruption System (§5) and Survival Systems (§6) for the underlying numbers rather than restating them.

The unifying tension, stated once and threaded through every loop: **surviving forces you to take on Taint; Taint is the only fuel for power; carrying Taint to spend later is what makes the world dangerous in real time.** Every loop below is a different-sized turn of that one wheel.

---

## 4.1 The three loops at a glance (loop diagram-in-text)

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

## 4.2 Moment-to-moment loop (seconds–minutes)

This is the texture of play — what the hands do continuously while out in the Reach.

**The cycle:**
1. **Read the environment.** Light radius is finite; the gloom hides resource nodes (clean vs blighted), the Wake, and the zone's decay state (fringe / decayed / blighted core — see §11). Reading correctly is how you decide whether the next 30 seconds are a fight, a harvest, or a retreat.
2. **Manage light.** Light is the single thing that suppresses Taint gain (lit ×1 vs dark ×5 — §6.2). Torches and lantern oil are consumable and finite, so every step deeper trades light-budget for objective-progress. Running out of light mid-Expedition is the signature spike (Taint gain ×5) — the "closing dark."
3. **Engage or avoid the Wake.** Combat is deliberate and stamina-gated (§9). The Wake's hunt-pressure scales with your current Taint band and the Tide (§10), so the more power you are carrying, the more the world hunts you while you carry it.
4. **Transact in the corruption economy.** Every meaningful action moves Taint: eating blighted food fends off hunger but raises Taint (§6.1); casting rot-magic or using rot-infused weapon arts spends Taint as an in-field release valve (§5.4); harvesting blighted nodes splashes a little Taint on; taking a wound while Fevered/Brink festers more in. There is no neutral action — the meter is always moving.

**Net of the inner loop:** Taint trends **up** while you survive and explore, and dips **only** when you choose to spend it in a fight. You are constantly reading "how hot am I, how dark is it, how close is the Wake, how full is my pack" — four readouts that are all, ultimately, the one meter and its inputs (§5).

---

## 4.3 The Expedition loop (the session — 30–90 min)

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

## 4.4 The meta loop (tens of hours)

The long game spends what the Expeditions bring home, against a clock that deepens with or without you.

**The four meta drives:**
- **Ascend a Path.** Invest banked Taint at a Hearth into the **Warded** (resist) and/or **Tainted** (embrace) trees plus martial/craft skills (§8). Ascension is a Hearth transaction that spends Taint (§5.4); Tainted nodes raise both your ceiling and your survival difficulty (`T_floor` and `T_max`), Warded nodes lower your floor. **Choosing a build is choosing your survival mode** (§5.6) — there is no separate difficulty slider doing this work.
- **Temper gear.** Spend Taint + Blight materials to raise gear tiers (§7). Equipped tempered gear raises your `T_floor` — power is literally bought with permanent survival difficulty.
- **Reclaim the map.** Defeat region **Wardens** to kindle **Greater Hearths**, rolling the Long Dusk back locally and pinning a region's decay one step better while it stays fueled (§6.5, §11). The reclaimed map is **impermanent** — lapse the fuel or lose the Hearth and the rot creeps back. You hold ground hearth by hearth; you never finally win.
- **Fight the descent.** Death and Brink exposure ratchet **Hollowing**, the permanent soft-permadeath track (§5.7). The only reducer is the rate-limited Cleansing rite at a Greater Hearth. The strongest (Tainted) builds live closest to **turning** — the meta loop is partly a campaign to stave that off.

**Race the clock.** The global **Long Dusk** deepens in **Tides** roughly every ~10 hours of cumulative out-in-the-Reach time (§6.5). Each Tide raises ambient Taint, Wake spawn-pressure, and encroachment speed — so standing still at base loses ground. This is the pressure that keeps the meta loop moving toward the endgame.

**End the story.** The arc terminates at the **Hollow Crown** with the locked three-ending choice — **End it / Master it / Be consumed** (frame in concept bible §9; quest delivery in §3). Settlement and world state persist across sessions (§13 for the co-op/shared-world case).

---

## 4.5 How the loops interlock

The three loops are one wheel seen at three zoom levels, coupled by the corruption economy:

- **Up-coupling (inner → outer):** every moment-to-moment action moves Taint, so the inner loop *is* what produces the `T_end` that the Expedition climax decides on, which *is* the banked Taint the meta loop spends on Path and gear.
- **Down-coupling (outer → inner):** your meta-loop build sets `T_floor` and `T_max` (§5.6), which sets your resting threat band, which changes how dangerous the *very next* moment-to-moment second is. A Pure Tainted build starts every Expedition already in Marked/Fevered; a Pure Warded build starts deep in Lucid. The build you grind toward reaches back down and re-tunes the texture of play.
- **The clock couples everything:** the Long Dusk's Tides (§6.5) raise the ambient cost of the inner loop, shorten the safe window of the Expedition, and pressure the meta loop forward — the only loop with no "stand still" option.

**Illustrative full-wheel example (illustrative — to tune).** A Hybrid Revenant (`T_floor=20`, `T_max=100`) departs a Hearth at Taint 20 (meta-loop state). Over a 35-minute Expedition the moment-to-moment loop pushes Taint to 81 (Fevered) through dark travel, blighted meals, and a Wake fight partly vented by casting. At the climax they **invest** 50 into a Tainted ascension node (now `T_floor` rises toward a Heavy-Tainted profile) and purge the rest to floor. Next Expedition therefore *departs* hotter and hunts harder — the meta decision re-tuned the inner loop. Twelve hours of such Expeditions later, the world has advanced ~1 Tide; a kindled Greater Hearth has pinned one region back a step. The wheel has turned at all three scales, and every turn transacted in the same Taint.

> Cross-references: the corruption economy that powers all three loops is fully specified in §5; the survival inputs (hunger, light, weather, the Tide clock) in §6; crafting/Hearths/gear in §7; Paths/ascension in §8; combat in §9; the Wake/Wardens in §10; world structure and Reliquaries in §11; the death model and Expedition session structure in §12; co-op in §13.
