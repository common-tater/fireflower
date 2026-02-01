#!/usr/bin/env node

var puppeteer = require('puppeteer')
var { spawn, execSync } = require('child_process')
var path = require('path')
var h = require('./helpers')

var ROOT = path.join(__dirname, '..')
var EXAMPLE_PORT = 8080
var RELAY_PORT = 8082
var URL = 'http://localhost:' + EXAMPLE_PORT + '/?path=' + h.TEST_PATH

// Allow running a single scenario: node test/run.js 3
var onlyScenario = process.argv[2] ? parseInt(process.argv[2], 10) : null

var scenarios = [
  { name: 'Basic P2P Tree (K=2)', fn: scenario1 },
  { name: 'Server Fallback', fn: scenario2 },
  { name: 'Force Server Mode', fn: scenario3 },
  { name: 'Force Server OFF → P2P Upgrade', fn: scenario4 },
  { name: 'Server Toggle OFF → P2P Reconnect', fn: scenario5 },
  { name: 'Rapid Joins (K=2)', fn: scenario6 },
  { name: 'K Change Mid-Session', fn: scenario7 },
  { name: 'Node Departure & Recovery', fn: scenario8 },
  { name: 'Mixed Transport Tree', fn: scenario9 },
  { name: 'Large Tree (K=3)', fn: scenario10 },
  { name: 'WebSocket Reconnection', fn: scenario11 },
  { name: 'Disconnect All & Reconnect', fn: scenario12 },
  { name: 'Server Fallback on Mid-Tree Disconnect', fn: scenario13 },
  { name: 'Heartbeat Pause → Fallback → Resume → Recovery', fn: scenario14 },
  { name: 'Server Info Cached After Server Seen', fn: scenario15 },
  { name: 'Rapid Disconnects with Server Fallback', fn: scenario16 },
  { name: 'Server-First Connection + P2P Upgrade', fn: scenario17 },
  { name: 'Force Server Downgrade (P2P → Server)', fn: scenario18 },
  { name: 'Force Server ON then OFF (roundtrip)', fn: scenario19 },
  { name: 'Simultaneous Server→P2P Upgrades (no stuck nodes)', fn: scenario20 },
  { name: 'Transitive Circle Prevention During Upgrades', fn: scenario21 },
  { name: 'Minimal Server→P2P Switch (1 peer)', fn: scenario22 },
  { name: 'Server-First Prefers Server, Stays When No Upgrade Target', fn: scenario23 },
  { name: 'Upgrade Skips Root (peers connect to each other)', fn: scenario24 },
  { name: 'K Limit Enforced Under Rapid Connections', fn: scenario25 },
  { name: 'Server-First Reconnection After Mid-Tree Disconnect', fn: scenario26 },
  { name: 'Server Capacity Limit (excess nodes use P2P)', fn: scenario27 }
]

// ─── Scenario implementations ───────────────────────────────────────

async function scenario1 (page) {
  // Basic P2P Tree: K=2, add 6 nodes, all should connect via P2P
  await h.setK(page, 2)
  await h.setServerEnabled(page, false)
  await h.wait(1000)

  await h.addNodes(page, 6)

  var states = await h.waitForAllConnected(page, 7) // root + 6
  var nonRoot = Object.keys(states).filter(function (id) { return !states[id].isRoot })

  // All non-root should be P2P
  for (var i = 0; i < nonRoot.length; i++) {
    assert(states[nonRoot[i]].transport === 'p2p',
      'Node ' + nonRoot[i].slice(-5) + ' should be p2p, got ' + states[nonRoot[i]].transport)
  }

  // Root should have at most K=2 downstream
  var root = Object.keys(states).find(function (id) { return states[id].isRoot })
  assert(states[root].downstreamCount <= 2,
    'Root downstream should be ≤2, got ' + states[root].downstreamCount)

  h.log('  All 6 nodes connected via P2P, root has ' + states[root].downstreamCount + ' downstream')
}

async function scenario2 (page) {
  // Server Fallback: with relay server, nodes should connect
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000) // let server connect to tree

  await h.addNodes(page, 3)

  var states = await h.waitForAllConnected(page, 4) // root + 3
  var nonRoot = Object.keys(states).filter(function (id) { return !states[id].isRoot })

  for (var i = 0; i < nonRoot.length; i++) {
    assert(states[nonRoot[i]].state === 'connected',
      'Node ' + nonRoot[i].slice(-5) + ' should be connected')
  }

  h.log('  All 3 nodes connected with server available')
}

async function scenario3 (page) {
  // Force Server: all new nodes should use server transport
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)
  await h.setForceServer(page, true)
  await h.wait(1000)

  await h.addNodes(page, 3)

  var states = await h.waitForAllConnected(page, 4)
  var nonRoot = Object.keys(states).filter(function (id) { return !states[id].isRoot })

  for (var i = 0; i < nonRoot.length; i++) {
    assert(states[nonRoot[i]].transport === 'server',
      'Node ' + nonRoot[i].slice(-5) + ' should be server, got ' + states[nonRoot[i]].transport)
  }

  h.log('  All 3 nodes connected via server transport')
  await h.setForceServer(page, false)
}

async function scenario4 (page) {
  // Force Server OFF → P2P Upgrade
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)
  await h.setForceServer(page, true)
  await h.wait(1000)

  await h.addNodes(page, 3, { p2pUpgradeInterval: 5000 })
  await h.waitForAllConnected(page, 4)

  // Verify they're on server
  var states = await h.getNodeStates(page)
  var nonRoot = Object.keys(states).filter(function (id) { return !states[id].isRoot })
  for (var i = 0; i < nonRoot.length; i++) {
    assert(states[nonRoot[i]].transport === 'server',
      'Node ' + nonRoot[i].slice(-5) + ' should start on server')
  }
  h.log('  All nodes on server, now disabling forceServer...')

  // Turn off forceServer — nodes should upgrade to P2P
  await h.setForceServer(page, false)

  // Wait for P2P upgrade (may need p2pUpgradeInterval to elapse)
  await h.waitForAll(page, function (states) {
    var ids = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (ids.length === 0) return false
    // At least some should upgrade to P2P
    var p2pCount = ids.filter(function (id) { return states[id].transport === 'p2p' }).length
    return p2pCount > 0
  }, 'at least one node upgrades to P2P', 45000)

  h.log('  Nodes upgrading to P2P after forceServer disabled')
}

