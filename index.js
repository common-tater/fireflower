var Firebase = require('firebase')

module.exports = FireFlower

function FireFlower (firebaseUrl, k) {
  if (!(this instanceof FireFlower)) {
    return new FireFlower(k)
  }
  if (!k) {
    console.error('must include k as args')
  }

  this.firebase = new Firebase(firebaseUrl)

  this.k = k
}

FireFlower.prototype.setBroadcaster = function (broadcasterId) {
  this.broadcasterId = broadcasterId
  var broadcasterRef = this.firebase.child('available_peers/' + broadcasterId)
  var listenersCollectionRef = broadcasterRef.child('listeners')
  // watch out for any future downstream peers being added to the
  // broadcaster's list of listeners
  listenersCollectionRef.on('child_added', function (childSnapshot) {
    connectToPeer.call(self, broadcasterId, childSnapshot.val().id)
  })
  // create the node in Firebase
  broadcasterRef.set({id: broadcasterId})

  // todo: make this work if there are already listeners waiting
}

FireFlower.prototype.addListener = function (listenerId) {
  var self = this
  // when finding a new upstream peer, pass [listenerId] as a peer to ignore,
  // so we don't find ourself if we're already in the list for some reason
  findPeerWithAvailableSlot.call(this, [listenerId], function (availablePeerSnapshot) {
    var availablePeerId = availablePeerSnapshot.val().id
    // set myself as one of the listeners in the available peer's list of listeners
    availablePeerSnapshot.ref().child('listeners/' + listenerId).set({id: listenerId}, function (err) {
      if (err) {
        return
      }

      // if the upstream peer found is now full (meaning it has k listeners),
      // then set it as unavailable so no more try to connect to it
      self.firebase.child('available_peers/' + availablePeerId + '/listeners').once('value', function (snapshot) {
        if (snapshot.numChildren() >= self.k)
          self.setPeerAsUnavailable.call(self, availablePeerId)
      })

      // add this new listener as an available peer in the overall pool
      var newListenerRef = self.firebase.child('available_peers/' + listenerId)
      newListenerRef.set({id: listenerId})
      // watch out for any future downstream peers being added to this
      // node's list of listeners
      newListenerRef.child('listeners').on('child_added', function (childSnapshot) {
        connectToPeer.call(self, listenerId, childSnapshot.val().id)
      })
    })
  })
}

FireFlower.prototype.setPeerAsUnavailable = function (peerId) {
  this.firebase.child('available_peers/' + peerId).remove()
}

FireFlower.prototype.removeListener = function (listenerId) {
  var self = this

  // watch out for the 'listeners' child being removed, because
  // if it ever is, that means that we're done re-reouting
  // downstream peers, and we can safely be removed from the
  // pool of available peers
  this.firebase.child('available_peers/' + listenerId).on('child_removed', function (removedChildSnapshot) {
    if (removedChildSnapshot.key() === 'listeners') {
      self.setPeerAsUnavailable.call(self, listenerId)
    }
  })

  // if there are any downstream listeners conencted to this listener,
  // find a new upstream peer for each of them
  this.firebase.child('available_peers/' + listenerId + '/listeners').once('value', function (snapshot) {
    snapshot.forEach(function (childSnapshot) {
      var downstreamListenerId = childSnapshot.val().id
      // when finding a new upstream peer, make sure it's not the same
      // as the one being removed, or the current one we're finding
      // a home for. That's why we pass [listenerid, downstreamListenerId]
      // as the ones to ignore when finding an available peer
      findPeerWithAvailableSlot.call(self, [listenerId, downstreamListenerId], function (peerSnapshot) {
        peerSnapshot.ref().child('listeners/' + downstreamListenerId).set({id: downstreamListenerId})
        snapshot.ref().remove()
      })
    })
  })
}

function findPeerWithAvailableSlot (ignoreThesePeerIds, cb) {
  this.firebase.child('available_peers/').once('value', function (snapshot) {
    snapshot.forEach(function (childSnapshot) {
      // only consider this peer if it shouldn't be ignored
      if (ignoreThesePeerIds.indexOf(childSnapshot.val().id) < 0) {
        cb(childSnapshot)
        return true
      }
    })
  })
}

function connectToPeer (upstreamPeerId, downstreamPeerId) {
  console.log('connecting upstream peer ' + upstreamPeerId + ' to downstream peer ' + downstreamPeerId)
  // todo: implement data channel connection
  // todo: when data connection is lost, make sure to remove
  //       this downstream peer ID from this upstream peer's
  //       list of listeners
}