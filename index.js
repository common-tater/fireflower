module.exports = Node

var debug = require('debug')('fireflower')
var events = require('events')
var inherits = require('inherits')
var Firebase = require('firebase')
var SimplePeer = require('simple-peer')

var CONNECTION_TIMEOUT = 2000

inherits(Node, events.EventEmitter)

function Node (url, opts) {
  if (!(this instanceof Node)) {
    return new Node(url, opts)
  }

  this.url = url
  this.opts = opts || {}
  this.id = this.opts.id
  this.state = 'disconnected'
  this.config = {}
  this.peers = {}

  // firebase refs
  this._ref = new Firebase(this.url)
  this._requestsRef = this._ref.child('requests')
  this._configRef = this._ref.child('configuration')
  this._logsRef = this._ref.child('logs')

  // if we weren't assigned an id, get one from the db
  this.id = this.id || this._requestsRef.push().key()

  this._requestRef = this._requestsRef.child(this.id)
  this._responsesRef = this._requestRef.child('responses')

  // bind callbacks
  this._onconfig = this._onconfig.bind(this)
  this._doconnect = this._doconnect.bind(this)
  this._onresponse = this._onresponse.bind(this)
  this._onrequest = this._onrequest.bind(this)

  // when the connection state changes, update the log
  this.on('statechange', this.reportStatus.bind(this))

  this._interval = null

  events.EventEmitter.call(this)
}

Node.prototype.connect = function (shouldReportStatus) {
  if (this.state !== 'disconnected') {
    throw new Error('invalid state for connect')
  }

  // make sure this is not set
  this._preventReconnect = false

  // set the recurring logging that frequently posts our
  // known state of our world to firebase, so it can
  // be used to visualize the state of the tree
  if (shouldReportStatus) {
    this.reportStatus()
    this._interval = setInterval(this.reportStatus.bind(this),
    // TODO: change the next line to this when it works: process.env.PEER_REPORTING_INTERVAL)
    5000)
  }

  // change state -> requesting
  debug(this.id + ' requesting connection')
  this.state = 'requesting'
  this.emit('statechange')

  // watch config
  if (!this._watchingConfig) {
    this._configRef.on('value', this._onconfig)
    this._watchingConfig = true
  }

  // ensure required config info
  if (!this.config.root || !this.config.K) {
    this.once('configure', this._doconnect)
    return this
  }

  this._doconnect()

  return this
}

Node.prototype.disconnect = function () {
  this.state = 'disconnected'
  this._preventReconnect = true

  // stop any reporting that may have been happening
  clearInterval(this._interval)

  // teardown listeners
  this.removeListener('configure', this._doconnect)
  this._configRef.off('value', this._onconfig)
  this._requestsRef.off('child_added', this._onrequest)
  this._responsesRef.off('child_added', this._onresponse)

  // ensure request is removed
  this._requestRef.remove()

  // destroy upstream connection
  this.root && this.root !== this && this.root.destroy()

  // destroy downstream connections
  for (var i in this.peers) {
    this.peers[i].destroy()
  }

  this.root = null
  this.peers = {}
  this._watchingConfig = false

  return this
}

// private api below

Node.prototype._onconfig = function (snapshot) {
  var data = snapshot.val()

  if (!data) {
    this.emit('error', new Error('missing configuration'))
    return
  }

  if (!data.K) {
    this.emit('error', new Error('configuration did not supply valid value for K'))
    return
  }

  if (!data.root) {
    this.emit('error', new Error('configuration did not supply a valid root'))
    return
  }

  this.config = data
  debug(this.id + ' updated configuration')
  this.emit('configure')
}

