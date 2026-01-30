module.exports = function (db) {
  database = db
  return Node
}

var debug = require('debug')('fireflower')
var events = require('events')
var inherits = require('inherits')
var Peer = require('./peer')
var ServerTransport = require('./server-transport')
var Blacklist = require('./blacklist')
var firebase = require('firebase/database')

var database = null

function deepMerge (target, source) {
  for (var key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {}
      deepMerge(target[key], source[key])
    } else {
      target[key] = source[key]
    }
  }
  return target
}

inherits(Node, events.EventEmitter)

function Node (path, opts) {
  if (!(this instanceof Node)) {
    return new Node(path, opts)
  }

  this.path = path
  this.opts = opts || {}
  this.root = this.opts.root
  this.reportInterval = this.opts.reportInterval
  this.connectionTimeout = this.opts.connectionTimeout || 5000
  this.state = 'disconnected'
  this.upstream = null
  this.downstream = {}
  this.blacklist = new Blacklist()
  this._transport = null

  // server fallback options
  this.serverUrl = this.opts.serverUrl || null
  this.serverFallback = this.opts.serverFallback || false
  this.maxP2PRetries = this.opts.maxP2PRetries || 2
  this._p2pRetries = 0

  // firebase refs
  this._ref = firebase.ref(database, this.path)
  this._configRef = firebase.child(this._ref, 'configuration')
  this._requestsRef = firebase.child(this._ref, 'requests')
  this._reports = firebase.child(this._ref, 'reports')

  // set a random id if one was not provided
  this.id = this.opts.id || firebase.push(this._requestsRef).key

  // ensure K
  this.K = this.K || 0

  // use external setTimeout if provided
  this._setTimeout = this.opts.setTimeout || setTimeout.bind(window)
  this._clearTimeout = this.opts.clearTimeout || clearTimeout.bind(window)

  // bind callbacks
  this._onconfig = this._onconfig.bind(this)
  this._doconnect = this._doconnect.bind(this)
  this._onrequest = this._onrequest.bind(this)
  this._onresponse = this._onresponse.bind(this)
  this._onmaskUpdate = this._onmaskUpdate.bind(this)
  this._onreportNeeded = this._onreportNeeded.bind(this)
  this._reviewResponses = this._reviewResponses.bind(this)

  events.EventEmitter.call(this)
}

Object.defineProperty(Node.prototype, 'K', {
  get: function () {
    return this.opts.K
  },
  set: function (value) {
    if (value === this.opts.K) return
    if (isNaN(value) || ~~value !== value || value < 0) {
      throw new Error('K must be 0 or a positive integer')
    }

    debug(this.id + ' set K to ' + value)
    this.opts.K = value

    var n = 0
    for (var i in this.downstream) {
      if (++n > this.opts.K) {
        this.downstream[i].close()
      }
    }
    this._reviewRequests()
  }
})

Object.defineProperty(Node.prototype, 'transport', {
  get: function () {
    return this._transport
  }
})

Node.prototype.connect = function () {
  if (this.state !== 'disconnected') {
    throw new Error('invalid state for connect')
  }

  this._preventReconnect = false

  // reporting?
  if (this.reportInterval && !this._reportInterval) {
    this._onreportNeeded()
  }

  // change state -> requesting
  debug(this.id + ' requesting connection')
  this.state = 'requesting'
  this.emit('statechange')

  // watch config
  if (!this._watchingConfig) {
    firebase.onValue(this._configRef, this._onconfig)
    this._watchingConfig = true
  }

  this._doconnect()

  return this
}

Node.prototype.disconnect = function () {
  this.state = 'disconnected'
  this._preventReconnect = true
  this._watchingConfig = false

  // remove some listeners
  this.removeListener('configure', this._doconnect)
  firebase.off(this._configRef, 'value', this._onconfig)
  firebase.off(this._requestsRef, 'child_added', this._onrequest)

  // stop reporting
  this._clearTimeout(this._reportInterval)
  delete this._reportInterval

  // remove outstanding request / response listener
  if (this._requestRef) {
    firebase.remove(this._requestRef)
    firebase.off(this._responsesRef, 'child_added', this._onresponse)
  }

  // clean up removal flag listener
  if (this._unsubRemovalFlag) {
    this._unsubRemovalFlag()
    this._unsubRemovalFlag = null
  }

  // close upstream connection
  if (this.upstream) {
    this.upstream.close()
    this.upstream = null
  }

  // close downstream connections
  for (var i in this.downstream) {
    this.downstream[i].close()
  }
  this.downstream = {}

  return this
}

