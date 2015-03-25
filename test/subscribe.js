var test = require('tape')
var Firebase = require('firebase')
var FireFlower = require('../')

process.env = require('./env.json')

var db = new Firebase(process.env.FIREBASE_URL)

// how long to wait, in seconds, to give Firebase
// its chance to set our data before we check it
var numSecsToWait = 3
var testBroadcasterId = 'test_broadcaster'
var firstSubscriberId = 'test_subscriber_1'
var secondSubscriberId = 'test_subscriber_2'
var fireFlowers = {}

// set a broadcaster A, have one subscriber B connect to them, have a second
// subscriber C subscribe directly to B, and verify that they're actually
// connected to B
test('subscribe specifically to a given peer', function (t) {
  t.plan(3)

  fireFlowers[testBroadcasterId] = new FireFlower(process.env.FIREBASE_URL, 3, testBroadcasterId)
  fireFlowers[testBroadcasterId].setBroadcaster(testBroadcasterId)

  fireFlowers[firstSubscriberId] = new FireFlower(process.env.FIREBASE_URL, 3, firstSubscriberId)
  fireFlowers[firstSubscriberId].subscribe()

  setTimeout(function () {
    fireFlowers[secondSubscriberId] = new FireFlower(process.env.FIREBASE_URL, 3, secondSubscriberId)
    fireFlowers[secondSubscriberId].subscribe(fireFlowers[firstSubscriberId].myPeerId)

    setTimeout(function () {
      t.equal(fireFlowers[testBroadcasterId].numSubscribers, 1)
      t.equal(fireFlowers[firstSubscriberId].numSubscribers, 1)
      t.equal(fireFlowers[secondSubscriberId], 0)

    }, numSecsToWait * 1000)
  }, numSecsToWait * 1000)

})

test('cleanup', function (t) {
  for (var peerId in fireFlowers) {
    db.child('available_peers/' + peerId).remove()
    db.child('peer_signals/' + peerId).remove()
  }

  t.end()
})