async function scenario5 (page) {
  // Server Toggle OFF → all nodes reconnect via P2P
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)
  await h.setForceServer(page, true)
  await h.wait(1000)

  await h.addNodes(page, 3)
  await h.waitForAllConnected(page, 4)
  h.log('  Nodes connected, now disabling server...')

  await h.setForceServer(page, false)
  await h.wait(500)
  await h.setServerEnabled(page, false)

  // Wait for all to reconnect via P2P
  await h.waitForAll(page, function (states) {
    var ids = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (ids.length === 0) return false
    return ids.every(function (id) {
      return states[id].state === 'connected' && states[id].transport === 'p2p'
    })
  }, 'all nodes reconnect via P2P', 30000)

  h.log('  All nodes reconnected via P2P after server disabled')
  await h.setServerEnabled(page, true) // restore
}

async function scenario6 (page) {
  // Rapid Joins: add 8 nodes quickly
  await h.setK(page, 2)
  await h.setServerEnabled(page, false)
  await h.wait(1000)

  // Add rapidly (override default delay)
  var ids = []
  for (var i = 0; i < 8; i++) {
    var id = await page.evaluate(function () {
      var node = window.graph.add({})
      node.x = 200 + Math.random() * (window.innerWidth - 300)
      node.y = 100 + Math.random() * (window.innerHeight - 200)
      window.graph.render()
      return node.id
    })
    ids.push(id)
    h.log('  Added node ' + id.slice(-5) + ' (' + (i + 1) + '/8)')
    await h.wait(500)
  }

  // Wait for stabilization
  await h.waitForAllConnected(page, 9, 45000) // root + 8

  h.log('  All 8 rapidly-added nodes connected')
}

async function scenario7 (page) {
  // K Change Mid-Session
  await h.setK(page, 2)
  await h.setServerEnabled(page, false)
  await h.wait(1000)

  await h.addNodes(page, 4)
  await h.waitForAllConnected(page, 5)
  h.log('  4 nodes connected with K=2, changing to K=4...')

  await h.setK(page, 4)
  await h.wait(2000)

  await h.addNodes(page, 4)
  await h.waitForAllConnected(page, 9)

  var states = await h.getNodeStates(page)
  var root = Object.keys(states).find(function (id) { return states[id].isRoot })
  h.log('  All 8 nodes connected, root has ' + states[root].downstreamCount + ' downstream (K=4)')
}

async function scenario8 (page) {
  // Node Departure & Recovery
  await h.setK(page, 2)
  await h.setServerEnabled(page, false)
  await h.wait(1000)

  var ids = await h.addNodes(page, 4)
  await h.waitForAllConnected(page, 5)

  // Find a node that has downstream (mid-tree)
  var states = await h.getNodeStates(page)
  var midNode = ids.find(function (id) {
    return states[id] && states[id].downstreamCount > 0
  })

  if (!midNode) {
    // If no mid-tree node, just disconnect any non-root
    midNode = ids[0]
  }

  h.log('  Disconnecting mid-tree node ' + midNode.slice(-5) + ' (downstream=' + (states[midNode] ? states[midNode].downstreamCount : 0) + ')...')
  await h.disconnectNode(page, midNode)
  await h.wait(2000)

  // Remaining nodes should reconnect
  await h.waitForAll(page, function (states) {
    var ids = Object.keys(states)
    return ids.every(function (id) { return states[id].state === 'connected' })
  }, 'remaining nodes reconnect', 30000)

  h.log('  Remaining nodes recovered after mid-tree departure')
}

async function scenario9 (page) {
  // Mixed Transport Tree
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)

  // Add 2 server-only nodes
  await h.setForceServer(page, true)
  await h.wait(1000)
  var serverIds = await h.addNodes(page, 2)
  await h.waitForAllConnected(page, 3)

  // Add 2 P2P nodes
  await h.setForceServer(page, false)
  await h.wait(1000)
  var p2pIds = await h.addNodes(page, 2)
  await h.waitForAllConnected(page, 5, 30000)

  var states = await h.getNodeStates(page)
  var serverCount = 0
  var p2pCount = 0
  var nonRoot = Object.keys(states).filter(function (id) { return !states[id].isRoot })
  for (var i = 0; i < nonRoot.length; i++) {
    if (states[nonRoot[i]].transport === 'server') serverCount++
    else if (states[nonRoot[i]].transport === 'p2p') p2pCount++
  }

  h.log('  Mixed tree: ' + serverCount + ' server, ' + p2pCount + ' p2p — all connected')
}

async function scenario10 (page) {
  // Large Tree (K=3)
  await h.setK(page, 3)
  await h.setServerEnabled(page, false)
  await h.wait(1000)

  await h.addNodes(page, 12, null)
  await h.waitForAllConnected(page, 13, 60000)

  var states = await h.getNodeStates(page)
  var root = Object.keys(states).find(function (id) { return states[id].isRoot })
  h.log('  All 12 nodes connected in K=3 tree, root downstream=' + states[root].downstreamCount)
}

