# 13. Co-op & Multiplayer Design

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

## 13.1 Pillars & scope

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

## 13.2 Session & host model

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

## 13.3 The shared Hearth

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

## 13.4 Role structure — the damage-triangle interdependence

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

## 13.5 Blight-transfer revive

The signature co-op mechanic (concept bible §4, USP #5): **you pour your banked power into a downed
ally to stabilize them — trading your strength for their life.**

### 13.5.1 The flow

1. An ally hits HP→0 and enters the server-owned **DOWNED** state with a **revive-window** timer
   (§12.2), replicated as a revive prompt.
2. A living ally **channels a Blight-transfer** on the downed player (a GAS ability, server-validated
   for range + window + sufficient Taint; predicted channel-start on the reviver for instant feel).
3. On completion, the server **atomically**: decrements the **reviver's banked Taint by ~30** (§5;
   floor-capped — see below) and **transfers it onto the revived ally**, stabilizing them **in place**
   at their current position.

### 13.5.2 The corruption cost — revive *transfers danger*

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

### 13.5.3 Corpse-cache ownership in co-op (the tech open item, resolved)

When a co-op death goes to **DEATH proper** (window expired), the dropped corpse-cache (§12.3/§12.4)
is, by default, **owner-only** to retrieve — **your banked Taint is yours**; allies can **escort and
guard** the corpse-run but **only you reclaim** the cache. A **party-open** retrieval mode is a
**world/difficulty setting** (the tech supports either, tech §6). Default owner-only because banked
Taint is the player's private moral stake (§13.3) and party-open invites grief; the setting exists for
groups who want pure shared-loot co-op.

### 13.5.4 Edge case — reviver disconnects mid-channel

Per the tech model (§2.3.1): the server **aborts and refunds** the reviver's Taint — **no silent
loss**. The downed ally stays downed (window continues); another ally may attempt the revive.

---

## 13.6 Party Taint & difficulty scaling

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

## 13.7 Turned-player persistence

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

## 13.8 The co-op ending canon — the Rite of the Crown (RESOLVED)

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

### 13.8.1 End it (the Pyre) — requires UNANIMITY

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

### 13.8.2 Master it (the Crown) — INDIVIDUAL & seizable

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

### 13.8.3 Be consumed (the Hollowing) — INDIVIDUAL

Unchanged from §12.7: a player at **max Hollowing turns anywhere** (or surrenders the final trial).
It is per-character; the turned form becomes a named elite for the others (§13.7); the world is
otherwise unchanged.

### 13.8.4 The resulting multiplayer dynamic (why this ruling)

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

### 13.8.5 Resolution rules (the rite, concretely)

| Aspect | Ruling |
|---|---|
| **Who can drive the rite** | **Any** living, present party member — **not** necessarily the host. The server arbitrates; the ending is **never hostage to who happens to be hosting** (tech-coop-expert confirmed sound). |
| **Eligible set** | Server-defined: **every currently-alive, present** party member. **Downed players are excluded** (they have not "offered" — §12.2) — the Pyre needs all *alive-and-present* to confirm. |
| **Pyre commit** | Server aggregates a **per-player consent boolean**; fires only when **all eligible confirm**. Pure runtime state; **only the outcome persists** (like Blight-transfer, §13.9). |
| **Crown commit** | Server-arbitrated **atomic compare-and-set** on the single `worldSovereign` anchor; **first-to-commit wins**; simultaneous-commit tie-break is netcode/design (e.g. lowest latency / earliest server-stamp), **not** lore. |
| **Abort safety** | The rite is **runtime state until the single atomic commit**, so a host-drop mid-rite (no migration, §13.2) can **never leave a half-applied ending** — an abort just means "re-form and redo," never a corrupted world. |

---

## 13.9 Netcode & persistence implications

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

## 13.10 Open Questions

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
