module.exports = createWebTransportServer

var EventEmitter = require('events').EventEmitter

function createWebTransportServer (opts) {
  var Http3Server
  try {
    Http3Server = require('@aspect-build/webtransport').Http3Server
  } catch (e) {
    try {
      Http3Server = require('webtransport').Http3Server
    } catch (e2) {
      console.warn('[webtransport-server] No WebTransport server library found. Install @aspect-build/webtransport or equivalent.')
      return null
    }
  }

  var port = opts.port || 4433
  var cert = opts.cert
  var key = opts.key
  var onSession = opts.onSession

  if (!cert || !key) {
    console.warn('[webtransport-server] TLS cert and key required for HTTP/3')
    return null
  }

  var server = new Http3Server({
    port: port,
    host: '0.0.0.0',
    secret: 'changeit',
    cert: cert,
    privKey: key
  })

  server.startServer()

  ;(async function () {
    var sessionStream = await server.sessionStream('/fireflower')
    var reader = sessionStream.getReader()

    while (true) {
      var result = await reader.read()
      if (result.done) break

      var session = result.value
      handleSession(session, onSession)
    }
  })()

  return server
}

async function handleSession (session, onSession) {
  await session.ready

  var peer = new WebTransportPeer(session)

  var controlStream = (await session.incomingBidirectionalStreams.getReader().read()).value
  if (!controlStream) return

  peer._controlWriter = controlStream.writable.getWriter()
  peer._controlReader = controlStream.readable.getReader()

  readControlLoop(peer)

  if (session.datagrams) {
    peer._datagramWriter = session.datagrams.writable.getWriter()
    readDatagramLoop(peer, session)
  }

  if (onSession) onSession(peer)
}

function WebTransportPeer (session) {
  this._session = session
  this._controlWriter = null
  this._controlReader = null
  this._datagramWriter = null
  this._channels = {}
  this.id = null
  this.didConnect = false
  this._closed = false
  this._emitter = new EventEmitter()
}

WebTransportPeer.prototype.on = function (event, fn) {
  this._emitter.on(event, fn)
}

WebTransportPeer.prototype.emit = function (event) {
  this._emitter.emit.apply(this._emitter, arguments)
}

WebTransportPeer.prototype.removeAllListeners = function () {
  this._emitter.removeAllListeners()
}

WebTransportPeer.prototype.sendControl = function (data) {
  if (this._closed || !this._controlWriter) return
  var encoded = new TextEncoder().encode(JSON.stringify(data))
  var frame = new Uint8Array(4 + encoded.length)
  new DataView(frame.buffer).setUint32(0, encoded.length)
  frame.set(encoded, 4)
  this._controlWriter.write(frame).catch(function () {})
}

WebTransportPeer.prototype.sendDatagram = function (data) {
  if (this._closed || !this._datagramWriter) return
  var buf = data instanceof Uint8Array ? data : new Uint8Array(data)
  this._datagramWriter.write(buf).catch(function () {})
}

WebTransportPeer.prototype.close = function () {
  if (this._closed) return
  this._closed = true
  try { this._session.close() } catch (e) {}
  this.emit('close')
}

WebTransportPeer.prototype.createDataChannel = function (label) {
  var shim = {
    label: label,
    readyState: 'open',
    bufferedAmount: 0,
    onopen: null,
    onmessage: null,
    send: function (data) {
      if (label === '_audio') {
        this._peer.sendDatagram(typeof data === 'string' ? new TextEncoder().encode(data) : data)
      } else {
        this._peer.sendControl({ type: 'channel', label: label, data: data })
      }
    }.bind({ _peer: this }),
    close: function () { this.readyState = 'closed' }
  }
  this._channels[label] = shim
  this.sendControl({ type: 'channel-open', label: label })
  return shim
}

async function readControlLoop (peer) {
  var decoder = new TextDecoder()
  var buffer = new Uint8Array(0)

  while (!peer._closed) {
    try {
      var result = await peer._controlReader.read()
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

        var data = JSON.parse(json)
        if (data.type === 'connect' && data.id) {
          peer.id = data.id
          peer.didConnect = true
          peer.sendControl({ type: 'connect', id: '__relay__' })
          peer.emit('connect')
        } else if (data.type === 'channel-open') {
          var ch = {
            label: data.label,
            readyState: 'open',
            bufferedAmount: 0,
            onopen: null,
            onmessage: null,
            send: function (d) {
              peer.sendControl({ type: 'channel', label: this.label, data: d })
            },
            close: function () { this.readyState = 'closed' }
          }
          peer._channels[data.label] = ch
          peer.emit('datachannel', ch)
        } else if (data.type === 'channel') {
          var channel = peer._channels[data.label]
          if (channel && channel.onmessage) {
            channel.onmessage({ data: data.data })
          }
        } else if (data.type === 'close') {
          peer.close()
        }
      }
    } catch (err) {
      break
    }
  }

  if (!peer._closed) peer.close()
}

async function readDatagramLoop (peer, session) {
  var reader = session.datagrams.readable.getReader()

  while (!peer._closed) {
    try {
      var result = await reader.read()
      if (result.done) break

      var ch = peer._channels._audio
      if (ch && ch.onmessage) {
        ch.onmessage({ data: result.value.buffer })
      }
    } catch (err) {
      break
    }
  }
}
