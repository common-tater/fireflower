// Centralized Firebase initialization for fireflower example
// This module ensures Firebase is only initialized once and provides
// easy access to the database instance throughout the application.

var firebase = require('firebase/app')
var firebaseDb = require('firebase/database')
var firebaseAuth = require('firebase/auth')

var app = null
var db = null
var readyPromise = null

/**
 * One-shot auth: resolve with the current user, or sign in anonymously
 * if there is none. Database rules require auth != null.
 */
function startAuth (app) {
  var auth = firebaseAuth.getAuth(app)
  return new Promise(function (resolve, reject) {
    var unsubscribe = null
    var done = false
    unsubscribe = firebaseAuth.onAuthStateChanged(auth, function (user) {
      if (done) return
      done = true
      if (unsubscribe) unsubscribe()
      if (user) {
        resolve(user)
      } else {
        firebaseAuth.signInAnonymously(auth).then(function (cred) {
          resolve(cred.user)
        }, reject)
      }
    }, reject)
    // Callback may have fired synchronously, before unsubscribe was assigned
    if (done) unsubscribe()
  })
}

/**
 * Resolves with the signed-in user (anonymous if needed).
 * Rejects if init() has not been called or sign-in fails.
 */
function ready () {
  if (!readyPromise) {
    return Promise.reject(new Error('Firebase not initialized. Call init() first.'))
  }
  return readyPromise
}

/**
 * Initialize Firebase with config.
 * Safe to call multiple times - will only initialize once.
 */
function init (config) {
  if (!app) {
    app = firebase.initializeApp(config)
    db = firebaseDb.getDatabase(app)
    console.log('Firebase initialized for project:', config.projectId)
    readyPromise = startAuth(app)
  }
  return { app: app, db: db }
}

/**
 * Get the Firebase database instance.
 * Throws if init() hasn't been called.
 */
function getDb () {
  if (!db) {
    throw new Error('Firebase not initialized. Call init() first.')
  }
  return db
}

/**
 * Get the Firebase app instance.
 */
function getApp () {
  if (!app) {
    throw new Error('Firebase not initialized. Call init() first.')
  }
  return app
}

module.exports = {
  init: init,
  getDb: getDb,
  getApp: getApp,
  ready: ready
}
