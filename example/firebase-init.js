// Centralized Firebase initialization for fireflower example
// This module ensures Firebase is only initialized once and provides
// easy access to the database instance throughout the application.

var firebase = require('firebase/app')
var firebaseDb = require('firebase/database')

var app = null
var db = null

/**
 * Initialize Firebase with config.
 * Safe to call multiple times - will only initialize once.
 */
function init (config) {
  if (!app) {
    app = firebase.initializeApp(config)
    db = firebaseDb.getDatabase(app)
    console.log('Firebase initialized for project:', config.projectId)
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
  getApp: getApp
}
