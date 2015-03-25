var test = require('tape')
var Firebase = require('firebase')
var FireFlower = require('../')

process.env = require('./env.json')

var db = new Firebase(process.env.FIREBASE_URL)

// how long to wait, in seconds, to give Firebase
// its chance to set our data before we check it
var numSecsToWait = 3
var testBroadcasterId = 'test_broadcaster'
var testSubscriberIds = ['test_subscriber_1', 'test_subscriber_2', 'test_subscriber_2']
var fireFlowers = {}

// set a broadcaster A, have one subscriber B connect to them, have a second
// subscriber C subscribe directly to B, and verify that they're actually
// connected to B
test('subscribe specifically to a given peer', function (t) {
  t.plan(3)

  fireFlowers[testBroadcasterId] = new FireFlower(process.env.FIREBASE_URL, 3, testBroadcasterId)
  fireFlowers[testBroadcasterId].setBroadcaster(testBroadcasterId)

  fireFlowers[testSubscriberIds[0]] = new FireFlower(process.env.FIREBASE_URL, 3, testSubscriberIds[0])
  fireFlowers[testSubscriberIds[0]].subscribe()

  setTimeout(function () {
    fireFlowers[testSubscriberIds[1]] = new FireFlower(process.env.FIREBASE_URL, 3, testSubscriberIds[1])
    fireFlowers[testSubscriberIds[1]].subscribe(fireFlowers[testSubscriberIds[0]].myPeerId)

    setTimeout(function () {
      t.equal(fireFlowers[testBroadcasterId].numSubscribers, 1)
      t.equal(fireFlowers[testSubscriberIds[0]].numSubscribers, 1)
      t.equal(fireFlowers[testSubscriberIds[1]], 0)

    }, numSecsToWait * 1000)
  }, numSecsToWait * 1000)

})

// set a broadcaster A and k=2, have 2 subscribers B/C connect to A, have a third
// subscriber D try to subscribe directly to A. Since A is full, make sure D
// wasn't able to connect to it, and that they were instead able to connect to B
test('subscribe with trying to prefer an unavailable peer', function (t) {
  t.plan(3)

  // clean the db before this test
  cleanup()

  fireFlowers[testBroadcasterId] = new FireFlower(process.env.FIREBASE_URL, 2, testBroadcasterId)
  fireFlowers[testBroadcasterId].setBroadcaster(testBroadcasterId)

  fireFlowers[testSubscriberIds[0]] = new FireFlower(process.env.FIREBASE_URL, 2, testSubscriberIds[0])
  fireFlowers[testSubscriberIds[0]].subscribe(testBroadcasterId)

  setTimeout(function () {
    fireFlowers[testSubscriberIds[1]] = new FireFlower(process.env.FIREBASE_URL, 2, testSubscriberIds[1])
    fireFlowers[testSubscriberIds[1]].subscribe(testBroadcasterId)

    setTimeout(function () {
      fireFlowers[testSubscriberIds[2]] = new FireFlower(process.env.FIREBASE_URL, 2, testSubscriberIds[2])
      // try to subscribe to the broadcaster, but they should be full,
      // so hopefully the connection is still made with a different peer
      fireFlowers[testSubscriberIds[2]].subscribe(testBroadcasterId)

      setTimeout(function () {
        t.equal(fireFlowers[testBroadcasterId].numSubscribers, 2)
        t.equal(fireFlowers[testSubscriberIds[0]].numSubscribers, 1)
        t.equal(fireFlowers[testSubscriberIds[1]].numSubscribers, 0)
      }, numSecsToWait * 1000)
    }, numSecsToWait * 1000)
  }, numSecsToWait * 1000)

})

test('cleanup', function (t) {
  cleanup()

  t.end()
})

function cleanup () {
  for (var peerId in fireFlowers) {
    db.child('available_peers/' + peerId).remove()
    db.child('peer_signals/' + peerId).remove()
  }
}
