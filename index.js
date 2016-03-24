module.exports = function (_Firebase) {
  Firebase = _Firebase
  return Node
}

var debug = require('debug')('fireflower')
var merge = require('merge').recursive
var events = require('events')
var inherits = require('inherits')
var SimplePeer = require('simpler-peer')
var Blacklist = require('./blacklist')
var Firebase = null

inherits(Node, events.EventEmitter)

function Node (url, opts) {
  if (!(this instanceof Node)) {
    return new Node(url, opts)
  }

  this.url = url
  this.opts = opts || {}
  this.root = this.opts.root
  this.reportInterval = this.opts.reportInterval
  this.connectionTimeout = this.opts.connectionTimeout || 5000
  this.state = 'disconnected'
  this.upstream = null
  this.downstream = {}
  this.blacklist = new Blacklist()

  // firebase refs
  this._ref = new Firebase(this.url)
  this._configRef = this._ref.child('configuration')
  this._requestsRef = this._ref.child('requests')
  this._reports = this._ref.child('reports')

  // set a random id if one was not provided
  this.id = this.opts.id
  this.userId = this.opts.userId || String(Math.random()).slice(2)
  this.peerId = this.opts.peerId || String(Math.random()).slice(2)

  // ensure K
  this.K = this.K || 0

  // use external setTimeout if provided
  this._setTimeout = this.opts.setTimeout || window.setTimeout.bind(window)
  this._clearTimeout = this.opts.clearTimeout || window.clearTimeout.bind(window)

  // bind callbacks
  this._onconfig = this._onconfig.bind(this)
  this._doconnect = this._doconnect.bind(this)
  this._onrequest = this._onrequest.bind(this)
  this._onresponse = this._onresponse.bind(this)
  this._updateMask = this._updateMask.bind(this)
  this._onreportNeeded = this._onreportNeeded.bind(this)
  this._reviewResponses = this._reviewResponses.bind(this)

  this._websocketConnected = this.opts.websocketConnected
  this._websocketUserId = this._websocketConnected

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

    debug(this.peerId + ' set K to ' + value)
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

Node.prototype.connect = function () {
  var self = this
  if (this.state !== 'disconnected' && this.state !== 'websocketconnected') {
    throw new Error('invalid state for connect')
  }

  this._preventReconnect = false

  // reporting?
  if (this.reportInterval && !this._reportInterval) {
    this._onreportNeeded()
  }

  // change state -> requesting
  if (this.state !== 'websocketconnected') {
    debug(this.peerId + ' requesting connection')
    this.state = 'requesting'
    this.emit('statechange')
  }

  // watch config
  if (!this._watchingConfig) {
    this._configRef.on('value', this._onconfig)
    this._watchingConfig = true
  }

  this._setTimeout(function () {
    self._doconnect()
  })

  return this
}

Node.prototype.disconnect = function () {
  var self = this
  this._setTimeout(function () {
    self._reset()

    self._preventReconnect = true
    self._watchingConfig = false

    // remove some listeners
    self.removeListener('configure', self._doconnect)
    self._configRef.off('value', self._onconfig)
    self._requestsRef.off('child_added', self._onrequest)
    self._responsesRef && self._responsesRef.off('child_added', self._onresponse)

    // close downstream connections
    for (var i in self.downstream) {
      self.downstream[i].close()
    }
    self.downstream = {}
  })

  return this
}

Node.prototype._reset = function () {
  this.state = 'disconnected'

  // remove outstanding request / response listener
  if (this._requestRef) {
    this._requestRef.remove()
  }
  delete this._responses

  // close upstream connection
  if (this.upstream) {
    this.upstream.close()
    this.upstream = null
  }

  this._onreportNeeded()
  // stop reporting
  this._clearTimeout(this._reportInterval)
  delete this._reportInterval
}

Node.prototype.changeToRequesting = function () {
  var self = this
  if (this._requesting) return

  this._requesting = true
  debug('start requesting peer connections')
  // if we're not already requesting or being requested, and we're
  // not already successfully connected to the flower
  if (!this._beingRequested && this.state !== 'connected') {
    this._reset()
    this._setTimeout(function () {
      self._websocketConnected = false
      self.connect()
    })
  }
}

Node.prototype.changeToNotRequesting = function () {
  var self = this
  if (!this._requesting) return

  this._requesting = false
  debug('stop requesting peer connections')
  this._reset()
  this._setTimeout(function () {
    self._websocketConnected = true
    self.connect()
  })
}

// private api below

Node.prototype._onconfig = function (snapshot) {
  var data = snapshot.val()
  merge(this.opts, data)
  debug(this.id + ' updated configuration')
  this.emit('configure')
}

Node.prototype._doconnect = function () {
  var self = this

  if (this._websocketConnected) {
    this._createRoot(this._websocketUserId)
    // emit connect but in nextTick
    this._setTimeout(function () {
      // change state -> connected
      debug(self.peerId + ' connected as websocket peer')
      self.state = 'websocketconnected'
      self.emit('statechange')

      // emit connect
      self.emit('connect')

      // start responding to requests
      self._requestsRef.on('child_added', self._onrequest)
    })

    return
  }

  // we are not connected to the websocket, so publish a connection request
  this._dorequest()
}

Node.prototype._createRoot = function (rootUserId) {
  var report = {
    root: true,
    state: 'connected',
    data: {
      id: rootUserId,
      username: 'root'
    }
  }
  this._reports.child(rootUserId).update(report)
}

Node.prototype._dorequest = function () {
  var self = this

  this._requestRef = this._requestsRef.push({
    id: this.peerId,
    mask: this._mask ? this._mask : this.peerId,
    removal_flag: {
      removed: false
    }
  })

  this._setTimeout(function () {
    // make sure no one removes our request until we're connected
    self._requestRef.child('removal_flag').once('child_removed', function () {
      if (self.state === 'requesting') {
        self._responsesRef.off('child_added', self._onresponse)
        self._dorequest()
      }
    })

    // listen for a response
    delete this._responses
    self._responsesRef = self._requestRef.child('responses')
    self._responsesRef.on('child_added', self._onresponse)
  })
}

Node.prototype._onrequest = function (snapshot) {
  if (this.state !== 'connected' && this.state !== 'websocketconnected') {
    return // can't respond to requests unless we are connected
  }

  this._beingRequested = true

  if (Object.keys(this.downstream).length >= this.opts.K) {
    this._beingRequested = false
    return // can't respond to requests if we've hit K peers
  }

  var self = this
  var requestRef = snapshot.ref()
  var requestId = snapshot.key()
  var request = snapshot.val()
  var peerId = request.id

  // responders may accidentally recreate requests
  // these won't have an id though and can be removed
  if (!peerId) {
    requestRef.remove()
    this._beingRequested = false
    return
  }

  // prevent circles
  if (request.mask === this._mask || peerId === this._mask) {
    //debug('potential circle detected with mask ' + request.mask + ', ignoring request')
    this._beingRequested = false
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
      this._beingRequested = false
      return
    }
  }

  debug(this.peerId + ' saw request by ' + peerId)

  var responseRef = requestRef.child('responses/' + this.peerId)

  // initiate peer connection
  // we have to do this before actually writing our response because
  // firebase can trigger events in the same tick which could circumvent
  // the K check at the top of this method
  this._connectToPeer(true, peerId, requestId, responseRef)

  // publish response
  responseRef.update({
    level: this._level || 0,
    upstream: this.upstream ? this.upstream.id : null
  })

  // watch for request withdrawal
  responseRef.once('child_removed', function () {
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
    this._responsesRef.off('child_added', this._onresponse)
    delete this._responses
    return
  }

  var candidates = {}

  for (var i in this._responses) {
    var snapshot = this._responses[i]
    var response = snapshot.val()
    response.id = snapshot.key()
    response.ref = snapshot.ref()

    if (this.blacklist.contains(response.id)) {
      debug('ignoring response ' + response.id + ' because we already blacklisted this peer')
      continue
    }

    if (!response.upstream) {
      this._acceptResponse(response)
      return
    }

    candidates[response.id] = response
  }

  var sorted = []
  for (var i in candidates) {
    if (!candidates[candidates[i].upstream]) {
      sorted.push(candidates[i])
    }
  }
  sorted.sort(function (a, b) {
    return a.level - b.level
  })

  if (sorted.length) {
    this._responsesRef.off('child_added', this._onresponse)
    this._acceptResponse(sorted[0])
    delete this._responses
  } else {
    this._responseReviewInterval = this._setTimeout(this._reviewResponses, 250)
  }
}

Node.prototype._acceptResponse = function (response) {
  var self = this
  var peerId = response.id

  // change state -> connecting (this prevents accepting multiple responses)
  debug(this.peerId + ' got response from ' + peerId)
  this.state = 'connecting'
  this.emit('statechange')

  // stop watching for request removal
  this._requestRef.child('removal_flag').off()

  // attempt a connection
  this._setTimeout(function () {
    self._connectToPeer(false, peerId, null, response.ref)
  })
}

Node.prototype._connectToPeer = function (initiator, peerId, requestId, responseRef) {
  var self = this
  var localSignals = responseRef.child(initiator ? 'responderSignals' : 'requesterSignals')
  var remoteSignals = responseRef.child(initiator ? 'requesterSignals' : 'responderSignals')

  var peer = new SimplePeer({
    initiator: initiator,
    trickle: this.opts.peerConfig ? this.opts.peerConfig.trickle : undefined,
    config: this.opts.peerConfig,
    channelConfig: this.opts.channelConfig
  })

  peer.id = peerId

  if (initiator) {
    this.downstream[peer.id] = peer
    peer.notifications = peer.createDataChannel('notifications')
    peer.notifications.on('open', this._onnotificationsOpen.bind(this, peer))
    peer.requestId = requestId
  } else {
    peer.on('datachannel', function (channel) {
      if (channel.label === 'notifications') {
        peer.notifications = channel
        peer.notifications.on('message', function (evt) {
          var controlData = JSON.parse(evt.data)
          // if the upstream peer doesn't have a mask set,
          // then they are directly connected to the root,
          // so then set this mask to be their peerId
          controlData.mask = controlData.mask || peer.id
          self._updateMask(controlData)
        })
      }
    })
  }

  peer.on('connect', this._onpeerConnect.bind(this, peer, remoteSignals))
  peer.on('close', this._onpeerDisconnect.bind(this, peer, remoteSignals))

  peer.on('error', function (err) {
    debug(this.peerId + ' saw peer connection error', err)
  })

  peer.on('signal', function (signal) {
    if (initiator && self.state !== 'connected' && self.state !== 'websocketconnected') return
    signal = JSON.parse(JSON.stringify(signal))
    localSignals.push(signal)
  })

  remoteSignals.on('child_added', function (snapshot) {
    if (initiator && self.state !== 'connected' && self.state !== 'websocketconnected') return
    var signal = snapshot.val()
    peer.signal(signal)
  })

  // timeout connections
  this._setTimeout(function () {
    if (!peer.didConnect) {
      debug(self.peerId + ' connection to ' + peer.id + ' timed out')
      peer.didTimeout = true
      peer.close()
      self._requesting = false
    }
    self._beingRequested = false
  }, this.connectionTimeout)
}

Node.prototype._onpeerConnect = function (peer, remoteSignals) {
  peer.didConnect = true
  peer.removeAllListeners('connect')
  peer.removeAllListeners('signal')
  remoteSignals.off()

  if (!this.downstream[peer.id]) {
    this._onupstreamConnect(peer)
  }
}

Node.prototype._onnotificationsOpen = function (peer, evt) {
  this._ondownstreamConnect(peer)
}

Node.prototype._onpeerDisconnect = function (peer, remoteSignals) {
  peer.removeAllListeners()
  remoteSignals.off()

  if (this.downstream[peer.id]) {
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
    debug(this.peerId + ' rejected upstream connection by ' + peer.id)
    peer.close()
    return
  }

  this.upstream = peer

  // change state -> connected
  debug(this.peerId + ' established upstream connection to ' + peer.id)
  this.state = 'connected'
  this.emit('statechange')
  this.emit('connect', peer)

  this._websocketConnected = false

  // begin responding to requests
  this._reviewRequests()
}

Node.prototype._onupstreamDisconnect = function (peer) {
  // stop responding to new requests
  this._requestsRef.off('child_added', this._onrequest)

  // remove request
  this._requestRef.remove()

  this.upstream = null

  // change state -> disconnected
  if (this.state !== 'disconnected') {
    debug(this.peerId + ' lost upstream connection to ' + peer.id)
  }

  this.state = 'disconnected'
  this.emit('statechange')

  // emit disconnect if we were connected
  if (peer.didConnect) {
    this.emit('disconnect', peer)
  }

  // // attempt to reconnect if we were not disconnected intentionally
  // if (!this._preventReconnect) {

  // mask off our descendants
  this._updateMask({
    mask: this.peerId,
    level: 0
  })

  //   // give our mask update a head start and/or wait longer if we timed out
  //   var self = this
  //   this._setTimeout(function () {
  //     if (!self._preventReconnect) {
  //       self.connect()
  //     }
  //   }, peer.didConnect ? 100 : this.connectionTimeout)
  // }
}

Node.prototype._ondownstreamConnect = function (peer) {
  // emit peerconnect
  debug(this.peerId + ' established downstream connection to ' + peer.id)
  this.emit('peerconnect', peer)

  // stop responding to requests if peers > K
  if (Object.keys(this.downstream).length >= this.opts.K) {
    this._requestsRef.off('child_added', this._onrequest)
  }

  // make sure downstream has the most up to date mask
  try {
    peer.notifications.send(JSON.stringify({
      mask: this._mask,
      level: this._level || 0
    }))
  } catch (err) {
    console.warn(this.peerId + ' failed to send initial mask update to ' + peer.id, err)
  }
}

Node.prototype._ondownstreamDisconnect = function (peer) {
  // remove from lookup
  delete this.downstream[peer.id]

  // emit events and potentially remove stale requests
  if (peer.didConnect) {
    if (this.state !== 'disconnected') {
      debug(this.peerId + ' lost downstream connection to ' + peer.id)
    }

    this.emit('peerdisconnect', peer)
  } else {
    if (peer.requestWithdrawn) {
      debug(this.peerId + ' saw request withdrawn by ' + peer.id)
    } else if (peer.didTimeout) {
      debug(this.peerId + ' removing stale request by ' + peer.id)
      this._requestsRef.child(peer.requestId).remove()
    }
  }

  this._reviewRequests()
}

Node.prototype._updateMask = function (data) {
  this._mask = data.mask
  this._level = ++data.level

  debug(this.peerId + ' set mask to ' + this._mask + ' and level to ' + this._level)

  // oops we made a circle, fix that
  if (this.downstream[this._mask]) {
    debug(this.peerId + ' destroying accidental circle back to ' + this._mask)
    this.downstream[this._mask].close()
  }

  for (var i in this.downstream) {
    var notifications = this.downstream[i].notifications
    try {
      notifications.send(JSON.stringify(data))
    } catch (err) {
      console.warn(this.peerId + ' failed to relay mask update downstream', err)
      this.downstream[i].close()
    }
  }
}

Node.prototype._onreportNeeded = function () {
  var self = this
  var upstream = null
  if (this.state === 'websocketconnected') {
    upstream = this._websocketUserId
  } else if (this.upstream) {
    upstream = this.upstream.id
  }

  var report = {
    state: this.state,
    upstream: upstream,
    timestamp: Firebase.ServerValue.TIMESTAMP
  }

  if (this.root) {
    report.root = true
  }

  // update the report root node, and then update its
  // child 'data' node, since we don't want to overwrite
  // existing data
  this._reports
    .child(this.peerId)
    .update(report, function () {
      if (self.reportData) {
        self._reports
          .child(self.peerId)
          .child('data')
          .update(self.reportData)
      }
    })

  // clear any previous reporting timers that may have been started
  this._clearTimeout(this._reportInterval)
  this._reportInterval = this._setTimeout(
    this._onreportNeeded,
    this.reportInterval
  )
}

Node.prototype._reviewRequests = function () {
  if ((this.state === 'connected' || this.state === 'websocketconnected')
        && Object.keys(this.downstream).length < this.opts.K) {
    this._requestsRef.off('child_added', this._onrequest)
    this._requestsRef.on('child_added', this._onrequest)
  }
}
