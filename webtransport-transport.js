module.exports = WebTransportTransport

var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')

inherits(WebTransportTransport, EventEmitter)

function WebTransportChannel (label, transport) {
  this.label = label
  this.readyState = 'open'
  this.bufferedAmount = 0
  this.onopen = null
  this.onmessage = null
  this._transport = transport
}

WebTransportChannel.prototype.send = function (data) {
  this._transport._sendChannel(this.label, data)
}

WebTransportChannel.prototype.close = function () {
  this.readyState = 'closed'
}

function WebTransportTransport (opts) {
  if (!(this instanceof WebTransportTransport)) return new WebTransportTransport(opts)
  EventEmitter.call(this)

  this.url = opts.url
  this.nodeId = opts.nodeId
  this.initiator = opts.initiator !== false
  this.didConnect = false
  this.transportType = 'server'
  this._closed = false
  this._channels = {}
  this._wt = null
  this._controlWriter = null
  this._controlReader = null
  this._datagramWriter = null
  this._datagramReader = null

  this._connect()
}

WebTransportTransport.prototype._connect = async function () {
  var self = this

  try {
    this._wt = new WebTransport(this.url)
    await this._wt.ready
  } catch (err) {
    this.emit('error', err)
    this._destroy()
    return
  }

  this._wt.closed.then(function () {
    self._destroy()
  }).catch(function () {
    self._destroy()
  })

  try {
    var controlStream = await this._wt.createBidirectionalStream()
    this._controlWriter = controlStream.writable.getWriter()
    this._controlReader = controlStream.readable.getReader()

    this._sendControl({ type: 'connect', id: this.nodeId })
    this._readControlLoop()

    if (this._wt.datagrams) {
      this._datagramWriter = this._wt.datagrams.writable.getWriter()
      this._readDatagramLoop()
    }
  } catch (err) {
    this.emit('error', err)
    this._destroy()
  }
}

WebTransportTransport.prototype._sendControl = function (data) {
  if (this._closed || !this._controlWriter) return
  var encoded = new TextEncoder().encode(JSON.stringify(data))
  var frame = new Uint8Array(4 + encoded.length)
  new DataView(frame.buffer).setUint32(0, encoded.length)
  frame.set(encoded, 4)
  this._controlWriter.write(frame).catch(function () {})
}

WebTransportTransport.prototype._sendChannel = function (label, data) {
  if (this._closed) return

  if (label === '_audio' && this._datagramWriter) {
    var buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data)
    this._datagramWriter.write(buf).catch(function () {})
    return
  }

  this._sendControl({ type: 'channel', label: label, data: data })
}

WebTransportTransport.prototype._readControlLoop = async function () {
  var decoder = new TextDecoder()
  var buffer = new Uint8Array(0)

  while (!this._closed) {
    try {
      var result = await this._controlReader.read()
      if (result.done) break

      var chunk = result.value
      var combined = new Uint8Array(buffer.length + chunk.length)
      combined.set(buffer)
      combined.set(chunk, buffer.length)
      buffer = combined

      while (buffer.length >= 4) {
        var msgLen = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0)
        if (buffer.length < 4 + msgLen) break
        var json = decoder.decode(buffer.slice(4, 4 + msgLen))
        buffer = buffer.slice(4 + msgLen)
        this._handleMessage(JSON.parse(json))
      }
    } catch (err) {
      break
    }
  }
}

WebTransportTransport.prototype._readDatagramLoop = async function () {
  if (!this._wt || !this._wt.datagrams) return
  var reader = this._wt.datagrams.readable.getReader()

  while (!this._closed) {
    try {
      var result = await reader.read()
      if (result.done) break

      var ch = this._channels._audio
      if (ch && ch.onmessage) {
        ch.onmessage({ data: result.value.buffer })
      }
    } catch (err) {
      break
    }
  }
}

WebTransportTransport.prototype._handleMessage = function (data) {
  switch (data.type) {
    case 'connect':
      this.id = data.id || '__relay__'
      this.didConnect = true
      this.emit('connect')
      break

    case 'channel-open':
      var channel = new WebTransportChannel(data.label, this)
      this._channels[data.label] = channel
      this.emit('datachannel', channel)
      if (channel.onopen) channel.onopen()
      break

    case 'channel':
      var ch = this._channels[data.label]
      if (ch && ch.onmessage) {
        ch.onmessage({ data: data.data })
      }
      break

    case 'close':
      this._destroy()
      break
  }
}

WebTransportTransport.prototype.createDataChannel = function (label, opts) {
  var channel = new WebTransportChannel(label, this)
  this._channels[label] = channel

  this._sendControl({ type: 'channel-open', label: label })

  setTimeout(function () {
    if (channel.onopen) channel.onopen()
  }, 0)

  return channel
}

WebTransportTransport.prototype.signal = function () {}

WebTransportTransport.prototype.close = function () {
  this._destroy()
}

WebTransportTransport.prototype._destroy = function () {
  if (this._closed) return
  this._closed = true

  if (this._controlWriter) {
    try { this._controlWriter.close() } catch (e) {}
    this._controlWriter = null
  }
  if (this._datagramWriter) {
    try { this._datagramWriter.close() } catch (e) {}
    this._datagramWriter = null
  }
  if (this._wt) {
    try { this._wt.close() } catch (e) {}
    this._wt = null
  }

  this._channels = {}
  this.emit('close')
}
