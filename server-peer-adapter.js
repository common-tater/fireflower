module.exports = ServerPeerAdapter

var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var ChannelShim = require('./channel-shim')

inherits(ServerPeerAdapter, EventEmitter)

/**
 * ServerPeerAdapter - Server-side Peer interface wrapping a WebSocket connection
 *
 * Used by the relay server to represent a connected client as a downstream peer.
 * Implements the same interface as Peer (WebRTC) so the Node class can treat
 * server and P2P connections identically.
 *
 * Created in a "pending" state without a WebSocket. Call wireUp(ws) once the
 * client's WebSocket connection arrives.
 */
function ServerPeerAdapter (peerId, serverNodeId) {
  if (!(this instanceof ServerPeerAdapter)) return new ServerPeerAdapter(peerId, serverNodeId)
  EventEmitter.call(this)

  this.id = peerId
  this._serverNodeId = serverNodeId || '__relay__'
  this.initiator = true
  this.didConnect = false
  this.transportType = 'server'
  this._closed = false
  this._channels = {}
  this._ws = null
  this._pending = true
}

/**
 * Wire up the actual WebSocket connection.
 * Called by the relay server when a client connects and identifies itself.
 */
ServerPeerAdapter.prototype.wireUp = function (ws) {
  if (this._closed) return
  var self = this

  this._ws = ws
  this._pending = false

  // Re-send channel-open for channels created before wireUp.
  // createDataChannel sends channel-open via _send, but _send silently drops
  // messages when _ws is null (pending state). Flush them now that WS is ready.
  for (var label in this._channels) {
    this._send({ type: 'channel-open', label: label })
  }

  ws.on('message', function (raw) {
    if (self._closed) return
    var data
    try {
      data = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
    } catch (err) {
      return
    }
    self._handleMessage(data)
  })

  ws.on('close', function () {
    self._destroy()
  })

  ws.on('error', function (err) {
    if (!self._closed) self.emit('error', err)
  })

  // Acknowledge the client's connection with the server node's actual ID
  this._send({ type: 'connect', id: this._serverNodeId })

  // Mark as connected
  this.didConnect = true
  this.emit('connect')
}

ServerPeerAdapter.prototype._handleMessage = function (data) {
  switch (data.type) {
    case 'connect':
      // Client re-identifying — already handled in wireUp
      break

    case 'channel-open':
      var channel = new ChannelShim(data.label, this)
      this._channels[data.label] = channel
      this.emit('datachannel', channel)
      if (channel.onopen) {
        channel.onopen()
      }
      break

    case 'channel':
      var ch = this._channels[data.label]
      if (ch && ch.onmessage) {
        ch.onmessage({ data: data.data })
      }
      break

    case 'ping':
      this._send({ type: 'pong' })
      break

    case 'close':
      this._destroy()
      break
  }
}

ServerPeerAdapter.prototype._send = function (data) {
  if (this._closed || !this._ws || this._ws.readyState !== 1) return
  if (this._ws.bufferedAmount > 65536) return
  try {
    this._ws.send(JSON.stringify(data))
  } catch (err) {
    // send failed silently
  }
}

/**
 * Create a data channel (emulated over WebSocket)
 */
ServerPeerAdapter.prototype.createDataChannel = function (label) {
  var channel = new ChannelShim(label, this)
  this._channels[label] = channel

  // Notify client that we're opening a channel
  this._send({ type: 'channel-open', label: label })

  // Simulate async open
  var self = this
  setTimeout(function () {
    if (channel.onopen) channel.onopen()
  }, 0)

  return channel
}

/**
 * Signal handler (no-op for WebSocket)
 */
ServerPeerAdapter.prototype.signal = function () {}

/**
 * Close the connection
 */
ServerPeerAdapter.prototype.close = function () {
  this._destroy()
}

ServerPeerAdapter.prototype._destroy = function () {
  if (this._closed) return
  this._closed = true

  if (this._ws && this._ws.readyState === 1) {
    try { this._send({ type: 'close' }) } catch (e) {}
    try { this._ws.close() } catch (e) {}
  }
  this._ws = null
  this._channels = {}

  this.emit('close')
}
