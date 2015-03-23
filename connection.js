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
  // newSignalRef will point to the new firebase node created on the destination
  // peer's list of signals. Keep it around so we can remove it once the
  // connection has finished (either succeeded or failed)
  var newSignalRef = null
  var timeout = null

  simplePeer.on('signal', function (signal) {
    signal = JSON.parse(JSON.stringify(signal))
    signal.peerId = self.peerId
    // create a new signal on the destination peer's list
    newSignalRef = self.destinationSignalsRef.push(signal)
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
    // remove the firebase node that was the destination peer's
    // reference to this peer
    newSignalRef.remove()

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
