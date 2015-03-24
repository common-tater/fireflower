var simplepeer = require('simple-peer')
var events = require('events')
var inherits = require('inherits')

module.exports = Connection

function Connection (firebase, peerId) {
  events.EventEmitter.call(this)
  var self = this

  this.firebase = firebase
  this.peerId = peerId
  this.output = null

  // myPeerSignals is a firebase ref for this peer, and
  // when a new child is added to that list, it means
  // a new peer is trying to connect, so connect to them
  this.myPeerSignalsRef = firebase.child('peer_signals/' + peerId)
  this.myPeerSignalsRef.on('child_added', function (signal) {
    self.connectToPeer(false, signal.val().peerId)
  })
}
inherits(Connection, events.EventEmitter)

Connection.prototype.connectToPeer = function (initiator, destinationPeerId) {
  var self = this

  var simplePeer = simplepeer({
    initiator: initiator
  })

  // destinationSignalRef is the ref in firebase for the user we're trying
  // to connect to. we're going to push a new child to their list, which
  // will trigger them to notice it and connect to us
  this.destinationSignalsRef = this.firebase.child('peer_signals/' + destinationPeerId)
  var timeout = null

  simplePeer.on('signal', function (signal) {
    signal = JSON.parse(JSON.stringify(signal))
    signal.peerId = self.peerId
    // create a new signal on the destination peer's list
    self.destinationSignalsRef.push(signal)
  })

  simplePeer.on('connect', function () {
    clearTimeout(timeout)
    simplePeer.removeAllListeners('signal')
    simplePeer.removeAllListeners('connect')

    if (initiator) {
      if (self.output) {
        self.output.pipe(simplePeer)
      }
    } else if (!self.output) {
      self.output = simplePeer
    }

    if (initiator) {
      self.emit('onconnected', self.output, self.peerId, destinationPeerId)
    } else {
      self.emit('onconnected', self.output, destinationPeerId, self.peerId)
    }
  })

  simplePeer.on('close', function () {
    clearTimeout(timeout)
    simplePeer.removeAllListeners()
    // remove any signals to the destination peer that are
    // left around, since the connection has been closed
    self.destinationSignalsRef
      .orderByChild('peerId')
      .startAt(self.peerId)
      .endAt(self.peerId)
      .once('value', function (snapshot) {
        snapshot.forEach(function (childSnapshot) {
          childSnapshot.ref().remove()
        })
      })

    if (self.output) {
      self.output.unpipe(simplePeer)
      if (self.output === simplePeer) {
        self.output = null
      }
    }

    if (initiator) {
      self.emit('onconnectionclosed', destinationPeerId, self.peerId)
    } else {
      self.emit('onconnectionclosed', self.peerId, destinationPeerId)
    }
  })

  // whenever a signal is added to my list by someone who wants,
  // to connect, signal them back
  this.myPeerSignalsRef.on('child_added', function (signal) {
    simplePeer.signal(signal.val())
  })

  // set a timer, and if by that time we haven't
  // connected, then destroy this peer attempt
  timeout = setTimeout(function () {
    // if a peer connection fails, do this:
    //this.emit('onconnectionfailed', destinationPeerId, self.peerId)
    simplePeer.destroy()
  }, 10000)

  window.addEventListener('beforeunload', onbeforeunload)

  function onbeforeunload () {
    simplePeer.destroy()
  }
}
