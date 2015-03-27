var fireflower = require('../')
var Graph = require('./src/graph')

var flower = fireflower('fireflower.firebaseio.com')
var root = flower.connect('0')

root.once('connect', function () {
  var graph = new Graph(flower, root)
  graph.render()
})
