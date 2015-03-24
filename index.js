var Firebase = require('firebase')
var Connection = require('./connection')

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

  this.onConnected = onConnected.bind(this)
  this.onConnectionClosed = onConnectionClosed.bind(this)
  this.onConnectionFailed = onConnectionFailed.bind(this)

  this.connection = new Connection(this.firebase, this.myPeerId)
  this.connection.on('onconnected', this.onConnected)
  this.connection.on('onconnectionclosed', this.onConnectionClosed)
  this.connection.on('onconnectionfailed', this.onConnectionFailed)
}

FireFlower.prototype.setBroadcaster = function () {
  var broadcasterRef = this.firebase.child('available_peers/' + this.myPeerId)
  // create an entry for this broadcaster in Firebase's list of available peers
  broadcasterRef.set({id: this.myPeerId}, function (err) {
    if (err) {
      throw err
    }
  })

  // todo: if there are any existing peers connected and
  // waiting, we should start the process of connecting
  // everyone
}

FireFlower.prototype.subscribe = function (preferredPeerId) {
  var self = this
  findPeerWithAvailableSlot.call(this, function (availablePeerId) {
    self.connection.connectToPeer(true, availablePeerId)
  }, preferredPeerId)
}

FireFlower.prototype.setAsAvailable = function () {
  this.firebase.child('available_peers/' + this.myPeerId).set({id: this.myPeerId})
}

FireFlower.prototype.setAsUnavailable = function () {
  this.firebase.child('available_peers/' + this.myPeerId).remove()
}

function findPeerWithAvailableSlot (cb, preferredPeerId) {
  var self = this

  // if the caller has a preferredPeerId in mind,
  // try to see if they're available first
  if (preferredPeerId !== null) {
    this.firebase.child('available_peers/' + preferredPeerId).once('value', function (snapshot) {
      if (snapshot.val() !== null) {
        return cb(preferredPeerId)
      }
    })
  }

  // if there is no preferred peer, or if it is unavailable, pick the
  // first peer out from the list (whichever one firebase gives us first)
  this.firebase.child('available_peers').once('value', function (snapshot) {
    snapshot.forEach(function (childSnapshot) {
      // only consider this peer if it isn't ourself
      if (childSnapshot.val().id !== self.myPeerId) {
        cb(childSnapshot.val().id)
        return true
      }
    })
  })
}

function onConnected (stream, upstreamPeerId, downstreamPeerId) {
  // if I am the upstream peer, and the connection was made,
  // then increment my number of subscribers, and if I'm now
  // full, remove me from the pool of available peers
  if (this.myPeerId === upstreamPeerId) {
    this.numSubscribers++

    if (this.numSubscribers >= this.k) {
      this.setAsUnavailable()
    }
  }
}

function onConnectionClosed (upstreamPeerId, downstreamPeerId) {
  if (this.myPeerId === upstreamPeerId) {
    // if I am the upstream peer, and the connection was lost,
    // then decrement my number of subscribers, and if I'm not
    // full anymore, add me to the pool of available peers
    this.numSubscribers--

    if (this.numSubscribers < this.k) {
      this.setAsAvailable()
    }
  } else if (this.myPeerId === downstreamPeerId) {
    // if I'm the downstream peer, and the connection was lost,
    // try to connect to a new upstream peer
    this.subscribe()
  }
}

function onConnectionFailed (upstreamPeerId, downstreamPeerId) {
  // retry
}