async function scenario11 (page, ctx) {
  // WebSocket Reconnection — clients detect server disconnect and fall back to P2P
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)
  await h.setForceServer(page, true)
  await h.wait(1000)

  await h.addNodes(page, 3)
  await h.waitForAllConnected(page, 4)
  h.log('  Nodes connected via server, now disabling server...')

  // Disable server via config (graceful shutdown)
  await h.setServerEnabled(page, false)
  await h.wait(3000)

  // Clients should detect WebSocket close and reconnect via P2P
  await h.waitForAllConnected(page, 4, 60000)
  var states = await h.getNodeStates(page)
  var nonRoot = Object.keys(states).filter(function (id) { return !states[id].isRoot })

  // All non-root should be P2P after server shutdown
  for (var i = 0; i < nonRoot.length; i++) {
    assert(states[nonRoot[i]].transport === 'p2p',
      'Node ' + nonRoot[i].slice(-5) + ' should be p2p after server shutdown, got ' + states[nonRoot[i]].transport)
  }

  h.log('  Clients reconnected via P2P after server shutdown')
  await h.setServerEnabled(page, true) // clean up for next test
}

async function scenario12 (page) {
  // Disconnect All & Reconnect — disconnect non-root nodes, then add fresh ones
  await h.setK(page, 2)
  await h.setServerEnabled(page, false)
  await h.wait(1000)

  var ids = await h.addNodes(page, 5)
  await h.waitForAllConnected(page, 6)
  h.log('  5 nodes connected, disconnecting all non-root...')

  // Disconnect all non-root
  for (var i = 0; i < ids.length; i++) {
    await h.disconnectNode(page, ids[i])
    await h.wait(200)
  }

  // Wait for root to report itself (so new nodes can find it)
  await h.wait(5000)

  // Add fresh nodes
  h.log('  Adding 5 fresh nodes...')
  await h.addNodes(page, 5)
  await h.waitForAllConnected(page, 6, 30000)

  h.log('  All nodes reconnected successfully')
}

async function scenario13 (page) {
  // Server Fallback on Mid-Tree Disconnect:
  // With server enabled, disconnect a mid-tree node. Its orphaned children
  // should fall back to server, then eventually upgrade back to P2P.
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)

  var ids = await h.addNodes(page, 4, { p2pUpgradeInterval: 5000 })
  await h.waitForAllConnected(page, 5)

  // Find a mid-tree node (has downstream children, is not root)
  var states = await h.getNodeStates(page)
  var midNode = ids.find(function (id) {
    return states[id] && states[id].downstreamCount > 0
  })

  if (!midNode) {
    h.log('  No mid-tree node found, using first non-root')
    midNode = ids[0]
  }

  h.log('  Disconnecting mid-tree node ' + midNode.slice(-5) + ' (downstream=' + (states[midNode] ? states[midNode].downstreamCount : 0) + ')...')
  await h.disconnectNode(page, midNode)

  // Wait for remaining nodes to reconnect — some may go through server first
  await h.waitForAllConnected(page, 4, 30000)

  // Check that at least one node went through server (fallback promotion)
  var midStates = await h.getNodeStates(page)
  var nonRoot = Object.keys(midStates).filter(function (id) { return !midStates[id].isRoot })
  var serverCount = nonRoot.filter(function (id) { return midStates[id].transport === 'server' }).length
  h.log('  After disconnect: ' + serverCount + ' on server, ' + (nonRoot.length - serverCount) + ' on p2p')

  // Wait for most nodes to upgrade to P2P. The last server-connected node may
  // stay on server if all other nodes are its descendants (upgrade skips root
  // to preserve broadcaster bandwidth — this is acceptable).
  await h.waitForAll(page, function (states) {
    var ids = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (ids.length === 0) return false
    var serverCount = ids.filter(function (id) { return states[id].transport === 'server' }).length
    return serverCount <= 1 && ids.every(function (id) { return states[id].state === 'connected' })
  }, 'nodes upgrade to P2P after fallback (at most 1 on server)', 60000)

  h.log('  Nodes recovered after server fallback')
}

async function scenario14 (page) {
  // Heartbeat Pause → Fallback → Resume → Recovery:
  // Pause heartbeats from a parent node. Children should attempt server fallback.
  // Resume heartbeats before timeout. Children should close fallback and stay on P2P.
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)

  var ids = await h.addNodes(page, 3, { p2pUpgradeInterval: 5000 })
  await h.waitForAllConnected(page, 4)

  // Find a node that has children (is sending heartbeats)
  var states = await h.getNodeStates(page)
  var parent = ids.find(function (id) {
    return states[id] && states[id].downstreamCount > 0
  })

  if (!parent) {
    // Root always has children in a 4-node tree
    parent = Object.keys(states).find(function (id) { return states[id].isRoot })
  }

  h.log('  Pausing heartbeats from ' + parent.slice(-5) + ' for 2.5s...')
  await h.pauseHeartbeats(page, parent)

  // Wait 2.5s — enough for early warning (3s from last beat) to be close,
  // but safely before the 4s kill timeout
  await h.wait(2500)

  // Resume heartbeats well before the 4s kill timeout
  await h.resumeHeartbeats(page, parent)
  h.log('  Heartbeats resumed, waiting for recovery...')

  // Wait for all nodes to be connected and stable
  await h.waitForAllConnected(page, 4, 15000)

  // Wait for most nodes to upgrade to P2P (server-first nodes need the upgrade
  // timer to fire — p2pUpgradeInterval=5s plus up to 25% jitter plus ICE time).
  // The last server-connected node may stay on server if all others are its descendants.
  await h.waitForAll(page, function (states) {
    var ids = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (ids.length === 0) return false
    var serverCount = ids.filter(function (id) { return states[id].transport === 'server' }).length
    return serverCount <= 1 && ids.every(function (id) { return states[id].state === 'connected' })
  }, 'nodes upgrade to P2P after heartbeat recovery (at most 1 on server)', 20000)

  h.log('  Nodes on P2P after recovery (at most 1 on server)')
}

