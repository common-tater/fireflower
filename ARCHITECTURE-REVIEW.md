# Fireflower Architecture Review

## System Summary

A K-ary tree broadcast system: one root produces data, all other nodes receive it by forming a tree of WebRTC data channel connections. A WebSocket relay server provides fast initial connections and fallback. Firebase Realtime Database handles signaling and coordination.

---

## CRITICAL

### 1. Single point of failure: root node

If the root browser tab crashes, closes, or loses network, **the entire tree goes dark**. Every node eventually detects upstream loss and reconnects, but there's no data source. No root election, no root migration, no standby root.

- **Impact on audio streaming**: Total stream interruption for all listeners. Reconnection cascade takes seconds even after a new root appears.
- **Complexity to fix**: High. Requires root election protocol or hot-standby root with data source handoff.
- **Risk**: High for any production deployment.

### 2. Data channels use `reliable` (TCP-like) mode by default

`peer.createDataChannel('_default', peer.channelConfig)` — with no explicit `maxRetransmits` or `ordered: false`, WebRTC defaults to reliable, ordered delivery. For audio streaming this is wrong: a single lost packet causes head-of-line blocking across the entire SCTP stream. Stale audio frames queue behind retransmissions, adding unbounded latency spikes.

- **Impact on audio streaming**: Latency spikes of 100-500ms+ under any packet loss. On mobile networks (2-5% loss typical), this makes real-time audio unusable.
- **Complexity to fix**: Low. Set `{ ordered: false, maxRetransmits: 0 }` on the audio data channel. Keep the `notifications` channel reliable.
- **Risk**: Low — additive change, doesn't affect signaling.

### 3. No actual media/audio transport layer

The system currently only has `_default` and `notifications` data channels. There is no:
- Audio encoding/decoding pipeline
- Jitter buffer
- Packet sequencing or timing recovery
- Codec selection (Opus, etc.)
- Clock synchronization between producer and consumers

The data channel sends arbitrary blobs, but for "ultra low latency audio," you need an audio-specific framing protocol on top of the data channels.

- **Impact**: The system can broadcast arbitrary messages but has no audio-specific path.
- **Complexity to fix**: High. Requires designing an audio framing protocol, choosing codec parameters, implementing jitter buffers.
- **Risk**: Medium — it's additive, doesn't break existing functionality.

### 4. Firebase as signaling plane is a latency and reliability bottleneck

Every connection (initial join, upgrade, fallback, reconnect) round-trips through Firebase Realtime Database:
- Request write → Firebase propagation → Response write → Firebase propagation → ICE candidate trickle (each via Firebase)
- Minimum 4-6 Firebase round trips before data flows
- Firebase has no SLA for propagation latency — typically 100-300ms per write, but can spike to seconds during outages
- If Firebase goes down, no new connections can form (existing P2P connections survive)

For audio: a mid-tree disconnect takes heartbeat detection (2-4s) + Firebase signaling (0.5-2s) + ICE negotiation (0.5-3s) = **3-9 seconds of dead air** for that subtree.

- **Complexity to fix**: High. Alternative: direct WebSocket signaling server, or use the relay server for signaling too.
- **Risk**: High for low-latency goals.

---

## HIGH

### 5. Tree depth adds cumulative latency per hop

In a K=2 tree with 1000 nodes, depth is ~10 levels. Each P2P hop adds the encode-transmit-decode latency of that link. WebRTC data channels on good connections add ~1-5ms per hop. But:
- On mobile/cellular, each hop can add 20-50ms
- At depth 10: **200-500ms end-to-end** for deepest nodes
- Nodes don't control their depth — health-based routing helps but doesn't guarantee low depth

- **Impact on audio**: Listeners at tree leaves hear audio 200-500ms after root on cellular. This may be acceptable for broadcast (not interactive), but competes poorly with CDN-based solutions (~50-100ms).
- **Complexity to fix**: Medium. Increase K (reduces depth but increases root/relay load), or implement depth-aware rebalancing.
- **Risk**: Medium — rebalancing causes temporary disruption.

### 6. Relay server is a single process, single machine

`relay-server.js` runs one Node.js process with `K: 1000`. Every server-connected client maintains a WebSocket to this single process. There is no:
- Horizontal scaling / load balancing
- Geographic distribution
- Process clustering
- Memory or connection limits

