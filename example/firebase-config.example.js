// Copy this file to firebase-config.js and fill in your Firebase project details.
//
// To set up Firebase Realtime Database:
// 1. Go to https://console.firebase.google.com
// 2. Create a new project (or use an existing one)
// 3. Go to Build > Realtime Database > Create Database
// 4. Choose a location (rules come from database.rules.json, not the console)
// 5. Go to Project Settings > General > Your apps > Add app (Web)
// 6. Copy the config values below
//
// Rules require auth: clients sign in anonymously before any read or write,
// so Anonymous must be enabled under Authentication > Sign-in method.

module.exports = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  databaseURL: 'https://YOUR_PROJECT-default-rtdb.firebaseio.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID'
}
