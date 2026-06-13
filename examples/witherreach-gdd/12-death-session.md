# 12. Death, Risk & Session Structure

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

## 12.1 The death model — two tiers, "Die Forward"

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

## 12.2 Downed & the revive window (co-op)

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

## 12.3 Death proper — respawn, the corpse-cache, Hollowing

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

## 12.4 The corpse-run — retrieval rules

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

## 12.5 The respawn resolver — when your Hearth goes dark

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

## 12.6 Hollowing — the soft-permadeath track (death's contribution)

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

## 12.7 Turning — the 10-pip telegraph & the TURN event

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

## 12.8 The Cleansing rite — the only stave-off

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

## 12.9 Expedition session structure — under the Long Dusk

Play is organized as **Expeditions**: a **round trip out from and back to a Hearth** (concept bible
§11; the loop is §4; the clock is §6). The death model is the *risk floor* under that loop.

### 12.9.1 The Expedition arc (one session, ~30–90 min)

| Phase | What happens | Death-model stake |
|---|---|---|
| **Outfit (at the Hearth)** | Spend the last session's banked Taint (bank / purge / invest, §5.5); repair/temper (§7); stock light + food (§6). | You set your **`T_floor`** and your starting band — your survival difficulty for the run (§5.6). |
| **Push out** | Travel into more-decayed, higher-TL zones (§10.2); manage light, hunger, Taint; gather; advance an objective (a Reliquary / resource frontier, §11). | **Distance from the Hearth = corpse-run length** if you die. Going deep is going far from your respawn. |
| **The objective / fight** | The richest reward sits in the highest-TL dark (§10.8); fights vent Taint (casters) or accrue it (festering wounds, §5.3). | Dying here drops the cache **far out**, in hostile ground. |
| **The return** | Race your Taint, light, supplies, and nerve back before they run out. | A death on the way home is the classic "so close" loss — and the return trip itself accrues ambient Taint (§5). |
| **The Hearth decision** | Bank / purge / invest the run's Taint (§5.5) — the session climax. | Banking hot means **next** Expedition starts in a higher band, hunted from minute one (§10.2) and dying hotter (§12.3). |

### 12.9.2 The session under the Tide

- The Long Dusk advances in **Tides** on **cumulative out-in-the-Reach time** (~10 h/Tide,
  Expedition-time only — §6.5). Idling at the Hearth does **not** advance it; you **cannot out-grind
  the clock at base**, but slow/co-op players are not punished by wall-clock.
- Each Tide raises ambient Taint, Wake spawn-pressure (+1 `TideTier`, §10.2), encroachment speed, and
  unlocks tougher Wake variants (§10.3) — so **the same Expedition route gets deadlier over the
  campaign**, and your accumulated **Hollowing** (which never resets) means late-game deaths land on a
  character already part-way to turning.
- **Greater Hearths** (won from Wardens, §10.5) roll back local decay and host the Cleansing rite —
  the only way to *push the death-clock back* locally, never globally (pillar 2).

### 12.9.3 Persistence

The **world and settlement persist across sessions** (concept bible §11). The death model's durable
state — **corpse-caches, turned-entities, Hearth bindings, the Hollowing track** — persists per the
Character⟂World save split (§13.9 / tech brief): **Hollowing + carried/banked Taint → character save;
corpse-caches + turned-entities + Hearth state → world save.** An Expedition can therefore be
**interrupted and resumed** without losing the run's stakes.

---

## 12.10 The risk ledger — what you keep, lose, and ratchet

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

## 12.11 Open Questions

- **Cache decay flourish (§6/§11).** A "caches slowly sink into Blight" timer is specced **off by
  default** (§12.4). Whether the decaying world should ever consume an un-recovered cache is a
  survival/world-design call — flagged so it is never silently lost to an invisible timer.
- **Multi-death cache count default vs. setting (§13/§18).** Default is single-cache (second death
  forfeits); exposing N-caches as a difficulty option interacts with co-op (§13.5) and difficulty
  presets (§19) — flagged for the options pass.
- **Pyre eligibility for high-Hollowing players (§3/§5).** Whether a near-turning player can still
  take the clean **End it** ending, or only a corrupted variant, is the §3.4.1 / §5 threshold flagged
  in narrative — it lands partly here because it is the death track that gates it.