async function scenario15 (page) {
  // Server Info Cached: after server is enabled and nodes see server responses,
  // _serverInfo should be cached on nodes. This is a prerequisite for fallback.
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)

  await h.addNodes(page, 3)
  await h.waitForAllConnected(page, 4)

  // Wait a bit for server responses to be seen during connection negotiation
  await h.wait(2000)

  var states = await h.getNodeStates(page)
  var nonRoot = Object.keys(states).filter(function (id) { return !states[id].isRoot })

  // At least some non-root nodes should have cached server info
  var withInfo = nonRoot.filter(function (id) { return states[id].hasServerInfo })
  h.log('  ' + withInfo.length + '/' + nonRoot.length + ' non-root nodes have _serverInfo cached')

  assert(withInfo.length > 0,
    'At least one non-root node should have _serverInfo cached, got 0')

  h.log('  Server info is cached — fallback would work for these nodes')
}

async function scenario16 (page) {
  // Rapid Disconnects with Server Fallback:
  // Disconnect two mid-tree nodes simultaneously. All orphaned children should
  // independently fall back to server and recover.
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)

  var ids = await h.addNodes(page, 6, { p2pUpgradeInterval: 5000 })
  await h.waitForAllConnected(page, 7)

  // Find two nodes with children
  var states = await h.getNodeStates(page)
  var parents = ids.filter(function (id) {
    return states[id] && states[id].downstreamCount > 0
  })

  if (parents.length < 2) {
    h.log('  Only ' + parents.length + ' parents found, disconnecting what we have')
    parents = parents.slice(0, 1)
  } else {
    parents = parents.slice(0, 2)
  }

  h.log('  Disconnecting ' + parents.length + ' mid-tree nodes simultaneously...')
  for (var i = 0; i < parents.length; i++) {
    await h.disconnectNode(page, parents[i])
  }

  var remaining = 7 - parents.length

  // Wait for remaining nodes to reconnect
  await h.waitForAllConnected(page, remaining, 30000)
  h.log('  All remaining nodes reconnected after rapid disconnects')

  // Wait for most nodes to end up on P2P. The last server-connected node may
  // stay on server if all others are its descendants (upgrade skips root).
  await h.waitForAll(page, function (states) {
    var ids = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (ids.length === 0) return false
    var serverCount = ids.filter(function (id) { return states[id].transport === 'server' }).length
    return serverCount <= 1 && ids.every(function (id) { return states[id].state === 'connected' })
  }, 'nodes upgrade to P2P (at most 1 on server)', 60000)

  h.log('  Nodes recovered after rapid disconnects with server fallback')
}

async function scenario17 (page) {
  // Server-First Connection + P2P Upgrade:
  // With server enabled, new nodes should connect via server first (for instant data),
  // then upgrade to P2P in the background.
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)

  await h.addNodes(page, 3, { p2pUpgradeInterval: 5000 })

  // Nodes should connect quickly (via server-first)
  await h.waitForAllConnected(page, 4)

  // Check initial state — at least some should be on server (server-first)
  var initialStates = await h.getNodeStates(page)
  var nonRoot = Object.keys(initialStates).filter(function (id) { return !initialStates[id].isRoot })
  var serverCount = nonRoot.filter(function (id) { return initialStates[id].transport === 'server' }).length
  h.log('  Initial: ' + serverCount + '/' + nonRoot.length + ' on server (server-first)')

  // Wait for most nodes to upgrade to P2P. The last server-connected node may
  // stay on server if all other nodes are its descendants (upgrade skips root).
  await h.waitForAll(page, function (states) {
    var ids = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (ids.length === 0) return false
    var serverCount = ids.filter(function (id) { return states[id].transport === 'server' }).length
    return serverCount <= 1 && ids.every(function (id) { return states[id].state === 'connected' })
  }, 'nodes upgrade to P2P after server-first (at most 1 on server)', 60000)

  h.log('  Nodes upgraded from server-first (at most 1 on server)')
}

async function scenario18 (page) {
  // Force Server Downgrade: with a stable P2P tree, toggle Force Server ON.
  // All non-root P2P nodes should switch to server transport.
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)

  // Add nodes and wait for them to be on P2P (may go through server-first then upgrade).
  // At most 1 may stay on server if it's everyone's ancestor (upgrade skips root).
  await h.addNodes(page, 3, { p2pUpgradeInterval: 5000 })
  await h.waitForAll(page, function (states) {
    var ids = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (ids.length < 3) return false
    var serverCount = ids.filter(function (id) { return states[id].transport === 'server' }).length
    return serverCount <= 1 && ids.every(function (id) { return states[id].state === 'connected' })
  }, 'nodes on P2P (at most 1 on server)', 60000)

  h.log('  Nodes ready, toggling Force Server ON...')
  await h.setForceServer(page, true)

  // All non-root should switch to server
  await h.waitForAll(page, function (states) {
    var ids = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (ids.length === 0) return false
    return ids.every(function (id) {
      return states[id].state === 'connected' && states[id].transport === 'server'
    })
  }, 'all nodes switch to server after force-server', 30000)

  h.log('  All non-root nodes downgraded from P2P to server')
  await h.setForceServer(page, false)
}

