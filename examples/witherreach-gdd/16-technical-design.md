# 16. Technical Design & Tech Stack

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

## 16.1 Decided stack at a glance

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

## 16.2 Engine choice — Unreal Engine 5

**WITHERREACH is built in Unreal Engine 5.** Develop on the latest stable release (5.6/5.7 as of mid-2026)
and **lock the engine version at vertical-slice sign-off** (§18) — never chase point releases
mid-production.

### 16.2.1 Why UE5 — the four load-bearing reasons

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

### 16.2.2 Why not Unity, why not custom

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

### 16.2.3 The one UE5 caveat — and the design boundary that resolves it

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

## 16.3 Combat & systems framework — GAS

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

## 16.4 Co-op networking model

**Player count: 2–4 (locked, bible §0/§12).** A small player count is a major simplifier — no relevancy
sharding, no large-scale player replication. **The networking challenge is world state, not players.**

### 16.4.1 Authority & hosting

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

### 16.4.2 Combat netcode (latency matters — §9)

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

### 16.4.3 The four signature systems — replication & persistence

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

## 16.5 Save & world-persistence architecture

### 16.5.1 The core split — Character save ⟂ World save (decided)

| Save | Owner | Holds |
|---|---|---|
| **Character save** (per-player, **portable** — travels to any world) | The player | **Revenant** identity, **Warded/Tainted** path + skills, the **Hollowing** track, carried/banked **Taint**, inventory/gear, the six attributes (§8). |
| **World save** (per-world, owned by host/server) | The host/world | The Long Dusk clock + per-region decay state, all **Hearths** (incl. **Greater Hearths** + the decay-rollback map), **settlement/base structures**, corpse-caches lying in the world, turned-entities, Wake/world spawn state, **Reliquary**/**Warden** completion flags, resource-node depletion. |

**Settlement is World state, not Character state.** This resolves "per-player settlement" + "world state
persists": in single-player the player owns one world (their settlement lives in it); in co-op the *shared
world* holds the shared Hearth/settlement, and guests bring their **Revenant** but build in the host's
world (the Valheim model — characters portable, bases belong to worlds). §7/§13 design around this.

### 16.5.2 Storage, integrity, and the decaying-world problem

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

### 16.5.3 Host migration — none in v1 (decided)

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

## 16.6 Performance & platform targets

Steam-first means PC + Steam Deck + Steam Machine are first-class, alongside PS5 / Xbox Series. The binding
constraints are **Xbox Series S (10GB shared RAM, weak GPU)** and **Steam Deck** — budget *to them*, scale
*up* for everyone else. **Never treat Series S as "Series X minus."**

### 16.6.1 Framerate / mode targets

| Platform | Target |
|---|---|
| **PS5 / Xbox Series X** | **60fps Performance** (≈1440p-class, dynamic resolution + temporal upscaling) — the mode the combat is tuned around. **Optional 30fps Fidelity** (≈4K-class) for screenshot/immersion players. |
| **Xbox Series S** | **60fps Performance** at ≈1080p-class with **software Lumen or baked/limited GI**, reduced Nanite density, aggressive World Partition streaming. **Budget this as its own line item.** |
| **PC** | Uncapped, fully scalable Low→Ultra. |
| **Steam Deck** | **30fps Verified** at ≈800p, Low–Medium, FSR — a launch goal. **Steam Machine Verified** bar is 1080p/30; targeting Deck typically satisfies it. |

Rationale: latency-sensitive Soulslike combat strongly favors 60 — make 60 the baseline the netcode +
combat are tuned at, and offer 30 as a fidelity *toggle*, not the floor.

### 16.6.2 PC spec targets **[VERIFY by vertical-slice profiling — depends on final fidelity]**

| Tier | Target | Approx spec |
|---|---|---|
| **Minimum** | 1080p / 30, Low, FSR Performance | ≈GTX 1070 / RX 5500 XT 8GB · 4c/8t (i5-8400 / Ryzen 5 2600) · 16GB RAM · **SSD required** |
| **Recommended** | 1440p / 60, High, upscaling Quality | ≈RTX 3060 Ti / RX 6700 XT · 6–8c (Ryzen 5 5600 / i5-12400) · 16–32GB RAM · **NVMe SSD** |

### 16.6.3 Hard technical budgets handed to the team

- **SSD is a hard minimum** (a real decision, not boilerplate): World Partition streaming + continuous
  decay-state churn + corpse-cache/turned-entity persistence make HDD non-viable.
- **Memory is budgeted to Series S (10GB shared):** set texture/streaming-pool budgets to Series S and
  scale up; it is the binding memory constraint.
- **Frame budget @60fps = 16.6ms:** reserve a *strict* slice for replication + AI. The Wake tide (spawn
  pressure scaling with Taint and Tide, §10) and the WorldDecaySubsystem are the CPU risks — keep decay on
  a slow tick and the Wake under a server-side budget / LOD-AI cap.

---

## 16.7 Death, respawn, turning & corpse-cache — technical model

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

## 16.8 What this section owns vs. references

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

## 16.9 Open Questions

- **[DESIGN → §6]** Long Dusk clock: advance on active-playtime only (recommended default) vs. ever
  offline. The architecture supports either; the design pick is Survival/World's.
- **[DESIGN → §12]** Corpse-cache count on multi-death (single Souls-style cache default vs. N) and
  **[→ §13]** co-op cache ownership (owner-only vs. party-open retrieval).
- **[VERIFY — vertical slice]** PC min/rec specs, autosave cadence, lag-compensation rewind window, and
  server tick rate — all confirmed by profiling, not assumed.
- **[CROSS-TEAM → §19]** **Game-speed slowdown in co-op:** it cannot apply per-player in a shared
  authoritative sim. Decision: solo-only, or host/party-vote applying to the whole session. Routed here
  from §19's combat-assist ruling; resolve with §13.
