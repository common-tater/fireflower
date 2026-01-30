module.exports = function (db) {
  database = db
  return Node
}

var debug = require('debug')('fireflower')
var events = require('events')
var inherits = require('inherits')
var Peer = require('./peer')
var ServerTransport = require('./server-transport')
var ServerPeerAdapter = require('./server-peer-adapter')
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

  // server node options
  this.isServer = this.opts.isServer || false
  this.serverUrl = this.opts.serverUrl || null
  this.serverOnly = this.opts.serverOnly || false
  this.p2pUpgradeInterval = this.opts.p2pUpgradeInterval || 30000
  this._upgradeTimer = null
  this._pendingAdapters = {}

  // health tracking
  this._connectedAt = null
  this._reconnectTimes = []  // timestamps of recent disconnects

  // dedup: track request IDs we've already responded to
  this._respondedRequests = {}

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

  // stop upgrade timer
  this._stopUpgradeTimer()

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

  // close pending adapters
  for (var j in this._pendingAdapters) {
    this._pendingAdapters[j].close()
  }
  this._pendingAdapters = {}

  return this
}

// private api below

Node.prototype._onconfig = function (snapshot) {
  var data = snapshot.val()
  if (data) deepMerge(this.opts, data)

  var wasServerOnly = this.serverOnly
  this.serverOnly = this.opts.serverOnly || false

  console.log('[fireflower] config changed', this.id, JSON.stringify(data))

  // If serverOnly was just turned off while connected via server, start upgrade timer
  if (wasServerOnly && !this.serverOnly && this._transport === 'server' && this.state === 'connected') {
    console.log('[fireflower] serverOnly disabled, starting P2P upgrade', this.id)
    this._stopUpgradeTimer()
    var self = this
    this._upgradeTimer = this._setTimeout(function () {
      self._attemptUpgrade()
    }, this.p2pUpgradeInterval)
  }

  debug(this.id + ' updated configuration')
  this.emit('configure')
}

