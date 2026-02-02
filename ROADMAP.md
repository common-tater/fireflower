# Roadmap

Living document tracking future plans, ideas, and considerations for Fireflower.

## Adaptive Upgrade Intervals

**Status:** Deferred

Nodes upgrading from server to P2P use a fixed `p2pUpgradeInterval` (default 30s) with 0-25% random jitter. This works well at moderate scale but could cause unnecessary contention in very large trees.

**Idea:** Scale the upgrade interval based on tree size — shorter for small trees (faster upgrades), longer for large trees (less thundering herd).

**Why deferred:**
- Current jitter already handles tested scenarios (34 passing, including thundering herd tests)
- No node currently knows the total tree size — it's not in the peer message flow
- Adding tree size requires either a new upward aggregation message type or root reading Firebase reports, both of which break the self-contained design principle (nodes only read Firebase for signaling and config, never reports)
- The cleanest approach (root reads reports, broadcasts count in mask updates) adds a Firebase dependency to root — acceptable but not free
- Upgrade timer code is duplicated in 4 locations; would benefit from refactoring first

**Revisit when:** Deployments exceed ~100 simultaneous nodes and upgrade storms become observable.

## Live Video Support

**Status:** Exploratory

Fireflower is transport-agnostic — the tree topology, signaling, reconnection, health scoring, and server fallback don't care what bytes flow through data channels. Audio streaming (the primary use case) works well because audio is low-bandwidth (~32-128 kbps), tolerant of small drops, and forgiving of per-hop latency.

Video changes the calculus significantly.

### What works today (no changes needed)
- Tree formation, signaling, reconnection, health routing
- Server fallback and P2P upgrade lifecycle
- The relay node forwards bytes without inspecting them

### Fireflower-layer considerations

**Channel reliability options**
- Data channels default to reliable + ordered (TCP-like)
- Live video needs unreliable + unordered (`ordered: false, maxRetransmits: 0`) to avoid cascading stalls from retransmission at each hop
- `peer.createDataChannel()` would need to accept and pass through these options
- Note: `channelConfig` already exists in the constructor opts but may not be wired through to relay channels

**Backpressure tuning**
- Current `BACKPRESSURE_THRESHOLD` is 64KB — fine for audio, easily exceeded by video
- The existing drop-on-backpressure behavior is actually correct for live video (skip stale frames)
- Threshold and drop strategy should be configurable per-channel or per-node
- No concept of frame priority — a keyframe chunk and a delta frame chunk are equally likely to be dropped

**Bandwidth multiplication**
- Each relay node uploads to K children: at 1 Mbps video with K=3, every internal node needs 3 Mbps upload
- K should be lower for video (K=2 or K=1), which makes the tree deeper, which adds latency
- Fundamental tension between fanout (fewer hops, more bandwidth per node) and depth (less bandwidth, more latency)

**Message chunking**
- WebRTC data channels have practical message size limits (~256KB, 16KB recommended)
- Video keyframes can be 50-200KB and need chunking
- Relay nodes forward chunks without reassembly, which is correct
- But backpressure-dropping a single chunk of a multi-chunk keyframe corrupts the entire frame

### Application-layer concerns (not Fireflower's responsibility)
- Codec selection, encoding, adaptive bitrate
- Quality adjustment based on tree depth
- Jitter buffering and frame reassembly
- I-frame vs P-frame prioritization
- Keyframe request/refresh mechanisms

### Topology consideration
- For video specifically, the relay server path (star topology) may outperform a deep P2P tree
- Server absorbs bandwidth cost but minimizes hops and latency
- The existing `serverOnly` mode already supports this — video consumers could run with server transport permanently
- Hybrid: root streams to relay server, server fans out to all consumers (no P2P tree)

### Summary
- Fireflower works for video today at small scale with no code changes
- For production video: expose channel reliability/ordering options, make backpressure configurable, consider priority-aware dropping
- The "data is data" principle holds — these are configuration knobs, not architectural changes
- Video may favor leaning on the relay server more heavily than the P2P tree

## Test Coverage Gaps

**Status:** Ongoing

Areas identified for future test scenarios:

- **Firebase connection blip recovery** — Verify the relay server's `.info/connected` watcher correctly re-publishes `serverUrl` and re-registers `onDisconnect` after a Firebase SDK reconnect. Hard to test without intercepting the Firebase connection.
- **Direct server reconnect under high load** — Multiple orphans using `_connectToServerDirect` when the relay is already serving many clients. Current scenarios (28-31) cover the path but not at scale.
- **Upgrade timer rescheduling** — Verify that failed upgrade attempts correctly reschedule without jitter accumulation or timer leaks across many cycles.

## Completed

Items that were on the roadmap and have been implemented:

- **Scenarios 33-34** — Deep line recovery (K=1) and relay server restart handling
- **serverCapacity sync fix** — `_onconfig` explicitly syncs/deletes `opts.serverCapacity` since `deepMerge` can't unset missing keys
- **serverFirst batching window** — Widened from 250ms to 500ms for better relay server response capture under reconnection storms
