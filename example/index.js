require('./debug-console')()

// Initialize Firebase first - before any other modules that might need it
var firebaseInit = require('./firebase-init')
var firebaseConfig = require('./firebase-config')
var firebase = firebaseInit.init(firebaseConfig)
var { ref, child, get } = require('firebase/database')

// Now load modules that depend on Firebase
var fireflower = require('../')(firebase.db)
var Graph = require('./src/graph')

// Allow configurable Firebase path via URL query parameter
var urlParams = new URLSearchParams(window.location.search)
var treePath = urlParams.get('path') || 'tree'

var knumber = document.querySelector('#k-number input')
knumber.addEventListener('change', onkchanged)

var serverCapacityInput = document.querySelector('#server-capacity-number input')
serverCapacityInput.addEventListener('change', onServerCapacityChanged)
serverCapacityInput.addEventListener('input', function () {
  // Clicking down arrow from 1 gives 0 — treat as "clear to infinity"
  if (serverCapacityInput.value === '0' || serverCapacityInput.value === '') {
    serverCapacityInput.value = ''
    onServerCapacityChanged()
  }
})

// --- Controls ---
var { remove, set, onValue } = require('firebase/database')

// Reset button: disconnects node, clears Firebase data, prevents reconnect
var resetBtn = document.querySelector('#reset-btn')
resetBtn.addEventListener('click', function () {
  if (resetBtn.classList.contains('disabled')) return
  resetBtn.classList.add('disabled')
  resetBtn.textContent = 'Disconnected'
  if (window.root) {
    window.root.disconnect()
  }
  remove(ref(firebase.db, treePath + '/requests'))
  remove(ref(firebase.db, treePath + '/reports'))
})

// Server toggle: enables/disables the relay server via Firebase config
var serverToggle = document.querySelector('#server-toggle')
var serverCheckbox = serverToggle.querySelector('input')
var configRef = ref(firebase.db, treePath + '/configuration/serverEnabled')

onValue(configRef, function (snapshot) {
  var enabled = snapshot.val()
  if (enabled === null) enabled = true
  serverCheckbox.checked = enabled
  serverToggle.classList.toggle('active', enabled)
})

serverCheckbox.addEventListener('change', function () {
  var enabled = serverCheckbox.checked
  serverToggle.classList.toggle('active', enabled)
  set(configRef, enabled)
})

// Force Server toggle: new clicked nodes only accept server responses
var forceServerToggle = document.querySelector('#force-server-toggle')
var forceServerCheckbox = forceServerToggle.querySelector('input')
var forceServerConfigRef = ref(firebase.db, treePath + '/configuration/serverOnly')

onValue(forceServerConfigRef, function (snapshot) {
  var enabled = !!snapshot.val()
  forceServerCheckbox.checked = enabled
  forceServerToggle.classList.toggle('active', enabled)
  if (window.graph) {
    window.graph.forceServer = enabled
  }
})

forceServerCheckbox.addEventListener('change', function () {
  var enabled = forceServerCheckbox.checked
  forceServerToggle.classList.toggle('active', enabled)
  set(forceServerConfigRef, enabled)
  if (window.graph) {
    window.graph.forceServer = enabled
  }
})

// Check if a root node already exists before deciding to be root
var treeRef = ref(firebase.db, treePath + '/reports')
get(treeRef).then(function(snapshot) {
  var isRoot = true

  if (snapshot.exists()) {
    // Check if there's an active root (reported within last 10 seconds)
    var reports = snapshot.val()
    var now = Date.now()
    for (var id in reports) {
      var report = reports[id]
      if (report.root && !report.isServer && report.timestamp && (now - report.timestamp) < 10000) {
        // Active root exists, we should connect as a child
        isRoot = false
        console.log('Found active root node:', id)
        break
      }
    }
  }

  console.log(isRoot ? 'Becoming ROOT node' : 'Connecting as CHILD node')

  window.root = fireflower(treePath, {
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
    window.graph = new Graph(treePath, window.root)
    onkchanged()
  })
}).catch(function(err) {
  console.error('Error checking for root:', err)

  window.root = fireflower(treePath, {
    root: true,
    reportInterval: 2500
  })
  window.root.connect()

  window.root.once('connect', function () {
    console.log('Transport:', window.root.transport)
    window.graph = new Graph(treePath, window.root)
    onkchanged()
  })
})

function onkchanged () {
  var k = parseInt(knumber.value, 10)
  if (window.graph) {
    window.graph.K = k
    window.graph.render()
  }
  var kRef = ref(firebase.db, treePath + '/configuration/K')
  set(kRef, k)
}

function onServerCapacityChanged () {
  var value = serverCapacityInput.value.trim()
  var serverCapacity = value === '' ? null : parseInt(value, 10)
  var serverCapacityRef = ref(firebase.db, treePath + '/configuration/serverCapacity')
  set(serverCapacityRef, serverCapacity)
}

// Watch serverCapacity config and update input
var serverCapacityConfigRef = ref(firebase.db, treePath + '/configuration/serverCapacity')
onValue(serverCapacityConfigRef, function (snapshot) {
  var capacity = snapshot.val()
  serverCapacityInput.value = capacity || ''
  serverCapacityInput.placeholder = capacity ? '' : '∞'
})