Node.prototype._doconnect = function () {
  var self = this

  if (this.root) {

    // emit connect but in nextTick
    this._setTimeout(function () {
      // change state -> connected
      console.log('[fireflower] connected as root', self.id)
      debug(self.id + ' connected as root')
      self._connectedAt = Date.now()
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
  debug(this.id + ' requesting connection')
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
  debug(this.id + ' saw request ' + requestId + ' from ' + peerId)
  var peerId = request.id

  // responders may accidentally recreate requests
  // these won't have an id though and can be removed
  if (!peerId) {
    firebase.remove(requestRef)
    return
  }

  // prevent circles and self-connections
  if (peerId === this._mask || peerId === this.id) {
    return
  }

  // deduplicate: skip if we already responded to this exact request
  if (this._respondedRequests[requestId]) {
    debug(this.id + ' dedup skipping request ' + requestId)
    return
  }

  // since we review requests after every connect / disconnect
  // it is possible to see a peer we know about
  var knownPeer = this.downstream[peerId]
  if (knownPeer) {
    if (knownPeer.requestId === requestId) {
      return
    }
    // if peer is already connected, this is likely an upgrade request — skip it
    if (knownPeer.didConnect) {
      return
    }
    // request ids don't match and peer never connected — must have disconnected without us noticing
    knownPeer.close()
  }

  debug(this.id + ' saw request by ' + peerId)

  var responseRef = firebase.child(requestRef, 'responses/' + this.id)

  // initiate peer connection
  // we have to do this before actually writing our response because
  // firebase can trigger events in the same tick which could circumvent
  // the K check at the top of this method
  // Track that we've responded to this request to prevent duplicates
  this._respondedRequests[requestId] = true

  var transportOpts = this.isServer ? { transport: 'server', serverUrl: this.serverUrl } : null
  this._connectToPeer(true, peerId, requestId, responseRef, transportOpts)

  // publish response
  var response = {
    level: this._level || 0,
    upstream: this.upstream ? this.upstream.id : null,
    health: this._getHealthScore()
  }
  if (this.isServer) {
    response.transport = 'server'
    response.serverUrl = this.serverUrl
  }
  firebase.update(responseRef, response)

  // Note: withdrawal detection is handled by ICE failure and connection timeout.
  // We previously watched onChildRemoved(responseRef) here, but when the requester
  // removes its request after connecting, Firebase cascades the removal synchronously,
  // killing the downstream peer before its ICE can finish connecting.
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

  var p2pRoots = []
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
      p2pRoots.push(response)
      continue
    }

    candidates[response.id] = response
  }

  // Accept P2P root (unless serverOnly mode)
  if (!this.serverOnly && p2pRoots.length) {
    firebase.off(this._responsesRef, 'child_added', this._onresponse)
    debug(this.id + ' accepting P2P root response')
    this._acceptResponse(p2pRoots[0])
    delete this._responses
    return
  }

  // Split non-root candidates into P2P and server, prefer P2P
  var p2pCandidates = []
  var serverCandidates = []

  for (var j in candidates) {
    var c = candidates[j]
    if (candidates[c.upstream]) continue // skip if upstream also responded
    if (c.transport === 'server') {
      serverCandidates.push(c)
    } else {
      p2pCandidates.push(c)
    }
  }

  // Sort by health score (higher = better), fall back to level (lower = better)
  // Only let health override level when there's a clear difference (>20 points)
  // and both candidates have reported health scores
  function healthSort (a, b) {
    var aHealth = a.health || 0
    var bHealth = b.health || 0
    // Only use health if both have reported a score
    if (aHealth > 0 && bHealth > 0) {
      var healthDiff = bHealth - aHealth
      if (Math.abs(healthDiff) > 20) return healthDiff
    }
    return a.level - b.level
  }
  p2pCandidates.sort(healthSort)
  serverCandidates.sort(healthSort)

  if (!this.serverOnly && p2pCandidates.length) {
    firebase.off(this._responsesRef, 'child_added', this._onresponse)
    debug(this.id + ' accepting P2P candidate response')
    this._acceptResponse(p2pCandidates[0])
    delete this._responses
    return
  }

  if (serverCandidates.length) {
    firebase.off(this._responsesRef, 'child_added', this._onresponse)
    debug(this.id + ' accepting server candidate response')
    this._acceptResponse(serverCandidates[0])
    delete this._responses
    return
  }

  this._responseReviewInterval = this._setTimeout(this._reviewResponses, 250)
}

Node.prototype._acceptResponse = function (response) {
  var peerId = response.id

  // change state -> connecting (this prevents accepting multiple responses)
  debug(this.id + ' got response from ' + peerId)
  debug(this.id + ' accepted response from ' + peerId)
  this.state = 'connecting'
  this.emit('statechange')

  // stop watching for request removal
  if (this._unsubRemovalFlag) {
    this._unsubRemovalFlag()
    this._unsubRemovalFlag = null
  }

  // thread transport metadata to _connectToPeer
  var transportOpts = null
  if (response.transport === 'server') {
    transportOpts = { transport: 'server', serverUrl: response.serverUrl }
  }

  // attempt a connection
  this._connectToPeer(false, peerId, null, response.ref, transportOpts)
}

Node.prototype._createTransport = function (initiator, peerId, transportOpts) {
  if (transportOpts && transportOpts.transport === 'server') {
    if (initiator && this.isServer) {
      // Server-side: create a pending adapter that gets wired up when client connects via WebSocket
      var adapter = new ServerPeerAdapter(peerId, this.id)
      this._pendingAdapters[peerId] = adapter
      return adapter
    } else if (!initiator && transportOpts.serverUrl) {
      // Client-side: create a ServerTransport to connect to the relay server
      return new ServerTransport({
        url: transportOpts.serverUrl,
        nodeId: this.id,
        initiator: true
      })
    }
  }

  // Default: WebRTC Peer
  return new Peer({
    initiator: initiator,
    trickle: this.opts.peerConfig ? this.opts.peerConfig.trickle : undefined,
    config: this.opts.peerConfig,
    channelConfig: this.opts.channelConfig,
    wrtc: this.opts.wrtc
  })
}

Node.prototype._connectToPeer = function (initiator, peerId, requestId, responseRef, transportOpts) {
  var self = this
  var isServerTransport = transportOpts && transportOpts.transport === 'server'

  var peer = this._createTransport(initiator, peerId, transportOpts)
  peer.id = peerId

  if (initiator) {
    this.downstream[peer.id] = peer
    // Create all data channels BEFORE negotiation so they're included in the SDP offer
    if (!isServerTransport) {
      peer.createDataChannel('_default', peer.channelConfig)
    }
    peer.notifications = peer.createDataChannel('notifications')
    peer.notifications.onopen = function () {
      peer.didConnect = true
      self._onnotificationsOpen(peer)
    }
    peer.requestId = requestId
    if (!isServerTransport) {
      peer.negotiate()
    }
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

  // Firebase signal exchange (skip for server transport — no ICE/SDP needed)
  var remoteSignals = null
  if (!isServerTransport) {
    var localSignals = firebase.child(responseRef, initiator ? 'responderSignals' : 'requesterSignals')
    remoteSignals = firebase.child(responseRef, initiator ? 'requesterSignals' : 'responderSignals')

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
  }

  peer.on('connect', this._onpeerConnect.bind(this, peer, remoteSignals))
  peer.on('close', this._onpeerDisconnect.bind(this, peer, remoteSignals))

  peer.on('error', function (err) {
    debug(self.id + ' saw peer connection error: ' + (err.message || err))
  })

  // timeout connections
  this._setTimeout(function () {
    if (!peer.didConnect) {
      debug(self.id + ' connection timeout -> ' + peer.id)
      peer.didTimeout = true
      peer.close()
    }
  }, this.connectionTimeout)
}

Node.prototype._stopUpgradeTimer = function () {
  if (this._upgradeTimer) {
    this._clearTimeout(this._upgradeTimer)
    this._upgradeTimer = null
  }
}

/**
 * Attempt to upgrade from server to P2P while staying connected.
 * Publishes a secondary request; if a P2P parent responds, switch over.
 */
Node.prototype._attemptUpgrade = function () {
  if (this._transport !== 'server' || this.state !== 'connected') return
  debug(this.id + ' attempting P2P upgrade from server')
  var self = this
  var upgradeRequestRef = firebase.push(this._requestsRef, {
    id: this.id,
    removal_flag: { removed: false }
  })

  var upgradeResponsesRef = firebase.child(upgradeRequestRef, 'responses')
  var upgradeTimeout = null

  var onUpgradeResponse = function (snapshot) {
    var response = snapshot.val()
    response.id = snapshot.key
    response.ref = snapshot.ref

    // Only accept P2P responses for upgrade
    if (response.transport === 'server') return
    if (self.blacklist.contains(response.id)) return

    // Got a P2P response — accept it
    firebase.off(upgradeResponsesRef, 'child_added', onUpgradeResponse)
    self._clearTimeout(upgradeTimeout)

    debug(self.id + ' got P2P upgrade response from ' + response.id)

    // Close server upstream, then accept P2P connection
    var serverUpstream = self.upstream
    self.upstream = null
    self._transport = null
    self.state = 'connecting'
    self.emit('statechange')

    self._connectToPeer(false, response.id, null, response.ref)

    // Close server after initiating P2P (so we don't re-enter requesting state)
    serverUpstream.close()
  }

  firebase.onChildAdded(upgradeResponsesRef, onUpgradeResponse)

  // Timeout: clean up and reschedule
  upgradeTimeout = this._setTimeout(function () {
    firebase.off(upgradeResponsesRef, 'child_added', onUpgradeResponse)
    firebase.remove(upgradeRequestRef)

    // Schedule next attempt
    if (self._transport === 'server' && self.state === 'connected') {
      self._upgradeTimer = self._setTimeout(function () {
        self._attemptUpgrade()
      }, self.p2pUpgradeInterval)
    }
  }, self.connectionTimeout)
}

Node.prototype._onpeerConnect = function (peer, remoteSignals) {
  debug(this.id + ' peer connected: ' + peer.id)
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

  if (this.downstream[peer.id] === peer) {
    this._ondownstreamDisconnect(peer)
  } else if (this.upstream === peer) {
    this._onupstreamDisconnect(peer)
  }
  // else: stale peer (replaced by a newer connection), ignore
}

Node.prototype._onupstreamConnect = function (peer) {
  // remove our request
  if (this._requestRef) {
    firebase.remove(this._requestRef)
  }

  // already got connected by someone else
  if (this.state === 'connected') {
    debug(this.id + ' rejected upstream connection by ' + peer.id)
    peer.close()
    return
  }

  var previousTransport = this._transport
  this.upstream = peer
  this._transport = peer.transportType || 'p2p'
  this._connectedAt = Date.now()

  // Upgraded from server to P2P
  if (previousTransport === 'server' && this._transport === 'p2p') {
    this._stopUpgradeTimer()
    console.log('[fireflower] upgraded server -> p2p', this.id)
    debug(this.id + ' upgraded from server to P2P')
    this.emit('upgrade')
  }

  // Start P2P upgrade timer when connected via server (skip if serverOnly)
  if (this._transport === 'server' && this.p2pUpgradeInterval && !this.serverOnly) {
    this._stopUpgradeTimer()
    var self = this
    this._upgradeTimer = this._setTimeout(function () {
      self._attemptUpgrade()
    }, this.p2pUpgradeInterval)
    this.emit('fallback')
  }

  // change state -> connected
  console.log('[fireflower] upstream connected', this.id, '->', peer.id, 'transport:', this._transport)
  debug(this.id + ' established upstream connection to ' + peer.id)
  this.state = 'connected'
  this.emit('statechange')
  this.emit('connect', peer)

  // begin responding to requests
  this._reviewRequests()
}

Node.prototype._onupstreamDisconnect = function (peer) {
  console.log('[fireflower] upstream disconnected', this.id, '-x->', peer.id, 'transport:', peer.transportType)
  debug(this.id + ' lost upstream ' + peer.id)
  // stop responding to new requests
  firebase.off(this._requestsRef, 'child_added', this._onrequest)

  // remove request
  if (this._requestRef) {
    firebase.remove(this._requestRef)
  }

  this.upstream = null
  this._transport = null
  this._connectedAt = null
  this._reconnectTimes.push(Date.now())
  this._stopUpgradeTimer()

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
        self.connect()
      }
    }, delay)
  }
}

