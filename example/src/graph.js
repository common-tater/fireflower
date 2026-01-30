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

    // Draw connection line from server to root
    var scale = isRetina ? 2 : 1
    this.context.beginPath()
    this.context.moveTo(root.x * scale, root.y * scale)
    this.context.lineTo(this.serverNode.x * scale, this.serverNode.y * scale)
    this.context.lineWidth = 2 * window.devicePixelRatio
    this.context.lineCap = 'round'
    this.context.strokeStyle = 'rgba(68, 221, 68, 0.7)'
    this.context.stroke()
  }

  for (var i in this.nodes) {
    var node = this.nodes[i]
    node.model.K = this.K

    if (!node.el.parentNode) {
      this.nodesEl.appendChild(node.el)
    }

    node.render()
  }
}

GraphView.prototype._watchServerNode = function (path) {
  var self = this
  var db = firebaseInit.getDb()
  var reportsRef = ref(db, path + '/reports')

  onValue(reportsRef, function (snapshot) {
    var reports = snapshot.val()
    if (!reports) {
      self._removeServerNode()
      return
    }

    var now = Date.now()
    var foundServer = false

    for (var id in reports) {
      var report = reports[id]
      if (report.isServer && report.timestamp && (now - report.timestamp) < 10000) {
        foundServer = true
        if (!self.serverNode || self.serverNode.serverId !== id) {
          self._removeServerNode()
          var el = document.createElement('div')
          el.className = 'node server-node'
          el.innerHTML = '<div id="circle"></div><div id="label">SERVER</div><div id="status"></div>'
          self.serverNode = {
            el: el,
            serverId: id,
            x: 120,
            y: 0,
            report: report,
            render: function () {
              this.el.style.left = this.x + 'px'
              this.el.style.top = this.y + 'px'
            }
          }
        }
        // Update report data each tick
        self.serverNode.report = report
        var statusEl = self.serverNode.el.querySelector('#status')
        var level = report.level != null ? report.level : '?'
        var transport = report.transport || '?'
        var health = report.health
        var scoreText = health ? ' \u2764 ' + health.score : ''
        statusEl.textContent = 'L' + level + ' ' + transport + scoreText
        break
      }
    }

    if (!foundServer) {
      self._removeServerNode()
    }

    self.render()
  })
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
