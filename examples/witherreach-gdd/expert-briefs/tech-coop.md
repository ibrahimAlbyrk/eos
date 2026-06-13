# WITHERREACH — Technical Director Brief (Tech Stack, Netcode, Persistence, Performance)

> **Status: DECIDED.** This is the binding technical-direction brief for GDD §16 (Technical Design & Tech Stack)
> and the technical inputs to §12 (Death/Session) and §13 (Co-op/Multiplayer). It builds on the LOCKED concept
> bible (esp. §10–13). Every recommendation here is one decided option with rationale, not a menu. Glossary terms
> (Taint, Hollowing, Blight, Hearth, Greater Hearth, the Wake, the Long Dusk, turning, Revenant, Expedition) are
> used verbatim per bible §14.
>
> Numbers flagged **[VERIFY]** are expert estimates that must be confirmed by profiling the vertical slice or by
> platform docs at the time of cert — they are starting targets, not contractual specs.

---

## 0. Decided stack at a glance

| Decision area | Decision | One-line why |
|---|---|---|
| **Engine** | **Unreal Engine 5** (develop on latest stable 5.6/5.7, version-lock at vertical slice) | Replication + GAS + animation + Nanite/Lumen give an indie-mid team the netcode, weighty combat, and decay visuals this game needs without building them. |
| **Combat framework** | **Gameplay Ability System (GAS)** | Replicated, prediction-ready abilities/attributes/cooldowns map 1:1 onto Taint, stamina, poise, rot-magic, Hollowing, Blight-transfer. |
| **Authority model** | **Server-authoritative, client-predicted** | Shared corruption economy must never desync or be client-cheatable; Soulslike feel needs prediction on top. |
| **Hosting topology** | **Listen-server default + dedicated-server binary from day one** | 2–4 friends host for free (Valheim/Enshrouded pattern); dedicated binary IS the persistence/host-independence answer and forces clean server-authority. |
| **Transport / online** | **EOS (Epic Online Services) relay + sessions, Steam sockets integration** | Free, NAT punchthrough, Steam-first today, console-ready tomorrow. |
| **Decay representation** | **State-based region decay (material/fog/lighting/prop/spawn-table/navmesh driven by a region-state scalar)** — NOT voxel terrain | Stays in UE5's wheelhouse; persists and replicates as a tiny state vector, not a voxel grid. |
| **Save model** | **Character save (per-player, portable) ⟂ World save (per-world: settlement, decay, Hearths, caches, turned-entities)** | Proven Valheim/Enshrouded split; makes co-op portable and persistence coherent. |
| **Host migration** | **None in v1.** Character/World split + frequent autosave covers host drop; dedicated server is the persistence path. | Seamless authority handoff is AAA-budget; dedicated delivers the same user value at a fraction of risk. |
| **Framerate target** | **60fps Performance (all platforms incl. Series S) + optional 30fps Fidelity on PS5/Series X; Steam Deck 30fps verified** | Latency-sensitive combat is tuned at 60; 30 is a fidelity toggle, not the baseline. |

---

## 1. Engine choice — DECISION: Unreal Engine 5

**Build WITHERREACH in Unreal Engine 5.** Develop on the latest stable (5.6/5.7 as of mid-2026), and **lock the
engine version at vertical-slice sign-off** — never chase point releases mid-production.

### Why UE5 (the four load-bearing reasons)

1. **Networking you don't have to invent.** UE5 ships a mature, battle-tested actor-replication model
   (relevancy, net priority, **dormancy**, RPCs, client prediction) plus the optional next-gen **Iris** system. For a
   2–4-player, world-persistence game the player count is trivial; the real replication load is *world actor count*
   (the Wake tide, decay props, settlement), and UE5's dormancy + relevancy gating handle exactly that. Writing
   equivalent authoritative netcode on top of Unity (Mirror/FishNet) or a custom stack is the single biggest schedule
   risk you can take on — and notably, every shipped survival-co-op comp on Unity (Valheim, V Rising, Enshrouded,
   Palworld) shipped *custom or third-party* netcode, i.e. the engine did **not** give it to them for free.
2. **Soulslike combat is a solved pipeline in UE5.** GAS (Gameplay Ability System) is a replicated, prediction-aware
   framework for abilities, attributes, costs, cooldowns, and status effects — it maps almost 1:1 onto this game's
   spec: Taint as a spendable attribute, stamina/poise as attributes, rot-magic and Blight-transfer as abilities,
   Hollowing and mutations as gameplay effects. Add Motion Matching / Control Rig / Chaos for weighty, frame-data
   melee with hitstop and root-motion. This is months of bespoke systems an indie team gets off the shelf.