A relay server handling 1000 WebSocket connections, each receiving and broadcasting audio data, will hit memory and CPU limits. Each downstream message is serialized per-client (no multicast).

- **Complexity to fix**: High. Requires relay server clustering, sticky sessions, or sharded relay topology.
- **Risk**: Medium — the P2P tree offloads most traffic, relay is a fallback.

### 7. No encryption or authentication on data channels

WebRTC data channels are DTLS-encrypted peer-to-peer (good), but:
- No authentication of node identity — any node that can write to Firebase can join the tree
- The relay server WebSocket (`ws://0.0.0.0:port`) uses unencrypted WS, not WSS
- Firebase security rules aren't mentioned — if open, anyone can read/write signaling data
- No mechanism to verify a node is who it claims to be (node IDs are self-asserted)

- **Impact**: In production, anyone could inject audio into the tree, impersonate nodes, or eavesdrop on the relay server.
- **Complexity to fix**: Medium. WSS is easy. Firebase security rules are medium. Node authentication (signed tokens) is medium.
- **Risk**: Low if this is internal/demo. High for production.

### 8. No backpressure or flow control

When a parent sends data faster than a child can receive (slow mobile connection, background tab), there's no mechanism to:
- Detect channel buffer buildup
- Drop frames or reduce quality
- Signal upstream to reduce rate

WebRTC data channels have a `bufferedAmount` property, but it's never checked. If a slow child causes the SCTP buffer to fill, the data channel blocks or the connection degrades.

- **Impact on audio**: A single slow child causes its parent to buffer, potentially affecting all siblings and the parent's upstream path.
- **Complexity to fix**: Medium. Check `bufferedAmount` before sends, implement frame dropping for slow receivers.
- **Risk**: Low — can be done per-channel without protocol changes.

---

## MEDIUM

### 9. Heartbeat is too slow for audio streaming

