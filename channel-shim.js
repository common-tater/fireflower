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
