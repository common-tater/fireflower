var firebaseInit = require('../example/firebase-init')
var firebaseConfig = require('../example/firebase-config')
var { ref, remove, set } = require('firebase/database')

var _firebase = null
function getDb () {
  if (!_firebase) {
    _firebase = firebaseInit.init(firebaseConfig)
  }
  return _firebase.db
}

const TEST_PATH = 'test-tree'  // isolated Firebase path for tests
const STEP_DELAY = 3000  // delay between adding nodes (ms)
const POLL_INTERVAL = 500 // how often to check state (ms)
const DEFAULT_TIMEOUT = 30000 // max wait time for assertions (ms)

function wait (ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms) })
}

function log (msg) {
  var ts = new Date().toISOString().slice(11, 19)
  console.log('[' + ts + '] ' + msg)
}

async function addNodes (page, count, opts) {
  var ids = []
  for (var i = 0; i < count; i++) {
    var id = await page.evaluate(function (opts) {
      var node = window.graph.add(opts || {})
      // Position randomly in the visible area
      node.x = 200 + Math.random() * (window.innerWidth - 300)
      node.y = 100 + Math.random() * (window.innerHeight - 200)
      window.graph.render()
      return node.id
    }, opts || null)
    ids.push(id)
    log('  Added node ' + id.slice(-5) + ' (' + (i + 1) + '/' + count + ')')
    if (i < count - 1) await wait(STEP_DELAY)
  }
  return ids
}

async function getNodeStates (page) {
  return page.evaluate(function () {
    var result = {}
    var graph = window.graph
    if (!graph) return result

    // Root node
    var root = graph.root
    if (root && root.model) {
      result[root.id] = {
        id: root.id,
        state: root.model.state,
        transport: root.model.transport || null,
        upstream: root.model.upstream ? root.model.upstream.id : null,
        downstreamCount: Object.keys(root.model.downstream || {}).length,
        isRoot: true
      }
    }

    // All other nodes
    for (var id in graph.nodes) {
      if (result[id]) continue // skip root
      var node = graph.nodes[id]
      if (!node || !node.model) continue
      result[id] = {
        id: id,
        state: node.model.state,
        transport: node.model.transport || null,
        upstream: node.model.upstream ? node.model.upstream.id : null,
        downstreamCount: Object.keys(node.model.downstream || {}).length,
        isRoot: false
      }
    }
    return result
  })
}

async function waitForAll (page, predicate, message, timeout) {
  timeout = timeout || DEFAULT_TIMEOUT
  var start = Date.now()
  var lastStates = null

  while (Date.now() - start < timeout) {
    var states = await getNodeStates(page)
    lastStates = states
    var ids = Object.keys(states)
    if (ids.length > 0 && predicate(states)) {
      return states
    }
    await wait(POLL_INTERVAL)
  }

  // Timeout — build error message
  var detail = ''
  if (lastStates) {
    for (var id in lastStates) {
      var s = lastStates[id]
      detail += '\n    ' + id.slice(-5) + ': state=' + s.state + ' transport=' + s.transport + ' upstream=' + (s.upstream ? s.upstream.slice(-5) : 'none')
    }
  }
  throw new Error('Timeout: ' + (message || 'waitForAll') + detail)
}

async function waitForAllConnected (page, expectedCount, timeout) {
  return waitForAll(page, function (states) {
    var ids = Object.keys(states)
    if (expectedCount && ids.length < expectedCount) return false
    for (var i = 0; i < ids.length; i++) {
      if (states[ids[i]].state !== 'connected') return false
    }
    return true
  }, 'all nodes connected (expected ' + (expectedCount || '?') + ')', timeout)
}

async function setServerEnabled (page, enabled) {
  log('  Setting serverEnabled=' + enabled)
  await page.evaluate(function (enabled) {
    var checkbox = document.querySelector('#server-toggle input')
    if (checkbox.checked !== enabled) {
      checkbox.checked = enabled
      checkbox.dispatchEvent(new Event('change'))
    }
  }, enabled)
}

async function setForceServer (page, enabled) {
  log('  Setting forceServer=' + enabled)
  await page.evaluate(function (enabled) {
    var checkbox = document.querySelector('#force-server-toggle input')
    if (checkbox.checked !== enabled) {
      checkbox.checked = enabled
      checkbox.dispatchEvent(new Event('change'))
    }
  }, enabled)
}

async function setK (page, value) {
  log('  Setting K=' + value)
  await page.evaluate(function (value) {
    var input = document.querySelector('#k-number input')
    input.value = value
    input.dispatchEvent(new Event('change'))
  }, value)
}

async function disconnectNode (page, nodeId) {
  log('  Disconnecting node ' + nodeId.slice(-5))
  await page.evaluate(function (nodeId) {
    var node = window.graph.nodes[nodeId]
    if (node) {
      node.model.disconnect()
      window.graph.remove(node)
      if (node.el.parentNode) node.el.parentNode.removeChild(node.el)
    }
  }, nodeId)
}

async function reconnectNode (page, nodeId) {
  await page.evaluate(function (nodeId) {
    var node = window.graph.nodes[nodeId]
    if (node) node.model.connect()
  }, nodeId)
}

async function resetAll (page) {
  log('  Resetting...')
  // Click the Reset button which disconnects root and clears Firebase data
  await page.evaluate(function () {
    var btn = document.querySelector('#reset-btn')
    if (btn) btn.click()
  })
  await wait(500)
  // Also clear Firebase from Node.js side to ensure clean state
  await clearFirebase()
  await wait(1000)
}

async function clearFirebase () {
  var db = getDb()
  await Promise.all([
    remove(ref(db, TEST_PATH + '/reports')),
    remove(ref(db, TEST_PATH + '/requests'))
  ])
  // Set serverEnabled=false so relay server doesn't interfere during page load
  await set(ref(db, TEST_PATH + '/configuration/serverEnabled'), false)
  await set(ref(db, TEST_PATH + '/configuration/serverOnly'), false)
}

async function clearFirebaseRequests () {
  var db = getDb()
  await remove(ref(db, TEST_PATH + '/requests'))
}

async function waitForRootReady (page, timeout) {
  timeout = timeout || 15000
  var start = Date.now()
  while (Date.now() - start < timeout) {
    var ready = await page.evaluate(function () {
      return !!(window.root && window.root.state === 'connected' && window.graph)
    })
    if (ready) return
    await wait(POLL_INTERVAL)
  }
  throw new Error('Timeout: root node not ready')
}

module.exports = {
  wait: wait,
  log: log,
  addNodes: addNodes,
  getNodeStates: getNodeStates,
  waitForAll: waitForAll,
  waitForAllConnected: waitForAllConnected,
  setServerEnabled: setServerEnabled,
  setForceServer: setForceServer,
  setK: setK,
  disconnectNode: disconnectNode,
  reconnectNode: reconnectNode,
  resetAll: resetAll,
  clearFirebase: clearFirebase,
  clearFirebaseRequests: clearFirebaseRequests,
  waitForRootReady: waitForRootReady,
  STEP_DELAY: STEP_DELAY,
  TEST_PATH: TEST_PATH
}
