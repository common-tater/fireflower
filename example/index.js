window.localStorage.debug = 'fireflower'

var firebase = require('firebase/app')
var firebaseDb = require('firebase/database')
var Graph = require('./src/graph')

// Initialize Firebase
var firebaseConfig = require('./firebase-config')
var app = firebase.initializeApp(firebaseConfig)
var db = firebaseDb.getDatabase(app)

var fireflower = require('../')(db)

var knumber = document.querySelector('#k-number input')
knumber.addEventListener('change', onkchanged)

window.root = fireflower('tree', { root: true, reportInterval: 2500 })
window.root.connect()

window.root.once('connect', function () {
  window.graph = new Graph('tree', window.root)
  onkchanged()
})

function onkchanged () {
  window.graph.K = parseInt(knumber.value, 10)
  window.graph.render()
}