Node.prototype._ondownstreamConnect = function (peer) {
  console.log('[fireflower] downstream connected', this.id, '<-', peer.id, 'count:', Object.keys(this.downstream).length)
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
  console.log('[fireflower] downstream disconnected', this.id, '-x-', peer.id, 'didConnect:', peer.didConnect)
  // remove from lookup
  delete this.downstream[peer.id]
  delete this._pendingAdapters[peer.id]

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

Node.prototype._getHealthScore = function () {
  var now = Date.now()
  var downstreamCount = Object.keys(this.downstream).length
  var K = this.opts.K || 2

  // uptime: 30 points, linear ramp over 60 seconds
  var uptime = this._connectedAt ? (now - this._connectedAt) / 1000 : 0
  var uptimeScore = Math.min(uptime / 60, 1) * 30

  // stability: 30 points, -10 per recent reconnect (last 2 minutes)
  var recentWindow = 120000
  var recentReconnects = 0
  for (var i = this._reconnectTimes.length - 1; i >= 0; i--) {
    if (now - this._reconnectTimes[i] < recentWindow) {
      recentReconnects++
    } else {
      break
    }
  }
  var stabilityScore = Math.max(30 - recentReconnects * 10, 0)

  // load: 20 points, inversely proportional to downstream usage
  var loadScore = 20 * (1 - downstreamCount / K)

  // level: 20 points, closer to root is better (cap at level 5)
  var level = this._level || 0
  var levelScore = 20 * (1 - Math.min(level, 5) / 5)

  // root always gets full uptime and stability since it has no upstream
  if (this.root) {
    uptimeScore = 30
    stabilityScore = 30
  }

  return Math.round(uptimeScore + stabilityScore + loadScore + levelScore)
}

Node.prototype._getHealthData = function () {
  var now = Date.now()
  var downstreamCount = Object.keys(this.downstream).length
  var recentWindow = 120000
  var recentReconnects = 0
  for (var i = this._reconnectTimes.length - 1; i >= 0; i--) {
    if (now - this._reconnectTimes[i] < recentWindow) {
      recentReconnects++
    } else {
      break
    }
  }
  return {
    score: this._getHealthScore(),
    uptime: this._connectedAt ? Math.round((now - this._connectedAt) / 1000) : 0,
    reconnects: recentReconnects,
    load: parseFloat((downstreamCount / (this.opts.K || 2)).toFixed(2)),
    level: this._level || 0,
    downstreamCount: downstreamCount
  }
}

Node.prototype._onreportNeeded = function () {
  var report = {
    state: this.state,
    upstream: this.upstream ? this.upstream.id : null,
    transport: this._transport,
    level: this._level || 0,
    timestamp: firebase.serverTimestamp()
  }

  if (this.root) {
    report.root = true
  }

  if (this.isServer) {
    report.isServer = true
  }

  report.health = this._getHealthData()

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