3. **"Rotting-gorgeous" at indie-mid headcount.** Nanite + Lumen + Megalights + the Fab/Quixel asset pipeline deliver
   the bible's art pillar (§6 "beautiful-in-decay") without a large rendering team. (Caveat: these same features are
   the Series S / Steam Deck pain point — see §4; scalability discipline is mandatory, not optional.)
4. **Console certification is a trodden path.** UE5's PS5/Xbox Series backends are mature and certified; Epic
   abstracts most platform plumbing. For a small team shipping PC + Console, that de-risks the hardest part of
   "Console, Steam-first."

### Why not Unity
Unity is the right call for smaller-scope, lower-fidelity, or 2D games — not for weighty 3D combat + persistent decay
visuals + console parity. Its first-party netcode (Netcode for GameObjects) is still maturing for authoritative,
physics-heavy combat at world-persistence scale; you'd build the combat ability/poise/frame-data layer yourself (no
GAS equivalent); and the 2023 runtime-fee episode, even after walk-back, is a real predictability risk for a
multi-year project. The comps that succeeded on Unity did so by *replacing* Unity's defaults — that's a tell.

### Why not a custom engine
The hard constraint is **indie-to-mid budget.** Custom means building renderer, netcode, physics, animation, tools,
*and* console ports — exactly where Valheim (custom) and Enshrouded (custom "Holistic" engine) sank deep specialist
effort with engine-specific DNA. A team that must ship Soulslike combat + Nanite-grade decay + console parity cannot
also afford an engine. Revisit only if a specific bottleneck proves UE5 can't do it — which leads to the one real
caveat:

### The one UE5 caveat (and the design constraint that resolves it)
UE5 terrain/streaming is **not voxel-native.** If "actively-decaying world" were specced as
Enshrouded-style fully-deformable/destructible voxel terrain, you'd fight World Partition the whole way.
**DECISION (hand this to the World/Systems writers): the Long Dusk decay is a per-region STATE machine, not voxel
terrain deformation.** A region's decay stage drives material parameters, fog/lighting, prop and spawn-table swaps,
and navmesh — visible, dramatic rot, but expressed as state over authored geometry. This keeps decay firmly inside
UE5's strengths and makes it cheap to replicate and persist (you store a small region-state vector, never a voxel
grid). This is both a tech and a design boundary; flag it early so World/Survival design doesn't promise terrain
deformation the tech won't cheaply give.

> **Iris note:** Iris is still marked *Experimental* in 5.7 though shipping in some 2025–26 titles. **Ship on the
> proven generic replication system; treat Iris as a later opt-in evaluation**, only if profiled world-actor counts
> demand it. It is not a launch dependency.

---

## 2. Co-op networking model

**Player count: 2–4 (locked, bible §0/§12).** Small player count is a major simplifier — no relevancy sharding or
large-scale player replication needed. The networking challenge is world state, not players.

### 2.1 Authority & hosting
- **Server-authoritative, client-predicted.** Exactly one authoritative simulation owns *all* gameplay state:
  Taint / Hollowing / Blight values, world decay state, Hearth state, the Wake spawns + AI, loot, corpse-caches,
  turned-entities. Clients predict locally for feel; the server is truth. A client must never be trusted to report
  its own Taint, hits, or revives — the entire corruption economy is the win/loss surface and must be server-owned.
- **Listen-server is the default** (one player's client is the authority + host) — zero hosting cost, matches every
  comp, NAT-traversed via EOS relay/Steam sockets.
- **A dedicated-server binary is built from day one.** UE5 makes this nearly free (same codebase, `-server` target).
  It serves three purposes: (a) always-on persistent/joinable worlds, (b) QA automation, (c) — most important —
  building dedicated-capable *forces* clean server-authority separation, which is precisely the discipline that makes
  the listen-server robust and uncheatable. Do not bolt dedicated on later.
- **Transport: EOS** (Online Subsystem EOS) for relay, NAT punchthrough, and sessions, with Steam sockets
  integration for the Steam-first launch. EOS is free, cross-platform, and keeps the console path open.

### 2.2 Combat netcode (latency matters — bible §10)
- **Movement:** client-side prediction + server reconciliation. UE5's CharacterMovementComponent does this natively,
  but it's tuned for shooters; **weighty root-motion attacks are the hard case** (root-motion is notoriously
  prediction-hostile). Budget custom work here: predict the acting player's own attack locomotion/animation for
  responsiveness, and reconcile.