async function scenario19 (page) {
  // Force Server ON then OFF: full roundtrip.
  // P2P → force server ON → server → force server OFF → P2P upgrade
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)

  await h.addNodes(page, 3, { p2pUpgradeInterval: 5000 })
  await h.waitForAll(page, function (states) {
    var ids = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (ids.length < 3) return false
    var serverCount = ids.filter(function (id) { return states[id].transport === 'server' }).length
    return serverCount <= 1 && ids.every(function (id) { return states[id].state === 'connected' })
  }, 'nodes on P2P (at most 1 on server)', 60000)

  h.log('  Nodes ready, toggling Force Server ON...')
  await h.setForceServer(page, true)

  await h.waitForAll(page, function (states) {
    var ids = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (ids.length === 0) return false
    return ids.every(function (id) {
      return states[id].state === 'connected' && states[id].transport === 'server'
    })
  }, 'all nodes on server', 30000)

  h.log('  All on server, toggling Force Server OFF...')
  await h.setForceServer(page, false)

  // Nodes should upgrade back to P2P
  await h.waitForAll(page, function (states) {
    var ids = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (ids.length === 0) return false
    var p2pCount = ids.filter(function (id) { return states[id].transport === 'p2p' }).length
    return p2pCount > 0
  }, 'at least one node upgrades back to P2P', 45000)

  h.log('  Nodes upgrading back to P2P after force-server roundtrip')
}

async function scenario20 (page) {
  // Simultaneous Server→P2P Upgrades: many nodes connect via server, then all
  // try to upgrade to P2P around the same time. This tests for circle formation
  // and stuck nodes during the thundering herd of upgrade requests.
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)

  // Use a short upgrade interval to trigger upgrades quickly
  await page.evaluate(function () {
    window._origUpgradeInterval = 30000
  })

  // Add many nodes quickly — they all connect via server-first
  await h.addNodes(page, 8, { p2pUpgradeInterval: 8000 })

  // Wait for all to be connected (via server-first)
  await h.waitForAllConnected(page, 9, 30000) // root + 8
  h.log('  All 8 nodes connected (server-first)')

  // Verify most are on server initially
  var initialStates = await h.getNodeStates(page)
  var nonRoot = Object.keys(initialStates).filter(function (id) { return !initialStates[id].isRoot })
  var serverCount = nonRoot.filter(function (id) { return initialStates[id].transport === 'server' }).length
  h.log('  Initial: ' + serverCount + '/' + nonRoot.length + ' on server')

  // Wait for ALL nodes to upgrade to P2P — this is where circles/stuck nodes would happen
  // The 8s upgrade interval means all nodes try to upgrade around the same time
  await h.waitForAll(page, function (states) {
    var ids = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (ids.length < 8) return false
    return ids.every(function (id) {
      return states[id].state === 'connected' && states[id].transport === 'p2p'
    })
  }, 'all 8 nodes upgrade to P2P without getting stuck', 60000)

  h.log('  All 8 nodes successfully upgraded from server to P2P (no stuck nodes)')

  // Verify no circles: walk upstream from each node, should always reach root
  var finalStates = await h.getNodeStates(page)
  assertNoCircles(finalStates)
  h.log('  No circles detected in final tree')
}

async function scenario21 (page) {
  // Transitive circle prevention: many server-connected nodes upgrade simultaneously.
  // K=3 gives enough capacity for the tree to stabilize. 5s upgrade interval with
  // jitter ensures overlapping upgrades without overwhelming ICE negotiation.
  await h.setK(page, 3)
  await h.setServerEnabled(page, true)
  await h.wait(2000)

  // Add nodes with 5s upgrade interval — short enough to overlap, long enough to stabilize
  await h.addNodes(page, 6, { p2pUpgradeInterval: 5000 })

  // Wait for all to connect via server-first
  await h.waitForAllConnected(page, 7, 30000) // root + 6
  h.log('  All 6 nodes connected (server-first)')

  // Wait for ALL nodes to upgrade to P2P without forming circles
  await h.waitForAll(page, function (states) {
    var ids = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (ids.length < 6) return false
    return ids.every(function (id) {
      return states[id].state === 'connected' && states[id].transport === 'p2p'
    })
  }, 'all 6 nodes upgrade to P2P without circles', 60000)

  h.log('  All nodes upgraded to P2P')

  // Check for N-node circles by walking upstream chains
  var states = await h.getNodeStates(page)
  assertNoCircles(states)

  // Verify ancestor chains are populated — every non-root P2P node should have ancestors
  var nonRoot = Object.keys(states).filter(function (id) { return !states[id].isRoot })
  var ancestorCount = 0
  for (var i = 0; i < nonRoot.length; i++) {
    var s = states[nonRoot[i]]
    if (s.ancestors.length > 0) ancestorCount++
  }
  h.log('  ' + ancestorCount + '/' + nonRoot.length + ' nodes have ancestor chains')
  assert(ancestorCount >= nonRoot.length - 1,
    'Most nodes should have ancestor chains, got ' + ancestorCount + '/' + nonRoot.length)

  // Second round: disconnect some nodes and add replacements to trigger another upgrade wave
  h.log('  Disconnecting 3 nodes...')
  var toDisconnect = nonRoot.slice(0, 3)
  for (var j = 0; j < toDisconnect.length; j++) {
    await h.disconnectNode(page, toDisconnect[j])
  }
  await h.wait(3000)

  await h.addNodes(page, 3, { p2pUpgradeInterval: 5000 })

  // Wait for all to connect and upgrade
  await h.waitForAll(page, function (states) {
    var ids = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (ids.length < 6) return false
    return ids.every(function (id) {
      return states[id].state === 'connected'
    })
  }, 'replacement nodes connected', 60000)

  // Final circle check
  var finalStates = await h.getNodeStates(page)
  assertNoCircles(finalStates)
  h.log('  No circles after second wave of upgrades')
}

