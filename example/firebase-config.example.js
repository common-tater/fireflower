// Copy this file to firebase-config.js and fill in your Firebase project details.
//
// To set up Firebase Realtime Database:
// 1. Go to https://console.firebase.google.com
// 2. Create a new project (or use an existing one)
// 3. Go to Build > Realtime Database > Create Database
// 4. Choose a location and start in "test mode" for development
// 5. Go to Project Settings > General > Your apps > Add app (Web)
// 6. Copy the config values below
//
// IMPORTANT: Test mode rules expire after 30 days.
// For production, configure proper security rules.

module.exports = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  databaseURL: 'https://YOUR_PROJECT-default-rtdb.firebaseio.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID'
}