- **Hit resolution: server-authoritative with lag compensation (server rewind).** The attacker sees an immediate
  swing (predicted animation); the server validates hits against rewound positions of targets (~up to 200–250ms
  rewind window **[VERIFY against playtest ping data]**); damage, poise, and stamina are applied server-side and
  replicated back. This is "favor the attacker's feel, validate on the server." Trade-off: rare "I hit but no damage"
  at high ping — mitigate with forgiving melee hit windows/capsules (Soulslike hitboxes are already generous) and a
  **playable-ping cap** on matchmaking/join.
- **Everything combat-relevant is a Gameplay Ability:** melee strings, rot-magic, Blight-transfer, status effects.
  GAS's built-in prediction-key system gives predicted execution + server authority for free.
- **Tick budget:** ~30–60Hz server tick for active combatants; the world (decay props, distant Wake, settlement
  structures) rides heavy net-update throttling + **dormancy** so it costs near-zero bandwidth when unchanged.

### 2.3 How the four signature systems replicate + persist

1. **Blight-transfer revive (bible §11):** a GAS ability the reviver channels on a DOWNED ally inside the revive
   window. Server validates: reviver has enough banked Taint, both in range, target still within window; then
   *atomically* decrements reviver Taint, stabilizes the target, and replicates the channel VFX + meter changes to
   all clients. Predicted channel-start on the reviver for instant feedback; server confirms completion. **Not
   independently persisted** — it's a live transaction; only the resulting Taint/Hollowing values persist via the
   normal character save. **Edge case to spec:** reviver disconnects mid-channel → server aborts and *refunds* Taint
   (no silent loss).
2. **Shared Hearth (bible §11/§13):** a persistent, server-owned world actor; state = lit/unlit, fuel, tier/upgrades,
   bound players, per-character bank ledger, decay-rollback radius. Relevancy-gated replication (only clients near it
   get updates). Bank/purge are server transactions. **Persists to the WORLD save** (a Hearth is world state), with
   the banked-Taint balances as per-character ledger entries on it. **Greater Hearths** additionally write a
   region-decay-rollback flag into world decay state (§2.3.3).
3. **World decay / the Long Dusk (bible §7/§10):** a server-owned **WorldDecaySubsystem.** The world is partitioned
   into regions; each holds a decay-stage scalar advanced by the global Long Dusk clock (deepening in **Tides**) and
   rolled back locally by lit Greater Hearths. It ticks slowly (decay is minutes/hours-scale, not per-frame); on a
   stage change it updates that region's material params / fog / lighting / navmesh / spawn tables and replicates a
   **compact region-state delta** — clients reproduce the thousands of resulting visual/spawn changes *locally from
   the scalar*. Bandwidth-trivial precisely because we chose state-based over voxel decay. **Persists:** the
   region-state vector + the global Long Dusk clock value, to the world save.
4. **Turned-player entities / turned NPCs (bible §10):** when a character fully Hollows and *turns*, the server spawns
   a persistent Wake-creature actor seeded from that character's identity (name, build, gear silhouette) at a
   location, and writes it into **world state.** It replicates as a normal AI Wake actor and is encounterable later.
   Key point: the turned entity is **world data, decoupled from the original character save** (the character is
   retired per the death model). On a dedicated/shared world it persists for everyone; on a solo or listen-server
   world it persists in that world's save.

---

## 3. Save & world-persistence architecture

### 3.1 The core split (DECISION): Character save ⟂ World save
The Valheim/Enshrouded-proven split, and the correct one here:

- **Character save** (per-player, *portable* — travels to any world): Revenant identity, Warded/Tainted path +
  skills, the **Hollowing** track, carried/banked **Taint**, inventory/gear, stats. Owned by the player. This is what
  makes co-op portable — you bring your Revenant to a friend's world.
- **World save** (per-world, owned by host/server): the Long Dusk clock + per-region decay state, all Hearths
  (incl. Greater Hearths + the decay-rollback map), **settlement/base structures**, corpse-caches lying in the world,
  turned-entities, Wake/world spawn state, Reliquary/Warden completion flags, resource-node depletion.

**Settlement is World state, not character state.** This resolves the bible's "per-player settlement" + "world state
persists": in single-player the player owns one world (their settlement lives in it); in co-op the *shared world*
holds the shared Hearth/settlement, and guests bring their character but build in the host's world. (Exactly the
Valheim model: characters are portable, bases belong to worlds.) **Co-op/Settlement writers must design around this.**

