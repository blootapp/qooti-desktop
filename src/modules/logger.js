// Structured logger — all developer logging goes through here.
// Format: [ISO_TIMESTAMP] [LEVEL] [module] [op:xxxxxx] message key=value
//
// Usage:
//   import { makeLogger, createOp } from './logger.js'
//   const log = makeLogger('Download')
//   const op  = createOp()
//   log.info('start', { url }, op)
//   log.error('failed', { error: err.message }, op)

const IS_DEV  = typeof import.meta !== 'undefined' && import.meta.env?.DEV
let _debugOn  = IS_DEV

/** Enable/disable DEBUG-level output at runtime (e.g. from a hidden settings toggle). */
export function enableDebug(on = true) { _debugOn = on }

/** Generate a short unique operation ID for correlating a single user action. */
export function createOp() {
  return 'op:' + Math.random().toString(16).slice(2, 8).padStart(6, '0')
}

function _stamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function _kv(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const pairs = Object.entries(obj)
  if (!pairs.length) return ''
  return ' ' + pairs.map(([k, v]) => {
    const s = v instanceof Error
      ? v.message + (v.stack ? ` [${v.stack.split('\n')[1]?.trim() ?? ''}]` : '')
      : String(v)
    return s.includes(' ') ? `${k}="${s}"` : `${k}=${s}`
  }).join(' ')
}

function _line(level, mod, op, msg, kv) {
  const opPart = op ? ` [${op}]` : ''
  return `[${_stamp()}] [${level}] [${mod}]${opPart} ${msg}${_kv(kv)}`
}

/**
 * Returns a logger bound to a module name.
 * @param {string} mod  - Feature area label (e.g. 'Download', 'AutoTag', 'OCR')
 * @returns {{ debug, info, warn, error }}
 *   Each method: (message: string, kv?: Record<string,any>, op?: string) => void
 */
export function makeLogger(mod) {
  return {
    debug: (msg, kv, op) => { if (_debugOn) console.debug(_line('DEBUG', mod, op, msg, kv)) },
    info:  (msg, kv, op) => console.info(_line('INFO',  mod, op, msg, kv)),
    warn:  (msg, kv, op) => console.warn(_line('WARN',  mod, op, msg, kv)),
    error: (msg, kv, op) => console.error(_line('ERROR', mod, op, msg, kv)),
  }
}
