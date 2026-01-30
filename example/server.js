var http = require('http')
var fs = require('fs')
var path = require('path')

var mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

var server = http.createServer(function (req, res) {
  console.log(req.method + ' ' + req.url)

  var urlPath = req.url.split('?')[0]
  var filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath)
  var ext = path.extname(filePath)

  fs.readFile(filePath, function (err, data) {
    if (err) {
      // fallback to index.html for SPA-style routing
      fs.readFile(path.join(__dirname, 'index.html'), function (err2, data2) {
        if (err2) {
          res.writeHead(404)
          res.end('Not found')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' })
        res.end(data2)
      })
      return
    }
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    })
    res.end(data)
  })
})

server.listen(process.env.PORT || 8080, process.env.HOST || '::', function (err) {
  if (err) return console.error('failed to start http server:', err)
  console.log('server listening on http://localhost:' + (process.env.PORT || 8080))
})
