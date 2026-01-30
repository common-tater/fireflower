#!/usr/bin/env node

/**
 * Fireflower Relay Server
 *
 * A WebSocket-based relay server that acts as a "super parent" node in the
 * Fireflower K-ary tree. Provides fallback connectivity when P2P WebRTC
 * connections fail.
 *
 * Usage:
 *   node relay-server.js --port 8082 --firebase-path tree
 *
 * Environment variables:
 *   PORT - Server port (default: 8082)
 *   FIREBASE_PATH - Firebase database path (default: 'tree')
 */

var WebSocketServer = require('ws').Server
var crypto = require('crypto')

// Parse command line arguments
var args = process.argv.slice(2)
var port = process.env.PORT || 8082
var firebasePath = process.env.FIREBASE_PATH || 'tree'
var firebaseConfigPath = './example/firebase-config.js'

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
var { ref, child, set, remove, serverTimestamp } = require('firebase/database')

// Generate server ID
var serverId = 'relay-' + crypto.randomBytes(4).toString('hex')
var serverUrl = 'ws://localhost:' + port

console.log('Fireflower Relay Server')
console.log('=======================')
console.log('Server ID:', serverId)
console.log('Port:', port)
console.log('Firebase path:', firebasePath)
console.log('Server URL:', serverUrl)
console.log()

// Create WebSocket server
var wss = new WebSocketServer({ port: port })
var clients = {}  // Map of clientId -> { ws, channels, lastPing }

wss.on('listening', function () {
  console.log('WebSocket server listening on port', port)
  registerInFirebase()
})

wss.on('connection', function (ws) {
  var clientId = null
  var clientChannels = {}

  console.log('New connection from', ws._socket.remoteAddress)

  ws.on('message', function (data) {
    var msg
    try {
      msg = JSON.parse(data.toString())
    } catch (err) {
      console.warn('Invalid JSON from client:', err.message)
      return
    }

    handleMessage(ws, msg, clientId, clientChannels)
  })

  ws.on('close', function () {
    if (clientId) {
      console.log('Client disconnected:', clientId)
      delete clients[clientId]
    }
  })

  ws.on('error', function (err) {
    console.error('WebSocket error:', err.message)
  })

  // Set up message handler that can update clientId
  function handleMessage (ws, msg, currentClientId, channels) {
    switch (msg.type) {
      case 'connect':
        // Client handshake
        clientId = msg.id
        clients[clientId] = {
          ws: ws,
          channels: channels,
          lastPing: Date.now()
        }
        console.log('Client connected:', clientId)

        // Send acknowledgment
        send(ws, {
          type: 'connect',
          id: serverId
        })
        break

      case 'channel-open':
        // Client created a channel
        channels[msg.label] = true
        console.log('Client', clientId, 'opened channel:', msg.label)

        // Echo back to confirm
        send(ws, {
          type: 'channel-open',
          label: msg.label
        })
        break

      case 'channel':
        // Client sent data on a channel
        // For now, we relay to all other clients (broadcast)
        // In a more sophisticated implementation, we'd maintain
        // the tree topology and forward only to appropriate peers
        relayToOthers(clientId, msg)
        break

      case 'ping':
        // Heartbeat ping
        if (clientId) {
          clients[clientId].lastPing = Date.now()
        }
        send(ws, { type: 'pong' })
        break

      case 'close':
        // Client is closing
        ws.close()
        break

      default:
        console.warn('Unknown message type from', clientId, ':', msg.type)
    }
  }
})

wss.on('error', function (err) {
  console.error('WebSocket server error:', err)
})

/**
 * Send a message to a WebSocket client
 */
function send (ws, data) {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(data))
    } catch (err) {
      console.warn('Failed to send message:', err.message)
    }
  }
}

/**
 * Relay a message to all other connected clients
 */
function relayToOthers (senderId, msg) {
  var count = 0
  for (var id in clients) {
    if (id !== senderId) {
      send(clients[id].ws, msg)
      count++
    }
  }
  if (count > 0) {
    console.log('Relayed', msg.type, 'from', senderId, 'to', count, 'clients')
  }
}

/**
 * Register this relay server in Firebase
 */
function registerInFirebase () {
  var serverRef = ref(firebase.db, firebasePath + '/servers/' + serverId)

  var serverData = {
    url: serverUrl,
    capacity: 1000,  // Max clients (configurable)
    connected: 0,    // Updated periodically
    timestamp: serverTimestamp()
  }

  set(serverRef, serverData)
    .then(function () {
      console.log('Registered in Firebase at:', firebasePath + '/servers/' + serverId)
    })
    .catch(function (err) {
      console.error('Failed to register in Firebase:', err.message)
    })

  // Update connected count periodically
  setInterval(function () {
    var connectedCount = Object.keys(clients).length
    set(child(serverRef, 'connected'), connectedCount).catch(function (err) {
      console.warn('Failed to update connected count:', err.message)
    })
    set(child(serverRef, 'timestamp'), serverTimestamp()).catch(function (err) {
      console.warn('Failed to update timestamp:', err.message)
    })
  }, 5000)

  // Clean up on exit
  process.on('SIGINT', function () {
    console.log('\nShutting down...')
    remove(serverRef)
      .then(function () {
        console.log('Deregistered from Firebase')
        process.exit(0)
      })
      .catch(function (err) {
        console.error('Failed to deregister:', err.message)
        process.exit(1)
      })
  })

  process.on('SIGTERM', function () {
    console.log('\nShutting down...')
    remove(serverRef)
      .then(function () {
        console.log('Deregistered from Firebase')
        process.exit(0)
      })
      .catch(function (err) {
        console.error('Failed to deregister:', err.message)
        process.exit(1)
      })
  })
}

/**
 * Heartbeat: Check for dead connections
 */
setInterval(function () {
  var now = Date.now()
  var timeout = 60000  // 60 seconds

  for (var id in clients) {
    if (now - clients[id].lastPing > timeout) {
      console.log('Client', id, 'timed out (no ping for 60s)')
      clients[id].ws.close()
      delete clients[id]
    }
  }
}, 30000)

console.log('Relay server started successfully')
console.log('Waiting for connections...')
console.log()
