module.exports = configure

var fs = require('fs')
var merge = require('merge')

function configure (filepath, cb) {
  var error = null

  try {
    merge(process.env, JSON.parse(fs.readFileSync(filepath)))
  } catch (err) {
    error = err
  }

  // if the env file was not found, that's ok
  if (error && error.code === 'ENOENT') {
    error = null
  }

  if (!error) {
    if (!process.env.FIREBASE_URL) {
      // ensure FIREBASE_URL
      error = new Error('environment does not define FIREBASE_URL')
    }
  }

  if (error) {
    error.message = 'error loading configuration: ' + error.message
  }

  cb && cb(error)
}
