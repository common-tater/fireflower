var Fireflower = require('../')
var hat = require('hat')

document.addEventListener('click', onclick)

var fireflower = new Fireflower('commontaterfresh-test.firebaseio.com', 3)
var rootBroadcasterId = hat(16)

fireflower.setBroadcaster(rootBroadcasterId)

function onclick (evt) {
  switch (evt.target.id) {
    case 'add-listener-btn':
      fireflower.addListener(hat(16))
      break
    case 'remove-listener-btn':
      fireflower.removeListener(document.getElementById('listener-id-text').value)
      break
  }
}
