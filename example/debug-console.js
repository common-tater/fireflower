// Simple on-screen console for mobile debugging
module.exports = function initDebugConsole() {
  var div = document.createElement('div')
  div.style.cssText = 'position:fixed;bottom:0;left:0;right:0;height:150px;background:rgba(0,0,0,0.8);color:#0f0;font-family:monospace;font-size:10px;overflow:auto;z-index:9999;padding:5px;pointer-events:none;'
  document.body.appendChild(div)

  function logToScreen(args, color) {
    var line = document.createElement('div')
    line.style.color = color || '#0f0'
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
    logToScreen(Array.from(arguments), '#f00')
    origError.apply(console, arguments)
  }
}
