var fireflower = require('../')(require('firebase'))
var Graph = require('./src/graph')

window.root = fireflower('fireflower.firebaseio.com', { id: '0' })
window.root.connect()

window.root.once('connect', function () {
  window.graph = new Graph('fireflower.firebaseio.com', window.root)
  window.graph.render()
})
