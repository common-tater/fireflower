var fireflower = require('../')(require('firebase'))
var Graph = require('./src/graph')

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
window.root = fireflower('fireflower.firebaseio.com', { root: true })
window.root.connect()
=======
window.root = fireflower('fireflower-dev.firebaseio.com', { id: '0' })
window.root.connect(true)
>>>>>>> stub for reporting status every 5 seconds if the node opts in
=======
window.root = fireflower('fireflower-dev.firebaseio.com', { id: '0' })
window.root.connect(true)
>>>>>>> stub for reporting status every 5 seconds if the node opts in
=======
window.root = fireflower('fireflower-dev.firebaseio.com', { id: '0' })
window.root.connect(true)
>>>>>>> stub for reporting status every 5 seconds if the node opts in

window.root.once('connect', function () {
  window.graph = new Graph('fireflower-dev.firebaseio.com', window.root)
  window.graph.render()
})
