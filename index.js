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
  this.id = this.opts.id || this._requestsRef.push().key()

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
    this._configRef.on('value', this._onconfig)
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
  this._configRef.off('value', this._onconfig)
  this._requestsRef.off('child_added', this._onrequest)

  // stop reporting
  this._clearTimeout(this._reportInterval)
  delete this._reportInterval

  // remove outstanding request / response listener
  if (this._requestRef) {
    this._requestRef.remove()
    this._responsesRef.off('child_added', this._onresponse)
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
  merge(this.opts, data)
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
      self._requestsRef.on('child_added', self._onrequest)
    })

    return
  }

  // we are not root so publish a connection request
  this._dorequest()
}

Node.prototype._dorequest = function () {
  var self = this

  this._requestRef = this._requestsRef.push({
    id: this.id,
    removal_flag: {
      removed: false
    }
  })

  // make sure no one removes our request until we're connected
  this._requestRef.child('removal_flag').once('child_removed', function () {
    if (self.state === 'requesting') {
      self._responsesRef.off('child_added', self._onresponse)
      self._dorequest()
    }
  })

  // listen for a response
  delete this._responses
  this._responsesRef = this._requestRef.child('responses')
  this._responsesRef.on('child_added', this._onresponse)
}

Node.prototype._onrequest = function (snapshot) {
  if (this.state !== 'connected') {
    return // can't respond to requests unless we are connected
  }

  if (Object.keys(this.downstream).length >= this.opts.K) {
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

  var responseRef = requestRef.child('responses/' + this.id)

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
  var peerId = response.id

  // change state -> connecting (this prevents accepting multiple responses)
  debug(this.id + ' got response from ' + peerId)
  this.state = 'connecting'
  this.emit('statechange')

  // stop watching for request removal
  this._requestRef.child('removal_flag').off()

  // attempt a connection
  this._connectToPeer(false, peerId, null, response.ref)
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
        peer.notifications.on('message', self._onmaskUpdate)
      }
    })
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
  this._setTimeout(function () {
    if (!peer.didConnect) {
      debug(self.id + ' connection to ' + peer.id + ' timed out')
      peer.didTimeout = true
      peer.close()
    }
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
    debug(this.id + ' rejected upstream connection by ' + peer.id)
    peer.close()
    return
  }

  this.upstream = peer

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
  this._requestsRef.off('child_added', this._onrequest)

  // remove request
  this._requestRef.remove()

  this.upstream = null

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
    this._setTimeout(function () {
      if (!self._preventReconnect) {
        self.connect()
      }
    }, peer.didConnect ? 100 : this.connectionTimeout)
  }
}

Node.prototype._ondownstreamConnect = function (peer) {
  // emit peerconnect
  debug(this.id + ' established downstream connection to ' + peer.id)
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
      this._requestsRef.child(peer.requestId).remove()
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
    timestamp: Firebase.ServerValue.TIMESTAMP
  }

  if (this.root) {
    report.root = true
  }

  if (this.reportData) {
    report.data = this.reportData
  }

  this._reports
    .child(this.id)
    .update(report)

  this._reportInterval = this._setTimeout(
    this._onreportNeeded,
    this.reportInterval
  )
}

Node.prototype._reviewRequests = function () {
  if (this.state === 'connected' && Object.keys(this.downstream).length < this.opts.K) {
    this._requestsRef.off('child_added', this._onrequest)
    this._requestsRef.on('child_added', this._onrequest)
  }
}