### 3.2 Storage, integrity, and the decaying-world problem
- **Format:** structured binary via UE SaveGame / a custom serializer — snapshot-based, not a live DB, at the 2–4
  scale. (A dedicated/shared persistent world MAY back the world save with an embedded **SQLite** store if
  region/entity counts grow; file-snapshot is sufficient at launch.)
- **A continuously-mutating decaying world demands a disciplined save cadence:** periodic autosave (every few minutes
  **[VERIFY cadence vs world size/IO]**) + **on-meaningful-event** saves (Hearth lit, Warden killed, region Tide
  advance, host exit) + **crash-safe atomic writes** (write-temp → fsync → rename) + **rolling backups** (keep N).
  Rolling backups are table stakes, not a nicety — survival players lose worlds to corruption, and both Valheim and
  Enshrouded ship rolling backups for exactly this reason.
- **Schema versioning + migration from day one.** The world persists for the life of the project; the decay-state and
  entity schemas *will* change. Bake a version field + migration path in now.
- **Long Dusk clock anchoring (design knob, with a technical default):** advance the Long Dusk on **world-active
  playtime** (accumulated ticks persisted in the world save), **not** real-world wall-clock — a survival world
  shouldn't rot while no one is playing unless designers explicitly want that. This resumes deterministically across
  sessions. **[DESIGN DECISION NEEDED]**: confirm whether the Long Dusk should ever advance offline; my recommended
  default is no (active-time only). The architecture supports either; flag it to Survival/World design.

### 3.3 Co-op host migration (DECISION: none in v1)
Seamless mid-session authority handoff is expensive and fragile, and the comps don't do it for listen-server
(Valheim/Enshrouded: if the host leaves, the session ends; the world is the host's, players rejoin when it's back).
**Do not build seamless host migration for v1.** Instead:
- **Character/World separation** means a host drop costs *no one* their character.
- The world belongs to the host; on host disconnect the session ends, the **last autosave + an on-disconnect save**
  preserve world state, and players rejoin when the host returns. Frequent autosave bounds the loss.
- **The dedicated server IS the host-independence answer.** Authority on a machine no one is "playing on" lets any
  player leave/join freely with a 24/7 persistent world. Groups who want host-independence are routed to dedicated
  rather than to fragile P2P authority handoff.

This is the deliberate indie-mid call: seamless migration is AAA-budget; the dedicated path delivers the same
user-value (persistent, joinable world) at a fraction of the cost and risk.

---

## 4. Performance & platform targets

Steam-first means PC + Steam Deck + Steam Machine are first-class, alongside PS5 / Xbox Series. The binding
constraints are **Xbox Series S (10GB shared RAM, weak GPU)** and **Steam Deck** — budget *to them*, scale *up* for
everyone else. Never treat Series S as "Series X minus."

### 4.1 Framerate / mode targets
- **PS5 / Xbox Series X:** **60fps Performance mode** (≈1440p-class, dynamic resolution + temporal upscaling) as the
  default the combat is tuned around; **optional 30fps Fidelity mode** (≈4K-class) for screenshot/immersion players.
- **Xbox Series S:** **60fps Performance** at ≈1080p-class with **software Lumen or baked/limited GI**, reduced
  Nanite density, aggressive World Partition streaming. Budget this as its own line item.
- **PC:** uncapped, fully scalable Low→Ultra.
- **Steam Deck:** **30fps Verified** at ≈800p, Low–Medium, FSR — a launch goal. **Steam Machine Verified** bar is
  1080p/30; targeting Deck typically satisfies it.

Rationale: latency-sensitive Soulslike combat strongly favors 60; make 60 the baseline the netcode + combat are
tuned at, and offer 30 as a fidelity *toggle*, not the floor.

### 4.2 PC spec targets **[VERIFY by vertical-slice profiling — these depend on final fidelity]**
- **Minimum (1080p/30, Low, FSR Performance):** ≈GTX 1070 / RX 5500 XT 8GB; 4c/8t CPU (i5-8400 / Ryzen 5 2600);
  16GB RAM; **SSD required.**
- **Recommended (1440p/60, High, upscaling Quality):** ≈RTX 3060 Ti / RX 6700 XT; 6–8c CPU (Ryzen 5 5600 / i5-12400);
  16–32GB RAM; **NVMe SSD.**

### 4.3 Hard technical budgets to hand the team
- **SSD is a hard minimum (a real decision, not boilerplate):** World Partition streaming + continuous decay-state
  churn + corpse-cache/turned-entity persistence make HDD non-viable.
