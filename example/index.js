require('./debug-console')()

// Initialize Firebase first - before any other modules that might need it
var firebaseInit = require('./firebase-init')
var firebaseConfig = require('./firebase-config')
var firebase = firebaseInit.init(firebaseConfig)
var { ref, child, get } = require('firebase/database')
var { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } = require('firebase/auth')

var auth = getAuth(firebase.app)

// Robust Login UI
showLogin('checking') // Show checking state immediately

function showLogin(state = 'login', user = null, errorMsg = null) {
  var overlay = document.getElementById('login-overlay')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'login-overlay'
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);display:flex;justify-content:center;align-items:center;z-index:9999;'
    document.body.appendChild(overlay)
  }

  overlay.innerHTML = '' // Reset content

  var box = document.createElement('div')
  box.style.cssText = 'background:#222;padding:30px;border-radius:8px;display:flex;flex-direction:column;gap:15px;min-width:320px;box-shadow: 0 4px 6px rgba(0,0,0,0.3);'

  if (state === 'checking') {
    var title = document.createElement('h3')
    title.innerText = 'Verifying permissions...'
    title.style.margin = '0'
    title.style.textAlign = 'center'
    box.appendChild(title)
  }
  else if (state === 'unauthorized') {
    var title = document.createElement('h3')
    title.innerText = 'Access Denied'
    title.style.color = '#ff6b6b'
    title.style.margin = '0'

    var msg = document.createElement('p')
    msg.innerText = `User ${user ? user.email : ''} is not authorized to access this database.`
    msg.style.fontSize = '14px'
    msg.style.opacity = '0.9'

    var signOutBtn = document.createElement('button')
    signOutBtn.innerText = 'Sign Out / Retry'
    signOutBtn.onclick = () => auth.signOut()

    box.appendChild(title)
    box.appendChild(msg)
    box.appendChild(signOutBtn)
  }
  else { // 'login'
    var title = document.createElement('h3')
    title.innerText = 'Login Required'
    title.style.margin = '0'
    title.style.textAlign = 'center'

    var email = document.createElement('input')
    email.placeholder = 'Email'
    email.type = 'email'
    email.style.padding = '8px'

    var pass = document.createElement('input')
    pass.placeholder = 'Password'
    pass.type = 'password'
    pass.style.padding = '8px'

    var btn = document.createElement('button')
    btn.innerText = 'Sign In'
    btn.style.padding = '8px'
    btn.style.cursor = 'pointer'

    var errorDiv = document.createElement('div')
    errorDiv.style.color = '#ff6b6b'
    errorDiv.style.fontSize = '12px'
    if (errorMsg) errorDiv.innerText = errorMsg

    btn.onclick = () => {
      errorDiv.innerText = 'Signing in...'
      signInWithEmailAndPassword(auth, email.value, pass.value)
        .catch(e => errorDiv.innerText = e.message)
    }

    // Allow Enter key to submit
    pass.onkeyup = (e) => { if(e.key === 'Enter') btn.click() }

    box.appendChild(title)
    box.appendChild(email)
    box.appendChild(pass)
    box.appendChild(btn)
    box.appendChild(errorDiv)
  }

  overlay.appendChild(box)
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    showLogin('checking')
    // Verify admin access by reading specific user node
    // This assumes rules allow reading /admins/$uid ONLY if it evaluates to true
    // Or we simply try to access the tree path which is protected.
    // Let's check admins path explicitly as it is the source of truth.
    get(child(ref(firebase.db, 'admins'), user.uid))
      .then((snap) => {
        if (snap.val() === true) {
          if (document.getElementById('login-overlay')) document.getElementById('login-overlay').remove()
          initApp()
        } else {
          showLogin('unauthorized', user)
        }
      })
      .catch((err) => {
        // Permission denied or other error
        console.error('Permission check failed:', err)
        showLogin('unauthorized', user)
      })
  } else {
    showLogin('login')
  }
})

