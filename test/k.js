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
  subscriberFireFlower.subscribe()

  setTimeout(function () {
    db.child('available_peers/' + testBroadcasterId).once('value', function (snapshot) {
      t.equal(snapshot.val(), null)
    })
  }, numSecsToWait * 1000)
})

test('when k=3 and peer is full, subscriber is removed from list of available peers', function (t) {
  t.plan(1)
  // cleanup the previous data so we can start fresh since we're changing k
  cleanup()

  broadcasterFireFlower = new FireFlower(process.env.FIREBASE_URL, 3, testBroadcasterId)
  broadcasterFireFlower.setBroadcaster(testBroadcasterId)

  // create 3 test subscribers, and subscribe them all
  // directly to the broadcaster
  var subscriberFireFlowers = []
  var testSubscriberIds = ['test_1', 'test_2', 'test_3']
  for (var i = 0; i < testSubscriberIds.length; i++) {
    var testFireFlower = new FireFlower(process.env.FIREBASE_URL, 3, testSubscriberIds[i])
    testFireFlower.subscribe(testBroadcasterId)
    subscriberFireFlowers.push(testFireFlower)
  }

  // wait for that to settle, and then test to see that the broadcaster
  // has become full and pulled out of the available peers list
  setTimeout(function () {
    db.child('available_peers/' + testBroadcasterId).once('value', function (snapshot) {
      t.equal(snapshot.val(), null)
    })
  }, numSecsToWait * 1000)
})

test('cleanup', function (t) {
  cleanup()

  t.end()
})

function cleanup () {
  db.child('available_peers/' + testBroadcasterId).remove()
  db.child('available_peers/' + testSubscriberId).remove()
  db.child('peer_signals/' + testBroadcasterId).remove()
  db.child('peer_signals/' + testSubscriberId).remove()
}