2s interval / 4s timeout means a dead parent isn't detected for 2-4 seconds. For audio broadcast, that's 2-4 seconds of silence before reconnection even starts. Then add reconnection time (3-9s from item #4).

- **Complexity to fix**: Low. Reduce to 500ms/1.5s. But beware of false positives in background tabs where timers are throttled to 1s minimum.
- **Risk**: Medium — aggressive heartbeat increases false positive disconnections on throttled tabs.

### 10. `_respondedRequests` map grows unboundedly

`this._respondedRequests[requestId] = true` is never cleaned up. Over a long session with many joins/reconnects, this map grows without limit. Each entry is small (string key → boolean), but in a session with thousands of reconnects it accumulates.

- **Complexity to fix**: Low. Prune entries older than 60s (matching the stale request window), or use an LRU cache.
- **Risk**: Very low.

### 11. `_reconnectTimes` array grows unboundedly

Same pattern — timestamps are pushed but never pruned beyond the 2-minute window check.

- **Complexity to fix**: Low. Prune in `_getHealthScore`.
- **Risk**: Very low.

### 12. No tree rebalancing after churn

When mid-tree nodes leave and their children reconnect, the tree can become unbalanced — deep chains on one side, empty capacity on the other. The health score helps new joins pick better parents, but existing nodes never migrate to reduce depth.

- **Complexity to fix**: High. Periodic rebalancing requires controlled migration (disconnect child, let it rejoin at a better position) without disrupting audio.
- **Risk**: Medium — rebalancing causes temporary disruptions.

### 13. Mobile device considerations

The system relies on:
- WebRTC (works on mobile browsers but with more constrained ICE, battery drain from DTLS)
- `setInterval`/`setTimeout` (throttled in background tabs to 1s+ on iOS/Android)
- Continuous WebSocket connections (killed by mobile OS power management)
- Stable network (mobile networks switch between WiFi/cellular, causing ICE restarts)

No special handling for:
- Network type changes (WiFi → cellular)
- App backgrounding / tab suspension
- Battery optimization
- ICE restart on network change

- **Complexity to fix**: Medium. Add `navigator.connection` monitoring, visibility change handlers, ICE restart logic.
- **Risk**: Low — additive changes.

### 14. Ancestor chain grows with tree depth

The `_ancestors` array is sent with every mask update and every heartbeat-adjacent notification. In a deep tree (depth 10+), this is 10+ node IDs (~200+ bytes) serialized to JSON on every mask relay. Not a bandwidth issue per se, but it scales with tree size and propagates on every topology change.

- **Complexity to fix**: Low. Could use a bloom filter or hash chain instead of full ID list for large trees.
- **Risk**: Very low.

### 15. Response review 250ms batching adds latency to initial connection

`_reviewResponses` is delayed 250ms after the first response arrives, to batch responses and pick the best one. For audio streaming, this means every new connection waits an extra 250ms before ICE even starts.

- **Complexity to fix**: Low. Reduce to 50-100ms, or accept immediately if root responds (root is always optimal for level).
- **Risk**: Very low.

---

## LOW

### 16. No metrics or observability beyond Firebase reports

Reports go to Firebase every 5s. No structured logging, no time-series metrics, no alerting. For a production audio system you'd want:
- Connection setup latency histograms
- Audio gap / underrun counters per node
- Tree depth distribution
- Relay server connection count and bandwidth

- **Complexity**: Medium. Requires choosing a metrics backend.
- **Risk**: None — purely additive.

### 17. `window` reference in constructor

`index.js:110-111` binds `setTimeout`/`clearTimeout` to `window`. This fails in Node.js environments unless the caller passes explicit timeout functions (like relay-server.js does). Not a bug today, but fragile.

- **Complexity**: Low. Use `typeof window !== 'undefined' ? window : global`.
- **Risk**: Very low.

### 18. ES5 style codebase

The entire codebase uses `var`, `prototype`, `inherits`, and avoids ES6+ features. This works but makes the code harder to follow than it needs to be (no `class`, `const`/`let`, arrow functions, `async`/`await`, `Map`/`Set`).

- **Complexity**: Medium for a full rewrite, low for incremental modernization.
- **Risk**: Low — cosmetic, but affects maintainability.

### 19. Test suite requires VPN-off and same-machine constraints

All tests run in a single Chrome instance on one machine. WebRTC between same-page peers exercises only the loopback path. Real-world issues (NAT traversal, TURN fallback, asymmetric bandwidth, high-latency links) are never tested.

- **Complexity**: High for a multi-machine test setup. Medium for adding TURN and network simulation.
- **Risk**: Low — functional correctness is well-tested; it's real-world resilience that's missing.

### 20. No TURN server configuration

`peerConfig` is passed through but there's no default TURN configuration. In production, ~10-15% of WebRTC connections require TURN to traverse symmetric NATs (common on corporate networks and mobile carriers). Without TURN, those connections fall to the relay server — acceptable if the relay is always running, but it concentrates load.

- **Complexity**: Low to add. Cost concern: TURN bandwidth is expensive.
- **Risk**: Low.

---

## Summary Table

| # | Issue | Severity | Complexity | Risk |
|---|-------|----------|-----------|------|
| 1 | Root SPOF | Critical | High | High |
| 2 | Reliable data channels (HOL blocking) | Critical | Low | Low |
| 3 | No audio transport layer | Critical | High | Medium |
| 4 | Firebase signaling latency | Critical | High | High |
| 5 | Tree depth cumulative latency | High | Medium | Medium |
| 6 | Single relay server | High | High | Medium |
| 7 | No auth/encryption on relay | High | Medium | Context-dependent |
| 8 | No backpressure/flow control | High | Medium | Low |
| 9 | Heartbeat too slow for audio | Medium | Low | Medium |
| 10 | Unbounded `_respondedRequests` | Medium | Low | Very low |
| 11 | Unbounded `_reconnectTimes` | Medium | Low | Very low |
| 12 | No tree rebalancing | Medium | High | Medium |
| 13 | Mobile device handling | Medium | Medium | Low |
| 14 | Ancestor chain size | Medium | Low | Very low |
| 15 | 250ms response batching | Medium | Low | Very low |
| 16 | No metrics/observability | Low | Medium | None |
| 17 | `window` reference | Low | Low | Very low |
| 18 | ES5 codebase style | Low | Medium | Low |
| 19 | Single-machine tests only | Low | High | Low |
| 20 | No TURN configuration | Low | Low | Low |

The tree topology, signaling, and resilience logic are solid for a data broadcasting system. The biggest gaps are all audio-specific: unreliable channel mode, audio framing/codec layer, root redundancy, and latency budget management. Items 2, 9, and 15 are quick wins. Items 1, 3, and 4 require architectural decisions before implementation.