Node.prototype._doconnect = function () {
  var self = this

  // are we root?
  if (this.id === this.config.root) {
    this.root = this
    this.branch = ''

    // emit connect but in nextTick
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

  // make sure we have a branch
  this.branch = this.branch || this.id.slice(-5)

  // we are not root so publish a connection request
  this._dorequest()

  // make sure no one removes our request until we're connected
  this._requestRef.child('removal_flag').on('child_removed', function () {
    if (self.state === 'requesting') {
      self._dorequest()
    }
  })

  // listen for responses
  this._responsesRef.on('child_added', this._onresponse)
}

Node.prototype._dorequest = function () {
  this._requestRef.update({
    branch: this.branch,
    removal_flag: {
      removed: false
    }
  }, function (err) {
    if (err) throw err // can this ever happen?
  })
}

Node.prototype._onrequest = function (snapshot) {
  if (this.state !== 'connected') {
    return // can't respond to requests unless we are connected
  }

  if (this.disabled) {
    return // useful for debugging
  }

  if (Object.keys(this.peers).length >= this.config.K) {
    return // can't respond to requests if we've hit K peers
  }

  var self = this
  var request = snapshot.val()
  var requestRef = snapshot.ref()
  var peerId = snapshot.key()

  // responders may accidentally recreate requests
  // these won't have a branch though and can be removed
  if (!request.branch) {
    requestRef.remove()
    return
  }

  // prevent circles
  if (this.branch.slice(0, 5) === request.branch.slice(0, 5) &&
      this.branch.length >= request.branch.length) {
    return
  }

  // it is possible to see a peer we already knew about
  var knownPeer = this.peers[peerId]
  if (knownPeer) {
    if (knownPeer.didConnect) {
      // we may not have witnessed them disconnect before they re-requested
      // if that happens we destroy them in the same tick and respond immediately
      knownPeer.destroy()
    } else {
      // we may have timed out while trying to connect to somebody else
      // if that happens we may have gotten a fresh list of requests
      // that included this peer which we are still connecting to
      return
    }
  }

  debug(this.id + ' saw request by ' + peerId)

  var responseRef = requestRef.child('responses/' + this.id)

  // initiate peer connection
  // we have to do this before actually writing our response because
  // firebase can trigger events in the same tick which could circumvent
  // the K check at the top of this method
  this._connectToPeer(peerId, true, responseRef)

  // publish response
  responseRef.update({
    branch: this.branch || '-'
  })

  // watch for request withdrawal
  responseRef.once('child_removed', function () {
    var peer = self.peers[peerId]
    if (peer && !peer.didConnect) {
      peer.requestWithdrawn = true
      peer.destroy()
    }
  })
}

Node.prototype._onresponse = function (snapshot) {
  if (this.state !== 'requesting') {
    return
  }

  var response = snapshot.val()
  var responseRef = snapshot.ref()
  var peerId = snapshot.key()
  var branch = response.branch

  if (!branch) {
    return
  } else if (branch === '-') {
    branch = ''
  }

  // TODO! prevent circles / allow proper healing
  // using this.branch and request.branch
  // this should be handled on the _onrequest side
  // but decisions should be rechecked on this side too

  // change state -> connecting (this prevents accepting multiple responses)
  debug(this.id + ' got response from ' + peerId)
  this.state = 'connecting'
  this.emit('statechange')

  // stop taking responses
  // WARNING: no idea why, but calling off() can trigger additional
  // events in the same tick so be sure to do it after changing state
  this._responsesRef.off('child_added', this._onresponse)
  this._requestRef.child('removal_flag').off()

  // attempt a connection
  this._connectToPeer(peerId, false, responseRef, branch)
}

Node.prototype._connectToPeer = function (peerId, initiator, responseRef, branch) {
  var self = this
  var localSignals = responseRef.child(initiator ? 'responderSignals' : 'requesterSignals')
  var remoteSignals = responseRef.child(initiator ? 'requesterSignals' : 'responderSignals')

  var peer = new SimplePeer({
    initiator: initiator
  })

  peer.id = peerId

  if (initiator) {
    this.peers[peer.id] = peer
  } else {
    peer.branch = branch
  }

  peer.on('connect', this._onpeerConnect.bind(this, peer, remoteSignals))
  peer.on('close', this._onpeerDisconnect.bind(this, peer, remoteSignals))

  peer.on('error', function (err) {
    debug(this.id + ' saw peer connection error', err)
  })

  peer.on('signal', function (signal) {
    if (initiator && self.state !== 'connected') return
    signal = JSON.parse(JSON.stringify(signal))
    localSignals.push(signal)
  })

  remoteSignals.on('child_added', function (snapshot) {
    if (initiator && self.state !== 'connected') return
    var signal = snapshot.val()
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

  peer._channel.maxPacketLifeTime = this.opts.maxPacketLifeTime || null
  peer._channel.maxRetransmits = this.opts.maxRetransmits || null
  peer._channel.ordered = this.opts.ordered === false ? false : true

  if (this.peers[peer.id]) {
    this._ondownstreamConnect(peer)
  } else {
    this._onupstreamConnect(peer)
  }
}

Node.prototype._onpeerDisconnect = function (peer, remoteSignals) {
  peer.removeAllListeners()
  remoteSignals.off()

  if (this.peers[peer.id]) {
    this._ondownstreamDisconnect(peer)
  } else {
    this._onupstreamDisconnect(peer)
  }
}

Node.prototype._onupstreamConnect = function (peer) {
  // remove our request
  this._requestRef.remove()

  // already got connected by someone else
  if (this.state === 'connected') {
    peer.destroy()
    return
  }

  // whoever just connected us is (as good as) root
  this.root = peer

  // update branch
  this.branch = peer.branch + this.id.slice(-5)

  // change state -> connected
  debug(this.id + ' was connected by ' + peer.id)
  this.state = 'connected'
  this.emit('statechange')

  // emit connect
  this.emit('connect', peer)

  // start responding to requests
  if (Object.keys(this.peers).length < this.config.K) {
    this._requestsRef.on('child_added', this._onrequest)
  }
}

Node.prototype._onupstreamDisconnect = function (peer) {
  // stop responding to new requests
  this._requestsRef.off('child_added', this._onrequest)

  // remove request
  this._requestRef.remove()

  delete this.root

  // change state -> disconnected
  debug(this.id + ' lost connection to ' + peer.id)
  this.state = 'disconnected'
  this.emit('statechange')

  // emit disconnect if we were connected
  if (peer.didConnect) {
    this.emit('disconnect', peer)
  }

  // FIXME kill all downstream connections to ensure circles don't occur
  for (var i in this.peers) {
    this.peers[i].destroy()
  }

  // attempt to reconnect if we were not disconnected intentionally
  if (!this._preventReconnect) {
    this.connect()
  }
}

Node.prototype._ondownstreamConnect = function (peer) {
  // emit peerconnect
  debug(this.id + ' did connect peer ' + peer.id)
  this.emit('peerconnect', peer)

  // stop responding to requests if peers > K
  if (Object.keys(this.peers).length >= this.config.K) {
    this._requestsRef.off('child_added', this._onrequest)
  }
}

Node.prototype._ondownstreamDisconnect = function (peer) {
  // remove from lookup
  delete this.peers[peer.id]

  // emit events and potentially remove stale requests
  if (peer.didConnect) {
    debug(this.id + ' lost connection to peer ' + peer.id)
    this.emit('peerdisconnect', peer)
  } else {
    if (peer.requestWithdrawn) {
      debug(this.id + ' saw request withdrawn by ' + peer.id)
    } else {
      debug(this.id + ' removing stale request by ' + peer.id)
      this._requestsRef.child(peer.id).remove()
    }
  }

  // if we are connected but not currently taking requests
  // and back below K, start accepting them again
  if (this.state === 'connected' && Object.keys(this.peers).length < this.config.K) {
    this._requestsRef.off('child_added', this._onrequest)
    this._requestsRef.on('child_added', this._onrequest)
  }
}

Node.prototype.reportStatus = function () {
  var nodeStatus = generateNodeStatusObject.call(this)
  this._logsRef.child(this.id).update(nodeStatus)
}

function generateNodeStatusObject () {
  var upstreamPeerId = null
  if (this.root && this.root.id) {
    upstreamPeerId = this.root.id
  }
  // the root will have its upstreamPeerId set as itself, but
  // that's a signal that it's the root, not that it's a node
  // who hasn't found an upstream peer yet

  return {
    id: this.id,
    upstream_peer_id: upstreamPeerId,
    state: this.state,
    timestamp: new Date().getTime()
  }
}
