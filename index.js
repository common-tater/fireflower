var Firebase = require('firebase')
var simplepeer = require('simple-peer')

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
  this.peers = {}
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

FireFlower.prototype.subscribe = function () {
  var self = this
  findPeerWithAvailableSlot.call(this, function (availablePeerId) {
    startListening.call(self, availablePeerId)
  })
}

FireFlower.prototype.setAsAvailable = function () {
  this.firebase.child('available_peers/' + this.myPeerId).set({id: this.myPeerId})
}

FireFlower.prototype.setAsUnavailable = function () {
  this.firebase.child('available_peers/' + this.myPeerId).remove()
}

function findPeerWithAvailableSlot (cb) {
  var self = this
  this.firebase.child('available_peers/').once('value', function (snapshot) {
    snapshot.forEach(function (childSnapshot) {
      // only consider this peer if it isn't ourself
      if (childSnapshot.val().id !== self.myPeerId) {
        cb(childSnapshot.val().id)
        return true
      }
    })
  })
}

function startListening (upstreamPeerId) {
  var self = this

  // if there is no listener data, or that listener is this user,
  // then ignore it
  if (!upstreamPeerId || upstreamPeerId === this.myPeerId) {
    return
  }

  var signalRef = this.firebase.child('signals/' + this.myPeerId)

  signalRef.set({
    peer_id: this.myPeerId
  }, function (err) {
    if (err) {
      return signalRef.once('value', startListening.bind(self))
    }

    var peer = self.peers[upstreamPeerId]

    if (peer && !peer.destroyed) {
      // if we already know about this peer, try to renegotiate -
      // the other side is responsible for tearing down the connection
      // so we wait here and flag that a renegotiation is in needed
      peer.needsRenegotiation = true
      peer.once('close', function () {
        connectToPeer.call(self, true, upstreamPeerId)
      })
      return
    }

    // push a new child on the upstream peer's list of signals,
    // which should cause them to attempt to connect to us as well
    var upstreamSignalRef = self.firebase.child('signals/' + upstreamPeerId)
    upstreamSignalRef.push({id: self.myPeerId})

    connectToPeer.call(self, true, upstreamPeerId)
  })
}

function connectToPeer (initiator, destinationPeerId) {
  var self = this
  var timeout = null
  var localSignals = this.firebase.child('signals').child(this.myPeerId)
  var remoteSignals = this.firebase.child('signals').child(destinationPeerId)

  var peer = simplepeer({
    initiator: initiator
  })

  this.peers[destinationPeerId] = peer

  peer.on('signal', function (signal) {
    signal = JSON.parse(JSON.stringify(signal))
    localSignals.push(signal, logerror)
  })

  peer.on('connect', function () {
    clearTimeout(timeout)
    peer.removeAllListeners('signal')
    peer.removeAllListeners('connect')
    remoteSignals.off()

    if (initiator) {
      if (self.output) {
        self.output.pipe(peer)
      }
    } else if (!self.output) {
      self.output = peer
    }
  })

  peer.on('close', function () {
    clearTimeout(timeout)
    window.removeEventListener('beforeunload', onbeforeunload)
    peer.removeAllListeners()
    remoteSignals.off()
    delete self.peers[destinationPeerId]

    if (self.output) {
      self.output.unpipe(peer)
      if (self.output === peer) {
        self.output = null
      }
    }
  })

  remoteSignals.on('child_added', function (signal) {
    peer.signal(signal.val().id)
  })

  timeout = setTimeout(function () {
    peer.destroy()
  }, 10000)

  window.addEventListener('beforeunload', onbeforeunload)

  function onbeforeunload () {
    peer.destroy()
  }
}

function logerror (err) {
  if (err) return console.error(err)
}
