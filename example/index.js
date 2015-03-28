var fireflower = require('../')
var Graph = require('./src/graph')

window.root = fireflower('fireflower.firebaseio.com', '0')
window.root.connect()

window.root.once('connect', function () {
  var graph = new Graph('fireflower.firebaseio.com', window.root)
  graph.render()
})
