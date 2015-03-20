var Firebase = require('firebase')

module.exports = FireFlower

function FireFlower (firebaseUrl, k, peerId) {
  if (!(this instanceof FireFlower)) {
    return new FireFlower(k)
  }
  if (!k) {
    console.error('must include k as args')
  }

  this.firebase = new Firebase(firebaseUrl)

  this.k = k
  this.numSubscribers = 0
  this.myPeerId = peerId
  this.broadcasterId = null
}

FireFlower.prototype.setBroadcaster = function () {
  this.broadcasterId = this.myPeerId
  var broadcasterRef = this.firebase.child('available_peers/' + this.myPeerId)
  // create the node in Firebase
  broadcasterRef.set({id: this.myPeerId}, function (err) {
    if (err) {
      throw err
    }
  })

  // todo: make this work if there are already subscribers waiting
}

FireFlower.prototype.subscribe = function () {
  var self = this
  findPeerWithAvailableSlot.call(this, function (availablePeerSnapshot) {
    var availablePeerId = availablePeerSnapshot.val().id
    connectToPeer.call(self, availablePeerId, self.myPeerId)
  })
}

FireFlower.prototype.setAsUnavailable = function () {
  this.firebase.child('available_peers/' + this.myPeerId).remove()
}

FireFlower.prototype.setAsAvailable = function () {
  this.firebase.child('available_peers/' + this.myPeerId).set({id: this.myPeerId})
}

function findPeerWithAvailableSlot (cb) {
  var self = this
  this.firebase.child('available_peers/').once('value', function (snapshot) {
    snapshot.forEach(function (childSnapshot) {
      // only consider this peer if it isn't ourself
      if (childSnapshot.val().id !== self.myPeerId) {
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
  //       list of subscribers

  // on connect
  if (upstreamPeerId === this.myPeerId) {
    this.numSubscribers++
    if (this.numSubscribers >= this.k) {
      this.setAsUnavailable()
    }
  } else if (downstreamPeerId === this.myPeerId) {
    // now that we've connected to an upstream peer,
    // add ourself to the pool of avaialble peers
    this.setAsAvailable.call(this)
  }

  // on disconnect
  if (upstreamPeerId === this.myPeerId) {
    removeSubscriber.call(this)
  }
}

function removeSubscriber () {
  this.numSubscribers--
  this.setAsAvailable.call(this)
}
