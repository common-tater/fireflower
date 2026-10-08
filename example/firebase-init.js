// Centralized Firebase initialization for fireflower example
// This module ensures Firebase is only initialized once and provides
// easy access to the database instance throughout the application.

var firebase = require('firebase/app')
var firebaseDb = require('firebase/database')
var firebaseAuth = require('firebase/auth')

var app = null
var db = null
var authReady = null

/**
 * Initialize Firebase with config.
 * Safe to call multiple times - will only initialize once.
 */
function init (config) {
  if (!app) {
    app = firebase.initializeApp(config)
    db = firebaseDb.getDatabase(app)
    // Database rules require auth; every read/write must wait on ready()
    authReady = firebaseAuth.signInAnonymously(firebaseAuth.getAuth(app))
    console.log('Firebase initialized for project:', config.projectId)
  }
  return { app: app, db: db }
}

/**
 * Promise that resolves once anonymous sign-in has completed.
 * Await this before any database read or write.
 */
function ready () {
  if (!authReady) {
    return Promise.reject(new Error('Firebase not initialized. Call init() first.'))
  }
  return authReady
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
  ready: ready,
  getDb: getDb,
  getApp: getApp
}