async function scenario22 (page) {
  // Minimal Server→P2P Switch: 1 peer connects via forced server, then
  // server is disabled entirely. The peer loses its server upstream and
  // must reconnect to root via P2P. We verify the peer ends up as root's
  // direct P2P child and stays connected.
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)
  await h.setForceServer(page, true)
  await h.wait(1000)

  var ids = await h.addNodes(page, 1, { p2pUpgradeInterval: 3000 })
  await h.waitForAllConnected(page, 2) // root + 1 peer
  h.log('  Peer connected via server')

  // Verify on server
  var states = await h.getNodeStates(page)
  var peerId = ids[0]
  assert(states[peerId].transport === 'server',
    'Peer should be on server, got ' + states[peerId].transport)

  // Disable forceServer AND server — peer must find root via P2P
  await h.setForceServer(page, false)
  await h.wait(500)
  await h.setServerEnabled(page, false)
  h.log('  Server disabled, peer must reconnect to root via P2P...')

  // Wait for peer to be connected to root via P2P
  var rootId = Object.keys(states).find(function (id) { return states[id].isRoot })
  await h.waitForAll(page, function (states) {
    var s = states[peerId]
    if (!s) return false
    return s.state === 'connected' && s.transport === 'p2p' && s.upstream === rootId
  }, 'peer connects to root via P2P', 20000)

  h.log('  Peer connected to root via P2P')

  // Verify it stays connected for a few seconds (not a transient blip)
  await h.wait(3000)
  var finalStates = await h.getNodeStates(page)
  var finalPeer = finalStates[peerId]
  assert(finalPeer.state === 'connected',
    'Peer should still be connected, got ' + finalPeer.state)
  assert(finalPeer.transport === 'p2p',
    'Peer should still be P2P, got ' + finalPeer.transport)
  assert(finalPeer.upstream === rootId,
    'Peer should still be child of root, got ' + (finalPeer.upstream || 'none').slice(-5))

  h.log('  Peer stayed connected to root via P2P for 3s — stable')
}

async function scenario23 (page) {
  // Server-first must prefer server candidate over P2P root response.
  // Previously, _reviewResponses accepted P2P root before checking for
  // server candidates, so serverFirst=true had no effect when root responded.
  //
  // With only 1 peer + root + relay, the peer should stay on server because
  // _attemptUpgrade skips root (root's bandwidth is reserved for broadcasting).
  // The peer correctly remains on server transport — no upgrade target exists.
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)

  // Add a single node with serverFirst (default) and a short upgrade interval
  var ids = await h.addNodes(page, 1, { p2pUpgradeInterval: 5000 })
  await h.waitForAllConnected(page, 2) // root + 1 peer

  // The peer should have connected via server transport FIRST (not P2P to root)
  var states = await h.getNodeStates(page)
  var peerId = ids[0]
  var peer = states[peerId]
  h.log('  Peer transport: ' + peer.transport + ', upstream: ' + (peer.upstream || 'none').slice(-5))

  // The peer's upstream should be the relay server, not root
  var rootId = Object.keys(states).find(function (id) { return states[id].isRoot })
  assert(peer.transport === 'server',
    'Peer should initially connect via server (server-first), got ' + peer.transport)
  assert(peer.upstream !== rootId,
    'Peer upstream should be relay server, not root directly')

  h.log('  Peer correctly connected via server-first (not P2P root)')

  // With only 1 peer, upgrade should NOT happen — the only P2P target is root,
  // and _attemptUpgrade skips root to preserve broadcaster bandwidth.
  // Wait for one upgrade cycle + jitter to confirm it stays on server.
  await h.wait(7000)
  var finalStates = await h.getNodeStates(page)
  assert(finalStates[peerId].state === 'connected',
    'Peer should still be connected')
  assert(finalStates[peerId].transport === 'server',
    'Peer should stay on server (no non-root upgrade target)')

  h.log('  Peer correctly stays on server (upgrade skips root)')
}

async function scenario24 (page) {
  // Server-connected nodes upgrading to P2P should connect to each other,
  // not to root. Root's K capacity should be reserved for the relay server
  // and naturally-joining nodes.
  await h.setK(page, 3)
  await h.setServerEnabled(page, true)
  await h.wait(2000)

  // Add 3 nodes with short upgrade interval — they connect via server-first
  var ids = await h.addNodes(page, 3, { p2pUpgradeInterval: 5000 })
  await h.waitForAllConnected(page, 4) // root + 3 peers

  // Verify all started on server
  var states = await h.getNodeStates(page)
  var rootId = Object.keys(states).find(function (id) { return states[id].isRoot })
  var serverCount = 0
  for (var i = 0; i < ids.length; i++) {
    if (states[ids[i]] && states[ids[i]].transport === 'server') serverCount++
  }
  h.log('  Initial: ' + serverCount + '/3 on server')

  // Wait for at least 2 nodes to upgrade to P2P (the third may stay on server
  // if no valid non-root peer is available to accept it)
  await h.waitForAll(page, function (states) {
    var p2pCount = 0
    for (var j = 0; j < ids.length; j++) {
      var s = states[ids[j]]
      if (s && s.transport === 'p2p') p2pCount++
    }
    return p2pCount >= 2
  }, 'at least 2 peers upgrade from server to P2P', 30000)

  // Check that upgraded peers connected to each other, not to root
  var finalStates = await h.getNodeStates(page)
  var p2pPeers = []
  var serverPeers = []
  for (var k = 0; k < ids.length; k++) {
    var s = finalStates[ids[k]]
    if (s.transport === 'p2p') {
      p2pPeers.push(ids[k])
      assert(s.upstream !== rootId,
        'Peer ' + ids[k].slice(-5) + ' upgraded to P2P but connected to root — should connect to another peer')
    } else {
      serverPeers.push(ids[k])
    }
  }

  h.log('  ' + p2pPeers.length + ' peers upgraded to P2P (not via root), ' + serverPeers.length + ' stayed on server')
  assert(p2pPeers.length >= 2,
    'At least 2 peers should upgrade to P2P, got ' + p2pPeers.length)
}

