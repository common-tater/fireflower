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
    var newSignalObject = signal.val()[Object.keys(signal.val())[0]]
    self.connectToPeer(false, newSignalObject.peerId)
  })
}
inherits(Connection, events.EventEmitter)

Connection.prototype.connectToPeer = function (initiator, destinationPeerId) {
  var self = this
  var localSignals = this.myPeerSignalsRef.child(this.peerId)
  var remoteSignals = this.myPeerSignalsRef.child(destinationPeerId)

  var simplePeer = simplepeer({
    initiator: initiator
  })

  var timeout = null

  simplePeer.on('signal', function (signal) {
    signal = JSON.parse(JSON.stringify(signal))
    signal.peerId = self.peerId
    // create a new signal on the destination peer's list
    localSignals.push(signal)
  })

  simplePeer.on('connect', function () {
    clearTimeout(timeout)
    simplePeer.removeAllListeners('signal')
    simplePeer.removeAllListeners('connect')
    remoteSignals.off()
    self.myPeerSignalsRef.remove()

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
    remoteSignals.off()
    self.myPeerSignalsRef.remove()

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
  remoteSignals.on('child_added', function (signal) {
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
