localStorage.debug = 'fireflower'

var Firebase = require('firebase')
var fireflower = require('../')(Firebase)
var Graph = require('./src/graph')

var dburl = 'fireflower.firebaseio.com'
var db = new Firebase(dburl)

var knumber = document.querySelector('#k-number input')
knumber.addEventListener('change', onkchanged)

window.root = fireflower(dburl, { root: true })
window.root.connect()

window.root.once('connect', function () {
  window.graph = new Graph(dburl, window.root)
  onkchanged()
})

function onkchanged () {
  window.graph.K = parseInt(knumber.value)
  window.graph.render()
}
