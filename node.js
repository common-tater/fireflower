module.exports = Node

var debug = require('debug')('fireflower')
var events = require('events')
var inherits = require('inherits')
var SimplePeer = require('simple-peer')

var RETRY_DELAY = 2000
var CONNECTION_TIMEOUT = 2000

inherits(Node, events.EventEmitter)

function Node (flower, id) {
  this.id = id
  this.peers = {}
  this.flower = flower
  this.session = 0
  this.state = 'disconnected'
  this._requestsRef = flower.ref.child('requests')

  // if we weren't assigned an id, get one from the db
  this.id = this.id || this._requestsRef.push().key()

  this._doconnect = this._doconnect.bind(this)
  this._onresponse = this._onresponse.bind(this)
  this._onrequest = this._onrequest.bind(this)

  events.EventEmitter.call(this)
}

Node.prototype.connect = function () {
  if (this.state !== 'disconnected') {
    throw new Error('invalid state for connect')
  }

  // change state -> requesting
  debug(this.id + ' requesting connection')
  this.state = 'requesting'
  this.emit('statechange')

  // make sure flower has config infos
  if (!this.flower.root || !this.flower.K) {
    this.flower.once('configure', this._doconnect)
    return
  }

  this._doconnect()
}

Node.prototype._doconnect = function () {
  var self = this

  // are we root?
  if (this.id === this.flower.root) {
    this.root = this

    // emit in nextTick
    setTimeout(function () {
      // change state -> connected
      debug(self.id + ' connected as root')
      self.state = 'connected'
      self.emit('statechange')

      // emit connect
      self.emit('connect')

      // start responding to requests
      self._requestsRef.on('child_added', self._onrequest)
    })

    return
  }

  // since we are not root we need to publish a connection request
  this._requestRef = this._requestsRef.child(this.id)
  this._requestRef.update({
    id: this.id, 
    removal_flag: {
      removed: false 
    }
  }, function (err) {
    if (err) {

      // keep trying to publish it
      setTimeout(function () {
        if (self.state === 'requesting') {
          self._doconnect()
        }
      }, RETRY_DELAY)

      return
    }

    // it's possible to get connected before this callback fires
    if (self.state !== 'requesting') {
      return
    }

    // in the rare case someone removes our request
    // before we actually get connected, reconnect
    self._requestRef.child('removal_flag').once('child_removed', function () {
      if (self.state !== 'connected' && 
          self.state !== 'disconnected') {
        self._doconnect()
      }
    })

    // now that our request has been published
    // wait for someone to respond
    self._responsesRef = self._requestRef.child('responses')
    self._responsesRef.on('child_added', self._onresponse)
  })
}

Node.prototype._onresponse = function (snapshot) {
  if (this.state !== 'requesting') {
    return // probably already processing a response
  }

  var response = snapshot.val()
  var responseRef = snapshot.ref()
  var peerId = response.id

  if (!peerId) {
    throw new Error('got response without id')
  }

  // change state -> connecting (this prevents accepting multiple responses)
  debug(this.id + ' got response from ' + peerId)
  this.state = 'connecting'
  this.emit('statechange')

  this._connectToPeer(peerId, false, responseRef)
}

Node.prototype._onrequest = function (snapshot) {
  if (this.state !== 'connected') {
    return // can't respond to requests unless we are connected
  }

  if (Object.keys(this.peers).length >= this.flower.K) {
    return // can't reponsd to requests if we've hit K peers
  }

  var self = this
  var request = snapshot.val()
  var requestRef = snapshot.ref()
  var peerId = request.id

  // responders may accidentally recreate requests -
  // "ghost" requests won't have id's and should be removed
  if (!peerId) {
    requestRef.remove()
    return
  }

  debug(this.id + ' saw connection request from ' + peerId)

  var responseRef = requestRef.child('responses/' + this.id)
  responseRef.update({ id: this.id }, function (err) {
    if (err) {
      // if this fails, assume it's because the request was removed
      debug(self.id + ' failed to set response to request by ' + request.id)
      return
    }

    if (Object.keys(self.peers).length < self.flower.K) {
      self._connectToPeer(request.id, true, responseRef)
    }
  })
}

