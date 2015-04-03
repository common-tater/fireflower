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
    "K": 3
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
  id: '0',                   // string, optional
  root: true,                // boolean, optional
  ordered: true,             // boolean, optional, defaults to true
  maxRetransmits: 3,         // integer, optional, defaults to null
  maxPacketLifeTime: 500     // integer, optional, defaults to null (mutually exclusive with maxRetransmits)
  shouldReportStatus: true   // boolean, optional, defaults to false
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
The connection to a downstream node was lost.

#### `node.emit('configure')`
Configuration data was read for the first time or updated.

#### `node.emit('error', error)`
A configuration error occurred.

## Status Reporting
Any node upon construction is able to opt-in to a reporting mechanism by setting the `shouldReportStatus` argument to true. That node will now report its status (id, upstream peer id, state, timestamp) into a "logs" node in the database. These status reports will happen at a set interval, in aggregation can give a better real-time picture of how the fireflower network tree is actually progressing.

## Note
Just a prototype for the moment!

## License
MIT