- **Memory is budgeted to Series S (10GB shared):** set texture/streaming-pool budgets to Series S and scale up;
  it is the binding memory constraint.
- **Frame budget @60fps = 16.6ms:** reserve a *strict* slice for replication + AI. The Wake tide (spawn pressure
  scaling with Taint and Tide, bible §10) and the WorldDecaySubsystem are the CPU risks — keep decay on a slow tick
  and the Wake under a server-side budget/LOD-AI cap.

---

## 5. Death / respawn / turning / corpse-cache — technical model

All server-authoritative; predicted only where it improves feel (the acting player's own revive channel). Persistence
follows the §3.1 split: **Hollowing + banked Taint → character save; corpse-caches + turned-entities + Hearth state →
world save.**

**Downed → death (co-op, bible §11):**
1. Server detects HP→0. In co-op the player enters a server-owned **DOWNED** state (ragdoll/crawl + revive-window
   timer), replicated; allies see a revive prompt.
2. **Blight-transfer revive** (§2.3.1) can interrupt and stabilize within the window.
3. If the window expires (or solo play) → **DEATH proper.**

**On DEATH proper:**
1. Server spawns a **corpse-cache** actor at the death location holding the dropped **banked Taint** (and, per design,
   possibly some gear) — a persistent world actor with an owner-id + recoverable flag, written to the **world save**,
   **dormant when no one is near** (cheap).
2. Server advances **Hollowing** by one step (writes **character save**).
3. Server respawns the player at their last-bound lit **Hearth** (the shared Hearth in co-op).
4. All of it replicates to clients.

**Corpse-cache retrieval (Souls-style corpse-run):** server validates proximity + ownership (or party-open, per
design), transfers Taint back, despawns the cache, updates the world save. Whether a second death forfeits the first
cache is a **design knob** — the tech supports N caches; default to Souls-style single recoverable cache
(configurable).

**Turning (soft-permadeath, bible §10/§11):**
- **Hollowing** is a server-authoritative GAS attribute. As it nears max, the server drives **escalating,
  telegraphed** replicated status/VFX/debuffs (mutation visuals, raised Wake aggro) — never a surprise.
- At max Hollowing the server triggers **TURN**: the character save is retired (the "tragic" reset, bible §9), and the
  server spawns a persistent **turned-entity** Wake actor into world state seeded from the character (name, build,
  gear silhouette, location). In co-op, allies present witness the turn as a set-piece. The turned entity is
  decoupled from the now-gone character and is encounterable later (§2.3.4).

**Respawn resolver (interacts with decay):** respawn at the last-bound lit Hearth; **if that Hearth's region has gone
dark or been lost to the Long Dusk**, the server falls back to the nearest lit / Greater Hearth. "Your Hearth went
out" is a real state the resolver must handle — coordinate with World/Survival design on the fallback order.

---

## 6. Open decisions handed to other writers / for verification
- **[DESIGN]** Long Dusk clock: advance on active-playtime only (my default) vs ever offline — Survival/World design.
- **[DESIGN]** Corpse-cache count on multi-death (single Souls-style cache default vs N) — Death/Session design.
- **[DESIGN]** Corpse-cache ownership in co-op (owner-only vs party-open retrieval) — Co-op design.
- **[VERIFY]** PC min/rec specs, autosave cadence, lag-compensation rewind window, server tick rate — all confirmed by
  vertical-slice profiling, not assumed.
- **[TECH BOUNDARY, already decided]** Decay is state-based, not voxel/destructible terrain — World/Survival design
  must build within this.

---

## 7. Sources (engine/netcode/platform grounding)
- Unreal Engine 5.7 docs — Iris Replication System, Migrate to Iris, Setting Up Dedicated Servers (dev.epicgames.com)
- StraySpark, "Iris Replication in Unreal Engine: Should You Opt In? (2026)"; BorMor, "Iris: 100 Players in One Place"
- Couch Learn, "How to build a Dedicated Server for your Unreal Engine 5 Game"; Uverse, "Multiplayer Game Framework
  Comparison 2025"
- Enshrouded Dedicated Server FAQ (zendesk) & Windows Central setup guide; PC Gamer, "Valheim dedicated server";
  Valheim/Enshrouded Steam community threads on P2P-host vs dedicated + separate character/world saves
- ResetEra/Vice, "Steam Machine Verified: 1080p/30 minimum"; Tom's Hardware, "Steam Deck 60 FPS benchmarks"
