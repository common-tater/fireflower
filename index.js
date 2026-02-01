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

function ts () {
  var d = new Date()
  return d.toISOString().slice(11, 23)
}

// Heartbeat: parent sends a ping to each child over the notifications channel.
// If the child doesn't hear from the parent within HEARTBEAT_TIMEOUT, it closes
// the connection and reconnects. This catches mid-tree disconnects faster than
// waiting for ICE to transition through disconnected→failed (~10-15s).
//
// Tuning guide:
//   HEARTBEAT_INTERVAL — how often the parent sends (lower = faster detection, more traffic)
//   HEARTBEAT_TIMEOUT  — how long the child waits before declaring the parent dead
//     Should be at least 2× INTERVAL to tolerate a missed beat (network jitter, CPU throttle).
//     Too low → false positives (especially in background tabs where timers are throttled).
//     Too high → slow detection, defeating the purpose.
var HEARTBEAT_INTERVAL = 2000  // ms — parent sends every 2s
var HEARTBEAT_TIMEOUT = 4000   // ms — child considers parent dead after 4s of silence
var BACKPRESSURE_THRESHOLD = 65536  // bytes — skip sends when bufferedAmount exceeds this

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
  this.serverOnly = this.isServer ? false : (this.opts.serverOnly || false)
  this.p2pUpgradeInterval = this.opts.p2pUpgradeInterval || 30000
  this._upgradeTimer = null
  this._pendingAdapters = {}

  // server-first: connect via server immediately, then upgrade to P2P
  // Server node itself never uses server-first (it IS the server)
  this.serverFirst = this.isServer ? false : (this.opts.serverFirst !== undefined ? this.opts.serverFirst : true)

  // server fallback: secondary server connection as warm standby
  this._serverFallback = null
  this._serverInfo = null  // cached {id, serverUrl} from server responses
  this.serverFallbackDelay = opts.serverFallbackDelay !== undefined
    ? opts.serverFallbackDelay : 1000

  // health tracking
  this._connectedAt = null
  this._reconnectTimes = []  // timestamps of recent disconnects

  // dedup: track request IDs we've already responded to
  this._respondedRequests = {}

  // ancestor chain for transitive circle detection
  this._ancestors = []

  // diagnostic ring buffer — last 50 events, readable from outside
  this._debugLog = []

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
  var g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : global)
  this._setTimeout = this.opts.setTimeout || setTimeout.bind(g)
  this._clearTimeout = this.opts.clearTimeout || clearTimeout.bind(g)

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

  // close server fallback
  this._closeServerFallback()
  this._serverInfo = null

  // stop heartbeat timeout and warning (child side)
  if (this._heartbeatTimeout) {
    clearTimeout(this._heartbeatTimeout)
    this._heartbeatTimeout = null
  }
  if (this._heartbeatWarning) {
    clearTimeout(this._heartbeatWarning)
    this._heartbeatWarning = null
  }

  // close upstream connection
  if (this.upstream) {
    this.upstream.close()
    this.upstream = null
  }

  // close downstream connections (also clears their heartbeat intervals)
  for (var i in this.downstream) {
    if (this.downstream[i]._heartbeatInterval) {
      clearInterval(this.downstream[i]._heartbeatInterval)
    }
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

Node.prototype._log = function (msg) {
  var entry = '[' + ts() + '] ' + msg
  this._debugLog.push(entry)
  if (this._debugLog.length > 50) this._debugLog.shift()
}

Node.prototype._onconfig = function (snapshot) {
  var data = snapshot.val()
  if (data) deepMerge(this.opts, data)

  var wasServerOnly = this.serverOnly
  // Server node should never use server transport (it IS the server)
  // If server is disabled, serverOnly is meaningless — override to false
  var serverEnabled = this.opts.serverEnabled !== false
  this.serverOnly = (this.isServer || this.root) ? false : (serverEnabled && this.opts.serverOnly) || false

  // Cache serverUrl from config so all nodes know where the server is
  if (data && data.serverUrl && !this.isServer) {
    this._serverInfo = { serverUrl: data.serverUrl }
  } else if (!this.isServer && (!data || !data.serverUrl) && !serverEnabled) {
    this._serverInfo = null
  }

  debug(this.id + ' config changed ' + JSON.stringify(data))

  // If serverOnly was just turned off while connected via server, start upgrade timer
  if (wasServerOnly && !this.serverOnly && this._transport === 'server' && this.state === 'connected') {
    console.log('[' + ts() + '] [fireflower] serverOnly disabled, starting P2P upgrade', this.id.slice(-5))
    this._stopUpgradeTimer()
    var self = this
    var jitter = Math.floor(Math.random() * this.p2pUpgradeInterval * 0.25)
    this._upgradeTimer = this._setTimeout(function () {
      self._attemptUpgrade()
    }, this.p2pUpgradeInterval + jitter)
  }

  // serverOnly cleared while requesting — restart request so it has serverOnly=false.
  // This happens when the server dies (triggering _dorequest with old serverOnly=true)
  // and the config change (serverOnly=false) arrives via Firebase shortly after.
  if (wasServerOnly && !this.serverOnly && this.state === 'requesting') {
    console.log('[' + ts() + '] [fireflower] serverOnly disabled while requesting, restarting request', this.id.slice(-5))
    firebase.off(this._responsesRef, 'child_added', this._onresponse)
    this._clearTimeout(this._responseReviewInterval)
    if (this._requestRef) firebase.remove(this._requestRef)
    this._dorequest()
  }

  // Force server ON: switch existing P2P nodes to server
  if (!wasServerOnly && this.serverOnly && this._transport === 'p2p' && this.state === 'connected') {
    console.log('[' + ts() + '] [fireflower] serverOnly enabled, switching to server', this.id.slice(-5))
    if (this._serverFallback) {
      // Promote existing server fallback
      var p2pUpstream = this.upstream
      this.upstream = null
      this._transport = null
      this._stopUpgradeTimer()
      p2pUpstream.removeAllListeners()
      p2pUpstream.close()
      this._promoteServerFallback()
    } else {
      this._switchToServer()
    }
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
      self._log('connected as root')
      debug(self.id + ' connected as root')
      self._connectedAt = Date.now()
      self._mask = self.id
      self._level = 0
      self._ancestors = []
      self.state = 'connected'
      self.emit('statechange')

      // emit connect
      self.emit('connect')

      // start responding to requests
      self._log('root LISTENING for requests')
      firebase.onChildAdded(self._requestsRef, self._onrequest)
    })

    return
  }

  // we are not root so publish a connection request
  this._dorequest()
}

