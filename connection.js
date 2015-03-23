var simplepeer = require('simple-peer')
var events = require('events')
var inherits = require('inherits')

module.exports = Connection

function Connection (firebase, peerId) {
  events.EventEmitter.call(this)

  this.firebase = firebase
  this.peerId = peerId
}
inherits(Connection, events.EventEmitter)

Connection.prototype.connectToPeer = function (upstreamPeerId) {
  // once a peer connection is succesfully made, do this:
  //this.emit('onconnected', stream, upstreamPeerId, this.peerId)
  // once a peer connection is disconnected or lost, do this:
  //this.emit('ondisconnected', upstreamPeerId, this.peerId)
}
