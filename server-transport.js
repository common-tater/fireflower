module.exports = ServerTransport

var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var ChannelShim = require('./channel-shim')

inherits(ServerTransport, EventEmitter)

/**
 * ServerTransport - WebSocket-based transport that emulates the Peer interface
 *
 * This class wraps a WebSocket connection and provides the same interface as
 * the Peer class (WebRTC), allowing the Node class to use either transport
 * interchangeably.
 *
 * @param {Object} opts - Configuration options
 * @param {string} opts.url - WebSocket server URL
 * @param {string} opts.nodeId - This node's ID
 * @param {boolean} opts.initiator - Always true for client-to-server
 */
function ServerTransport (opts) {
  if (!(this instanceof ServerTransport)) return new ServerTransport(opts)
  EventEmitter.call(this)

  this.url = opts.url
  this.nodeId = opts.nodeId
  this.initiator = opts.initiator !== false
  this.didConnect = false
  this.transportType = 'server'
  this._closed = false
  this._channels = {}  // Map of label -> ChannelShim
  this._ws = null
  this._connectTimeout = null

  this._connect()
}

ServerTransport.prototype._connect = function () {
  var self = this

  try {
    // Use browser WebSocket or Node.js ws
    var WS = typeof WebSocket !== 'undefined' ? WebSocket : require('ws')
    this._ws = new WS(this.url)
  } catch (err) {
    this._handleError(err)
    return
  }

  // Connection timeout (10 seconds)
  this._connectTimeout = setTimeout(function () {
    if (!self.didConnect && !self._closed) {
      self._handleError(new Error('ServerTransport: connection timeout'))
      self._destroy()
    }
  }, 10000)

  this._ws.onopen = function () {
    clearTimeout(self._connectTimeout)
    self._connectTimeout = null

    // Send initial handshake
    self._send({
      type: 'connect',
      id: self.nodeId
    })
  }

  this._ws.onmessage = function (evt) {
    if (self._closed) return

    var data
    try {
      data = JSON.parse(typeof evt.data === 'string' ? evt.data : evt.data.toString())
    } catch (err) {
      // failed to parse, ignore
      return
    }

    self._handleMessage(data)
  }

  this._ws.onerror = function (err) {
    self._handleError(err)
  }

  this._ws.onclose = function () {
    self._destroy()
  }
}

ServerTransport.prototype._handleMessage = function (data) {
  switch (data.type) {
    case 'connect':
      // Server acknowledges connection and sends its ID
      this.id = data.id || '__relay__'
      this.didConnect = true
      this.emit('connect')
      break

    case 'channel-open':
      // Server opened a channel
      var channel = new ChannelShim(data.label, this)
      this._channels[data.label] = channel
      // Emit datachannel event (like WebRTC ondatachannel)
      this.emit('datachannel', channel)
      // Trigger onopen
      if (channel.onopen) {
        channel.onopen()
      }
      break

    case 'channel':
      // Message on a specific channel
      var ch = this._channels[data.label]
      if (ch && ch.onmessage) {
        ch.onmessage({ data: data.data })
      }
      break

    case 'close':
      // Server is closing the connection
      this._destroy()
      break

    default:
      // unknown message type, ignore
  }
}

ServerTransport.prototype._handleError = function (err) {
  if (this._closed) return
  this.emit('error', err)
}

ServerTransport.prototype._send = function (data) {
  if (this._closed || !this._ws || this._ws.readyState !== 1) return
  if (this._ws.bufferedAmount > 65536) return

  try {
    this._ws.send(JSON.stringify(data))
  } catch (err) {
    console.warn('ServerTransport: failed to send', err)
    this._handleError(err)
  }
}

/**
 * Create a data channel (emulated over WebSocket)
 * @param {string} label - Channel name
 * @param {Object} opts - Channel options (ignored for WebSocket)
 * @returns {ChannelShim} - Channel-like object
 */
ServerTransport.prototype.createDataChannel = function (label, opts) {
  var channel = new ChannelShim(label, this)
  this._channels[label] = channel

  // Notify server that we're creating a channel
  this._send({
    type: 'channel-open',
    label: label
  })

  // Simulate async open (like WebRTC)
  var self = this
  setTimeout(function () {
    if (channel.onopen) {
      channel.onopen()
    }
  }, 0)

  return channel
}

/**
 * Signal handler (no-op for WebSocket, used by WebRTC)
 */
ServerTransport.prototype.signal = function (data) {
  // No-op: WebSocket doesn't need signaling
}

/**
 * Close the connection
 */
ServerTransport.prototype.close = function () {
  this._destroy()
}

ServerTransport.prototype._destroy = function () {
  if (this._closed) return
  this._closed = true

  if (this._connectTimeout) {
    clearTimeout(this._connectTimeout)
    this._connectTimeout = null
  }

  // Send close message if WebSocket is open
  if (this._ws && this._ws.readyState === 1) {
    try {
      this._send({ type: 'close' })
    } catch (e) {}
  }

  // Close WebSocket
  if (this._ws) {
    try {
      this._ws.close()
    } catch (e) {}
    this._ws = null
  }

  // Clean up channels
  this._channels = {}

  this.emit('close')
}

