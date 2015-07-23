window.localStorage.debug = 'fireflower'

var Firebase = require('firebase')
var fireflower = require('../')(Firebase)
var Graph = require('./src/graph')

var dburl = 'fireflower.firebaseio.com'
var knumber = document.querySelector('#k-number input')
knumber.addEventListener('change', onkchanged)

window.root = fireflower(dburl, { root: true, reportInterval: 2500 })
window.root.connect()

window.root.once('connect', function () {
  window.graph = new Graph(dburl, window.root)
  onkchanged()
})

function onkchanged () {
  window.graph.K = parseInt(knumber.value, 10)
  window.graph.render()
}