// private api below

Node.prototype._onconfig = function (snapshot) {
  var data = snapshot.val()
  if (data) deepMerge(this.opts, data)
  debug(this.id + ' updated configuration')
  this.emit('configure')
}

Node.prototype._doconnect = function () {
  var self = this

  if (this.root) {

    // emit connect but in nextTick
    this._setTimeout(function () {
      // change state -> connected
      debug(self.id + ' connected as root')
      self.state = 'connected'
      self.emit('statechange')

      // emit connect
      self.emit('connect')

      // start responding to requests
      firebase.onChildAdded(self._requestsRef, self._onrequest)
    })

    return
  }

  // we are not root so publish a connection request
  this._dorequest()
}

Node.prototype._dorequest = function () {
  console.log('UseFireflower: _dorequest', this.id)
  var self = this

  this._requestRef = firebase.push(this._requestsRef, {
    id: this.id,
    removal_flag: {
      removed: false
    }
  })

  // make sure no one removes our request until we're connected
  var removalFlagRef = firebase.child(this._requestRef, 'removal_flag')
  var unsubRemoval = firebase.onChildRemoved(removalFlagRef, function () {
    unsubRemoval()
    self._unsubRemovalFlag = null
    if (self.state === 'requesting') {
      firebase.off(self._responsesRef, 'child_added', self._onresponse)
      self._dorequest()
    }
  })
  this._unsubRemovalFlag = unsubRemoval

  // listen for a response
  delete this._responses
  this._responsesRef = firebase.child(this._requestRef, 'responses')
  firebase.onChildAdded(this._responsesRef, this._onresponse)
}

Node.prototype._onrequest = function (snapshot) {
  if (this.state !== 'connected') {
    return // can't respond to requests unless we are connected
  }

  if (Object.keys(this.downstream).length >= this.opts.K) {
    return // can't respond to requests if we've hit K peers
  }

  var self = this
  var requestRef = snapshot.ref
  var requestId = snapshot.key
  var request = snapshot.val()
  console.log('UseFireflower: _onrequest from', requestId, request, 'myId:', this.id)
  var peerId = request.id

  // responders may accidentally recreate requests
  // these won't have an id though and can be removed
  if (!peerId) {
    firebase.remove(requestRef)
    return
  }

  // prevent circles
  if (peerId === this._mask) {
    return
  }

  // since we review requests after every connect / disconnect
  // it is possible to see a peer we know about
  var knownPeer = this.downstream[peerId]
  if (knownPeer) {
    if (knownPeer.requestId !== requestId) {
      // if request ids don't match, the peer must have disconnected without us noticing
      knownPeer.close()
    } else {
      return
    }
  }

  debug(this.id + ' saw request by ' + peerId)

  var responseRef = firebase.child(requestRef, 'responses/' + this.id)

  // initiate peer connection
  // we have to do this before actually writing our response because
  // firebase can trigger events in the same tick which could circumvent
  // the K check at the top of this method
  this._connectToPeer(true, peerId, requestId, responseRef)

  // publish response
  firebase.update(responseRef, {
    level: this._level || 0,
    upstream: this.upstream ? this.upstream.id : null
  })

  // watch for request withdrawal
  var unsubWithdraw = firebase.onChildRemoved(responseRef, function () {
    unsubWithdraw()
    var peer = self.downstream[peerId]
    if (peer && !peer.didConnect) {
      peer.requestWithdrawn = true
      peer.close()
    }
  })
}

Node.prototype._onresponse = function (snapshot) {
  if (this.state !== 'requesting') {
    return
  }

  if (this._responses) {
    this._responses.push(snapshot)
  } else {
    this._responses = [ snapshot ]
    this._clearTimeout(this._responseReviewInterval)
    this._responseReviewInterval = this._setTimeout(this._reviewResponses, 250)
  }
}

