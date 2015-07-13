module.exports = Blacklist

function Blacklist () {
  this._list = {}
}

Blacklist.prototype.add = function (id) {
  this._list[id] = true
}

Blacklist.prototype.remove = function (id) {
  if (id) {
    delete this._list[id]
  } else {
    this._list = {}
  }
}

Blacklist.prototype.contains = function (id) {
  return this._list[id]
}
