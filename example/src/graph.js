module.exports = GraphView

var fireflower = null
var firebaseInit = require('../firebase-init')
var { ref, onValue } = require('firebase/database')
var NodeView = require('./node')
var isRetina = window.devicePixelRatio > 1

function GraphView (path, root) {
  // Initialize fireflower with the centralized database instance
  if (!fireflower) {
    fireflower = require('../../')(firebaseInit.getDb())
  }

  this.path = path
  this.el = document.querySelector('#graph')
  this.nodesEl = this.el.querySelector('#nodes')
  this.canvas = this.el.querySelector('canvas')
  this.context = this.canvas.getContext('2d')
  this.nodes = {}
  this.serverNode = null

  this.root = new NodeView(this, root)
  this.root.el.classList.add('root')
  this.nodes[this.root.id] = this.root

  if (isRetina) {
    this.context.scale(2, 2)
  }

  this.nodesEl.addEventListener('click', this._onclick.bind(this))
  window.addEventListener('resize', this.render.bind(this))

  // Watch Firebase reports for server node
  this._watchServerNode(path)

  // Listen for local neighborhood events to visualize peers we know about
  // even if we aren't the global root.
  var self = this

  // 1. Downstream peers connecting to us
  // Defer briefly so Firebase has time to identify the server node,
  // preventing a gray flash before _updateServerNode runs.
  root.on('peerconnect', function (peer) {
    setTimeout(function () {
      if (self.nodes[peer.id]) return
      if (self.serverNode && self.serverNode.serverId === peer.id) return

      // The relay server peer is tagged _isServerPeer in _onrequest —
      // skip it here, _updateServerNode handles the green SERVER element.
      if (peer._isServerPeer) return

      // Check Firebase reports directly — the serverNode element may not
      // have the serverId set yet (still in "connecting..." state)
      if (self._serverReports) {
        for (var rid in self._serverReports) {
          if (rid === peer.id && self._serverReports[rid].isServer) return
        }
      }

      console.log('Visualizing downstream peer:', peer.id)
      var remoteModel = new RemotePeerModel(peer, { upstream: root })
      var nodeView = new NodeView(self, remoteModel)

      nodeView.x = self.width / 2 + (Math.random() * 200 - 100)
      nodeView.y = self.height / 2 + 150

      self.nodes[peer.id] = nodeView
      self.render()
    }, 500)
  })

  // 2. Downstream peers disconnecting
  root.on('peerdisconnect', function (peer) {
    var nodeView = self.nodes[peer.id]
    // Only remove if it's a remote model (don't remove locally created nodes)
    if (nodeView && nodeView.model instanceof RemotePeerModel) {
      console.log('Removing downstream peer visualization:', peer.id)
      nodeView.destroy()
    }
  })

  // 3. Upstream connection (our parent)
  root.on('connect', function (peer) {
    if (!peer) return // connected as root
    if (self.nodes[peer.id]) return
    // Skip if this is the server node (already shown as green SERVER element)
    if (self.serverNode && self.serverNode.serverId === peer.id) return

    console.log('Visualizing upstream peer:', peer.id)
    // For upstream, WE are the downstream
    var remoteModel = new RemotePeerModel(peer, { upstream: null })
    var nodeView = new NodeView(self, remoteModel)

    // Position upstream node above the local node
    nodeView.x = self.width / 2
    nodeView.y = self.height / 2 - 150

    self.nodes[peer.id] = nodeView
    self.render()
  })
}

GraphView.prototype.render = function () {
  this.width = window.innerWidth
  this.height = window.innerHeight

  this.canvas.width = isRetina ? this.width * 2 : this.width
  this.canvas.height = isRetina ? this.height * 2 : this.height
  this.context.clearRect(0, 0, this.canvas.width, this.canvas.height)

  var root = this.root = this.nodes[this.root.id]
  root.x = this.width / 2
  root.y = this.height / 2

  // Position server node at fixed location and draw connection to root
  if (this.serverNode) {
    this.serverNode.x = 120
    this.serverNode.y = this.height / 2

    if (!this.serverNode.el.parentNode) {
      this.nodesEl.appendChild(this.serverNode.el)
    }
    this.serverNode.render()

    // Draw connection line from server to root (only when online)
    if (!this.serverNode.offline) {
      var scale = isRetina ? 2 : 1
      this.context.beginPath()
      this.context.moveTo(root.x * scale, root.y * scale)
      this.context.lineTo(this.serverNode.x * scale, this.serverNode.y * scale)
      this.context.lineWidth = 2 * window.devicePixelRatio
      this.context.lineCap = 'round'
      this.context.strokeStyle = 'rgba(68, 221, 68, 0.7)'
      this.context.stroke()
    }
  }

  for (var i in this.nodes) {
    var node = this.nodes[i]
    if (this.K != null) node.model.K = this.K

    if (!node.el.parentNode) {
      this.nodesEl.appendChild(node.el)
    }

    node.render()
  }

  this.updateOverlay()
}

GraphView.prototype.updateOverlay = function () {
  var nodeCount = Object.keys(this.nodes).length
  var p2pCount = 0
  var serverCount = 0

  for (var id in this.nodes) {
    var node = this.nodes[id]
    var model = node.model
    if (model.state !== 'connected') continue
    if (model.transport === 'server') {
      serverCount++
    } else if (model.upstream) {
      p2pCount++
    }
  }

  var statNodes = document.getElementById('stat-nodes')
  var statP2p = document.getElementById('stat-p2p')
  var statServer = document.getElementById('stat-server')
  if (statNodes) statNodes.textContent = nodeCount
  if (statP2p) statP2p.textContent = p2pCount
  if (statServer) statServer.textContent = serverCount
}