Node.prototype._reviewResponses = function () {
  if (this.state !== 'requesting') {
    firebase.off(this._responsesRef, 'child_added', this._onresponse)
    delete this._responses
    return
  }

  var candidates = {}

  for (var i in this._responses) {
    var snapshot = this._responses[i]
    var response = snapshot.val()
    response.id = snapshot.key
    response.ref = snapshot.ref

    if (this.blacklist.contains(response.id)) {
      continue
    }

    if (!response.upstream) {
      console.log('UseFireflower: accepting root response', response)
      this._acceptResponse(response)
      return
    }

    candidates[response.id] = response
  }

  var sorted = []
  for (var j in candidates) {
    if (!candidates[candidates[j].upstream]) {
      sorted.push(candidates[j])
    }
  }
  sorted.sort(function (a, b) {
    return a.level - b.level
  })

  if (sorted.length) {
    firebase.off(this._responsesRef, 'child_added', this._onresponse)
    console.log('UseFireflower: accepting sorted response', sorted[0])
    this._acceptResponse(sorted[0])
    delete this._responses
  } else {
    this._responseReviewInterval = this._setTimeout(this._reviewResponses, 250)
  }
}

Node.prototype._acceptResponse = function (response) {
  var peerId = response.id

  // change state -> connecting (this prevents accepting multiple responses)
  debug(this.id + ' got response from ' + peerId)
  console.log('UseFireflower: _acceptResponse from', peerId, response)
  this.state = 'connecting'
  this.emit('statechange')

  // stop watching for request removal
  if (this._unsubRemovalFlag) {
    this._unsubRemovalFlag()
    this._unsubRemovalFlag = null
  }

  // attempt a connection
  this._connectToPeer(false, peerId, null, response.ref)
}

Node.prototype._connectToPeer = function (initiator, peerId, requestId, responseRef) {
  var self = this
  var localSignals = firebase.child(responseRef, initiator ? 'responderSignals' : 'requesterSignals')
  var remoteSignals = firebase.child(responseRef, initiator ? 'requesterSignals' : 'responderSignals')

  var peer = new Peer({
    initiator: initiator,
    trickle: this.opts.peerConfig ? this.opts.peerConfig.trickle : undefined,
    config: this.opts.peerConfig,
    channelConfig: this.opts.channelConfig
  })

  peer.id = peerId

  if (initiator) {
    this.downstream[peer.id] = peer
    peer.notifications = peer.createDataChannel('notifications')
    peer.notifications.onopen = function () {
      self._onnotificationsOpen(peer)
    }
    peer.requestId = requestId
  } else {
    peer.on('datachannel', function (channel) {
      if (channel.label === 'notifications') {
        peer.notifications = channel
        peer.notifications.onmessage = function (evt) {
          self._onmaskUpdate(evt)
        }
      }
    })
  }

  peer.on('connect', this._onpeerConnect.bind(this, peer, remoteSignals))
  peer.on('close', this._onpeerDisconnect.bind(this, peer, remoteSignals))

  peer.on('error', function (err) {
    debug(self.id + ' saw peer connection error: ' + (err.message || err))
  })

  peer.on('signal', function (signal) {
    if (initiator && self.state !== 'connected') return
    signal = JSON.parse(JSON.stringify(signal))
    firebase.push(localSignals, signal)
  })

  peer._unsubRemoteSignals = firebase.onChildAdded(remoteSignals, function (snapshot) {
    if (initiator && self.state !== 'connected') return
    var signal = snapshot.val()
    peer.signal(signal)
  })

  // timeout connections
  this._setTimeout(function () {
    if (!peer.didConnect) {
      debug(self.id + ' connection to ' + peer.id + ' timed out')
      peer.didTimeout = true
      peer.close()
    }
  }, this.connectionTimeout)
}

