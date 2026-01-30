window.localStorage.debug = 'fireflower'
require('./debug-console')()

// Initialize Firebase first - before any other modules that might need it
var firebaseInit = require('./firebase-init')
var firebaseConfig = require('./firebase-config')
var firebase = firebaseInit.init(firebaseConfig)
var { ref, child, get } = require('firebase/database')

// Now load modules that depend on Firebase
var fireflower = require('../')(firebase.db)
var Graph = require('./src/graph')

var knumber = document.querySelector('#k-number input')
knumber.addEventListener('change', onkchanged)

// Check if a root node already exists before deciding to be root
var treeRef = ref(firebase.db, 'tree/reports')
get(treeRef).then(function(snapshot) {
  var isRoot = true

  if (snapshot.exists()) {
    // Check if there's an active root (reported within last 10 seconds)
    var reports = snapshot.val()
    var now = Date.now()
    for (var id in reports) {
      var report = reports[id]
      if (report.root && report.timestamp && (now - report.timestamp) < 10000) {
        // Active root exists, we should connect as a child
        isRoot = false
        console.log('Found active root node:', id)
        break
      }
    }
  }

  console.log(isRoot ? 'Becoming ROOT node' : 'Connecting as CHILD node')

  window.root = fireflower('tree', {
    root: isRoot,
    reportInterval: 2500
  })
  window.root.connect()

  window.root.on('fallback', function () {
    console.log('%c FALLBACK: Switched to server relay', 'color: #00CED1; font-weight: bold')
  })

  window.root.on('upgrade', function () {
    console.log('%c UPGRADE: Switched back to P2P', 'color: #00FF00; font-weight: bold')
  })

  window.root.once('connect', function () {
    console.log('Transport:', window.root.transport)
    window.graph = new Graph('tree', window.root)
    onkchanged()
  })
}).catch(function(err) {
  console.error('Error checking for root:', err)

  window.root = fireflower('tree', {
    root: true,
    reportInterval: 2500
  })
  window.root.connect()

  window.root.once('connect', function () {
    console.log('Transport:', window.root.transport)
    window.graph = new Graph('tree', window.root)
    onkchanged()
  })
})

function onkchanged () {
  if (window.graph) {
    window.graph.K = parseInt(knumber.value, 10)
    window.graph.render()
  }
}
