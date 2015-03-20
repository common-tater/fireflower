var test = require('tape')
var Firebase = require('firebase')
var FireFlower = require('../')

process.env = require('./env.json')

var db = new Firebase(process.env.FIREBASE_URL)

test('auth with secret', function (t) {
  t.plan(2)

  db.authWithCustomToken(process.env.FIREBASE_SECRET, function (err, auth) {
    t.error(err)
    t.equal(auth.provider, 'custom')
  })
})

test('unauth', function (t) {
  t.plan(1)

  db.onAuth(onauth)
  db.unauth()

  function onauth () {
    db.offAuth(onauth)
    t.pass()
  }
})

test('set first broadcaster', function (t) {
  t.plan(1)

  var fireflower = new FireFlower(process.env.FIREBASE_URL, 3)

  var broadcasterId = 0
  fireflower.setBroadcaster(broadcasterId)
  db.child('available_peers/' + broadcasterId).once('value', function (snapshot) {
    t.equal(snapshot.val().id, broadcasterId)
  })
})
