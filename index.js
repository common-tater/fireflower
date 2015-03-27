module.exports = Fireflower

var debug = require('debug')('fireflower')
var events = require('events')
var inherits = require('inherits')
var Firebase = require('firebase')
var Node = require('./node')

inherits(Fireflower, events.EventEmitter)

function Fireflower (url) {
  if (!(this instanceof Fireflower)) {
    return new Fireflower(url)
  }

  this.url = url
  this.nodes = {}
  this._onconfigure = this._onconfigure.bind(this)

  this.ref = new Firebase(url)
  this.configRef = this.ref.child('configuration')
  this.configRef.on('value', this._onconfigure)

  events.EventEmitter.call(this)
}

Fireflower.prototype._onconfigure = function (snapshot) {
  var data = snapshot.val()

  if (!data.K) {
    throw new Error('configuration did not supply valid value for K')
  }

  if (!data.root) {
    throw new Error('configuration did not supply a valid root')
  }

  this.K = data.K
  this.root = data.root

  debug(this.url + ' did update configuration')
  this.emit('configure')
}

Fireflower.prototype.connect = function (id) {
  var node = new Node(this, id)
  this.nodes[node.id] = node
  node.connect()
  return node
}

Fireflower.prototype.disconnect = function () {
  this.configRef.off()

  for (var i in this.nodes) {
    this.nodes[i].disconnect()
  }

  this.nodes = {}
}