Node.prototype._dorequest = function () {
  this._log('dorequest state=' + this.state)
  console.log('[' + ts() + '] [fireflower] _dorequest', this.id.slice(-5), 'state=' + this.state, 'transport=' + this._transport, 'serverFirst=' + this.serverFirst, 'serverOnly=' + this.serverOnly)
  debug(this.id + ' requesting connection')
  var self = this

  var requestData = {
    id: this.id,
    t: Date.now(),
    removal_flag: {
      removed: false
    },
    serverOnly: this.serverOnly
  }
  if (this.isServer) requestData.isServer = true
  this._requestRef = firebase.push(this._requestsRef, requestData)

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
  // Prune _respondedRequests older than 60s (matches stale request window)
  var now = Date.now()
  for (var rid in this._respondedRequests) {
    if (now - this._respondedRequests[rid] > 60000) {
      delete this._respondedRequests[rid]
    }
  }

  var requestId = snapshot.key
  var request = snapshot.val()
  var peerId = request.id

  if (this.state !== 'connected') {
    this._log('SKIP request ' + (requestId || '').slice(-5) + ' from ' + (peerId || '').slice(-5) + ': not connected (state=' + this.state + ')')
    return
  }

  // Ignore stale requests (older than 60s) — prevents ghost nodes from occupying capacity
  var requestTime = request.t
  if (requestTime && Date.now() - requestTime > 60000) {
    this._log('SKIP request ' + (requestId || '').slice(-5) + ': stale (' + Math.round((Date.now() - requestTime) / 1000) + 's old)')
    firebase.remove(snapshot.ref)
    return
  }

  // Ignore requests from nodes that only want server transport (unless we ARE the server)
  if (request.serverOnly && !this.isServer) {
    this._log('SKIP request ' + requestId.slice(-5) + ': requester is serverOnly')
    return
  }

  // Note: server-connected nodes ARE allowed to respond to requests. Previously they
  // were blocked ("server-transport-no-respond") to prevent filling K capacity before
  // upgrading. But this creates a deadlock: when root is at K capacity (e.g., relay +
  // ghost node from external browser tab), ALL server-connected nodes refuse to respond
  // to each other's upgrade requests, and root can't accept either. The existing circle
  // prevention (ancestor chain, upstream check, downstream check in _attemptUpgrade)
  // handles safety. Server nodes accepting children may need those children to reconnect
  // after upgrade, but the system handles reconnection gracefully.

  var self = this
  var requestRef = snapshot.ref
  debug(this.id + ' saw request ' + requestId + ' from ' + peerId)

  // Root always accepts server node requests (server needs a direct root connection).
  // All other nodes respect the K limit.
  // Count only connected peers toward K — pending (not-yet-connected) peers from stale
  // Firebase requests must not block real connections. Stale requests occur when
  // _reviewRequests replays requests from nodes that already found a parent but whose
  // Firebase remove hasn't propagated yet. Without this fix, stale peers fill downstream
  // to K, root unsubscribes, and real requests are missed for the entire connectionTimeout.
  var isServerRequest = request.isServer
  var connectedCount = 0
  for (var did in this.downstream) {
    if (this.downstream[did].didConnect) connectedCount++
  }
  if (connectedCount >= this.opts.K && !(this.root && isServerRequest)) {
    this._log('SKIP request ' + requestId.slice(-5) + ': at K capacity (' + connectedCount + '/' + this.opts.K + ' connected)')
    return
  }
  // Note: we intentionally do NOT cap pending (in-progress ICE) connections.
  // Pending peers time out after connectionTimeout (5s) and get cleaned up.
  // A pending cap was previously here but caused a critical bug: when serverOnly
  // nodes publish requests, root responds with a P2P offer that the node ignores
  // (it only wants server). The "zombie" pending peer blocks root from responding
  // to legitimate upgrade requests. The connected count cap above is the real gate.

  // responders may accidentally recreate requests
  // these won't have an id though and can be removed
  if (!peerId) {
    firebase.remove(requestRef)
    return
  }

  // prevent self-connection
  if (peerId === this.id) {
    this._log('SKIP request ' + requestId.slice(-5) + ': self-connection')
    return
  }

  // prevent circles: check single mask, full ancestor chain, and direct upstream
  if (peerId === this._mask) {
    this._log('SKIP request ' + requestId.slice(-5) + ': mask circle (peerId=' + peerId.slice(-5) + ' mask=' + (this._mask || 'none').slice(-5) + ')')
    return
  }
  if (this._ancestors && this._ancestors.indexOf(peerId) !== -1) {
    this._log('SKIP request ' + requestId.slice(-5) + ': ancestor circle (peerId=' + peerId.slice(-5) + ' is in ancestor chain)')
    return
  }
  if (this.upstream && this.upstream.id === peerId) {
    this._log('SKIP request ' + requestId.slice(-5) + ': requester is our upstream')
    return
  }

  // deduplicate: skip if we already responded to this exact request
  if (this._respondedRequests[requestId]) {
    this._log('SKIP request ' + requestId.slice(-5) + ': dedup')
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
    // if peer is already connected, this is likely an upgrade request — skip it.
    // Exception: if the request is serverOnly, the peer is switching to server transport
    // and needs a fresh server connection. Close the stale downstream and respond.
    if (knownPeer.didConnect) {
      if (!request.serverOnly || !this.isServer) {
        return
      }
      this._log('closing stale downstream for ' + peerId.slice(-5) + ' (switching to server)')
      knownPeer.removeAllListeners()
      knownPeer.close()
      delete this.downstream[peerId]
    }
    // request ids don't match and peer never connected — must have disconnected without us noticing
    knownPeer.close()
  }

  debug(this.id + ' saw request by ' + peerId)
  console.log('[' + ts() + '] [fireflower] RESPOND ' + this.id.slice(-5) + ' -> ' + peerId.slice(-5) + ' via: ' + (this._transport || 'root'))

  var responseRef = firebase.child(requestRef, 'responses/' + this.id)

  // initiate peer connection
  // we have to do this before actually writing our response because
  // firebase can trigger events in the same tick which could circumvent
  // the K check at the top of this method
  // Track that we've responded to this request to prevent duplicates
  this._respondedRequests[requestId] = Date.now()

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
  var resp = snapshot.val()
  this._log('response from ' + (snapshot.key || '').slice(-5) + ' transport=' + (resp && resp.transport || 'p2p'))
  if (this.state !== 'requesting') {
    return
  }

  if (this._responses) {
    this._responses.push(snapshot)
  } else {
    this._responses = [ snapshot ]
    this._responseWindowStart = Date.now()
  }

  // When serverFirst is active, reset the batch timer on each new response
  // so the server gets a fair chance. During reconnection storms the relay
  // server can be slower than root's P2P response — without resetting, the
  // first 250ms window closes before the server candidate arrives. Cap total
  // wait at 1500ms so we don't block forever if no server is running.
  this._clearTimeout(this._responseReviewInterval)
  var delay
  if (this.serverFirst && !this.serverOnly) {
    var elapsed = Date.now() - this._responseWindowStart
    var remaining = 1500 - elapsed
    delay = remaining > 250 ? 250 : (remaining > 50 ? remaining : 50)
  } else {
    delay = 100
  }
  this._responseReviewInterval = this._setTimeout(this._reviewResponses, delay)
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

  // Split non-root candidates into P2P and server early so server-first
  // can check for server candidates before accepting the P2P root.
  var p2pCandidates = []
  var serverCandidates = []

  for (var j in candidates) {
    var c = candidates[j]
    if (c.transport === 'server') {
      this._serverInfo = { id: c.id, serverUrl: c.serverUrl }
      serverCandidates.push(c)
    } else {
      // For P2P: skip if upstream also responded (prefer the higher node)
      if (candidates[c.upstream]) continue
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

  console.log('[' + ts() + '] [fireflower] _reviewResponses', this.id.slice(-5), 'p2pRoots=' + p2pRoots.length, 'p2pCandidates=' + p2pCandidates.length, 'serverCandidates=' + serverCandidates.length, 'serverOnly=' + this.serverOnly, 'serverFirst=' + this.serverFirst)

  // Server-first: when enabled and a server candidate exists, prefer it over
  // P2P root for instant data. The P2P upgrade timer handles switching later.
  // This must be checked BEFORE the P2P root acceptance — otherwise root's
  // response (which has no upstream) always wins and server-first never fires.
  if (this.serverFirst && !this.serverOnly && serverCandidates.length) {
    firebase.off(this._responsesRef, 'child_added', this._onresponse)
    this._log('accepting server-first response from ' + serverCandidates[0].id.slice(-5))
    debug(this.id + ' accepting server-first candidate response')
    this._acceptResponse(serverCandidates[0])
    delete this._responses
    return
  }

  // Accept P2P root (unless serverOnly mode)
  if (!this.serverOnly && p2pRoots.length) {
    firebase.off(this._responsesRef, 'child_added', this._onresponse)
    debug(this.id + ' accepting P2P root response')
    this._acceptResponse(p2pRoots[0])
    delete this._responses
    return
  }

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
          var data = JSON.parse(evt.data)
          if (data.type === 'heartbeat') {
            self._onheartbeat(peer)
          } else {
            self._onmaskUpdate(evt)
          }
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

  return peer
}

Node.prototype._stopUpgradeTimer = function () {
  if (this._upgradeTimer) {
    this._clearTimeout(this._upgradeTimer)
    this._upgradeTimer = null
  }
}

/**
 * Switch from P2P to server transport.
 * Called when serverOnly is toggled ON while connected via P2P.
 */
Node.prototype._switchToServer = function () {
  this._log('switching to server')

  // Close P2P upstream
  var p2pUpstream = this.upstream
  this.upstream = null
  this._transport = null
  this._stopUpgradeTimer()

  // Clear stale ancestor chain — we're leaving our position in the P2P tree.
  // Without this, the old ancestors cause false positive circle detection when
  // responding to other nodes' requests during the server switch.
  this._updateMask({
    mask: this.id,
    level: 0x10000,
    ancestors: []
  })

  // Stop responding to requests temporarily
  firebase.off(this._requestsRef, 'child_added', this._onrequest)

  if (p2pUpstream) {
    p2pUpstream.removeAllListeners()
    p2pUpstream.close()
  }

  // Close server fallback if any (we'll get a fresh server connection)
  this._closeServerFallback()

  // Reconnect — since serverOnly is true, _reviewResponses will only accept server
  this.state = 'requesting'
  this.emit('statechange')
  this._dorequest()
}

/**
 * Attempt to upgrade from server to P2P while staying connected.
 * Publishes a secondary request; if a P2P parent responds, switch over.
 */
Node.prototype._attemptUpgrade = function () {
  if (this._transport !== 'server' || this.state !== 'connected') return
  console.log('[' + ts() + '] [fireflower] _attemptUpgrade', this.id.slice(-5), 'transport=' + this._transport)
  debug(this.id + ' attempting P2P upgrade from server')
  var self = this
  var upgradeRequestRef = firebase.push(this._requestsRef, {
    id: this.id,
    t: Date.now(),
    removal_flag: { removed: false }
  })

  var upgradeResponsesRef = firebase.child(upgradeRequestRef, 'responses')
  var upgradeTimeout = null
  var upgradeAccepted = false

  var onUpgradeResponse = function (snapshot) {
    if (upgradeAccepted) return
    var response = snapshot.val()
    response.id = snapshot.key
    response.ref = snapshot.ref

    // Only accept P2P responses for upgrade
    if (response.transport === 'server') return
    if (self.blacklist.contains(response.id)) return
    // Don't accept our own downstream as upstream — would create a circle
    if (self.downstream[response.id]) return
    // Skip root — upgrade to peers, not root (preserve root's K capacity)
    if (!response.upstream) return

    upgradeAccepted = true
    self._log('upgrade ACCEPT ' + self.id.slice(-5) + ' <- ' + response.id.slice(-5))

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

    var upgradePeer = self._connectToPeer(false, response.id, null, response.ref)

    // Do NOT remove the upgrade request yet — both sides need the Firebase signal
    // paths (requesterSignals/responderSignals under the response ref) for ICE
    // negotiation. Removing the request deletes the entire subtree including signals.
    // Clean up after the connection succeeds or fails.
    if (upgradePeer) {
      var cleanedUp = false
      var cleanupRequest = function () {
        if (!cleanedUp) {
          cleanedUp = true
          firebase.remove(upgradeRequestRef)
        }
      }
      upgradePeer.on('connect', cleanupRequest)
      upgradePeer.on('close', cleanupRequest)
    }

    // Close server after initiating P2P (so we don't re-enter requesting state)
    // Remove listeners first to prevent _onpeerDisconnect from firing
    if (serverUpstream) {
      serverUpstream.removeAllListeners()
      serverUpstream.close()
    }
  }

  firebase.onChildAdded(upgradeResponsesRef, onUpgradeResponse)

  // Timeout: clean up and reschedule
  upgradeTimeout = this._setTimeout(function () {
    self._log('upgrade TIMEOUT transport: ' + self._transport)
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

/**
 * Attempt to establish a secondary server connection as a warm standby.
 * Triggered by heartbeat early warning when P2P upstream seems unhealthy.
 */
Node.prototype._attemptServerFallback = function () {
  if (this._transport !== 'p2p') return
  if (this.state !== 'connected') return
  if (this._serverFallback) return
  if (!this._serverInfo) return

  var self = this
  debug(this.id + ' attempting server fallback')

  var fallbackRequestRef = firebase.push(this._requestsRef, {
    id: this.id,
    t: Date.now(),
    removal_flag: { removed: false }
  })

  var fallbackResponsesRef = firebase.child(fallbackRequestRef, 'responses')
  var fallbackTimeout = null

  var onFallbackResponse = function (snapshot) {
    var response = snapshot.val()
    response.id = snapshot.key
    response.ref = snapshot.ref

    // Only accept server responses
    if (response.transport !== 'server') return

    firebase.off(fallbackResponsesRef, 'child_added', onFallbackResponse)
    self._clearTimeout(fallbackTimeout)

    debug(self.id + ' got server fallback response from ' + response.id)
    firebase.remove(fallbackRequestRef)
    self._connectServerFallback(response)
  }

  firebase.onChildAdded(fallbackResponsesRef, onFallbackResponse)

  // Timeout: clean up if no server responds
  fallbackTimeout = this._setTimeout(function () {
    firebase.off(fallbackResponsesRef, 'child_added', onFallbackResponse)
    firebase.remove(fallbackRequestRef)
  }, self.connectionTimeout)
}

/**
 * Establish a secondary server connection (warm standby).
 * The fallback receives data but its mask/level updates are ignored.
 */
Node.prototype._connectServerFallback = function (response) {
  var self = this
  var transport = new ServerTransport({
    url: response.serverUrl,
    nodeId: this.id,
    initiator: true
  })

  transport.id = response.id
  transport.transportType = 'server'

  transport.on('connect', function () {
    // Check we still need the fallback
    if (self._transport !== 'p2p' || self.state !== 'connected') {
      transport.removeAllListeners()
      transport.close()
      return
    }
    self._log('server fallback connected')
    self._serverFallback = transport
  })

  transport.on('close', function () {
    if (self._serverFallback === transport) {
      self._serverFallback = null
    }
  })

  // Handle notifications channel — ignore mask updates, only track heartbeats
  transport.on('datachannel', function (channel) {
    if (channel.label === 'notifications') {
      channel.onmessage = function (evt) {
        var data = JSON.parse(evt.data)
        if (data.type === 'heartbeat') {
          // Track server fallback heartbeat for liveness
          if (self._serverFallbackHeartbeat) clearTimeout(self._serverFallbackHeartbeat)
          self._serverFallbackHeartbeat = setTimeout(function () {
            // Server fallback went silent — close it
            if (self._serverFallback === transport) {
              self._log('server fallback heartbeat timeout')
              self._closeServerFallback()
            }
          }, HEARTBEAT_TIMEOUT)
        }
        // Ignore mask updates — keep primary upstream's tree position
      }
    }
  })
}

/**
 * Promote server fallback to primary upstream.
 * Called when P2P upstream dies and fallback is already connected.
 */
Node.prototype._promoteServerFallback = function () {
  var fallback = this._serverFallback
  this._serverFallback = null

  // Clear fallback heartbeat timer
  if (this._serverFallbackHeartbeat) {
    clearTimeout(this._serverFallbackHeartbeat)
    this._serverFallbackHeartbeat = null
  }

  // Set up as primary upstream
  this.upstream = fallback
  this._transport = 'server'
  this._connectedAt = Date.now()

  this._log('promoted server fallback to primary -> ' + fallback.id)

  // Switch notification handler to accept mask updates (was ignoring them)
  var self = this
  fallback.removeAllListeners('datachannel')
  // Re-wire any existing notifications channel
  if (fallback._channels && fallback._channels.notifications) {
    var channel = fallback._channels.notifications
    channel.onmessage = function (evt) {
      var data = JSON.parse(evt.data)
      if (data.type === 'heartbeat') {
        self._onheartbeat(fallback)
      } else {
        self._onmaskUpdate(evt)
      }
    }
  }

  // Wire close handler
  fallback.removeAllListeners('close')
  fallback.on('close', self._onpeerDisconnect.bind(self, fallback, null))

  // change state -> connected
  this.state = 'connected'
  this.emit('statechange')
  this.emit('fallback')

  // Start P2P upgrade timer (unless serverOnly)
  if (this.p2pUpgradeInterval && !this.serverOnly) {
    this._stopUpgradeTimer()
    var jitter = Math.floor(Math.random() * this.p2pUpgradeInterval * 0.25)
    this._upgradeTimer = this._setTimeout(function () {
      self._attemptUpgrade()
    }, self.p2pUpgradeInterval + jitter)
  }

  // Resume responding to requests
  this._reviewRequests()
}

/**
 * Clean up and close the server fallback connection.
 */
Node.prototype._closeServerFallback = function () {
  if (!this._serverFallback) return
  debug(this.id + ' closing server fallback (P2P healthy)')
  var fallback = this._serverFallback
  this._serverFallback = null
  if (this._serverFallbackHeartbeat) {
    clearTimeout(this._serverFallbackHeartbeat)
    this._serverFallbackHeartbeat = null
  }
  fallback.removeAllListeners()
  fallback.close()
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
  } else if (this.downstream[peer.id] !== peer && this.state === 'connecting') {
    // Race condition: we're trying to connect upstream to this peer (upgrade),
    // but a DIFFERENT peer object with the same ID exists in downstream
    // (from responding to their request). Close the stale downstream entry
    // and treat this new peer as our upstream.
    this._log('resolving downstream/upstream collision with ' + peer.id.slice(-5))
    var staleDownstream = this.downstream[peer.id]
    delete this.downstream[peer.id]
    if (staleDownstream._heartbeatInterval) {
      clearInterval(staleDownstream._heartbeatInterval)
    }
    staleDownstream.removeAllListeners()
    staleDownstream.close()
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
  } else if (this.state === 'connecting') {
    // Peer failed before becoming upstream — reset and reconnect
    this._log('peer ' + peer.id.slice(-5) + ' failed during connecting, reconnecting')
    debug(this.id + ' peer failed during connecting state, reconnecting')
    this.state = 'disconnected'
    this.emit('statechange')
    var self = this
    this._setTimeout(function () {
      if (!self._preventReconnect) {
        self.connect()
      }
    }, 100)
  }
  // else: stale peer (replaced by a newer connection), ignore
}

Node.prototype._onupstreamConnect = function (peer) {
  this._log('upstream connected ' + peer.id.slice(-5) + ' transport:' + (peer.transportType || 'p2p'))
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
    this._log('upgraded server -> p2p')
    debug(this.id + ' upgraded from server to P2P')
    this.emit('upgrade')
  }

  // Start P2P upgrade timer when connected via server (skip if serverOnly)
  // Add random jitter (0-25% of interval) to prevent thundering herd when
  // many nodes connect via server around the same time
  if (this._transport === 'server' && this.p2pUpgradeInterval && !this.serverOnly) {
    this._stopUpgradeTimer()
    var self = this
    var jitter = Math.floor(Math.random() * this.p2pUpgradeInterval * 0.25)
    this._upgradeTimer = this._setTimeout(function () {
      self._attemptUpgrade()
    }, this.p2pUpgradeInterval + jitter)
    this.emit('fallback')
  }

  // change state -> connected
  console.log('[' + ts() + '] [fireflower] upstream connected', this.id, '->', peer.id, 'transport:', this._transport)
  debug(this.id + ' established upstream connection to ' + peer.id)
  this.state = 'connected'
  this.emit('statechange')
  this.emit('connect', peer)

  // If serverOnly was set while we were connecting via P2P, switch now
  if (this.serverOnly && this._transport === 'p2p') {
    this._log('connected via P2P but serverOnly is set, switching to server')
    this._switchToServer()
    return
  }

  // Start initial heartbeat timeout — if no heartbeat arrives within
  // HEARTBEAT_TIMEOUT, the parent is dead (may have died before sending one).
  // Without this, a child whose parent dies before the first heartbeat
  // sits forever with no timeout running.
  if (!this.root && this._transport === 'p2p') {
    var self2 = this
    this._heartbeatTimeout = setTimeout(function () {
      if (self2.upstream === peer && !peer._closed) {
        self2._log('initial heartbeat timeout, closing upstream -x-> ' + peer.id)
        peer.close()
      }
    }, HEARTBEAT_TIMEOUT)
  }

  // begin responding to requests
  this._reviewRequests()
}

Node.prototype._onupstreamDisconnect = function (peer) {
  this._log('upstream disconnected ' + peer.id.slice(-5) + ' transport:' + (peer.transportType || 'p2p'))
  console.log('[' + ts() + '] [fireflower] upstream disconnected', this.id, '-x->', peer.id, 'transport:', peer.transportType)
  debug(this.id + ' lost upstream ' + peer.id)

  // stop heartbeat timeout and warning
  if (this._heartbeatTimeout) {
    clearTimeout(this._heartbeatTimeout)
    this._heartbeatTimeout = null
  }
  if (this._heartbeatWarning) {
    clearTimeout(this._heartbeatWarning)
    this._heartbeatWarning = null
  }

  // If we have a server fallback ready, promote it immediately
  if (this._serverFallback && peer.didConnect) {
    // stop responding to new requests temporarily
    firebase.off(this._requestsRef, 'child_added', this._onrequest)
    if (this._requestRef) {
      firebase.remove(this._requestRef)
    }
    this.upstream = null
    this._transport = null
    this._stopUpgradeTimer()
    this._reconnectTimes.push(Date.now())
    this.emit('disconnect', peer)
    this._promoteServerFallback()
    return
  }

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

  // Close any pending server fallback attempt
  this._closeServerFallback()

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

    // mask off our descendants — _updateMask will append our id to ancestors
    // when relaying, so children get [this.id] in their ancestor chain
    this._updateMask({
      mask: this.id,
      level: 0x10000,
      ancestors: []
    })

    // give our mask update a head start and/or wait longer if we timed out
    var self = this
    var delay = peer.didConnect ? 100 : this.connectionTimeout
    this._log('scheduling reconnect delay=' + delay + 'ms')

    this._setTimeout(function () {
      if (!self._preventReconnect) {
        self._log('reconnecting now')
        self.connect()
      }
    }, delay)
  }
}

Node.prototype._ondownstreamConnect = function (peer) {
  // emit peerconnect
  debug(this.id + ' established downstream connection to ' + peer.id)
  this.emit('peerconnect', peer)

  // stop responding to requests if connected peers >= K
  var connected = 0
  for (var cid in this.downstream) {
    if (this.downstream[cid].didConnect) connected++
  }
  var childIds = []
  for (var cid2 in this.downstream) {
    if (this.downstream[cid2].didConnect) childIds.push(cid2.slice(-5))
  }
  console.log('[' + ts() + '] [fireflower] downstream connected', this.id.slice(-5), '<-', peer.id.slice(-5), 'connected:', connected + '/' + this.opts.K, connected >= this.opts.K ? '(FULL children: ' + childIds.join(',') + ')' : '')
  if (connected >= this.opts.K) {
    firebase.off(this._requestsRef, 'child_added', this._onrequest)
  }

  // make sure downstream has the most up to date mask (including ancestor chain)
  if (!peer.notifications.bufferedAmount || peer.notifications.bufferedAmount < BACKPRESSURE_THRESHOLD) {
    try {
      peer.notifications.send(JSON.stringify({
        mask: this._mask,
        level: this._level || 0,
        ancestors: (this._ancestors || []).concat([this.id])
      }))
    } catch (err) {
      console.warn(this.id + ' failed to send initial mask update to ' + peer.id, err)
    }
  }

  // start sending heartbeat to this child
  // Also detect dead downstream: when the child closes its side of the connection,
  // the data channel transitions to 'closed' long before ICE reaches 'failed' (~10s).
  // By checking readyState on each heartbeat tick, we detect dead children within
  // one heartbeat interval (2s) instead of waiting for ICE timeout.
  peer._heartbeatInterval = setInterval(function () {
    if (peer._closed) {
      clearInterval(peer._heartbeatInterval)
      return
    }
    if (peer.notifications && peer.notifications.readyState === 'open') {
      if (!peer.notifications.bufferedAmount || peer.notifications.bufferedAmount < BACKPRESSURE_THRESHOLD) {
        try {
          peer.notifications.send(JSON.stringify({ type: 'heartbeat', t: Date.now() }))
        } catch (err) {}
      }
    } else if (peer.didConnect && peer.notifications &&
               (peer.notifications.readyState === 'closed' || peer.notifications.readyState === 'closing')) {
      clearInterval(peer._heartbeatInterval)
      peer._heartbeatInterval = null
      peer.close()
    }
  }, HEARTBEAT_INTERVAL)
}

Node.prototype._ondownstreamDisconnect = function (peer) {
  if (peer.didConnect) {
    var remainConnected = 0
    for (var rid in this.downstream) {
      if (rid !== peer.id && this.downstream[rid].didConnect) remainConnected++
    }
    console.log('[' + ts() + '] [fireflower] downstream disconnected', this.id, '-x-', peer.id, 'remaining:', remainConnected + '/' + this.opts.K)
  }

  // stop heartbeat to this child
  if (peer._heartbeatInterval) {
    clearInterval(peer._heartbeatInterval)
    peer._heartbeatInterval = null
  }

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

Node.prototype._onheartbeat = function (peer) {
  if (this._heartbeatTimeout) clearTimeout(this._heartbeatTimeout)
  if (this._heartbeatWarning) clearTimeout(this._heartbeatWarning)

  var self = this

  // P2P is healthy — close server fallback if we have one
  if (this._serverFallback) {
    this._closeServerFallback()
  }

  // Tier 1: Early warning — trigger server fallback attempt
  if (this.serverFallbackDelay && this._serverInfo && this._transport === 'p2p') {
    this._heartbeatWarning = setTimeout(function () {
      if (self.upstream === peer && !peer._closed && !self._serverFallback) {
        self._log('heartbeat warning, attempting server fallback')
        self._attemptServerFallback()
      }
    }, HEARTBEAT_INTERVAL + self.serverFallbackDelay)
  }

  // Tier 2: Kill — close upstream (existing behavior)
  this._heartbeatTimeout = setTimeout(function () {
    if (self.upstream === peer && !peer._closed) {
      self._log('heartbeat timeout, closing upstream -x-> ' + peer.id)
      peer.close()
    }
  }, HEARTBEAT_TIMEOUT)
}

Node.prototype._updateMask = function (data) {
  this._mask = data.mask
  this._ancestors = data.ancestors || []
  this._level = ++data.level

  debug(this.id + ' set mask to ' + this._mask + ' and level to ' + this._level + ' ancestors: ' + this._ancestors.length)

  // oops we made a circle, fix that — check both single mask and full ancestor list
  if (this.downstream[this._mask]) {
    debug(this.id + ' destroying accidental circle back to ' + this._mask)
    this.downstream[this._mask].close()
  }
  for (var a = 0; a < this._ancestors.length; a++) {
    if (this.downstream[this._ancestors[a]]) {
      debug(this.id + ' destroying accidental circle back to ancestor ' + this._ancestors[a])
      this.downstream[this._ancestors[a]].close()
    }
  }

  // Relay to children with our id appended to the ancestor chain
  var relayData = {
    mask: data.mask,
    level: data.level,
    ancestors: this._ancestors.concat([this.id])
  }

  for (var i in this.downstream) {
    var notifications = this.downstream[i].notifications
    if (notifications && notifications.readyState === 'open') {
      if (!notifications.bufferedAmount || notifications.bufferedAmount < BACKPRESSURE_THRESHOLD) {
        try {
          notifications.send(JSON.stringify(relayData))
        } catch (err) {
          console.warn(this.id + ' failed to relay mask update downstream', err)
        }
      }
    }
  }
}

Node.prototype._getHealthScore = function () {
  var now = Date.now()

  // Prune _reconnectTimes older than 2 minutes
  while (this._reconnectTimes.length && now - this._reconnectTimes[0] > 120000) {
    this._reconnectTimes.shift()
  }

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
  if (this.state !== 'connected') {
    this._log('_reviewRequests SKIP state=' + this.state)
    return
  }

  // Use connected count (not total) to match _ondownstreamConnect's stop check.
  // Pending peers (ICE in progress) sit in this.downstream but shouldn't block
  // the node from accepting new requests — _onrequest has its own capacity checks.
  var connected = 0
  var pending = 0
  for (var id in this.downstream) {
    if (this.downstream[id].didConnect) connected++
    else pending++
  }
  if (connected < this.opts.K) {
    console.log('[' + ts() + '] [fireflower] _reviewRequests SUBSCRIBING', this.id.slice(-5), 'connected=' + connected + '/' + this.opts.K, 'pending=' + pending)
    firebase.off(this._requestsRef, 'child_added', this._onrequest)
    firebase.onChildAdded(this._requestsRef, this._onrequest)
  } else {
    console.log('[' + ts() + '] [fireflower] _reviewRequests FULL', this.id.slice(-5), 'connected=' + connected + '/' + this.opts.K)
  }
}
