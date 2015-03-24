var test = require('tape')
var Firebase = require('firebase')
var FireFlower = require('../')
var async = require('async')

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
    db.child('available_peers/' + testBroadcasterId).remove()
  })
})

test('set broadcaster and subscribe with first listener', function (t) {
  t.plan(3)

  var broadcasterId = 'test_broadcaster'
  var broadcasterFireFlower = new FireFlower(process.env.FIREBASE_URL, 3, broadcasterId)
  broadcasterFireFlower.setBroadcaster(broadcasterId)

  var listenerId = 'test_listener'
  var listenerFireFlower = new FireFlower(process.env.FIREBASE_URL, 3, listenerId)

  var asyncTasks = []

  // wait a few seconds to allow for the broadcaster
  // to be set
  var numSecsToWait = 1
  setTimeout(function () {
    listenerFireFlower.subscribe(broadcasterId)

    setTimeout(function () {
      asyncTasks.push(function (cb) {
        // check that there are only two, and no other available peers
        db.child('available_peers').once('value', function (snapshot) {
          t.equal(snapshot.numChildren(), 2)
          cb()
        })
      })

      asyncTasks.push(function (cb) {
        // check to see that the broadcaster is in the available peers pool
        db.child('available_peers/' + broadcasterId).once('value', function (snapshot) {
          if (snapshot.val() === null) {
            t.error('broadcaster not available')
          } else {
            t.equal(snapshot.val().peerId, broadcasterId)
          }
          cb()
        })
      })

      asyncTasks.push(function (cb) {
        // check to see that the listener is also in the available peers pool
        db.child('available_peers/' + listenerId).once('value', function (snapshot) {
          if (snapshot.val() === null) {
            t.error('listner not available')
          } else {
            t.equal(snapshot.val().peerId, listenerId)
          }
          cb()
        })
      })

      async.parallel(asyncTasks, function () {
        cleanup()
      })

      function cleanup () {
        db.child('available_peers/' + broadcasterId).remove()
        db.child('available_peers/' + listenerId).remove()
        db.child('peer_signals/' + broadcasterId).remove()
        db.child('peer_signals/' + listenerId).remove()
      }
    }, numSecsToWait * 1000)
  }, numSecsToWait * 1000)

})
