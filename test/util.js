exports.rand = rand
exports.createDatabase = createDatabase
exports.deleteDatabase = deleteDatabase
exports.admin = null
exports.database = null

var FirebaseAdmin = require('firebase-admin')
var rules = require('../etc/rules.json')

function createDatabase (cb) {
  var username = process.env.FIREBASE_USER
  var password = process.env.FIREBASE_PASS

  FirebaseAdmin.getToken(username, password)
    .done(function (token) {
      doCreateDatabase(token, cb)
    }, cb)
}

function doCreateDatabase (token, cb) {
  exports.admin = new FirebaseAdmin(token)
  exports.admin.createDatabase(rand())
    .done(function (database) {
      exports.database = database
      setupRules(cb)
    }, cb)
}

function setupRules (cb) {
  // apparently we need to wait 1s before db is actually ready
  setTimeout(function () {
    exports.database.setRules(rules.rules)
      .done(function () {
        setupAuth(cb)
      }, cb)
  }, 1000)
}

function setupAuth (cb) {
  exports.database.setAuthConfig({
    anonymous: {
      enabled: true
    },
    password: {
      enabled: true
    }
  })
    .done(function () {
      addTestUser(cb)
    }, cb)
}

function addTestUser (cb) {
  exports.database.createUser('fireflowertester@common-tater.com', 'flowertownisthebesttown')
    .done(function () {
      getSecret(cb)
    }, cb)
}

function getSecret (cb) {
  exports.database.getAuthTokens()
    .done(function (tokens) {
      cb(null, exports.database.toString(), tokens[0])
    }, cb)
}

function deleteDatabase (cb) {
  exports.admin.deleteDatabase(exports.database)
    .done(cb, cb)
}

function rand () {
  return 10000 + ~~(Math.random() * 10000)
}