function initApp() {
  if (window.root) return // Already initialized

  // Now load modules that depend on Firebase
var fireflower = require('../')(firebase.db)
var Graph = require('./src/graph')

// Allow configurable Firebase path via URL query parameter
var urlParams = new URLSearchParams(window.location.search)
var treePath = urlParams.get('path') || 'tree'

var knumber = document.querySelector('#k-number input')
knumber.addEventListener('change', onkchanged)

var serverCapacityInput = document.querySelector('#server-capacity-number input')
serverCapacityInput.addEventListener('change', onServerCapacityChanged)
serverCapacityInput.addEventListener('input', function () {
  // Clicking down arrow from 1 gives 0 — treat as "clear to infinity"
  if (serverCapacityInput.value === '0' || serverCapacityInput.value === '') {
    serverCapacityInput.value = ''
    onServerCapacityChanged()
  }
})

// --- Controls ---
var { remove, set, onValue } = require('firebase/database')

// Reset button: disconnects node, clears Firebase data, prevents reconnect
var resetBtn = document.querySelector('#reset-btn')
resetBtn.addEventListener('click', function () {
  if (resetBtn.classList.contains('disabled')) return
  resetBtn.classList.add('disabled')
  resetBtn.textContent = 'Disconnected'
  if (window.root) {
    window.root.disconnect()
  }
  remove(ref(firebase.db, treePath + '/requests'))
  remove(ref(firebase.db, treePath + '/reports'))
})

// Logout button
var controls = document.getElementById('controls')
var logoutBtn = document.createElement('button')
logoutBtn.innerText = 'Logout'
logoutBtn.style.marginLeft = '10px'
logoutBtn.addEventListener('click', function() {
  auth.signOut().then(() => {
    location.reload()
  })
})
controls.appendChild(logoutBtn)

// Server toggle: enables/disables the relay server via Firebase config
var serverToggle = document.querySelector('#server-toggle')
var serverCheckbox = serverToggle.querySelector('input')
var configRef = ref(firebase.db, treePath + '/configuration/serverEnabled')

onValue(configRef, function (snapshot) {
  var enabled = snapshot.val()
  if (enabled === null) enabled = true
  serverCheckbox.checked = enabled
  serverToggle.classList.toggle('active', enabled)
})

serverCheckbox.addEventListener('change', function () {
  var enabled = serverCheckbox.checked
  serverToggle.classList.toggle('active', enabled)
  set(configRef, enabled)
})

// Force Server toggle: new clicked nodes only accept server responses
var forceServerToggle = document.querySelector('#force-server-toggle')
var forceServerCheckbox = forceServerToggle.querySelector('input')
var forceServerConfigRef = ref(firebase.db, treePath + '/configuration/serverOnly')

onValue(forceServerConfigRef, function (snapshot) {
  var enabled = !!snapshot.val()
  forceServerCheckbox.checked = enabled
  forceServerToggle.classList.toggle('active', enabled)
  if (window.graph) {
    window.graph.forceServer = enabled
  }
})

forceServerCheckbox.addEventListener('change', function () {
  var enabled = forceServerCheckbox.checked
  forceServerToggle.classList.toggle('active', enabled)
  set(forceServerConfigRef, enabled)
  if (window.graph) {
    window.graph.forceServer = enabled
  }
})

// Check if a root node already exists before deciding to be root
var treeRef = ref(firebase.db, treePath + '/reports')
get(treeRef).then(function(snapshot) {
  var isRoot = true

  if (snapshot.exists()) {
    // Check if there's an active root (reported within last 10 seconds)
    var reports = snapshot.val()
    var now = Date.now()
    for (var id in reports) {
      var report = reports[id]
      if (report.root && !report.isServer && report.timestamp && (now - report.timestamp) < 10000) {
        // Active root exists, we should connect as a child
        isRoot = false
        console.log('Found active root node:', id)
        break
      }
    }
  }

  console.log(isRoot ? 'Becoming ROOT node' : 'Connecting as CHILD node')

  window.root = fireflower(treePath, {
    root: isRoot,
    reportInterval: 2500
  })
  window.root.connect()

  window.root.on('fallback', function () {
    console.log('%c FALLBACK: Switched to server relay', 'color: #00CED1; font-weight: bold')
  })

  window.root.on('upgrade', function () {
    console.log('%c UPGRADE: Switched back to P2P', 'color: #00FF00; font-weight: bold')
  })

  window.root.once('connect', function () {
    console.log('Transport:', window.root.transport)
    window.graph = new Graph(treePath, window.root)
    onkchanged()
  })
}).catch(function(err) {
  console.error('Error checking for root:', err)

  window.root = fireflower(treePath, {
    root: true,
    reportInterval: 2500
  })
  window.root.connect()

  window.root.once('connect', function () {
    console.log('Transport:', window.root.transport)
    window.graph = new Graph(treePath, window.root)
    onkchanged()
  })
})

function onkchanged () {
  var k = parseInt(knumber.value, 10)
  if (window.graph) {
    window.graph.K = k
    window.graph.render()
  }
  var kRef = ref(firebase.db, treePath + '/configuration/K')
  set(kRef, k)
}

function onServerCapacityChanged () {
  var value = serverCapacityInput.value.trim()
  var serverCapacity = value === '' ? null : parseInt(value, 10)
  var serverCapacityRef = ref(firebase.db, treePath + '/configuration/serverCapacity')
  set(serverCapacityRef, serverCapacity)
}

// Watch serverCapacity config and update input
var serverCapacityConfigRef = ref(firebase.db, treePath + '/configuration/serverCapacity')
onValue(serverCapacityConfigRef, function (snapshot) {
  var capacity = snapshot.val()
  serverCapacityInput.value = capacity || ''
  serverCapacityInput.placeholder = capacity ? '' : '∞'
})
}