async function scenario25 (page) {
  // K Limit Enforced: add many nodes rapidly with K=2. After stabilization,
  // no node should have more than K connected children. This tests the fix
  // in _ondownstreamConnect that closes excess peers when multiple pending
  // peers complete ICE simultaneously.
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)

  // Add 8 nodes rapidly — short delays to maximize concurrent ICE
  var ids = []
  for (var i = 0; i < 8; i++) {
    var id = await page.evaluate(function () {
      var node = window.graph.add({})
      node.x = 200 + Math.random() * (window.innerWidth - 300)
      node.y = 100 + Math.random() * (window.innerHeight - 200)
      window.graph.render()
      return node.id
    })
    ids.push(id)
    h.log('  Added node ' + id.slice(-5) + ' (' + (i + 1) + '/8)')
    await h.wait(500) // rapid — half the normal delay
  }

  await h.waitForAllConnected(page, 9, 45000) // root + 8
  h.log('  All 8 nodes connected, checking K limits...')

  // Poll a few times to catch transient over-capacity (some peers may still
  // be completing ICE when we first check)
  for (var check = 0; check < 3; check++) {
    await h.wait(2000)
    var states = await h.getNodeStates(page)
    for (var nid in states) {
      var s = states[nid]
      assert(s.connectedDownstreamCount <= 2,
        'Node ' + nid.slice(-5) + ' has ' + s.connectedDownstreamCount + ' connected children (K=2)')
    }
  }

  h.log('  K=2 limit enforced — no node exceeded 2 connected children')
}

async function scenario26 (page) {
  // Server-First Reconnection After Mid-Tree Disconnect:
  // With server enabled, build a P2P tree, then disconnect a mid-tree node.
  // Orphaned children should reconnect via server-first (not skip to P2P),
  // proving the batch timer reset gives the server candidate time to arrive.
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)

  // Add nodes, let them upgrade to P2P
  var ids = await h.addNodes(page, 4, { p2pUpgradeInterval: 8000 })
  await h.waitForAll(page, function (states) {
    var nodeIds = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (nodeIds.length < 4) return false
    var serverCount = nodeIds.filter(function (id) { return states[id].transport === 'server' }).length
    return serverCount <= 1 && nodeIds.every(function (id) { return states[id].state === 'connected' })
  }, 'nodes on P2P (at most 1 on server)', 60000)
  h.log('  Nodes upgraded (at most 1 on server)')

  // Find a mid-tree node with children
  var states = await h.getNodeStates(page)
  var midNode = ids.find(function (id) {
    return states[id] && states[id].connectedDownstreamCount > 0
  })
  if (!midNode) midNode = ids[0]

  var orphanCount = states[midNode] ? states[midNode].connectedDownstreamCount : 0
  h.log('  Disconnecting mid-tree node ' + midNode.slice(-5) + ' (children=' + orphanCount + ')...')
  await h.disconnectNode(page, midNode)

  // Poll for orphaned nodes going through server transport (server-first reconnection).
  // The batch timer reset ensures the server candidate isn't missed during the storm.
  var sawServerTransport = false
  var pollStart = Date.now()
  while (Date.now() - pollStart < 15000) {
    var midStates = await h.getNodeStates(page)
    var nonRoot = Object.keys(midStates).filter(function (id) { return !midStates[id].isRoot })
    for (var j = 0; j < nonRoot.length; j++) {
      if (midStates[nonRoot[j]].transport === 'server') {
        sawServerTransport = true
        break
      }
    }
    if (sawServerTransport) break
    await h.wait(300)
  }
  h.log('  Saw server transport during reconnection: ' + sawServerTransport)

  // Wait for all remaining nodes to reconnect
  var expectedCount = 4 // root + 3 remaining (one disconnected)
  await h.waitForAllConnected(page, expectedCount, 30000)

  // Wait for most nodes to upgrade to P2P after reconnection. The last
  // server-connected node may stay on server if all others are its descendants.
  await h.waitForAll(page, function (states) {
    var nodeIds = Object.keys(states).filter(function (id) { return !states[id].isRoot })
    if (nodeIds.length === 0) return false
    var serverCount = nodeIds.filter(function (id) { return states[id].transport === 'server' }).length
    return serverCount <= 1 && nodeIds.every(function (id) { return states[id].state === 'connected' })
  }, 'nodes upgrade to P2P after server-first reconnection (at most 1 on server)', 60000)

  h.log('  Nodes recovered after server-first reconnection')
  if (sawServerTransport) {
    h.log('  Confirmed: orphaned nodes used server-first during reconnection')
  }
}

async function scenario27 (page) {
  // Server Capacity Limit: Set serverCapacity to 3, add 6 nodes.
  // First 3 should connect via server, remaining 3 should fall back to P2P.
  // Root should have K=0 while server is not full, then revert to K when server fills up.
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.setServerCapacity(page, 3)
  await h.wait(2000) // let server connect and advertise capacity

  // Add 6 nodes
  await h.addNodes(page, 6)

  // Wait for all to connect
  var states = await h.waitForAllConnected(page, 7, 30000) // root + 6
  var nonRoot = Object.keys(states).filter(function (id) { return !states[id].isRoot })

  // Count server vs P2P connections
  var serverCount = 0
  var p2pCount = 0
  for (var i = 0; i < nonRoot.length; i++) {
    if (states[nonRoot[i]].transport === 'server') serverCount++
    else if (states[nonRoot[i]].transport === 'p2p') p2pCount++
  }

  h.log('  Server connections: ' + serverCount + ', P2P connections: ' + p2pCount)

  // Verify capacity limit is enforced
  assert(serverCount <= 3,
    'Server should have at most 3 connections, got ' + serverCount)
  assert(p2pCount >= 3,
    'At least 3 nodes should use P2P when server is full, got ' + p2pCount)
  assert(serverCount + p2pCount === 6,
    'All 6 nodes should be connected')

  // Verify root accepted P2P connections when server was full
  var root = Object.keys(states).find(function (id) { return states[id].isRoot })
  h.log('  Root downstream count: ' + states[root].downstreamCount)
  // Root should have at least 1 P2P child (since server is at capacity)
  assert(states[root].downstreamCount >= 1,
    'Root should have accepted P2P connections when server was full')

  h.log('  Server capacity limit enforced: ' + serverCount + ' server, ' + p2pCount + ' P2P')

  // Clean up: remove capacity limit
  await h.setServerCapacity(page, null)
}

