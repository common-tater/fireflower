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

test('set broadcaster', function (t) {
  t.plan(1)

  var testBroadcasterId = 'test_broadcaster'

  var fireflower = new FireFlower(process.env.FIREBASE_URL, 3, testBroadcasterId)
  fireflower.setBroadcaster(testBroadcasterId)
  db.child('available_peers/' + testBroadcasterId).once('value', function (snapshot) {
    t.equal(snapshot.val().id, testBroadcasterId)
    // remove this broadcaster to reset
    db.child('available_peers' + testBroadcasterId).remove()
  })
})

test('set broadcaster and subscribe with first listener', function (t) {
  t.plan(3)

  var broadcasterId = 'test_broadcaster'
  var broadcasterFireFlower = new FireFlower(process.env.FIREBASE_URL, 3, broadcasterId)
  broadcasterFireFlower.setBroadcaster(broadcasterId)
  var broadcasterRef = null

  var listenerId = 'test_listener'
  var listenerFireFlower = new FireFlower(process.env.FIREBASE_URL, 3, listenerId)
  var listenerRef = null
  // todo: do we need to make this have a callback so our tests below don't
  // check too early?
  listenerFireFlower.subscribe(broadcasterId)

  // check that there are only two, and no other available peers
  db.child('available_peers').once('value', function (snapshot) {
    t.equal(snapshot.numChildren(), 2)

    // check to see that the broadcaster is in the available peers pool
    db.child('available_peers/' + broadcasterId).once('value', function (snapshot) {
      if (snapshot.val() === null) {
        t.error('broadcaster not available')
      } else {
        broadcasterRef = snapshot.ref()
        t.equal(snapshot.val().peerId, broadcasterId)
        // cleanup
        broadcasterRef.remove()
      }
    })

    // check to see that the listener is also in the available peers pool
    db.child('available_peers/' + listenerId).once('value', function (snapshot) {
      if (snapshot.val() === null) {
        t.error('listner not available')
      } else {
        listenerRef = snapshot.ref()
        t.equal(snapshot.val().peerId, listenerId)
        // cleanup
        listenerRef.remove()
      }
    })
  })

})