GraphView.prototype._watchServerNode = function (path) {
  var self = this
  var db = firebaseInit.getDb()
  var reportsRef = ref(db, path + '/reports')
  var serverEnabledRef = ref(db, path + '/configuration/serverEnabled')
  var serverUrlRef = ref(db, path + '/configuration/serverUrl')

  // Track config state — start false until Firebase responds
  this._serverEnabled = false
  this._serverUrl = null  // set by relay server on connect, removed on disconnect
  this._serverReports = null

  onValue(serverEnabledRef, function (snapshot) {
    var enabled = snapshot.val()
    self._serverEnabled = enabled !== false
    self._updateServerNode()
  })

  // serverUrl is the reliable online signal — relay server writes it on
  // connect, removes it on disconnect, and uses onDisconnect() for crash cleanup
  onValue(serverUrlRef, function (snapshot) {
    self._serverUrl = snapshot.val() || null
    self._updateServerNode()
  })

  onValue(reportsRef, function (snapshot) {
    self._serverReports = snapshot.val()
    self._updateServerNode()
  })
}

GraphView.prototype._updateServerNode = function () {
  var reports = this._serverReports
  var serverEnabled = this._serverEnabled
  var serverOnline = !!this._serverUrl  // serverUrl present = relay server is alive

  // Find server report for status display (level, health, etc.)
  var bestServer = null
  if (reports && serverOnline) {
    var bestTimestamp = 0
    for (var id in reports) {
      var report = reports[id]
      if (report.isServer && report.timestamp) {
        if (report.timestamp > bestTimestamp) {
          bestTimestamp = report.timestamp
          bestServer = { id: id, report: report }
        }
      }
    }
  }

  if (serverOnline && bestServer) {
    // Server is online with report data
    var sid = bestServer.id
    var sreport = bestServer.report
    if (!this.serverNode || this.serverNode.serverId !== sid || this.serverNode.offline) {
      this._removeServerNode()
      this._createServerNodeEl(sid, false)
    }
    // Remove any gray RemotePeerModel duplicate (peerconnect may have fired
    // before Firebase identified this peer as the server node)
    if (this.nodes[sid] && this.nodes[sid].model instanceof RemotePeerModel) {
      this.nodes[sid].destroy()
      delete this.nodes[sid]
    }
    this.serverNode.report = sreport
    var statusEl = this.serverNode.el.querySelector('#status')
    var level = sreport.level != null ? sreport.level : '?'
    var transport = sreport.transport || '?'
    var health = sreport.health
    var scoreText = health ? ' \u2764 ' + health.score : ''
    statusEl.textContent = 'L' + level + ' ' + transport + scoreText
  } else if (serverOnline) {
    // Server URL present but no report yet — show green, connecting
    if (!this.serverNode || this.serverNode.offline) {
      this._removeServerNode()
      this._createServerNodeEl(null, false)
    }
    var connectingStatus = this.serverNode.el.querySelector('#status')
    connectingStatus.textContent = 'connecting...'
  } else if (serverEnabled) {
    // Server enabled but offline — show red indicator
    if (!this.serverNode || !this.serverNode.offline) {
      this._removeServerNode()
      this._createServerNodeEl(null, true)
    }
    var offlineStatus = this.serverNode.el.querySelector('#status')
    offlineStatus.textContent = 'OFFLINE'
  } else {
    // Server disabled — hide it
    this._removeServerNode()
  }

  if (this.width) this.render()
}

GraphView.prototype._createServerNodeEl = function (serverId, offline) {
  var el = document.createElement('div')
  el.className = 'node server-node' + (offline ? ' server-offline' : '')
  el.innerHTML = '<div id="circle"></div><div id="label">SERVER</div><div id="status"></div>'
  this.serverNode = {
    el: el,
    serverId: serverId,
    offline: offline,
    x: 120,
    y: 0,
    report: null,
    render: function () {
      this.el.style.left = this.x + 'px'
      this.el.style.top = this.y + 'px'
    }
  }
}

GraphView.prototype._removeServerNode = function () {
  if (this.serverNode && this.serverNode.el.parentNode) {
    this.serverNode.el.parentNode.removeChild(this.serverNode.el)
  }
  this.serverNode = null
}

GraphView.prototype.add = function (opts) {
  var nodeOpts = { reportInterval: 2500, K: this.K || 2 }
  if (opts) {
    for (var k in opts) nodeOpts[k] = opts[k]
  }
  var model = fireflower(this.path, nodeOpts).connect()
  var node = new NodeView(this, model)
  this.nodes[node.id] = node
  return node
}

GraphView.prototype.remove = function (node) {
  delete this.nodes[node.id]
}

GraphView.prototype._onclick = function (evt) {
  if (evt.target !== this.nodesEl) return

  var opts = {}
  if (this.forceServer) {
    opts.serverOnly = true
  }
  var node = this.add(opts)
  node.x = evt.clientX
  node.y = evt.clientY

  this.render()
}

// --- RemotePeerModel ---
// Minimal implementation of the fireflower node interface for remote peers
function RemotePeerModel (peer, opts) {
  this.id = peer.id
  this.state = 'connected'
  this.transport = peer.transport || 'p2p' // assume p2p unless told otherwise
  this.upstream = opts.upstream || null
  this.downstream = {}
  this.opts = opts

  // Minimal event emitter
  this._listeners = {}
}

RemotePeerModel.prototype.on = function (event, cb) {
  if (!this._listeners[event]) this._listeners[event] = []
  this._listeners[event].push(cb)
}

RemotePeerModel.prototype.emit = function (event, data) {
  if (this._listeners[event]) {
    this._listeners[event].forEach(function (cb) { cb(data) })
  }
}

RemotePeerModel.prototype.disconnect = function () {
  this.state = 'disconnected'
  this.emit('statechange')
}