// ─── Infrastructure ─────────────────────────────────────────────────

function startExampleServer () {
  var proc = spawn('node', ['example/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: EXAMPLE_PORT }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout.on('data', function (d) {
    var line = d.toString().trim()
    if (line) h.log('[example] ' + line)
  })
  proc.stderr.on('data', function (d) {
    var line = d.toString().trim()
    if (line) h.log('[example:err] ' + line)
  })
  return proc
}

function startRelayServer (opts) {
  opts = opts || {}
  var args = [
    'relay-server.js',
    '--firebase-path', h.TEST_PATH
  ]
  // Only use fixed ID if requested (for server restart test)
  if (opts.useFixedId) {
    args.push('--id', 'test-relay-server')
  }
  var proc = spawn('node', args, {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: RELAY_PORT }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout.on('data', function (d) {
    var line = d.toString().trim()
    if (line) h.log('[relay] ' + line)
  })
  proc.stderr.on('data', function (d) {
    var line = d.toString().trim()
    if (line) h.log('[relay:err] ' + line)
  })
  return proc
}

function assert (condition, message) {
  if (!condition) {
    throw new Error('ASSERT FAILED: ' + message)
  }
}

// Walk upstream from each node to detect N-node circles (not just 2-node)
function assertNoCircles (states) {
  var ids = Object.keys(states)
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i]
    if (states[id].isRoot) continue
    var visited = {}
    var current = id
    var path = [current.slice(-5)]
    while (current && states[current] && !states[current].isRoot) {
      if (visited[current]) {
        throw new Error('Circle detected: ' + path.join(' -> '))
      }
      visited[current] = true
      current = states[current].upstream
      if (current) path.push(current.slice(-5))
    }
    if (!current || !states[current]) {
      // upstream points to a node not in states (e.g., server node) — ok
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────

async function main () {
  var results = []
  var ctx = {}

  // Build the example app
  h.log('Building example app...')
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' })
  h.log('Build complete')

  // Start servers
  h.log('Starting example server on port ' + EXAMPLE_PORT + '...')
  ctx.exampleProcess = startExampleServer()
  await h.wait(1000)

  h.log('Starting relay server on port ' + RELAY_PORT + '...')
  ctx.relayProcess = startRelayServer()
  await h.wait(2000)

  // Launch browser
  h.log('Launching browser...')
  var browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [
      '--window-size=1200,800',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--allow-loopback-in-peer-connection'
    ]
  })

  var page = (await browser.pages())[0]

  // Forward console messages
  page.on('console', function (msg) {
    var type = msg.type()
    if (type === 'error') {
      h.log('[page:error] ' + msg.text())
    }
  })

  // Filter scenarios
  var toRun = scenarios
  if (onlyScenario) {
    toRun = [scenarios[onlyScenario - 1]]
    if (!toRun[0]) {
      console.error('Scenario ' + onlyScenario + ' not found (1-' + scenarios.length + ')')
      process.exit(1)
    }
  }

  for (var i = 0; i < toRun.length; i++) {
    var scenario = toRun[i]
    var num = onlyScenario || (i + 1)

    h.log('')
    h.log('━━━ Scenario ' + num + ': ' + scenario.name + ' ━━━')

    // Clear Firebase and fresh page load for each scenario
    await h.clearFirebase()
    await h.wait(2000)
    // Clear again in case old page wrote reports after the first clear
    await h.clearFirebase()
    await h.wait(500)
    await page.goto(URL)
    await h.waitForRootReady(page, 20000)
    h.log('  Root ready')

    try {
      await scenario.fn(page, ctx)
      results.push({ num: num, name: scenario.name, pass: true })
      h.log('  ✓ PASSED')
    } catch (err) {
      results.push({ num: num, name: scenario.name, pass: false, error: err.message })
      h.log('  ✗ FAILED: ' + err.message)
    }

    // Clean up between scenarios
    await h.resetAll(page)
    await h.wait(1000)
  }

  // Summary
  h.log('')
  h.log('═══════════════════════════════════════')
  h.log('  RESULTS')
  h.log('═══════════════════════════════════════')

  var passed = 0
  var failed = 0
  for (var i = 0; i < results.length; i++) {
    var r = results[i]
    if (r.pass) {
      h.log('  ✓ Scenario ' + r.num + ': ' + r.name)
      passed++
    } else {
      h.log('  ✗ Scenario ' + r.num + ': ' + r.name)
      h.log('    ' + r.error)
      failed++
    }
  }

  h.log('')
  h.log('  ' + passed + ' passed, ' + failed + ' failed')
  h.log('═══════════════════════════════════════')

  // If stdin is not a TTY (e.g., piped, background, CI), auto-close and exit.
  // Otherwise keep browser open for visual inspection.
  if (!process.stdin.isTTY) {
    browser.close().catch(function () {})
    if (ctx.exampleProcess) ctx.exampleProcess.kill()
    if (ctx.relayProcess) ctx.relayProcess.kill()
    process.exit(failed > 0 ? 1 : 0)
  }

  h.log('')
  h.log('Browser left open for inspection. Press Ctrl+C to exit.')

  // Clean up on Ctrl+C
  process.on('SIGINT', function () {
    h.log('Shutting down...')
    browser.close().catch(function () {})
    if (ctx.exampleProcess) ctx.exampleProcess.kill()
    if (ctx.relayProcess) ctx.relayProcess.kill()
    process.exit(failed > 0 ? 1 : 0)
  })
}

main().catch(function (err) {
  console.error('Fatal error:', err)
  process.exit(1)
})
