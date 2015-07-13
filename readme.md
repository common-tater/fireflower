# fireflower
[K-ary trees](http://en.wikipedia.org/wiki/K-ary_tree) of [RTCDataChannel](http://www.w3.org/TR/webrtc/#rtcdatachannel) connected nodes.

## Why
Scalable broadcasting for streams of live data.

## How
* [SimplePeer](https://github.com/feross/simple-peer) for representing peer node `RTCDataChannel` connections.
* [Firebase](https://www.firebase.com) for `RTCPeerConnection` signaling.

## Example
```
$ npm run example
```

## Test
```
$ npm run test
```
There aren't any real tests yet (coming soon though!), for now this just runs standard.

## Require
```javascript
var fireflower = require('fireflower')
```

## Constructor
```javascript
var node = fireflower('tree-signals-url.firebaseio.com' [, opts])
```

Where `opts` can be:
```javascript
{
  id: '0',                            // string, optional
  root: true,                         // boolean, optional, indicates that you want to be the root node
  reportInterval: 5000,               // int, optional, generate perodic status reports
  peerConfig: {                       // object, optional, standard RTCPeerConnection constructor options
    iceServers: [
      {
        url: 'stun:23.21.150.121'
      }, {
        url: 'turn:global.turn.twilio.com:1234?transport=udp',
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

## Note
Just a prototype for the moment!

## License
MIT
