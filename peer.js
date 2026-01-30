module.exports = Peer

var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')

inherits(Peer, EventEmitter)

function Peer (opts) {
  if (!(this instanceof Peer)) return new Peer(opts)
  EventEmitter.call(this)

  this.initiator = opts.initiator || false
  this.trickle = opts.trickle !== false
  this.config = opts.config || {}
  this.channelConfig = opts.channelConfig || {}
  this.didConnect = false
  this.transportType = 'p2p'
  this._closed = false

  this._pc = new RTCPeerConnection(this.config)
  this._setupListeners()

  if (this.initiator) {
    this._negotiate()
  }
}

Peer.prototype._setupListeners = function () {
  var self = this
  var pc = this._pc

  pc.onicecandidate = function (evt) {
    if (self._closed) return
    console.log('Peer: ICE candidate', evt.candidate ? 'found' : 'end')
    if (evt.candidate) {
      if (self.trickle) {
        self.emit('signal', {
          candidate: {
            candidate: evt.candidate.candidate,
            sdpMid: evt.candidate.sdpMid,
            sdpMLineIndex: evt.candidate.sdpMLineIndex
          }
        })
      }
    } else if (!self.trickle) {
      self.emit('signal', {
        type: pc.localDescription.type,
        sdp: pc.localDescription.sdp
      })
    }
  }

  pc.ondatachannel = function (evt) {
    self.emit('datachannel', evt.channel)
  }

  pc.oniceconnectionstatechange = function () {
    if (self._closed) return
    var state = pc.iceConnectionState
    console.log('Peer: ICE state change', state)
    if ((state === 'connected' || state === 'completed') && !self.didConnect) {
      self.didConnect = true
      self.emit('connect')
    }
    if (state === 'disconnected') {
      self._disconnectTimer = setTimeout(function () {
        if (!self._closed && pc.iceConnectionState === 'disconnected') {
          self._destroy()
        }
      }, 5000)
    } else if (self._disconnectTimer) {
      clearTimeout(self._disconnectTimer)
      self._disconnectTimer = null
    }
    if (state === 'failed' || state === 'closed') {
      self._destroy()
    }
  }
}

Peer.prototype._negotiate = function () {
  console.log('Peer: _negotiate starting (createOffer)')
  var self = this
  var pc = this._pc

  this._dc = pc.createDataChannel('_default', this.channelConfig)

  pc.createOffer().then(function (offer) {
    return pc.setLocalDescription(offer)
  }).then(function () {
    if (self.trickle && !self._closed) {
      self.emit('signal', {
        type: pc.localDescription.type,
        sdp: pc.localDescription.sdp
      })
    }
  }).catch(function (err) {
    if (!self._closed) self.emit('error', err)
  })
}

Peer.prototype.signal = function (data) {
  console.log('Peer: signal received', data.type || (data.candidate ? 'candidate' : 'unknown'))
  var self = this
  var pc = this._pc

  if (this._closed) return

  if (data.candidate) {
    pc.addIceCandidate(data.candidate).catch(function (err) {
      if (!self._closed) self.emit('error', err)
    })
  } else if (data.type) {
    pc.setRemoteDescription(data).then(function () {
      if (pc.remoteDescription.type === 'offer') {
        return pc.createAnswer().then(function (answer) {
          return pc.setLocalDescription(answer)
        }).then(function () {
          if (self.trickle && !self._closed) {
            self.emit('signal', {
              type: pc.localDescription.type,
              sdp: pc.localDescription.sdp
            })
          }
        })
      }
    }).catch(function (err) {
      if (!self._closed) self.emit('error', err)
    })
  }
}

Peer.prototype.createDataChannel = function (label, opts) {
  return this._pc.createDataChannel(label, opts || this.channelConfig)
}

Peer.prototype.close = function () {
  this._destroy()
}

Peer.prototype._destroy = function () {
  if (this._closed) return
  this._closed = true
  if (this._disconnectTimer) {
    clearTimeout(this._disconnectTimer)
    this._disconnectTimer = null
  }
  try { this._pc.close() } catch (e) {}
  this.emit('close')
}
