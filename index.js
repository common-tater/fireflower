module.exports = function (_Firebase) {
  Firebase = _Firebase
  return Node
}

var debug = require('debug')('fireflower')
var events = require('events')
var inherits = require('inherits')
var SimplePeer = require('simple-peer')
var Firebase = null

var CONNECTION_TIMEOUT = 2000

inherits(Node, events.EventEmitter)

function Node (url, opts) {
  if (!(this instanceof Node)) {
    return new Node(url, opts)
  }

  this.url = url
  this.opts = opts || {}
  this.root = this.opts.root
  this.reportInterval = this.opts.reportInterval
  this.state = 'disconnected'
  this.config = {}
  this.upstream = null
  this.downstream = {}

  // firebase refs
  this._ref = new Firebase(this.url)
  this._configRef = this._ref.child('configuration')
  this._requestsRef = this._ref.child('requests')
  this._reports = this._ref.child('reports')

  // set a random id if one was not provided
  this.id = this.opts.id || this._requestsRef.push().key()

  // bind callbacks
  this._onconfig = this._onconfig.bind(this)
  this._doconnect = this._doconnect.bind(this)
  this._onrequest = this._onrequest.bind(this)
  this._onresponse = this._onresponse.bind(this)
  this._onmaskupdate = this._onmaskupdate.bind(this)
  this._onreportNeeded = this._onreportNeeded.bind(this)

  events.EventEmitter.call(this)
}

Node.prototype.connect = function () {
  if (this.state !== 'disconnected') {
    throw new Error('invalid state for connect')
  }

  this._preventReconnect = false

  // reporting?
  if (this.reportInterval && !this._reportInterval) {
    this._reportInterval = setInterval(this._onreportNeeded, this.reportInterval)
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

  // ensure required config info
  if (!this.config.K) {
    this.once('configure', this._doconnect)
    return this
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
  clearInterval(this._reportInterval)
  delete this._reportInterval

  // remove outstanding request / response listener
  if (this._requestRef) {
    this._requestRef.remove()
    this._responsesRef.off('child_added', this._onresponse)
  }

  // destroy upstream connection
  if (this.upstream) {
    this.upstream.destroy()
    this.upstream = null
  }

  // destroy downstream connections
  for (var i in this.downstream) {
    this.downstream[i].destroy()
  }
  this.downstream = {}

  return this
}

// private api below

Node.prototype._onconfig = function (snapshot) {
  var data = snapshot.val()

  if (!data) {
    this.emit('error', new Error('missing configuration'))
    return
  }

  if (!data.K || isNaN(data.K)) {
    this.emit('error', new Error('configuration did not supply valid value for K'))
    return
  }

  this.config = data
  debug(this.id + ' updated configuration')
  this.emit('configure')
}

Node.prototype._doconnect = function () {
  var self = this

  if (this.root) {

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
  this._responsesRef = this._requestRef.child('responses')
  this._responsesRef.once('child_added', this._onresponse)
}

Node.prototype._onrequest = function (snapshot) {
  if (this.state !== 'connected') {
    return // can't respond to requests unless we are connected
  }

  if (Object.keys(this.downstream).length >= this.config.K) {
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
      knownPeer.destroy()
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
    id: this.id
  })

  // watch for request withdrawal
  responseRef.once('child_removed', function () {
    var peer = self.downstream[peerId]
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

  var responseRef = snapshot.ref()
  var response = snapshot.val()
  var peerId = response.id

  if (!peerId) {
    return
  }

  // change state -> connecting (this prevents accepting multiple responses)
  debug(this.id + ' got response from ' + peerId)
  this.state = 'connecting'
  this.emit('statechange')

  // stop watching for request removal
  this._requestRef.child('removal_flag').off()

  // attempt a connection
  this._connectToPeer(false, peerId, null, responseRef)
}

Node.prototype._connectToPeer = function (initiator, peerId, requestId, responseRef) {
  var self = this
  var localSignals = responseRef.child(initiator ? 'responderSignals' : 'requesterSignals')
  var remoteSignals = responseRef.child(initiator ? 'requesterSignals' : 'responderSignals')

  var peer = new SimplePeer({
    initiator: initiator
  })

  peer.id = peerId

  if (initiator) {
    this.downstream[peer.id] = peer
    peer.notifications = peer._pc.createDataChannel('notifications')
    peer.requestId = requestId
  } else {
    var oldondatachannel = peer._pc.ondatachannel
    peer._pc.ondatachannel = function (evt) {
      if (evt.channel.label === 'notifications') {
        peer.notifications = evt.channel
        peer.notifications.onmessage = self._onmaskupdate
      } else {
        oldondatachannel(evt)
      }
    }
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

  if (this.downstream[peer.id]) {
    this._ondownstreamConnect(peer)
  } else {
    this._onupstreamConnect(peer)
  }
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
    peer.destroy()
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
    this._onmaskupdate({ data: this.id })

    // give our mask update a tiny head start
    var self = this
    setTimeout(function () {
      if (!self._preventReconnect) {
        self.connect()
      }
    }, 100)
  }
}

Node.prototype._ondownstreamConnect = function (peer) {
  // emit peerconnect
  debug(this.id + ' established downstream connection to ' + peer.id)
  this.emit('peerconnect', peer)

  // stop responding to requests if peers > K
  if (Object.keys(this.downstream).length >= this.config.K) {
    this._requestsRef.off('child_added', this._onrequest)
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
    } else {
      debug(this.id + ' removing stale request by ' + peer.id)
      this._requestsRef.child(peer.requestId).remove()
    }
  }

  this._reviewRequests()
}

Node.prototype._onmaskupdate = function (evt) {
  this._mask = evt.data

  debug(this.id + ' set mask to ' + this._mask)

  // oops we made a circle, fix that
  if (this.downstream[this._mask]) {
    debug(this.id + ' destroying accidental circle back to ' + this._mask)
    this.downstream[this._mask].destroy()
  }

  for (var i in this.downstream) {
    try {
      this.downstream[i].notifications.send(this._mask)
    } catch (err) {
      // this would only happen if the peer was in
      // the process of closing so we don't care
    }
  }
}

Node.prototype._onreportNeeded = function () {
  debug(this.id + ' reporting')

  var report = {
    state: this.state,
    upstream: this.upstream ? this.upstream.id : null,
    timestamp: Date.now()
  }

  if (this.root) {
    report.root = true
  }

  this._reports
    .child(this.id)
    .update(report)
}

Node.prototype._reviewRequests = function () {
  if (this.state === 'connected' && Object.keys(this.downstream).length < this.config.K) {
    this._requestsRef.off('child_added', this._onrequest)
    this._requestsRef.on('child_added', this._onrequest)
  }
}
