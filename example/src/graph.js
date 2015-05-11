module.exports = GraphView

var fireflower = require('../../')(require('firebase'))
var NodeView = require('./node')
var isRetina = window.devicePixelRatio > 1

function GraphView (url, root) {
  this.url = url
  this.el = document.querySelector('#graph')
  this.nodesEl = this.el.querySelector('#nodes')
  this.canvas = this.el.querySelector('canvas')
  this.context = this.canvas.getContext('2d')
  this.nodes = {}

  this.root = new NodeView(this, root)
  this.root.el.classList.add('root')
  this.nodes[this.root.id] = this.root

  if (isRetina) {
    this.context.scale(2, 2)
  }

  this.nodesEl.addEventListener('click', this._onclick.bind(this))
  window.addEventListener('resize', this.render.bind(this))
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

  for (var i in this.nodes) {
    var node = this.nodes[i]

    if (!node.el.parentNode) {
      this.nodesEl.appendChild(node.el)
    }

    node.render()
  }
}

GraphView.prototype.add = function () {
  var model = fireflower(this.url).connect()
  var node = new NodeView(this, model)
  this.nodes[node.id] = node
  return node
}

GraphView.prototype.remove = function (node) {
  delete this.nodes[node.id]
}

GraphView.prototype._onclick = function (evt) {
  if (evt.target !== this.nodesEl) return

  var node = this.add()
  node.x = evt.x
  node.y = evt.y

  this.render()
}
