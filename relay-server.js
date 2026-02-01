#!/usr/bin/env node

/**
 * Fireflower Relay Server
 *
 * Runs as a proper Node in the K-ary tree, using WebSocket transport instead
 * of WebRTC. Responds to connection requests through normal Firebase signaling.
 *
 * Usage:
 *   node relay-server.js --port 8082 --firebase-path tree --id <node-id>
 *
 * Environment variables:
 *   PORT - Server port (default: 8082)
 *   FIREBASE_PATH - Firebase database path (default: 'tree')
 *   NODE_ID - Fixed node ID (optional, generates random if not set)
 */

var WebSocketServer = require('ws').Server
var wrtc = require('node-datachannel/polyfill')
var os = require('os')

// Auto-detect LAN IP so remote devices (phones, other machines) can reach the
// relay server. 0.0.0.0 only works for same-machine connections.
function getLanIp () {
  var interfaces = os.networkInterfaces()
  for (var name in interfaces) {
    var addrs = interfaces[name]
    for (var j = 0; j < addrs.length; j++) {
      var addr = addrs[j]
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address
      }
    }
  }
  return '0.0.0.0'
}

// Parse command line arguments
var args = process.argv.slice(2)
var port = process.env.PORT || 8082
var firebasePath = process.env.FIREBASE_PATH || 'tree'
var firebaseConfigPath = './example/firebase-config.js'
var nodeId = process.env.NODE_ID || null
var serverHost = process.env.SERVER_HOST || null
var serverCapacity = process.env.SERVER_CAPACITY ? parseInt(process.env.SERVER_CAPACITY, 10) : null

for (var i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10)
    i++
  } else if (args[i] === '--firebase-path' && args[i + 1]) {
    firebasePath = args[i + 1]
    i++
  } else if (args[i] === '--firebase-config' && args[i + 1]) {
    firebaseConfigPath = args[i + 1]
    i++
  } else if (args[i] === '--id' && args[i + 1]) {
    nodeId = args[i + 1]
    i++
  } else if (args[i] === '--host' && args[i + 1]) {
    serverHost = args[i + 1]
    i++
  } else if (args[i] === '--server-capacity' && args[i + 1]) {
    serverCapacity = parseInt(args[i + 1], 10)
    i++
  }
}

// Initialize Firebase
var firebaseInit = require('./example/firebase-init')
var firebaseConfig
try {
  firebaseConfig = require(firebaseConfigPath)
} catch (err) {
  console.error('Error: Could not load Firebase config from', firebaseConfigPath)
  console.error('Please create example/firebase-config.js with your Firebase configuration')
  process.exit(1)
}

var firebase = firebaseInit.init(firebaseConfig)
var host = serverHost || getLanIp()
var serverUrl = 'ws://' + host + ':' + port

// Create the Node — connects as a child of the root via WebRTC
var fireflower = require('./')(firebase.db)
var opts = {
  root: false,
  isServer: true,
  K: 1000,
  serverUrl: serverUrl,
  serverCapacity: serverCapacity,
  reportInterval: 5000,
  wrtc: wrtc,
  setTimeout: setTimeout.bind(global),
  clearTimeout: clearTimeout.bind(global)
}
if (nodeId) {
  opts.id = nodeId
}
var node = fireflower(firebasePath, opts)

console.log('Fireflower Relay Server')
console.log('=======================')
console.log('Node ID:', node.id)
console.log('Port:', port)
console.log('Firebase path:', firebasePath)
console.log('Server URL:', serverUrl)
if (serverCapacity) {
  console.log('Server capacity:', serverCapacity)
}
console.log()

// Create WebSocket server
var wss = new WebSocketServer({ port: port })

wss.on('listening', function () {
  console.log('WebSocket server listening on port', port)
})

var nodeConnected = false

function getConnectedCount () {
  var count = 0
  for (var id in node.downstream) {
    if (node.downstream[id].didConnect) count++
  }
  return count
}

function updateServerCapacityState () {
  if (!nodeConnected || !serverCapacity) return

  var connectedCount = getConnectedCount()
  var atCapacity = connectedCount >= serverCapacity
  var capacityRef = ref(firebase.db, firebasePath + '/configuration/serverAtCapacity')
  set(capacityRef, atCapacity)
  onDisconnect(capacityRef).remove()
}

