var Fireflower = require('../')
var hat = require('hat')

document.addEventListener('click', onclick)

var fireflowerPeers = {}

// add initial broadcaster
var broadcasterId = hat(16)
var broadcasterPeer = new Fireflower('fireflower-dev.firebaseio.com', 3, broadcasterId)
fireflowerPeers[broadcasterId] = broadcasterPeer
broadcasterPeer.setBroadcaster()

function onclick (evt) {
  switch (evt.target.id) {
    case 'add-listener-btn':
      var myPeerId = hat(16)
      var peer = new Fireflower('fireflower-dev.firebaseio.com', 3, myPeerId)
      fireflowerPeers[myPeerId] = peer
      peer.subscribe()
      break
    case 'remove-listener-btn':
      var peerIdToRemove = document.getElementById('listener-id-text').value
      //fireflowerPeers[peerIdToRemove].removeSubscriber()
      break
  }
}