Node.prototype._connectViaServer = function () {
  var self = this

  // Emit fallback event
  this.emit('fallback')

  // Change state
  this.state = 'connecting'
  this.emit('statechange')

  // Get server URL (from opts or Firebase registry)
  if (!this.serverUrl) {
    // TODO: In future, look up available servers from Firebase servers/ path
    // For now, require explicit serverUrl in opts
    debug(this.id + ' server fallback enabled but no serverUrl provided')
    this.emit('error', new Error('Server fallback enabled but no serverUrl configured'))
    return
  }

  debug(this.id + ' connecting to relay server: ' + this.serverUrl)

  // Create ServerTransport
  var transport = new ServerTransport({
    url: this.serverUrl,
    nodeId: this.id,
    initiator: true
  })

  // The server will assign its own ID via the connect handshake
  // For now, use a placeholder
  transport.id = '__relay__'

  // Set up notifications channel (we're the initiator/client)
  transport.notifications = transport.createDataChannel('notifications')
  transport.notifications.onopen = function () {
    debug(self.id + ' server notifications channel opened')
    self._updateMask({
      mask: self._mask || self.id,
      level: self._level || 0
    })
  }

  // Handle connect event
  transport.on('connect', function () {
    debug(self.id + ' connected to relay server')
    transport.didConnect = true
    self._transport = 'server'
    self._onupstreamConnect(transport)
  })

  // Handle close event
  transport.on('close', function () {
    debug(self.id + ' relay server connection closed')
    self._onupstreamDisconnect(transport)
  })

  // Handle error event
  transport.on('error', function (err) {
    debug(self.id + ' relay server error: ' + (err.message || err))
  })

  // Connection timeout
  this._setTimeout(function () {
    if (!transport.didConnect) {
      debug(self.id + ' relay server connection timed out')
      transport.didTimeout = true
      transport.close()
    }
  }, this.connectionTimeout)
}

Node.prototype._onpeerConnect = function (peer, remoteSignals) {
  console.log('UseFireflower: _onpeerConnect', peer.id)
  peer.didConnect = true
  peer.removeAllListeners('connect')
  peer.removeAllListeners('signal')
  if (peer._unsubRemoteSignals) {
    peer._unsubRemoteSignals()
    peer._unsubRemoteSignals = null
  }

  if (!this.downstream[peer.id]) {
    this._onupstreamConnect(peer)
  }
}

Node.prototype._onnotificationsOpen = function (peer) {
  this._ondownstreamConnect(peer)
}

Node.prototype._onpeerDisconnect = function (peer, remoteSignals) {
  peer.removeAllListeners()
  if (peer._unsubRemoteSignals) {
    peer._unsubRemoteSignals()
    peer._unsubRemoteSignals = null
  }

  if (this.downstream[peer.id]) {
    this._ondownstreamDisconnect(peer)
  } else {
    this._onupstreamDisconnect(peer)
  }
}

Node.prototype._onupstreamConnect = function (peer) {
  // remove our request
  firebase.remove(this._requestRef)

  // already got connected by someone else
  if (this.state === 'connected') {
    debug(this.id + ' rejected upstream connection by ' + peer.id)
    peer.close()
    return
  }

  this.upstream = peer
  this._transport = 'p2p'
  this._p2pRetries = 0  // Reset retry counter on successful P2P connection

  // change state -> connected
  debug(this.id + ' established upstream connection to ' + peer.id)
  this.state = 'connected'
  this.emit('statechange')
  this.emit('connect', peer)

  // begin responding to requests
  this._reviewRequests()
}

