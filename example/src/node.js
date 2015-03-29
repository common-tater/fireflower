module.exports = NodeView

var hyperglue = require('hyperglue2')
var isRetina = window.devicePixelRatio > 1

function NodeView (graph, model) {
  this.graph = graph
  this.model = model
  this.model.on('statechange', this.graph.render.bind(this.graph))

  this.id = this.model.id
  this.x = 0
  this.y = 0
  this.width = 30
  this.height = 30

  this.el = hyperglue('<div class="node"><div id="circle"></div><div id="label"></div></div>')
  this.el.querySelector('#circle').addEventListener('click', this.destroy.bind(this))
}

NodeView.prototype.render = function () {
  var self = this
  var ctx = this.graph.context
  var upstream = this.graph.nodes[this.model.root && this.model.root.id]
  var scale = isRetina ? 2 : 1

  hyperglue(this.el, {
    _attr: {
      'data-id': this.id
    },
    '#label': { _html: this.id + '<br>' + this.model.branch }
  })

  this.x = Math.min(this.x, this.graph.width)
  this.y = Math.min(this.y, this.graph.height)
  this.el.style.left = this.x + 'px'
  this.el.style.top = this.y + 'px'

  if (upstream) {
    ctx.beginPath()
    ctx.moveTo(upstream.x * scale, upstream.y * scale)
    ctx.lineTo(self.x * scale, self.y * scale)
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(104, 104, 104, 0.5)'
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
