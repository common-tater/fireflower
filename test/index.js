var fs = require('fs')
var spawn = require('cross-spawn')
var test = require('tape')
var configure = require('./configure')
var util = require('./util')

var args = process.argv.slice(2)
var zuul = null

configure(__dirname + '/../etc/env.json', function (err) {
  if (err) throw err

  util.createDatabase(function (err, url, secret) {
    if (err) throw err

    process.env.PORT = util.rand()
    process.env.FIREBASE_URL = url
    process.env.FIREBASE_SECRET = secret
    process.on('SIGINT', onsigint)

    // zuul doesn't know how to use browserify transforms (envify)
    // so we write the environment configuration to a json file
    fs.writeFileSync(__dirname + '/env.json', JSON.stringify({
      FIREBASE_URL: url,
      FIREBASE_SECRET: secret
    }))

    runtests()

    function onsigint () {
      process.removeListener('SIGINT', onsigint)

      if (zuul) {
        zuul.kill('SIGINT')
      } else {
        oncomplete()
      }
    }
  })
})

function runtests () {
  // run browser tests
  test('browser', function (t) {
    t.plan(1)
    startZuul.call(t)
  })
}

function startZuul () {
  var self = this
  var opts = args.concat([ '--local', '8000', '--ui', 'tape', '--no-coverage', '--', 'test/client.js'])

  zuul = spawn('zuul', opts, { stdio: 'inherit' })
  zuul.on('exit', function (status) {
    self.equal(status, 0)
    oncomplete()
  })
}

function oncomplete () {
  util.deleteDatabase(function (err) {
    if (err) {
      console.warn('db teardown failed', err)
    }
  })
}
