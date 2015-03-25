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
var testSubscriberIds = ['test_subscriber_1', 'test_subscriber_2', 'test_subscriber_3']
var fireFlowers = {}

test('when k=1 and peer is full, subscriber is removed from list of available peers', function (t) {
  t.plan(1)

  fireFlowers[testBroadcasterId] = new FireFlower(process.env.FIREBASE_URL, 1, testBroadcasterId)
  fireFlowers[testBroadcasterId].setBroadcaster(testBroadcasterId)
  fireFlowers[testSubscriberIds[0]] = new FireFlower(process.env.FIREBASE_URL, 1, testSubscriberIds[0])
  fireFlowers[testSubscriberIds[0]].subscribe()

  setTimeout(function () {
    db.child('available_peers/' + testBroadcasterId).once('value', function (snapshot) {
      t.equal(snapshot.val(), null)
    })
  }, numSecsToWait * 1000)
})

test('broadcaster keeps correct count of 3 subscribers when k=3', function (t) {
  t.plan(1)
  // cleanup the previous data so we can start fresh since we're changing k
  cleanup()

  fireFlowers[testBroadcasterId] = new FireFlower(process.env.FIREBASE_URL, 3, testBroadcasterId)
  fireFlowers[testBroadcasterId].setBroadcaster(testBroadcasterId)

  // create 3 test subscribers, and subscribe them all
  // directly to the broadcaster

  for (var i = 0; i < testSubscriberIds.length; i++) {
    fireFlowers[testSubscriberIds[i]] = new FireFlower(process.env.FIREBASE_URL, 3, testSubscriberIds[i])
    // specifically subscribe to the broadcaster, not
    // just the first one FireFlower picks for us
    fireFlowers[testSubscriberIds[i]].subscribe(testBroadcasterId)

  }
  t.equal(fireFlowers[testBroadcasterId].numSubscribers, 3)
})

test('when k=3 and peer is full, subscriber has been removed from list of available peers', function (t) {
  t.plan(1)

  // wait for the previous subscriber connection to settle, and then
  // test to see that the broadcaster has become full and pulled out
  // of the available peers list
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
  for (var peerId in fireFlowers) {
    db.child('available_peers/' + peerId).remove()
    db.child('peer_signals/' + peerId).remove()
  }
}
