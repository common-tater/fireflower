var fs = require('fs')
var got = require('got')
var test = require('tape')
var serve = require('../server')

var html = fs.readFileSync(__dirname + '/../share/index.html', 'utf8')
var server = serve()

test('http server serves static files', function (t) {
  t.plan(2)

  got('http://localhost:' + process.env.PORT + '/index.html', function (err, data) {
    t.error(err)
    t.equal(data, html)
    t.end()
    server.close()
  })
})