Node.prototype._onupstreamDisconnect = function (peer) {
  // stop responding to new requests
  firebase.off(this._requestsRef, 'child_added', this._onrequest)

  // remove request
  if (this._requestRef) {
    firebase.remove(this._requestRef)
  }

  this.upstream = null

  // Save previous transport type for reconnection logic
  var previousTransport = this._transport
  this._transport = null

  // change state -> disconnected
  if (this.state !== 'disconnected') {
    debug(this.id + ' lost upstream connection to ' + peer.id)
  }

  this.state = 'disconnected'
  this.emit('statechange')

  // emit disconnect if we were connected
  if (peer.didConnect) {
    this.emit('disconnect', peer)
  }

  // attempt to reconnect if we were not disconnected intentionally
  if (!this._preventReconnect) {

    // mask off our descendants
    this._updateMask({
      mask: this.id,
      level: 0x10000
    })

    // give our mask update a head start and/or wait longer if we timed out
    var self = this
    var delay = peer.didConnect ? 100 : this.connectionTimeout

    this._setTimeout(function () {
      if (!self._preventReconnect) {
        // If we were on server and it disconnected, reset P2P retries and try P2P again
        if (previousTransport === 'server') {
          debug(self.id + ' server connection lost, attempting P2P reconnection')
          self._p2pRetries = 0
          self.connect()
        }
        // If we were on P2P or never connected
        else {
          // Increment retry counter for P2P connections
          self._p2pRetries = (self._p2pRetries || 0) + 1
          debug(self.id + ' P2P retry count: ' + self._p2pRetries + '/' + self.maxP2PRetries)

          // Check if we should fall back to server
          if (self._p2pRetries > self.maxP2PRetries && self.serverFallback) {
            debug(self.id + ' P2P retries exceeded, falling back to server')
            self._connectViaServer()
          } else {
            // Continue trying P2P
            self.connect()
          }
        }
      }
    }, delay)
  }
}

Node.prototype._ondownstreamConnect = function (peer) {
  // emit peerconnect
  debug(this.id + ' established downstream connection to ' + peer.id)
  this.emit('peerconnect', peer)

  // stop responding to requests if peers > K
  if (Object.keys(this.downstream).length >= this.opts.K) {
    firebase.off(this._requestsRef, 'child_added', this._onrequest)
  }

  // make sure downstream has the most up to date mask
  try {
    peer.notifications.send(JSON.stringify({
      mask: this._mask,
      level: this._level || 0
    }))
  } catch (err) {
    console.warn(this.id + ' failed to send initial mask update to ' + peer.id, err)
  }
}

Node.prototype._ondownstreamDisconnect = function (peer) {
  // remove from lookup
  delete this.downstream[peer.id]

  // emit events and potentially remove stale requests
  if (peer.didConnect) {
    if (this.state !== 'disconnected') {
      debug(this.id + ' lost downstream connection to ' + peer.id)
    }

    this.emit('peerdisconnect', peer)
  } else {
    if (peer.requestWithdrawn) {
      debug(this.id + ' saw request withdrawn by ' + peer.id)
    } else if (peer.didTimeout) {
      debug(this.id + ' removing stale request by ' + peer.id)
      firebase.remove(firebase.child(this._requestsRef, peer.requestId))
    }
  }

  this._reviewRequests()
}

Node.prototype._onmaskUpdate = function (evt) {
  this._updateMask(JSON.parse(evt.data))
}

Node.prototype._updateMask = function (data) {
  this._mask = data.mask
  this._level = ++data.level

  debug(this.id + ' set mask to ' + this._mask + ' and level to ' + this._level)

  // oops we made a circle, fix that
  if (this.downstream[this._mask]) {
    debug(this.id + ' destroying accidental circle back to ' + this._mask)
    this.downstream[this._mask].close()
  }

  for (var i in this.downstream) {
    var notifications = this.downstream[i].notifications
    try {
      notifications.send(JSON.stringify(data))
    } catch (err) {
      console.warn(this.id + ' failed to relay mask update downstream', err)
    }
  }
}

Node.prototype._onreportNeeded = function () {
  var report = {
    state: this.state,
    upstream: this.upstream ? this.upstream.id : null,
    timestamp: firebase.serverTimestamp()
  }

  if (this.root) {
    report.root = true
  }

  if (this.reportData) {
    report.data = this.reportData
  }

  firebase.update(
    firebase.child(this._reports, this.id),
    report
  )

  this._reportInterval = this._setTimeout(
    this._onreportNeeded,
    this.reportInterval
  )
}

Node.prototype._reviewRequests = function () {
  if (this.state === 'connected' && Object.keys(this.downstream).length < this.opts.K) {
    firebase.off(this._requestsRef, 'child_added', this._onrequest)
    firebase.onChildAdded(this._requestsRef, this._onrequest)
  }
}
