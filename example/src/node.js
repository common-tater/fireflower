module.exports = NodeView

var isRetina = window.devicePixelRatio > 1

function healthColor (score, alpha) {
  if (alpha == null) alpha = 0.9
  if (score >= 80) return 'rgba(68, 204, 68, ' + alpha + ')'    // green
  if (score >= 50) return 'rgba(255, 140, 25, ' + alpha + ')'   // orange
  if (score >= 20) return 'rgba(255, 204, 0, ' + alpha + ')'    // yellow
  return 'rgba(255, 68, 68, ' + alpha + ')'                      // red
}

function NodeView (graph, model) {
  this.graph = graph
  this.model = model
  this.model.on('statechange', this.graph.render.bind(this.graph))

  this.id = this.model.id
  this.x = 0
  this.y = 0
  this.width = 30
  this.height = 30

  this.el = document.createElement('div')
  this.el.className = 'node'
  this.el.innerHTML = '<div id="circle"><span id="score"></span></div><div id="label"></div>'
  this.el.querySelector('#circle').addEventListener('click', this.destroy.bind(this))
}

NodeView.prototype.render = function () {
  var self = this
  var ctx = this.graph.context
  var upstreamId = this.model.upstream && this.model.upstream.id
  var upstream = this.graph.nodes[upstreamId]
  if (!upstream && this.graph.serverNode && this.graph.serverNode.serverId === upstreamId) {
    upstream = this.graph.serverNode
  }
  var scale = isRetina ? 2 : 1

  this.el.setAttribute('data-id', this.id)
  var transport = this.model.transport
  this.el.querySelector('#label').textContent = this.id + (transport === 'server' ? ' [S]' : '')
  this.el.classList.toggle('server-transport', transport === 'server')

  // Health score display and coloring
  var score = typeof this.model._getHealthScore === 'function' ? this.model._getHealthScore() : null
  var isRoot = this.graph.root === this
  var circleEl = this.el.querySelector('#circle')
  var scoreEl = this.el.querySelector('#score')
  if (score != null && this.model.state === 'connected') {
    scoreEl.textContent = score
    circleEl.style.backgroundColor = healthColor(score, 0.3)
    // Root keeps white border for identity; peers get health-colored border
    if (!isRoot) {
      circleEl.style.borderColor = healthColor(score)
    }
  } else {
    scoreEl.textContent = ''
    circleEl.style.borderColor = ''
    circleEl.style.backgroundColor = ''
  }

  this.x = Math.min(this.x, this.graph.width)
  this.y = Math.min(this.y, this.graph.height)
  this.el.style.left = this.x + 'px'
  this.el.style.top = this.y + 'px'

  if (upstream) {
    ctx.beginPath()
    ctx.moveTo(upstream.x * scale, upstream.y * scale)
    ctx.lineTo(self.x * scale, self.y * scale)
    ctx.lineWidth = 2 * window.devicePixelRatio
    ctx.lineCap = 'round'
    ctx.strokeStyle = transport === 'server' ? 'rgba(0, 206, 209, 0.7)' : 'rgba(104, 104, 104, 0.5)'
    ctx.stroke()
  }
}

NodeView.prototype.destroy = function () {
  if (this.graph.root === this) return

  if (this.el.parentNode) {
    this.el.parentNode.removeChild(this.el)
  }

  this.graph.remove(this)
  this.model.disconnect()
  this.graph.render()
}
