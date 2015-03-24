var test = require('tape')
var Firebase = require('firebase')
var FireFlower = require('../')

process.env = require('./env.json')

var db = new Firebase(process.env.FIREBASE_URL)

// how long to wait, in seconds, to give Firebase
// its chance to set our data before we check it
var numSecsToWait = 1
var testBroadcasterId = 'test_broadcaster'
var testSubscriberId = 'test_subscriber'
var broadcasterFireFlower = null
var subscriberFireFlower = null

test('set broadcaster', function (t) {
  t.plan(1)

  broadcasterFireFlower = new FireFlower(process.env.FIREBASE_URL, 3, testBroadcasterId)
  broadcasterFireFlower.setBroadcaster(testBroadcasterId)

  setTimeout(function () {
    db.child('available_peers/' + testBroadcasterId).once('value', function (snapshot) {
      t.equal(snapshot.val().id, testBroadcasterId)
    })
  }, numSecsToWait * 1000)
})

// check that there are only two, and no other available peers
test('subscribe and check for correct number of available peers', function (t) {
  t.plan(1)

  subscriberFireFlower = new FireFlower(process.env.FIREBASE_URL, 3, testSubscriberId)
  subscriberFireFlower.subscribe()
  setTimeout(function () {
    db.child('available_peers').once('value', function (snapshot) {
      t.equal(snapshot.numChildren(), 2)
    })
  }, numSecsToWait * 1000)
})

test('broadcaster is in available peers pool', function (t) {
  t.plan(1)

  db.child('available_peers/' + testBroadcasterId).once('value', function (snapshot) {
    if (snapshot.val() === null) {
      t.error('broadcaster not available')
    } else {
      t.equal(snapshot.val().peerId, testBroadcasterId)
    }
  })
})

test('subscriber is in available peers pool', function (t) {
  t.plan(1)

  db.child('available_peers/' + testSubscriberId).once('value', function (snapshot) {
    if (snapshot.val() === null) {
      t.error('subscriber not available')
    } else {
      t.equal(snapshot.val().peerId, testSubscriberId)
    }
  })
})

test('cleanup', function (t) {
  db.child('available_peers/' + testBroadcasterId).remove()
  db.child('available_peers/' + testSubscriberId).remove()
  db.child('peer_signals/' + testBroadcasterId).remove()
  db.child('peer_signals/' + testSubscriberId).remove()

  t.end()
})
