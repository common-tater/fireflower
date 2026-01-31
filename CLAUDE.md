# Fireflower

P2P broadcasting system using WebRTC data channels in a K-ary tree topology, with Firebase Realtime Database for signaling.

## Architecture

- **index.js** — `Node` class. Manages tree membership, upstream/downstream connections, health tracking, signaling via Firebase.
- **peer.js** — `Peer` class. Thin wrapper around `RTCPeerConnection`. Handles offer/answer/ICE signaling. Does NOT auto-negotiate; caller must create data channels then call `peer.negotiate()`.
- **server-transport.js** / **server-peer-adapter.js** / **channel-shim.js** — WebSocket-based server fallback transport for nodes that can't do P2P.
- **relay-server.js** — Node.js WebSocket relay server that joins the tree as a regular node (level 1 child of root).
- **example/** — Browser demo app with 2D visualization. Shows server node status (green=online, red=offline).
- **example/src/graph.js** — 2D graph view. Watches Firebase reports for server node presence and `serverEnabled` config. Shows red "OFFLINE" indicator when server is enabled but not reporting.
- **visualizer/** — 3D Three.js visualization of the tree, reads reports from Firebase.

## Key Patterns

### Signaling flow
1. Requester writes to `tree/requests/<pushId>` with its node ID
2. Responder sees request via `onChildAdded`, writes response to `tree/requests/<pushId>/responses/<responderId>`
3. Both sides exchange SDP offer/answer and ICE candidates via `requesterSignals` and `responderSignals` sub-paths
4. Requester removes `tree/requests/<pushId>` after connecting

### Initiator/Responder roles
The **responder** (parent node) is always the WebRTC **initiator** (creates the offer). The **requester** (child node) is the WebRTC **responder**. This is because the parent decides to accept the connection and starts the process.

### Data channels
Two data channels per connection:
- `_default` — general data channel
- `notifications` — used for mask/config updates and heartbeat from parent to child

Both channels must be created BEFORE calling `peer.negotiate()` so they are included in the SDP offer.

### Heartbeat (disconnect detection)
Parents send `{ type: 'heartbeat', t: <timestamp> }` every 2s over the `notifications` channel. Children have a 4s timeout; if it expires, they close the upstream peer and reconnect. An initial heartbeat timeout is started in `_onupstreamConnect` so that if a parent dies before sending its first heartbeat, the child still detects the failure (rather than sitting forever with no timeout running). The child's `notifications.onmessage` handler checks for `data.type === 'heartbeat'` vs mask updates (which have no `type` field). Heartbeat is purely P2P — no server involvement. Cleanup happens in `_ondownstreamDisconnect`, `_onupstreamDisconnect`, and `disconnect()`.

### Health system
Each node computes a health score (0-100) from:
- **Uptime** (30 pts) — time since last connection, ramps over 60s
- **Stability** (30 pts) — penalized by recent reconnects
- **Load** (20 pts) — downstream count relative to K
- **Level** (20 pts) — tree depth (closer to root = better)

Health is included in reports (for visualization) and responses (for routing). New nodes prefer healthier parents.

## Important Lessons

### Firebase event cascade race condition
When a node removes its Firebase request after connecting (`firebase.remove(requestRef)`), Firebase cascades the removal to all children **synchronously** in the same JS execution context. Any `onChildRemoved` listeners on child paths fire immediately, before the current event loop tick completes. Do NOT use `onChildRemoved` on response sub-paths to detect request withdrawal — it will fire during normal cleanup and kill the connection before ICE finishes.

### Dedup for Firebase onChildAdded replays
`firebase.onChildAdded` replays all existing children when first subscribed. If a listener is removed and re-added (e.g., during `_reviewRequests`), it replays everything. Use a `_respondedRequests` map keyed by request ID to prevent processing the same request twice. Do NOT delete entries from this map in `_ondownstreamDisconnect` — the Firebase remove is async and the request may still be visible during replay.

### Self-connection prevention
After connecting, a node calls `_reviewRequests` which subscribes to Firebase requests. Its own request may still exist (remove is async). The `_onrequest` handler must check `peerId === this.id` to prevent responding to its own request.

### Peer.negotiate() is explicit
`Peer` does NOT auto-negotiate in its constructor. The caller must:
1. Create the Peer
2. Create all data channels via `peer.createDataChannel()`
3. Call `peer.negotiate()` to generate the SDP offer

This ensures all channels are in the SDP. Previously, auto-negotiation in the constructor caused channels created afterward to not be in the offer.

### Peer failure during 'connecting' state causes stuck node
When a requester node accepts a response and calls `_connectToPeer`, `this.upstream` is not set until `_onupstreamConnect` fires (after ICE completes). If the P2P connection fails before that, `_onpeerDisconnect` checks `this.upstream === peer` which is false, silently ignoring the failure. The node gets permanently stuck in `'connecting'` state. Fix: in `_onpeerDisconnect`, if `state === 'connecting'` and the peer doesn't match downstream or upstream, reset to `'disconnected'` and schedule reconnect.

### Server node must never use server transport
The relay server IS the server — it must never try to connect via server transport. When `serverOnly` is set in Firebase config, the relay server's fireflower node would read it and try to connect to its own WebSocket. Guard with `this.isServer ? false : (this.opts.serverOnly || false)` so `isServer` nodes always ignore `serverOnly`.

### serverOnly must be reactive via Firebase config
The `serverOnly` flag controls whether nodes only accept server responses. It must be:
1. Stored in Firebase (`tree/configuration/serverOnly`) so all nodes can read it
2. Reactive in `_onconfig` — when it transitions from true to false, start the P2P upgrade timer
3. Written as `false` (not `null`) when disabling — `deepMerge` cannot clear keys from `null`

### Stale Firebase reports after reset/restart
Firebase reports persist until explicitly removed. After resetting or restarting the relay server, old server reports may still exist with recent-enough timestamps. When selecting a server node from reports, always pick the one with the most recent timestamp rather than the first match. For 2D visualization, server-connected nodes should fall back to the server's fixed position (120, height/2) if `graph.serverNode` isn't available yet.

### serverEnabled=false must clear serverOnly
When the server is disabled (`serverEnabled: false`), `serverOnly` becomes meaningless — there's no server to be "only" using. If `serverOnly` stays true, nodes can't connect via P2P either, causing them to get stuck. In `_onconfig`, override: `serverOnly = (serverEnabled && opts.serverOnly) || false`.

### Relay server auto-reconnect after reset
When the Reset button clears Firebase data and the root page refreshes, the relay server's upstream WebRTC connection becomes stale. The server should detect the ICE disconnect and reconnect to the new root. If the relay server gets stuck, restart it manually. The server's `onValue` config watcher keeps it responsive to enable/disable toggles.

### Upgrade requests must be cleaned up from Firebase
`_attemptUpgrade` publishes a secondary Firebase request to find P2P peers. When a response is accepted, the timeout handler (which normally cleans up the request) is cancelled. If the request is not explicitly removed after acceptance, it stays in Firebase permanently. Other nodes see it via `onChildAdded` replay and respond to a stale request, wasting resources and potentially creating unwanted connections. Fix: call `firebase.remove(upgradeRequestRef)` immediately after accepting a response in `_attemptUpgrade`.

### Circle prevention: child must never accept parent as downstream
The mask-based circle check (`peerId === this._mask`) does NOT work during normal steady-state operation because root never initializes `_mask` — it stays `undefined` for the entire tree. This means the only effective circle check is `peerId === this.id` (self-connection).

When two nodes both upgrade from server to P2P close together in time, a circle can form: Node A upgrades and connects to Node B as child. Then Node B's upgrade timer fires and publishes a request. Node A responds (it has capacity, the request is new, and the mask check fails). Node A becomes both child and parent of Node B. Mask updates then bounce infinitely between them (async loop via data channel `notifications.send()`), flooding the event loop, which starves heartbeat timers and causes the entire tree to collapse.

Fix: in `_onrequest`, always check `this.upstream && this.upstream.id === peerId`. A node must never accept its own upstream parent as a downstream child. This catches direct parent-child circles regardless of mask state.

### Server-first connection design
The `serverFirst` option (default: true) causes `_reviewResponses` to prefer server candidates over P2P when both are available. This gives nodes instant data through the relay server while P2P negotiation happens in the background via the upgrade timer. When no server is running, `serverCandidates.length` is 0 and the code falls through to the normal P2P path — P2P-only mode is completely unaffected. The `isServer` node always has `serverFirst: false` (it IS the server). Root also ignores it (root has no upstream).

### Force-server downgrade
When `serverOnly` transitions from false to true in `_onconfig`, existing P2P nodes must actively switch to server transport. The `_switchToServer` method closes the P2P upstream, sets state to `'requesting'`, and calls `_dorequest()`. Since `serverOnly` is now true, `_reviewResponses` only accepts server responses. Root is exempt from `serverOnly` (it IS the broadcaster): `this.serverOnly = (this.isServer || this.root) ? false : ...`.

### Server URL must be in Firebase config
`_serverInfo` (needed for server fallback and server-first) was previously only populated when a node happened to see a server response during `_reviewResponses`. Nodes that connected via P2P on first try never got it. The relay server now writes `serverUrl` to `tree/configuration/serverUrl` on connect and removes it on disconnect. Every node picks it up via `_onconfig` — no new subscriptions needed.

### Upstream-also-responded filter must not apply to server candidates
In `_reviewResponses`, there's a filter: `if (candidates[c.upstream]) continue` — "if your upstream also responded, skip you and prefer the higher node." This makes sense for P2P (prefer level-1 over level-2) but must NOT apply to server candidates. The relay server is always a child of root. Root always responds to requests. So this filter **always** skips the server candidate when root also responded. The fix: only apply the upstream filter to P2P candidates, never to server candidates. This was invisible before server-first and force-server because the server candidate was rarely needed in `_reviewResponses` (fallback used its own separate request/response flow).

### Simultaneous upgrade thundering herd causes circles and stuck nodes
When many nodes connect via server around the same time, their P2P upgrade timers fire simultaneously. Each publishes an upgrade request AND responds to other nodes' upgrade requests (server-connected nodes DO respond to requests). This creates a race: node A accepts node B as downstream (via `_onrequest`), while B's upgrade gets a P2P response from A, so B tries to make A its upstream. Now A is both B's parent and child. Fix at two levels: (1) `_attemptUpgrade`'s `onUpgradeResponse` rejects responses from nodes already in downstream; (2) `_onpeerConnect` handles the collision when `state === 'connecting'` and `downstream[peer.id]` exists but is a *different peer object* (`!== peer`) — closes the stale downstream and promotes to upstream. The `!== peer` check is critical: without it, normal downstream peers completing ICE while the node happens to be in `connecting` state get incorrectly promoted to upstream, breaking reconnection. Also add random jitter (0-25% of interval) to upgrade timers to spread out the upgrade attempts.

### Initial heartbeat timeout prevents stuck children
The heartbeat timeout (`_onheartbeat`) is started only when a heartbeat message is received. But the parent sends its first heartbeat after a 2s interval. If the parent dies before sending any heartbeat, the child never starts a timeout and sits forever with `state: 'connected'` but a dead upstream. Fix: start an initial heartbeat timeout in `_onupstreamConnect` for P2P connections. The first actual heartbeat resets this timeout via `_onheartbeat`.

### Do not enable debug module in production
The `debug` npm module (`require('debug')('fireflower')`) is used throughout `index.js`. Setting `localStorage.debug = 'fireflower'` enables all debug output to console. With many nodes and frequent events (config changes, requests, mask updates), this generates hundreds of thousands of log lines. The example app should NOT set `localStorage.debug` — it floods the browser console and the on-screen debug overlay.

### Firebase onValue fires immediately in constructors
`firebase.onValue` replays the current value synchronously when first subscribed. If subscribed during a constructor (e.g., `GraphView._watchServerNode`), the callback fires before the constructor returns. Any method called from the callback (like `render()`) sees uninitialized state (`this.K` undefined, `this.width` unset). Guard with null checks: `if (this.K != null)` before setting K, `if (this.width)` before rendering.

### Relay server must use onDisconnect for cleanup
When the relay server process is killed (SIGKILL, crash), normal cleanup handlers (`node.on('disconnect')`, `process.on('SIGINT')`) don't fire. Firebase data like `serverUrl` and the server's report linger, making clients think the server is still online. Use Firebase's `onDisconnect()` API to register server-side cleanup that runs automatically when the Firebase client connection drops. The relay server now calls `onDisconnect(serverUrlConfigRef).remove()` and `onDisconnect(reportRef).remove()` after writing these values.

### Server online detection uses serverUrl config, not report timestamps
The 2D visualizer detects whether the relay server is running by watching `configuration/serverUrl` in Firebase — not by checking report timestamps. The relay server writes `serverUrl` on connect and removes it on disconnect (with `onDisconnect` as backup). Report timestamps are unreliable because `onValue` only fires on data changes, not on time passing, so a stale report can look fresh on page load. The `serverUrl` presence/absence is a binary signal that updates reactively.

### Debug ring buffer for post-mortem diagnostics
Each node has a `_debugLog` array (ring buffer, last 50 entries) that captures key events: request skips with reasons, upstream connect/disconnect, state transitions. These write to the buffer only (no console output) so they're silent during normal operation. The test helper `waitForAll` dumps the ring buffer in timeout error messages, making it possible to diagnose stuck nodes after the fact.

## Build

```bash
npm run build          # builds example/build.js
cd visualizer && npm run build  # builds visualizer/share/build.js
```

## Running

```bash
# Terminal 1: Example app (port 8080)
node example/server.js

# Terminal 2: Visualizer (port 8081)
cd visualizer && npm start

# Terminal 3: Relay server (port 8082)
node relay-server.js
```

### Configurable Firebase path
The example app reads `?path=<name>` from the URL query string, defaulting to `'tree'`. This enables multiple independent trees on the same Firebase database — each path gets its own requests, reports, configuration, and node space. The 3D visualizer also supports path via URL pathname (e.g., `http://localhost:8081/my-path`).

## Testing

Automated test suite using Puppeteer that runs 20 scenarios with a visible browser:

```bash
npm test           # Run all 20 scenarios
node test/run.js 3 # Run only scenario 3
```

The test runner:
1. Builds the example app
2. Starts the example server (port 8080) and relay server (port 8082) as child processes
3. Launches Chrome with `headless: false` so you can watch the 2D visualizer
4. Runs each scenario sequentially with automatic reset between them
5. Reports pass/fail for each scenario

Tests use the isolated Firebase path `test-tree` (not the default `tree`) so they don't interfere with manual testing. The relay server is also started with `--firebase-path test-tree`.

Open the 3D visualizer at `http://localhost:8081/test-tree` in a separate tab to watch tests in 3D.

### Test files
- `test/run.js` — Main test runner with all 20 scenarios
- `test/helpers.js` — Shared utilities (addNodes, waitForAllConnected, setK, etc.); `TEST_PATH` constant defines the isolated path

### Scenarios
1. Basic P2P Tree (K=2) — 6 nodes, all P2P
2. Server Fallback — nodes connect with relay server available
3. Force Server Mode — all nodes use server transport
4. Force Server OFF → P2P Upgrade — server nodes upgrade to P2P
5. Server Toggle OFF → P2P Reconnect — server-connected nodes switch to P2P
6. Rapid Joins (K=2) — 8 nodes added quickly
7. K Change Mid-Session — K=2→4 with nodes
8. Node Departure & Recovery — mid-tree node removal
9. Mixed Transport Tree — some server, some P2P
10. Large Tree (K=3) — 12 nodes
11. WebSocket Reconnection — clients detect server disconnect, fall back to P2P
12. Disconnect All & Reconnect — remove and re-add nodes
13. Server Fallback on Mid-Tree Disconnect — orphans fall back to server, then upgrade to P2P
14. Heartbeat Pause → Fallback → Resume → Recovery
15. Server Info Cached After Server Seen
16. Rapid Disconnects with Server Fallback
17. Server-First Connection + P2P Upgrade — nodes connect via server first, then upgrade to P2P
18. Force Server Downgrade (P2P → Server) — toggle serverOnly ON, all P2P nodes switch to server
19. Force Server ON then OFF (roundtrip) — P2P → server → P2P
20. Simultaneous Server→P2P Upgrades — many nodes upgrade at once, no circles or stuck nodes
