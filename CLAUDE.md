# Fireflower

P2P broadcasting system using WebRTC data channels in a K-ary tree topology, with Firebase Realtime Database for signaling.

## Architecture

- **index.js** — `Node` class. Manages tree membership, upstream/downstream connections, health tracking, signaling via Firebase.
- **peer.js** — `Peer` class. Thin wrapper around `RTCPeerConnection`. Handles offer/answer/ICE signaling. Does NOT auto-negotiate; caller must create data channels then call `peer.negotiate()`.
- **server-transport.js** / **server-peer-adapter.js** / **channel-shim.js** — WebSocket-based server fallback transport for nodes that can't do P2P.
- **relay-server.js** — Node.js WebSocket relay server that joins the tree as a regular node (level 1 child of root).
- **example/** — Browser demo app with 2D visualization. Shows server node status (green=online, red=offline).
- **example/src/graph.js** — 2D graph view. Watches Firebase reports for server node presence and `serverEnabled` config. Shows red "OFFLINE" indicator when server is enabled but not reporting.
- **[fireflower-visualizer](https://github.com/common-tater/fireflower-visualizer)** — Separate repo. 3D Three.js visualization of the tree, reads reports from Firebase. Clone alongside this repo and run on port 8081. Features diagnostic overlays for node health, network stats (max depth, disconnected count), and detailed node info on click.

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

### Upgrade requests must be cleaned up from Firebase (but not too early)
`_attemptUpgrade` publishes a secondary Firebase request to find P2P peers. When a response is accepted, the timeout handler (which normally cleans up the request) is cancelled. If the request is not explicitly removed after acceptance, it stays in Firebase permanently. Other nodes see it via `onChildAdded` replay and respond to a stale request, wasting resources and potentially creating unwanted connections. However, `firebase.remove(upgradeRequestRef)` must NOT be called immediately — the remove cascades to the entire subtree including the response's `requesterSignals`/`responderSignals` paths that both sides need for ICE negotiation. Removing too early kills the signal exchange and the connection fails. Fix: defer `firebase.remove(upgradeRequestRef)` until the peer emits `connect` (success) or `close` (failure). Use `_connectToPeer`'s return value (the peer object) to attach these listeners.

### Circle prevention: ancestor chain for transitive circle detection
The original mask-based circle check (`peerId === this._mask`) only carried a single ancestor ID and root never initialized `_mask`, so it stayed `undefined` for the entire tree. The direct parent check (`this.upstream.id === peerId`) only catches 2-node circles (A ↔ B). With simultaneous P2P upgrades from server, N-node circles can form: A → B → C → D → A. This happens when multiple server-connected nodes upgrade at the same time — they respond to each other's requests and form a web of connections where the mask hasn't propagated yet.

Fix: propagate a **full ancestor list** through mask updates instead of just a single ID. Each node's `_ancestors` array contains the IDs of every node between it and root. In `_ondownstreamConnect`, the parent sends `{ mask, level, ancestors: [...this._ancestors, this.id] }`. In `_onrequest`, the check `this._ancestors.indexOf(peerId) !== -1` catches any transitive ancestor trying to become a child, regardless of how many hops away. Root initializes `_mask = this.id`, `_level = 0`, `_ancestors = []` in `_doconnect`. When a subtree disconnects, `_onupstreamDisconnect` sets `ancestors: [this.id]` so descendants know their disconnected subtree root.

The direct parent check (`this.upstream.id === peerId`) is kept as a fast path alongside the ancestor check.

### Server-first must be checked before P2P root acceptance in _reviewResponses
In `_reviewResponses`, root's response has no `upstream` field, so it goes into `p2pRoots`. The original code accepted `p2pRoots` immediately (line ~590) BEFORE the server-first check (line ~632). This meant server-first was dead code whenever root responded — root always won. Fix: split candidates into P2P and server lists BEFORE the P2P root acceptance block. Check `this.serverFirst && serverCandidates.length` first, and only fall through to P2P root acceptance if server-first doesn't apply.

### Server-first connection design
The `serverFirst` option (default: true) causes `_reviewResponses` to prefer server candidates over P2P when both are available. This gives nodes instant data through the relay server while P2P negotiation happens in the background via the upgrade timer. When no server is running, `serverCandidates.length` is 0 and the code falls through to the normal P2P path — P2P-only mode is completely unaffected. The `isServer` node always has `serverFirst: false` (it IS the server). Root also ignores it (root has no upstream).

### Server-first response batching resets on each new response
When `serverFirst` is active, `_onresponse` resets the 500ms batch timer on each new response, capped at 1500ms total from the first response. Root's P2P response arrives faster than the relay server's response (Firebase signaling is faster than WebSocket setup). The original design started a single 250ms timer on the first response — subsequent responses didn't reset it. This worked for initial connections but failed during reconnection storms: when a mid-tree node disconnects, all downstream nodes reconnect simultaneously. The relay server, busy handling multiple reconnections, responds slower than 500ms after root. By resetting the timer on each new response, the server gets a fair chance to respond even when it's under load. The 500ms window (up from 250ms) gives the relay server more headroom under heavy reconnection load at the cost of slightly slower initial connections. The 1500ms cap prevents indefinite waiting when no server is running. Non-serverFirst nodes still use the fast 100ms window (no reset).

### Relay server needs longer batching window to connect to root
The relay server has `serverFirst: false` (it IS the server), so `_onresponse` uses the fast 100ms batching window. Root and level-1 nodes both see the server's request via Firebase. If a level-1 node's response arrives within 100ms but root's response takes longer, `_reviewResponses` fires with only `p2pCandidates` (no `p2pRoots`) and accepts the level-1 node instead of root. Fix: when `this.isServer`, use a 500ms batching window. The relay server only connects once at startup (or on reconnect), so the extra delay is negligible. This ensures root's response arrives before the review, and the priority logic (`p2pRoots` before `p2pCandidates`) correctly selects root.

### Root must always stay subscribed to requests (for server)
When root reaches K capacity, `_ondownstreamConnect` unsubscribes from Firebase requests. But the relay server's `isServer` exception in `_onrequest` (bypasses K check) only works if root receives the request. If root already unsubscribed, it never sees the server's request, and the relay server connects to a non-root node instead. Fix: root never unsubscribes from requests — `_ondownstreamConnect` and `_reviewRequests` both skip the unsubscribe/full check when `this.root`. The per-request K check in `_onrequest` still rejects regular nodes at capacity, so root doesn't accept unlimited children.

### Relay server gets a free slot on root (doesn't count toward K)
The relay server peer is tagged with `_isServerPeer = true` when root responds to its `isServer` request. All K-counting code on root (`_onrequest`, `_ondownstreamConnect`, `_reviewRequests`, K setter pruning) excludes `_isServerPeer` peers. The free slot only applies on root — non-root nodes count the server normally.

### Root sets K=0 when server is online
When root sees `serverUrl` in Firebase config (relay server is online), it sets K=0 via `_onconfig`. Combined with the server's free slot, root accepts only the relay server — all regular peers are funneled through the relay. This preserves root's bandwidth for broadcasting. At most one server-connected node will remain on server transport permanently. Here's why: when upgrade timers fire, server-connected nodes find each other via Firebase and form P2P parent-child relationships. As each node upgrades, it becomes a descendant of whichever node accepted it. The last node still on server ends up as the ancestor of every other node in the P2P sub-tree — it can't upgrade because (a) `_attemptUpgrade` skips root to preserve broadcaster bandwidth, and (b) every other node is its descendant, so connecting to any of them would create a circle (blocked by ancestor chain check). This is correct behavior — the relay server always has at least one direct child, and that child serves as the sub-tree root for all the P2P nodes beneath it. When `serverUrl` disappears (server offline), root restores K to the user-configured value so peers can form a direct P2P tree. The user-set K is tracked in `_baseK` separately from `opts.K` since `deepMerge` overwrites `opts.K` on every config change.

### Relay server K must be preserved across config changes
`_onconfig` calls `deepMerge(this.opts, data)` which overwrites `opts.K` with the Firebase config K (the user-facing K for regular nodes, e.g., 2). The relay server starts with K=1000 to handle many children, but `deepMerge` clobbers it to 2 on every config change, causing the server to reject connections at 2 children. Fix: save and restore `opts.K` around `deepMerge` when `this.isServer`. Root already has its own K management via `_baseK`.

### K value written to Firebase for 3D visualizer
The 3D visualizer reads `configuration/K` from Firebase to display the current K. The example app's `onkchanged()` writes K to Firebase when the user changes it. This is purely for visualization — nodes still receive K directly via `opts.K` at construction time. The system works without Firebase state for K.

### Force-server downgrade
When `serverOnly` transitions from false to true in `_onconfig`, existing P2P nodes must actively switch to server transport. The `_switchToServer` method closes the P2P upstream, sets state to `'requesting'`, and calls `_dorequest()`. Since `serverOnly` is now true, `_reviewResponses` only accepts server responses. Root is exempt from `serverOnly` (it IS the broadcaster): `this.serverOnly = (this.isServer || this.root) ? false : ...`.

### Server URL must be in Firebase config
`_serverInfo` (needed for server fallback and server-first) was previously only populated when a node happened to see a server response during `_reviewResponses`. Nodes that connected via P2P on first try never got it. The relay server now writes `serverUrl` to `tree/configuration/serverUrl` on connect and removes it on disconnect. Every node picks it up via `_onconfig` — no new subscriptions needed.

### Relay server must advertise LAN IP, not 0.0.0.0
The relay server's `serverUrl` is written to Firebase config and included in response data. Nodes use it to open a WebSocket connection to the relay server. If the URL is `ws://0.0.0.0:8082`, same-machine browsers resolve it to localhost and it works. But remote devices (phones, other machines) interpret `0.0.0.0` as their own loopback — the WebSocket connection silently fails and the node falls back to P2P, never reaching the server. The relay server now auto-detects the LAN IP via `os.networkInterfaces()` and advertises that (e.g., `ws://192.168.86.41:8082`). Override with `--host <ip>` or `SERVER_HOST=<ip>` env var.

### Upstream-also-responded filter must not apply to server candidates
In `_reviewResponses`, there's a filter: `if (candidates[c.upstream]) continue` — "if your upstream also responded, skip you and prefer the higher node." This makes sense for P2P (prefer level-1 over level-2) but must NOT apply to server candidates. The relay server is always a child of root. Root always responds to requests. So this filter **always** skips the server candidate when root also responded. The fix: only apply the upstream filter to P2P candidates, never to server candidates. This was invisible before server-first and force-server because the server candidate was rarely needed in `_reviewResponses` (fallback used its own separate request/response flow).

### Simultaneous upgrade thundering herd causes circles and stuck nodes
When many nodes connect via server around the same time, their P2P upgrade timers fire simultaneously. Each publishes an upgrade request AND responds to other nodes' upgrade requests (server-connected nodes DO respond to requests). This creates a race: node A accepts node B as downstream (via `_onrequest`), while B's upgrade gets a P2P response from A, so B tries to make A its upstream. Now A is both B's parent and child. Fix at two levels: (1) `_attemptUpgrade`'s `onUpgradeResponse` rejects responses from nodes already in downstream; (2) `_onpeerConnect` handles the collision when `state === 'connecting'` and `downstream[peer.id]` exists but is a *different peer object* (`!== peer`) — closes the stale downstream and promotes to upstream. The `!== peer` check is critical: without it, normal downstream peers completing ICE while the node happens to be in `connecting` state get incorrectly promoted to upstream, breaking reconnection. Also add random jitter (0-25% of interval) to upgrade timers to spread out the upgrade attempts.

### Initial heartbeat timeout prevents stuck children
The heartbeat timeout (`_onheartbeat`) is started only when a heartbeat message is received. But the parent sends its first heartbeat after a 2s interval. If the parent dies before sending any heartbeat, the child never starts a timeout and sits forever with `state: 'connected'` but a dead upstream. Fix: start an initial heartbeat timeout in `_onupstreamConnect` for P2P connections. The first actual heartbeat resets this timeout via `_onheartbeat`.

### setTimeout/clearTimeout must be bound to global context
In browsers, `setTimeout` and `clearTimeout` throw `Illegal invocation` when called without the correct `this` context (e.g., `window`). The Node class stores them as `this._setTimeout` / `this._clearTimeout`, which strips the original binding. Use `setTimeout.bind(globalThis)` (with fallback to `window` or `global`) so it works in both browsers and Node.js. Do NOT use bare `setTimeout` without binding — it works in Node.js but fails in Chrome.

### Do not enable debug module in production
The `debug` npm module (`require('debug')('fireflower')`) is used throughout `index.js`. Setting `localStorage.debug = 'fireflower'` enables all debug output to console. With many nodes and frequent events (config changes, requests, mask updates), this generates hundreds of thousands of log lines. The example app should NOT set `localStorage.debug` — it floods the browser console and the on-screen debug overlay.

### Firebase onValue fires immediately in constructors
`firebase.onValue` replays the current value synchronously when first subscribed. If subscribed during a constructor (e.g., `GraphView._watchServerNode`), the callback fires before the constructor returns. Any method called from the callback (like `render()`) sees uninitialized state (`this.K` undefined, `this.width` unset). Guard with null checks: `if (this.K != null)` before setting K, `if (this.width)` before rendering.

### Relay server must use onDisconnect for cleanup
When the relay server process is killed (SIGKILL, crash), normal cleanup handlers (`node.on('disconnect')`, `process.on('SIGINT')`) don't fire. Firebase data like `serverUrl` and the server's report linger, making clients think the server is still online. Use Firebase's `onDisconnect()` API to register server-side cleanup that runs automatically when the Firebase client connection drops. The relay server now calls `onDisconnect(serverUrlConfigRef).remove()` and `onDisconnect(reportRef).remove()` after writing these values.

### Server online detection uses serverUrl config, not report timestamps
The 2D visualizer detects whether the relay server is running by watching `configuration/serverUrl` in Firebase — not by checking report timestamps. The relay server writes `serverUrl` on connect and removes it on disconnect (with `onDisconnect` as backup). Report timestamps are unreliable because `onValue` only fires on data changes, not on time passing, so a stale report can look fresh on page load. The `serverUrl` presence/absence is a binary signal that updates reactively.

### Firebase onDisconnect is one-shot — must re-register after reconnect
Firebase's `onDisconnect()` handlers fire when the SDK's persistent connection to the Firebase backend drops (network hiccup, keepalive timeout, etc.). They are one-shot: once triggered, they're gone. When the SDK reconnects, the `onDisconnect` has already removed `serverUrl`, but the relay server's fireflower node is still connected to the tree (P2P upstream is fine). The relay server must watch `.info/connected` and re-publish `serverUrl` + re-register `onDisconnect` whenever Firebase reconnects while the tree node is active. Without this, a brief Firebase connection blip permanently removes the server's online indicator.

### _reviewRequests must use connected count, not total count
`_reviewRequests` decides whether to re-subscribe to Firebase requests (i.e., resume accepting new children). It must use the count of **connected** downstream peers, not `Object.keys(this.downstream).length` (which includes pending peers still in ICE negotiation). During P2P upgrades, a node responds to many requests, creating pending downstream peers. Most never connect (the requester accepted a different response). These stale pending peers sit in `this.downstream` for up to `connectionTimeout` (5s). If `_reviewRequests` counts them, the node thinks it's at capacity and stops listening for requests — even though it has fewer than K connected children. This causes root isolation: root loses its connected children but can't accept new ones because pending peers block the resume check. The stop check in `_ondownstreamConnect` and the resume check in `_reviewRequests` must use the same metric (connected count).

### _ondownstreamConnect must close excess peers over K
When multiple pending peers complete ICE simultaneously, each one passed the `_onrequest` capacity gate while still pending (only connected peers count toward K). They all transition to `didConnect: true` around the same time, and each `_ondownstreamConnect` increments the connected count past K. Previously, `_ondownstreamConnect` only unsubscribed from new requests at capacity — it never closed excess peers. Fix: after counting connected peers, if `connected > K`, close the newly connected peer (it's the excess one) and return early before sending mask/heartbeat. The closed peer's child detects the disconnect via heartbeat timeout and reconnects elsewhere. This is distinct from the K setter's pruning (which handles K *decreasing*) — this handles K being *exceeded* by a connection race.

### Upgrade requests should skip root
When server-connected nodes upgrade to P2P via `_attemptUpgrade`, they should connect to other peers — not to root. Root's bandwidth is reserved for broadcasting. In `onUpgradeResponse`, filter out responses where `!response.upstream` (root has no upstream). This is one of two reasons the last server-connected node stays on server permanently — even if it's the only node left to upgrade, root is not a valid target. The other reason is circle prevention: all other nodes are its descendants in the P2P sub-tree (see "Root sets K=0 when server is online").

### VPN/CGNAT breaks same-machine WebRTC
WebRTC ICE candidates on a machine with an active VPN may only include the VPN tunnel's CGNAT address (e.g., `100.64.x.x` on `utun4`). Same-page WebRTC connections (used by the test suite and the example app's peer nodes) require UDP hairpin through the ICE candidate's interface. CGNAT addresses can't hairpin, so all P2P connections fail silently (ICE state goes to `failed`). Fix: disable VPN during development/testing, or configure the VPN to exclude local traffic. The test runner's Chrome flags (`--disable-features=WebRtcHideLocalIpsWithMdns`, `--allow-loopback-in-peer-connection`) help with mDNS but don't fix the CGNAT routing issue.

### Test runner auto-exits when stdin is not a TTY
When run from a background process, CI, or piped context (`!process.stdin.isTTY`), the test runner auto-closes the browser and exits after printing results. When run interactively from a terminal, it keeps the browser open for inspection and waits for Ctrl+C. This prevents zombie browser processes from accumulating during automated runs. Never run multiple test runners simultaneously on the same Firebase path — they share the same `test-tree` data and will interfere with each other.

### Use waitForAll instead of fixed waits in tests
Tests that wait for nodes to reach a specific state (e.g., all nodes upgrading from server to P2P) should use `waitForAll` with a polling function and generous timeout, not `h.wait(N)` with a fixed delay followed by assertions. Fixed waits are fragile — P2P upgrade timers have jitter (0-25%), ICE negotiation time varies, and server-first adds an extra hop. `waitForAll` polls every 500ms and gives a clear timeout error with debug log dumps if the condition isn't met.

### Debug ring buffer for post-mortem diagnostics
Each node has a `_debugLog` array (ring buffer, last 50 entries) that captures key events: request skips with reasons, upstream connect/disconnect, state transitions. These write to the buffer only (no console output) so they're silent during normal operation. The test helper `waitForAll` dumps the ring buffer in timeout error messages, making it possible to diagnose stuck nodes after the fact.

### Server-connected nodes MUST respond to requests (no blanket block)
Previously, server-connected nodes were blocked from responding to any request (`_onrequest` returned early when `this._transport === 'server'`). The rationale was that they'd fill K capacity before upgrading to P2P. This created a **deadlock**: when root is at K capacity (e.g., relay + ghost node from external browser tab), ALL server-connected nodes refuse to respond to upgrade requests, and root can't accept either — nobody can upgrade to P2P and the tree is stuck. The existing circle prevention (ancestor chain check, upstream check, downstream check in `_attemptUpgrade`) is sufficient to prevent cycles. Server nodes accepting children may cause those children to reconnect after upgrade, but the system handles reconnection gracefully.

### Stale Firebase requests from ghost nodes
If a node's process is killed or a browser tab is closed without proper cleanup, its Firebase request may persist. When a new root starts, it sees the stale request, responds, and potentially wastes a K slot on a dead or ghost node. Fix: requests include a `t` (timestamp) field. `_onrequest` ignores requests older than 60 seconds and removes them from Firebase. This prevents ghost nodes from occupying capacity after restarts or crashes.

### Ghost nodes from external browser tabs
When running tests with `?path=test-tree`, any other browser tab (e.g., user's Brave browser) open on the same path joins the same tree. These "ghost nodes" are LIVE nodes with fresh timestamps, so the 60s stale request check doesn't catch them. They can fill root's K capacity (e.g., K=2 with relay + ghost = FULL), blocking test nodes from upgrading to P2P. Ghost nodes are not a bug — they're legitimate nodes on the same tree. The system must be resilient to unexpected nodes consuming root capacity. Key insight: the upgrade deadlock was not caused by ghost nodes per se, but by the now-removed server-transport-no-respond restriction that prevented server-connected nodes from forming P2P sub-trees when root was full.

### Console.log strategy for index.js
Strategic console.logs remain in index.js **only** for topology-changing events: upstream/downstream connected/disconnected, `_dorequest` with full state, `RESPOND` (accepting a request), `_reviewResponses` with candidate counts, `_reviewRequests` decisions (SUBSCRIBING/FULL), `_attemptUpgrade`, and `serverOnly` transitions. Per-request diagnostics (SAW request, SKIP request, every _onresponse) go to the `_debugLog` ring buffer (via `this._log()`) to keep console output focused on connection topology. The ring buffer preserves full diagnostic data for post-mortem analysis via `waitForAll` timeout dumps. When debugging a specific issue, add temporary console.logs but remove them before committing.

### Zombie pending peers from serverOnly nodes block capacity
When `serverOnly` is true, nodes only accept server responses. But their Firebase requests are visible to all responders, including root and P2P nodes. Root responds to these requests, creating pending downstream peers. The `serverOnly` node ignores root's P2P response (it only wants server), but root's pending entry persists for `connectionTimeout` (5s). Previously, a `pendingCount >= K` cap in `_onrequest` blocked root from responding to ANY new requests while these zombie pending peers existed. Fix: remove the pending count cap entirely — the connected count cap (`connected >= K`) is the real gate. Zombie pending peers expire harmlessly after 5s.

### Requests include serverOnly flag to prevent wasted responses
Requests now include `serverOnly: this.serverOnly` in the request data. In `_onrequest`, non-server nodes skip requests where `request.serverOnly === true`. This prevents the zombie pending peer problem at the source — P2P nodes don't waste a downstream slot responding to a node that will ignore the response.

### Stale downstream entry blocks relay from responding to serverOnly requests
When the relay responds to a node's upgrade request, it creates a downstream entry with `didConnect: true`. If the node chose a different parent (e.g., root accepted faster), the relay's downstream entry becomes a zombie — ICE completed but the node uses a different upstream. When the node later publishes a `serverOnly` request (force-server switch), the relay's `_onrequest` sees `this.downstream[peerId]` exists with `didConnect: true` and silently returns (line 484: "already connected, must be upgrade request — skip it"). But this is a brand new request, not an upgrade. Fix: when `request.serverOnly && this.isServer`, close the stale downstream entry and respond to the new request. The `didConnect` skip is still correct for non-serverOnly requests (actual upgrade requests from connected children).

### Direct server reconnect bypasses Firebase signaling
When a node's P2P upstream dies and the node has cached `_serverInfo` (from a previous server-first connection), `_connectToServerDirect()` connects to the relay server's WebSocket immediately — no Firebase request/response round-trip needed. This shaves seconds off reconnection for orphaned nodes. The method creates a `ServerTransport` directly, and on success sets it as primary upstream with mask/heartbeat wiring, then starts the P2P upgrade timer. On failure or timeout, it falls back to `this.connect()` (normal Firebase path). The fast path triggers in `_onupstreamDisconnect` when: `peer.didConnect && _serverInfo && serverFirst && !_serverAtCapacity && !isServer && !root`.

### Relay server accepts cold WebSocket connections
When `_connectToServerDirect` connects to the relay server, there's no pending `ServerPeerAdapter` (normally created during Firebase request/response). The relay server handles this by creating an adapter on the fly when a WebSocket arrives with no pending adapter and `node.state === 'connected'`. It wires the adapter into `node.downstream`, creates the notifications channel, and triggers `_ondownstreamConnect` — the same flow as a normal Firebase-signaled connection. If `node.state !== 'connected'`, the connection is rejected (server is shutting down or not ready).

### serverOnly race condition: config change arrives after server disconnect
When force-server is toggled OFF and the server is disabled, two things happen: (1) the relay server shuts down, closing WebSocket connections instantly, and (2) the Firebase config change propagates to all nodes. The WebSocket close is immediate but the Firebase config takes a network round-trip. A node connected via server detects the disconnect first and calls `_dorequest` with stale `serverOnly=true`. Root sees the request but skips it (`request.serverOnly && !this.isServer`). Seconds later the config change arrives, setting `this.serverOnly = false`, but `_onconfig` only handled this transition when `state === 'connected'` and `transport === 'server'` — not when in `requesting` state. Fix: add a branch in `_onconfig` that detects `wasServerOnly && !this.serverOnly && this.state === 'requesting'` and restarts the request with the corrected `serverOnly=false` flag. The old request (with `serverOnly=true`) is removed from Firebase and a new one is published that P2P nodes can respond to.

### Relay server must publish serverId for direct server reconnect
`_connectToServerDirect` needs `this._serverInfo.id` (the relay server's node ID) to set `transport.id` on the created upstream peer. When `_serverInfo` was populated only from Firebase config (`_onconfig`), it only had `{ serverUrl }` — no `id`. The relay server now writes its node ID to `tree/configuration/serverId` alongside `serverUrl`, and removes it on disconnect (with `onDisconnect` backup). `_onconfig` builds `_serverInfo` as `{ id: data.serverId || null, serverUrl: data.serverUrl }`.

### Node _onconfig must explicitly sync serverCapacity
`deepMerge(this.opts, data)` only overwrites keys present in `data`. When `serverCapacity` is removed from Firebase config (user clears the input), the key is absent from the snapshot — `deepMerge` leaves the stale `opts.serverCapacity` untouched. Fix: in `_onconfig`, explicitly set `opts.serverCapacity = data.serverCapacity` when present, and `delete opts.serverCapacity` when absent. This ensures clearing the capacity limit in the UI actually takes effect on all nodes.

### Relay server updateServerCapacityState must use node.opts.serverCapacity
The relay server's `updateServerCapacityState` function must read capacity from `node.opts.serverCapacity` (updated by the Firebase config watcher), not the local `serverCapacity` variable (set from command line args only). The Firebase watcher sets `node.opts.serverCapacity` on config changes but the local variable never updates. Also, the guard must use `cap == null` (not `!cap`) — `!0` is true, so `serverCapacity=0` was silently skipped, preventing `serverAtCapacity=true` from being written to Firebase.

### setServerCapacity helper must handle 0 correctly
The test helper `setServerCapacity(page, value)` used `value || '∞'` for logging and `value || ''` for the input value. JavaScript's `||` treats `0` as falsy, so `setServerCapacity(page, 0)` displayed as `∞` and sent empty string (null) to Firebase. Fix: use `value != null ? value : '∞'` and `value != null ? value : ''`.

### Test assertions on debug log entries are fragile
The `_debugLog` ring buffer (50 entries) rotates entries when many events occur after reconnection (mask updates, config changes, request/response cycles). Tests checking for specific debug log entries (like `scheduling reconnect delay=`) may fail because the entry was pushed out. Prefer assertions on observable state (e.g., `directReconnects === 0` + `waitForAll` proving reconnection succeeded) over matching specific debug log strings. The `getNodeStates` helper reads `.slice(-50)` to capture the full ring buffer.

### Test timing: waitForAllConnected vs waitForAll for disconnect detection
`waitForAllConnected` checks that all nodes have `state === 'connected'`. After disconnecting a mid-tree node, its orphaned children are still in `connected` state until heartbeat timeout fires (~4s). `waitForAllConnected` returns immediately (all nodes report connected). By the time the assertion runs, the orphans haven't entered `_onupstreamDisconnect` yet, so their debug logs don't show reconnection entries. Fix: use `waitForAll` with a predicate that checks orphans have reconnected to a *different* upstream than the disconnected node.

### connectedDownstreamIds vs downstreamIds in test helpers
`downstreamIds` (from `Object.keys(node.model.downstream)`) includes pending peers still in ICE negotiation that never connect. These are stale entries from nodes that accepted a different response. Using `downstreamIds` to identify orphan children includes nodes that were never actually children. The `connectedDownstreamIds` field filters to only peers with `didConnect: true`, giving the actual connected children.

## Dev Environment Setup

### Firebase project
Both fireflower and fireflower-visualizer use the same Firebase Realtime Database: **fireflower-test-viz** (`fireflower-test-viz-default-rtdb`). Firebase config files are gitignored — copy from `firebase-config.example.js` and use the `fireflower-test-viz` project credentials. Auth via `firebase login` (CLI) — no `.env` file needed.

### Stale Firebase data
After crashes, resets, or switching machines, stale data in Firebase (old reports, stuck requests, ghost `serverUrl`) can prevent nodes from connecting. Clear it before manual testing:
```bash
firebase database:remove /tree --project fireflower-test-viz --instance fireflower-test-viz-default-rtdb --force
firebase database:set /tree/configuration --project fireflower-test-viz --instance fireflower-test-viz-default-rtdb --data '{"serverEnabled":true,"serverOnly":false}' --force
```

### Related repos
- **fireflower** — this repo, the core library + example app + relay server + tests
- **[fireflower-visualizer](https://github.com/common-tater/fireflower-visualizer)** — 3D visualizer, clone to `../fireflower-visualizer`. Independent app that reads the same Firebase database (no code dependency on fireflower). Needs `events` npm package installed for browser build.

### GitHub
Org: `common-tater`. PRs go to `common-tater/fireflower` and `common-tater/fireflower-visualizer`.

## Build

```bash
npm run build          # builds example/build.js
# Visualizer is a separate repo (fireflower-visualizer), build it there:
# cd ../fireflower-visualizer && npm run build
```

## Running

```bash
npm run dev        # example app (8080) + relay server (8082)
npm run dev:all    # above + 3D visualizer (8081) — requires ../fireflower-visualizer
npm run dev:p2p    # example app only, no relay server
npm run dev:viz    # 3D visualizer only — requires ../fireflower-visualizer
```

### Configurable Firebase path
The example app reads `?path=<name>` from the URL query string, defaulting to `'tree'`. This enables multiple independent trees on the same Firebase database — each path gets its own requests, reports, configuration, and node space. The 3D visualizer supports path via URL pathname (e.g., `http://localhost:8081/test-tree`), defaulting to `tree`.

## Testing

Automated test suite using Puppeteer with a visible browser:

```bash
npm test           # Run all scenarios
node test/run.js 3 # Run only scenario 3
```

The test runner:
1. Builds the example app
2. Starts the example server (port 8084) and relay server (port 8083) as child processes
3. Launches Chrome with `headless: false` so you can watch the 2D visualizer
4. Runs each scenario sequentially with automatic reset between them
5. Reports pass/fail for each scenario

Tests use isolated ports (8084 for example server, 8083 for relay) and the Firebase path `test-tree` so they don't interfere with manual testing on ports 8080/8082 with the default `tree` path. The test suite can run in parallel with manual testing.

Open the 3D visualizer at `http://localhost:8081/test-tree` in a separate tab to watch tests in 3D.

### Test files
- `test/run.js` — Main test runner with all scenarios
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
13. Server Fallback on Mid-Tree Disconnect — orphans fall back to server, most upgrade to P2P (at most 1 stays on server)
14. Heartbeat Pause → Fallback → Resume → Recovery
15. Server Info Cached After Server Seen
16. Rapid Disconnects with Server Fallback
17. Server-First Connection + P2P Upgrade — nodes connect via server first, most upgrade to P2P (at most 1 stays on server as relay sub-tree root)
18. Force Server Downgrade (P2P → Server) — toggle serverOnly ON, all P2P nodes switch to server
19. Force Server ON then OFF (roundtrip) — P2P → server → P2P
20. Simultaneous Server→P2P Upgrades — many nodes upgrade at once, no circles or stuck nodes (at most 1 stays on server)
21. Transitive Circle Prevention During Upgrades — verify ancestor chain prevents N-node circles (at most 1 stays on server)
22. Minimal Server→P2P Switch — 1 peer on forced server, server disabled, peer reconnects to root via P2P
23. Server-First Prefers Server, Stays When No Upgrade Target — verifies server-first picks server candidate over root, and peer stays on server when only upgrade target is root (preserves broadcaster bandwidth)
24. Upgrade Skips Root — server-connected nodes upgrade to each other, not to root
25. K Limit Enforced Under Rapid Connections — 8 rapid nodes, no node exceeds K=2 connected children
26. Server-First Reconnection After Mid-Tree Disconnect — orphans use server-first (direct or Firebase), most upgrade to P2P (at most 1 stays on server)
27. Server Capacity Limit — excess nodes beyond serverCapacity use P2P instead of server
28. Direct Server Reconnect on Mid-Tree Disconnect — orphans with cached `_serverInfo` use `_connectToServerDirect` fast path, verified via debug log
29. Concurrent Direct Server Reconnects — multiple orphans from same parent use direct server reconnect simultaneously, relay handles cold WebSocket connections
30. Direct Server Reconnect Blocked by Server Capacity — when `_serverAtCapacity=true`, orphans skip fast path and use normal Firebase reconnect
31. Ancestor Chain Integrity After Direct Server Reconnect — verify no node lists itself as ancestor and no circles form after orphans reconnect through relay
32. Root Protection: Nodes Connect Through Relay, Not Root — when relay is online (root K=0), new nodes connect through relay, never directly to root
33. Deep Line Recovery (K=1) — Verify line topology recovery after mid-chain disconnect (requires setServerCapacity(1) to force line structure).
34. Relay Server Restart Handling — Verify nodes reconnect to a new relay instance after the server process is killed and restarted.
35. K Decrease Prunes Excess Children — Reduce K from 3→1 with a full tree, verify pruned children reconnect and no node exceeds new K.
36. Cascade Disconnect During Reconnection — Disconnect a second parent while orphans from the first are still reconnecting; all nodes must recover with no circles.
