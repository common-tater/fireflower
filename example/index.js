var fireflower = require('../')(require('firebase'))
var Graph = require('./src/graph')

window.root = fireflower('fireflower-dev.firebaseio.com', { id: '0' })
window.root.connect(true)

window.root.once('connect', function () {
  window.graph = new Graph('fireflower-dev.firebaseio.com', window.root)
  window.graph.render()
})
