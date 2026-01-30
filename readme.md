# fireflower
[K-ary trees](http://en.wikipedia.org/wiki/K-ary_tree) of [RTCDataChannel](http://www.w3.org/TR/webrtc/#rtcdatachannel) connected nodes.

## Why
Scalable broadcasting for streams of live data.

## How
* Native [WebRTC](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API) for peer node `RTCDataChannel` connections.
* [Firebase Realtime Database](https://firebase.google.com/docs/database) for `RTCPeerConnection` signaling.

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

## Visualization
For a 3D visualization of the network topology, see the [visualizer](./visualizer) directory.


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
  root: true,                         // boolean, optional, indicates that you want to be the root node
  reportInterval: 5000,               // int, optional, generate periodic status reports
  connectionTimeout: 5000,            // int, optional, timeout for peer connections (default 5000ms)
  peerConfig: {                       // object, optional, standard RTCPeerConnection constructor options
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
  channelConfig: {                    // object, optional, standard RTCDataChannel properties
    ordered: true,
    maxRetransmits: 3,
    maxPacketLifeTime: 500
  }
}
```

## Methods
#### `node.connect()`
Publish a request to join the tree. If disconnected, instances will republish their request to join.

#### `node.disconnect()`
Disconnect and / or halt any attempts to reconnect.

#### `node.blacklist.add(id)`
#### `node.blacklist.remove([id])`
#### `node.blacklist.contains(id)`

## Events
#### `node.emit('connect', peer)`
An upstream node has responded to the instance's request to join the tree and has established an `RTCDataChannel` connection.

#### `node.emit('disconnect', peer)`
Connection to upstream node was lost.

#### `node.emit('peerconnect', peer)`
Response to a connection request was accepted and a downstream node was connected.

#### `node.emit('peerdisconnect', peer)`
The connection to a downstream node was lost.

#### `node.emit('configure')`
Configuration data was read for the first time or updated.

#### `node.emit('error', error)`
A configuration error occurred.

## Browser Support
Tested on modern browsers with WebRTC support:
* Chrome (desktop and Android)
* Firefox
* Safari (desktop and iOS)
* Edge

## License
MIT
