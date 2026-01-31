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

## Example
```
$ cp example/firebase-config.example.js example/firebase-config.js
# Edit example/firebase-config.js with your Firebase project config
$ npm run example
```

Open http://localhost:8080 in your browser. Click the canvas to add peer nodes and watch the K-ary tree form in real-time. Works on desktop browsers and mobile (Chrome on Android, Safari on iOS).

Use `?path=<name>` to run on a different Firebase path (default: `tree`). Multiple tabs with different paths are fully independent trees.

### Relay Server
Start the WebSocket relay server for server fallback transport:
```
$ node relay-server.js
```

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
The example app includes a 2D canvas visualization. For a 3D visualization of the network topology:

```
$ cd visualizer && npm install && npm start
```

Open http://localhost:8081 to see the live 3D tree with physics simulation.

- Gray lines = P2P connections
- Green lines = server connections
- Node colors reflect health score (green = healthy, red = struggling)

## Testing
Automated test suite using Puppeteer with 12 scenarios:

```
$ npm test           # Run all scenarios
$ node test/run.js 3 # Run a single scenario
```

Tests launch a visible Chrome browser so you can watch nodes connect in the 2D visualizer while scenarios execute. The test runner manages the example server, relay server, and Firebase state automatically. Tests use an isolated Firebase path (`test-tree`) so they don't interfere with manual testing.

### Scenarios
1. Basic P2P Tree (K=2)
2. Server Fallback
3. Force Server Mode
4. Force Server OFF → P2P Upgrade
5. Server Toggle OFF → P2P Reconnect
6. Rapid Joins
7. K Change Mid-Session
8. Node Departure & Recovery
9. Mixed Transport Tree
10. Large Tree (K=3)
11. Server Restart Recovery
12. Disconnect All & Reconnect

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

#### `node.blacklist.add(id)`
#### `node.blacklist.remove([id])`
#### `node.blacklist.contains(id)`

## Events
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
| `visualizer/` | 3D Three.js visualizer (submodule) |
| `test/` | Automated Puppeteer test suite |

## Browser Support
Tested on modern browsers with WebRTC support:
* Chrome (desktop and Android)
* Firefox
* Safari (desktop and iOS)
* Edge

## License
MIT