function publishServerPresence () {
  var serverUrlConfigRef = ref(firebase.db, firebasePath + '/configuration/serverUrl')
  set(serverUrlConfigRef, serverUrl)
  // Auto-remove serverUrl if Firebase connection drops (process kill, crash, etc.)
  // onDisconnect is one-shot — re-register each time Firebase reconnects
  onDisconnect(serverUrlConfigRef).remove()

  // Auto-remove server report on Firebase disconnect
  var reportRef = ref(firebase.db, firebasePath + '/reports/' + node.id)
  onDisconnect(reportRef).remove()

  // Publish initial capacity state
  updateServerCapacityState()
}

node.on('connect', function () {
  console.log('Node connected to tree as child (level 1)')
  console.log('Upstream:', node.upstream ? node.upstream.id : 'none')
  console.log('Transport:', node.transport)

  nodeConnected = true
  publishServerPresence()
})

node.on('disconnect', function () {
  nodeConnected = false
  // Remove serverUrl from config when server disconnects
  var serverUrlConfigRef = ref(firebase.db, firebasePath + '/configuration/serverUrl')
  remove(serverUrlConfigRef)
  // Remove server report
  var reportRef = ref(firebase.db, firebasePath + '/reports/' + node.id)
  remove(reportRef)
  // Remove capacity state
  var capacityRef = ref(firebase.db, firebasePath + '/configuration/serverAtCapacity')
  remove(capacityRef)
})

// Update capacity state on downstream changes
node.on('downstreamConnect', updateServerCapacityState)
node.on('downstreamDisconnect', updateServerCapacityState)


wss.on('connection', function (ws) {
  console.log('New WebSocket connection from', ws._socket.remoteAddress)

  var identified = false

  ws.on('message', function (data) {
    if (identified) return // already wired up, adapter handles messages

    var msg
    try {
      msg = JSON.parse(data.toString())
    } catch (err) {
      return
    }

    // Wait for the client's connect handshake to learn their ID
    if (msg.type === 'connect' && msg.id) {
      identified = true
      var clientId = msg.id
      console.log('Client identified:', clientId)

      // Find the pending adapter created by _connectToPeer
      var adapter = node._pendingAdapters[clientId]
      if (adapter) {
        delete node._pendingAdapters[clientId]
        adapter.wireUp(ws)
        console.log('Wired up adapter for', clientId)
      } else {
        console.warn('No pending adapter for client', clientId, '— closing')
        ws.close()
      }
    }
  })

  ws.on('error', function (err) {
    console.error('WebSocket error:', err.message)
  })
})

wss.on('error', function (err) {
  console.error('WebSocket server error:', err)
})

// Watch serverEnabled config toggle from visualizer
var { ref, onValue, set, remove, onDisconnect } = require('firebase/database')
var configRef = ref(firebase.db, firebasePath + '/configuration/serverEnabled')
var serverActive = false

onValue(configRef, function (snapshot) {
  var enabled = snapshot.val()
  if (enabled === null) enabled = true // default to enabled

  if (enabled && !serverActive) {
    console.log('Server ENABLED via config — connecting to tree')
    serverActive = true
    node.connect()
  } else if (!enabled && serverActive) {
    console.log('Server DISABLED via config — disconnecting from tree')
    serverActive = false
    node.disconnect()
  }
})

// Watch serverCapacity from Firebase config (takes precedence over command line/env)
var serverCapacityConfigRef = ref(firebase.db, firebasePath + '/configuration/serverCapacity')
onValue(serverCapacityConfigRef, function (snapshot) {
  var capacity = snapshot.val()
  if (capacity != null) {
    node.opts.serverCapacity = capacity
    console.log('Server capacity updated from config:', capacity)
    updateServerCapacityState()
  } else if (serverCapacity) {
    // Fall back to command line/env var if Firebase config is null
    node.opts.serverCapacity = serverCapacity
  }
})

// When Firebase reconnects after a brief drop, onDisconnect has already fired
// and removed serverUrl. Re-publish if the tree node is still active.
var connectedRef = ref(firebase.db, '.info/connected')
onValue(connectedRef, function (snapshot) {
  if (snapshot.val() === true && nodeConnected) {
    publishServerPresence()
  }
})

// Clean up on exit
function shutdown () {
  console.log('\nShutting down...')
  node.disconnect()
  wss.close(function () {
    console.log('Server stopped')
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log('Relay server started successfully')
console.log('Waiting for connections...')
console.log()
