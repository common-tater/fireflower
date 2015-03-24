var test = require('tape')
var Firebase = require('firebase')
var FireFlower = require('../')

process.env = require('./env.json')

var db = new Firebase(process.env.FIREBASE_URL)

// how long to wait, in seconds, to give Firebase
// its chance to set our data before we check it.
// We may need to wait a while because simple-peer
// might take a bit of back and forth to establish
// a solid connection
var numSecsToWait = 10
var testBroadcasterId = 'test_broadcaster'
var testSubscriberId = 'test_subscriber'
var broadcasterFireFlower = null
var subscriberFireFlower = null

test('when k=1 and peer is full, subscriber is removed from list of available peers', function (t) {
  t.plan(1)

  broadcasterFireFlower = new FireFlower(process.env.FIREBASE_URL, 1, testBroadcasterId)
  broadcasterFireFlower.setBroadcaster(testBroadcasterId)
  subscriberFireFlower = new FireFlower(process.env.FIREBASE_URL, 1, testSubscriberId)
  subscriberFireFlower.subscribe(testBroadcasterId)

  setTimeout(function () {
    db.child('available_peers/' + testBroadcasterId).once('value', function (snapshot) {
      t.equal(snapshot.val(), null)
    })
  }, numSecsToWait * 1000)
})

test('cleanup', function (t) {
  db.child('available_peers/' + testBroadcasterId).remove()
  db.child('available_peers/' + testSubscriberId).remove()
  db.child('peer_signals/' + testBroadcasterId).remove()
  db.child('peer_signals/' + testSubscriberId).remove()

  t.end()
})
