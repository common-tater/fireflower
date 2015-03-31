# fireflower
[K-ary trees](http://en.wikipedia.org/wiki/K-ary_tree) of [RTCDataChannel](http://www.w3.org/TR/webrtc/#rtcdatachannel) connected nodes.

## Why
Scalable broadcasting for streams of live data.

## How
* [SimplePeer](https://github.com/feross/simple-peer) for representing peer node `RTCDataChannel` connections.
* [Firebase](https://www.firebase.com) for `RTCPeerConnection` signaling.

## Example
`npm run example`

## Prerequisite
The following database structure must exist before the first node attempts to join:
```json
{
  "configuration": {
    "K": 3,
    "root": "id-of-the-root-node"
  }
}
```

## Require
```javascript
var fireflower = require('fireflower')
```

## Constructor
```javascript
var node = fireflower('tree-signals-url.firebaseio.com', {
  id: OPTIONAL_NODE_ID_TO_USE,
  maxRetransmits: OPTIONAL_INT,
  maxPacketLifeTime: OPTIONAL_TIME_IN_MS
})
```

## API
#### `node.connect()`
Publish a request to join the tree. If disconnected, instances will republish their request to join.

#### `node.disconnect()`
Disconnect and / or halt any attempts to reconnect.

## Events
#### `node.emit('connect', SimplePeerInstance)`
An upstream node has responded to the instance's request to join the tree and has established an `RTCDataChannel` connection.

#### `node.emit('disconnect', SimplePeerInstance)`
Connection to upstream node was lost.

#### `node.emit('peerconnect', SimplePeerInstance)`
Response to a connection request was accepted and a downstream node was connected.

#### `node.emit('peerdisconnect', SimplePeerInstance)`
Response to a connection request was accepted and a downstream node was connected.

#### `node.emit('configure')`
Configuration data was read for the first time or updated.

#### `node.emit('error', error)`
A configuration error occurred.

## Note
Just a prototype for the moment!

## License
MIT
