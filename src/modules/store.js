// Central event bus — the only channel for cross-module communication.
// Modules never import each other. All state flows through here.
// See architecture §18.

const store = new EventTarget()

store.emit = (type, detail) =>
  store.dispatchEvent(new CustomEvent(type, { detail }))

store.on = (type, handler) => {
  const wrapped = e => handler(e.detail)
  store.addEventListener(type, wrapped)
  return wrapped // return so callers can store it for store.off()
}

store.off = (type, handler) =>
  store.removeEventListener(type, handler)

export default store
