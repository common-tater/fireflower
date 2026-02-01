module.exports = ChannelShim

/**
 * ChannelShim - Emulates a WebRTC DataChannel over WebSocket
 *
 * Provides the same interface as RTCDataChannel for compatibility
 * with the Node class's expectations.
 */
function ChannelShim (label, transport) {
  this.label = label
  this.readyState = 'open'
  this.onopen = null
  this.onmessage = null
  this.onclose = null
  this.onerror = null
  this._transport = transport
}

Object.defineProperty(ChannelShim.prototype, 'bufferedAmount', {
  get: function () {
    return this._transport && this._transport._ws ? this._transport._ws.bufferedAmount || 0 : 0
  }
})

ChannelShim.prototype.send = function (data) {
  if (this.readyState !== 'open') {
    throw new Error('ChannelShim: cannot send on closed channel')
  }

  this._transport._send({
    type: 'channel',
    label: this.label,
    data: data
  })
}

ChannelShim.prototype.close = function () {
  this.readyState = 'closed'
  if (this.onclose) {
    this.onclose()
  }
}
