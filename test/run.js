#!/usr/bin/env node

var puppeteer = require('puppeteer')
var { spawn, execSync } = require('child_process')
var path = require('path')
var h = require('./helpers')

var ROOT = path.join(__dirname, '..')
var EXAMPLE_PORT = 8080
var RELAY_PORT = 8082
var URL = 'http://localhost:' + EXAMPLE_PORT

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
  { name: 'Server Restart Recovery', fn: scenario11 },
  { name: 'Disconnect All & Reconnect', fn: scenario12 }
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

  await h.addNodes(page, 3)
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
  // Server Restart Recovery
  await h.setK(page, 2)
  await h.setServerEnabled(page, true)
  await h.wait(2000)
  await h.setForceServer(page, true)
  await h.wait(1000)

  await h.addNodes(page, 3)
  await h.waitForAllConnected(page, 4)
  h.log('  Nodes connected via server, killing relay server...')

  // Kill relay server
  if (ctx.relayProcess) {
    ctx.relayProcess.kill('SIGTERM')
    await h.wait(3000)
  }

  // Restart relay server
  h.log('  Restarting relay server...')
  ctx.relayProcess = startRelayServer()
  await h.wait(5000) // let server reconnect

  // Nodes should recover
  await h.waitForAllConnected(page, 4, 30000)
  h.log('  Nodes recovered after server restart')
  await h.setForceServer(page, false)
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

function startRelayServer () {
  var proc = spawn('node', ['relay-server.js'], {
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
    args: ['--window-size=1200,800']
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

  // Keep browser open for inspection
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
