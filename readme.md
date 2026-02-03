# fireflower
[K-ary trees](http://en.wikipedia.org/wiki/K-ary_tree) of [RTCDataChannel](http://www.w3.org/TR/webrtc/#rtcdatachannel) connected nodes.

## Why
Scalable broadcasting for streams of live data.

## How
* Native [WebRTC](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API) for peer node `RTCDataChannel` connections.
* [Firebase Realtime Database](https://firebase.google.com/docs/database) for `RTCPeerConnection` signaling.
* WebSocket relay server for fallback when P2P connections fail.
* Health-aware routing to prefer stable, low-load parents.

## Setup

### Prerequisites
* Node.js 18+
* A Firebase project with Realtime Database enabled

### Firebase Configuration
1. Go to https://console.firebase.google.com
2. Create a new project (or use an existing one)
3. Go to Build > Realtime Database > Create Database
4. Choose a location and start in **test mode** for development
5. Go to Project Settings > General > Your apps > Add app (Web)
6. Copy the config values into `example/firebase-config.js` (see `firebase-config.example.js`)

### Install
```
$ npm install
```

## Development

Start the example app and relay server:
```
$ npm run dev
```

| Server | Port | Script |
|--------|------|--------|
| Example app (2D) | 8080 | `npm run dev:app` |
| Relay server | 8082 | `npm run dev:relay` |
| 3D Visualizer | 8081 | `npm run dev:viz` |

Run just the example app without the relay server (pure P2P):
```
$ npm run dev:p2p
```

For the 3D visualizer, clone [fireflower-visualizer](https://github.com/common-tater/fireflower-visualizer) alongside this repo and run `npm run dev:viz`, or `npm run dev:all` to start everything together.

## Example
```
$ cp example/firebase-config.example.js example/firebase-config.js
# Edit example/firebase-config.js with your Firebase project config
$ npm run dev
```

Open http://localhost:8080 in your browser. Click the canvas to add peer nodes and watch the K-ary tree form in real-time. Works on desktop browsers and mobile (Chrome on Android, Safari on iOS).

Use `?path=<name>` to run on a different Firebase path (default: `tree`). Multiple tabs with different paths are fully independent trees.

### Relay Server
The relay server joins the tree as a level-1 child of root via WebRTC, then accepts client connections via WebSocket. Nodes that can't establish P2P connections will fall back to the server automatically.

Options:
```
$ node relay-server.js --port 8082 --firebase-path tree
```

### Controls
The example app provides UI controls:
- **K** — Maximum downstream connections per node
- **Server** — Enable/disable the relay server (via Firebase config)
- **Force Server** — Force new nodes to use server transport only
- **Reset** — Disconnect all nodes and clear Firebase data

## Visualization
The example app includes a 2D canvas visualization. Open http://localhost:8081 for a 3D visualization of the network topology.

- Gray lines = P2P connections
- Green lines = server connections
- Node colors reflect health score (green = healthy, red = struggling)

## Testing
Automated test suite using Puppeteer with 40 scenarios:

```
$ npm test           # Run all scenarios
$ node test/run.js 3 # Run a single scenario
```

Tests launch a visible Chrome browser so you can watch nodes connect in the 2D visualizer while scenarios execute. The test runner manages the example server, relay server, and Firebase state automatically. Tests use an isolated Firebase path (`test-tree`) so they don't interfere with manual testing.

**Note:** WebRTC connections may fail when a VPN is active. VPN tunnel interfaces often use CGNAT addresses (e.g., `100.64.x.x`) that cannot hairpin UDP traffic, causing all P2P connections to silently fail (ICE state goes to `failed`). Disable your VPN before running tests or developing locally.

### Scenarios
1. Basic P2P Tree (K=2)
2. Server Fallback
3. Force Server Mode
4. Force Server OFF → P2P Upgrade
5. Server Toggle OFF → P2P Reconnect
6. Rapid Joins (K=2)
7. K Change Mid-Session
8. Node Departure & Recovery
9. Mixed Transport Tree
10. Large Tree (K=3)
11. WebSocket Reconnection
12. Disconnect All & Reconnect
13. Server Fallback on Mid-Tree Disconnect
14. Heartbeat Pause → Fallback → Resume → Recovery
15. Server Info Cached After Server Seen
16. Rapid Disconnects with Server Fallback
17. Server-First Connection + P2P Upgrade
18. Force Server Downgrade (P2P → Server)
19. Force Server ON then OFF (roundtrip)
20. Simultaneous Server→P2P Upgrades
21. Transitive Circle Prevention During Upgrades
22. Minimal Server→P2P Switch
23. Server-First Prefers Server Over P2P Root
24. Upgrade Skips Root
25. K Limit Enforced Under Rapid Connections
26. Server-First Reconnection After Mid-Tree Disconnect
27. Server Capacity Limit
28. Direct Server Reconnect on Mid-Tree Disconnect
29. Concurrent Direct Server Reconnects
30. Direct Server Reconnect Blocked by Server Capacity
31. Ancestor Chain Integrity After Direct Server Reconnect
32. Root Protection: Nodes Connect Through Relay, Not Root
33. Deep Line Recovery (K=1)
34. Relay Server Restart Handling
35. K Decrease Prunes Excess Children
36. Cascade Disconnect During Reconnection
37. Data Integrity During Topology Changes
38. Continuous Churn (Join/Leave Overlap)
39. Late Joiner Receives Data
40. Flash Crowd (Mass Simultaneous Join)

## Build
```
$ npm run build
```

## Require
```javascript
var firebase = require('firebase/app')
var firebaseDb = require('firebase/database')

var app = firebase.initializeApp({ /* your config */ })
var db = firebaseDb.getDatabase(app)

var fireflower = require('fireflower')(db)
```

## Constructor
```javascript
var node = fireflower('database/path' [, opts])
```

Where `opts` can be:
```javascript
{
  id: '0',                            // string, optional
  root: true,                         // boolean, optional, root node
  K: 2,                               // int, optional, max downstream connections
  reportInterval: 5000,               // int, optional, health report interval (ms)
  connectionTimeout: 5000,            // int, optional, P2P connection timeout (ms)
  isServer: false,                    // boolean, optional, relay server node
  serverUrl: 'ws://localhost:8082',   // string, optional, relay server URL
  serverOnly: false,                  // boolean, optional, only use server transport
  p2pUpgradeInterval: 30000,          // int, optional, delay before P2P upgrade (ms)
  peerConfig: {                       // object, optional, RTCPeerConnection config
    iceServers: [
      {
        urls: 'stun:stun.l.google.com:19302'
      }, {
        urls: 'turn:global.turn.twilio.com:3478?transport=udp',
        username: 'xxx',
        credential: 'yyy'
      }
    ]
  },
  channelConfig: {                    // object, optional, RTCDataChannel properties
    ordered: true,
    maxRetransmits: 3,
    maxPacketLifeTime: 500
  }
}
```

## Properties
- `node.id` — Unique node identifier
- `node.state` — `'disconnected'` | `'requesting'` | `'connecting'` | `'connected'`
- `node.transport` — `'p2p'` | `'server'` | `null`
- `node.upstream` — Upstream peer or `null`
- `node.downstream` — Map of downstream peers
- `node.K` — Get/set maximum downstream connections

## Methods
#### `node.connect()`
Publish a request to join the tree. If disconnected, instances will republish their request to join.

#### `node.disconnect()`
Disconnect and halt any attempts to reconnect.

#### `node.send(data)`
Broadcast data to all downstream peers via the `_default` data channel. Data flows strictly downward through the tree (root → leaves). Each intermediate node automatically relays to its children.

#### `node.blacklist.add(id)`
#### `node.blacklist.remove([id])`
#### `node.blacklist.contains(id)`

## Events
#### `node.emit('data', data)`
Received broadcast data from upstream. Emitted on every node in the tree as data flows from root to leaves.

#### `node.emit('connect', peer)`
An upstream node has responded to the instance's request to join the tree and has established an `RTCDataChannel` connection.

#### `node.emit('disconnect', peer)`
Connection to upstream node was lost.

#### `node.emit('fallback')`
Switched from P2P to server relay transport.

#### `node.emit('upgrade')`
Upgraded from server relay back to P2P transport.

#### `node.emit('peerconnect', peer)`
Response to a connection request was accepted and a downstream node was connected.

#### `node.emit('peerdisconnect', peer)`
The connection to a downstream node was lost.

#### `node.emit('statechange')`
Node state changed (check `node.state`).

#### `node.emit('configure')`
Configuration data was read for the first time or updated.

#### `node.emit('error', error)`
A configuration error occurred.

## Files
| File | Description |
|------|-------------|
| `index.js` | Node class — tree membership, signaling, health |
| `peer.js` | WebRTC peer connection wrapper |
| `server-transport.js` | WebSocket client transport |
| `server-peer-adapter.js` | WebSocket server-side peer adapter |
| `channel-shim.js` | DataChannel-like shim for WebSocket |
| `relay-server.js` | WebSocket relay server |
| `example/` | 2D visualizer demo app |
| [`fireflower-visualizer`](https://github.com/common-tater/fireflower-visualizer) | 3D Three.js visualizer (separate repo) |
| `test/` | Automated Puppeteer test suite |

## Browser Support
Tested on modern browsers with WebRTC support:
* Chrome (desktop and Android)
* Firefox
* Safari (desktop and iOS)
* Edge

## Roadmap
See [ROADMAP.md](ROADMAP.md) for future plans, ideas, and considerations (video support, adaptive upgrades, test coverage).

## License
MIT
