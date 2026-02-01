// Simple on-screen console for mobile debugging
module.exports = function initDebugConsole() {
  var div = document.createElement('div')
  div.id = 'debug-console'
  document.body.appendChild(div)

  function logToScreen(args, color) {
    var line = document.createElement('div')
    line.className = 'debug-line'
    if (color) line.style.color = color
    line.textContent = args.map(a =>
      typeof a === 'object' ? JSON.stringify(a) : String(a)
    ).join(' ')
    div.appendChild(line)
    div.scrollTop = div.scrollHeight
  }

  var origLog = console.log
  console.log = function() {
    logToScreen(Array.from(arguments))
    origLog.apply(console, arguments)
  }

  var origError = console.error
  console.error = function() {
    logToScreen(Array.from(arguments), '#f44')
    origError.apply(console, arguments)
  }
}
