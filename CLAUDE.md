# Fireflower

P2P broadcasting system using WebRTC data channels in a K-ary tree topology, with Firebase Realtime Database for signaling.

## Architecture

- **index.js** — `Node` class. Manages tree membership, upstream/downstream connections, health tracking, signaling via Firebase.
- **peer.js** — `Peer` class. Thin wrapper around `RTCPeerConnection`. Handles offer/answer/ICE signaling. Does NOT auto-negotiate; caller must create data channels then call `peer.negotiate()`.
- **server-transport.js** / **server-peer-adapter.js** / **channel-shim.js** — WebSocket-based server fallback transport for nodes that can't do P2P.
- **relay-server.js** — Node.js WebSocket relay server that joins the tree as a regular node (level 1 child of root).
- **example/** — Browser demo app with 2D visualization.
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
- `notifications` — used for mask/config updates from parent to child

Both channels must be created BEFORE calling `peer.negotiate()` so they are included in the SDP offer.

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

## Build

```bash
npm run build          # builds example/build.js
cd visualizer && npm run build  # builds visualizer/share/build.js
```

## Running

```bash
# Terminal 1: Example app (port 8080)
npx http-server example -p 8080

# Terminal 2: Visualizer (port 8081)
npx http-server visualizer/share -p 8081

# Terminal 3: Relay server (port 8082)
node relay-server.js
```