Node.prototype._connectToPeer = function (peerId, initiator, responseRef) {
  var self = this
  var localSignals = responseRef.child(initiator ? 'responderSignals' : 'requesterSignals')
  var remoteSignals = responseRef.child(initiator ? 'requesterSignals' : 'responderSignals')

  var peer = new SimplePeer({
    initiator: initiator
  })

  peer.id = peerId

  if (initiator) {
    this.peers[peer.id] = peer
  }

  peer.on('connect', this._onpeerConnect.bind(this, peer, remoteSignals))

  peer.on('close', this._onpeerClose.bind(this, peer, remoteSignals))
  
  peer.on('error', function (err) {
    debug(this.id + ' saw peer connection error', err)
  })

  peer.on('signal', function (signal) {
    signal = JSON.parse(JSON.stringify(signal))
    
    // debug(self.id + ' generated signal for ' + peer.id, signal)
    
    localSignals.push(signal)
  })

  remoteSignals.on('child_added', function (snapshot) {
    var signal = snapshot.val()

    // debug(self.id + ' got signal from ' + peer.id, signal)
    
    peer.signal(signal)
  })

  // timeout connections
  setTimeout(function () {
    if (!peer.didConnect) {
      peer.destroy()
    }
  }, CONNECTION_TIMEOUT)
}

Node.prototype._onpeerConnect = function (peer, remoteSignals) {
  peer.didConnect = true
  peer.removeAllListeners('connect')
  peer.removeAllListeners('signal')
  remoteSignals.off()

  // we were the initiator
  if (this.peers[peer.id]) {

    // emit peerconnect
    debug(this.id + ' did connect peer ' + peer.id)
    this.emit('peerconnect', peer)

    // stop responding to requests if peers > K
    if (Object.keys(this.peers).length >= this.flower.K) {
      this._requestsRef.off('child_added', this._onrequest)
    }

    return
  }

  // whoever just connected us is (as good as) root
  this.root = peer

  // change state -> connected
  debug(this.id + ' was connected by ' + peer.id)
  this.state = 'connected'
  this.emit('statechange')

  // remove our request
  this._responsesRef.off()
  delete this._responsesRef
  this._requestRef.remove()
  delete this._requestRef

  // emit connect
  this.emit('connect')

  // start responding to requests
  if (Object.keys(this.peers).length < this.flower.K) {
    this._requestsRef.off('child_added', this._onrequest)
    this._requestsRef.on('child_added', this._onrequest)
  }
}

Node.prototype._onpeerClose = function (peer, remoteSignals) {
  peer.removeAllListeners()
  remoteSignals.off()

  // whoever just disconnected was downstream
  if (this.root && peer !== this.root) {

    // remove from lookup
    delete this.peers[peer.id]

    // emit peerdisconnect
    debug(this.id + ' lost connection to peer ' + peer.id)
    this.emit('peerdisconnect', peer)

    // if peer never connected, remove the their request
    if (!peer.didConnect) {
      debug(this.id + ' removing request by ' + peer.id)
      this._requestsRef.child(peer.id).remove()
    }

    // if we are back below K start responding to requests again
    if (Object.keys(this.peers).length < this.flower.K) {
      this._requestsRef.off('child_added', this._onrequest)
      this._requestsRef.on('child_added', this._onrequest)
    }

    return
  }

  // remember previous state in case disconnect was called explictly
  var previousState = this.state

  // stop responding to new requests
  this._requestsRef.off('child_added', this._onrequest)

  delete this.root

  // change state -> disconnected
  debug(this.id + ' lost connection to ' + peer.id)
  this.state = 'disconnected'
  this.emit('statechange')

  // emit disconnect
  this.emit('disconnect')

  // attempt to reconnect if we were not disconnected intentionally
  if (previousState !== 'disconnected') {
    this.connect()
  }
}

Node.prototype.disconnect = function () {
  this.state = 'disconnected'

  // teardown possible listeners
  this.flower.removeListener('configure', this._doconnect)
  this._requestsRef.off('child_added', this._onrequest)

  // teardown request
  if (this.requestRef) {
    this._responsesRef.off()
    delete this._responsesRef
    this._requestRef.remove()
    delete this._requestRef
  }

  // destroy upstream connection
  this.root && this.root !== this && this.root.destroy()

  // destroy downstream connections
  for (var i in this.peers) {
    this.peers[i].destroy()
  }

  this.peers = {}
}
