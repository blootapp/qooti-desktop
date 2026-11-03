// Styled dropdown for a native <select> (guide Select 6:132 + Menu item 6:122).
// The OS draws a <select>'s open list itself, so it can't match the app. This keeps the
// <select> as the source of truth (value + 'change' events, so existing handlers work),
// hides it, and shows a pill button that opens an app-styled menu instead.

const CHECK = `<span class="icon icon-14" style="mask-image:url('/icons/check.svg');-webkit-mask-image:url('/icons/check.svg')" aria-hidden="true"></span>`

let openMenu = null   // { close } of the menu that's currently open

export function enhanceSelect(select) {
  if (!select || select.dataset.enhanced) return
  select.dataset.enhanced = '1'
  select.hidden = true

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `${select.className} sm-trigger`
  btn.setAttribute('aria-haspopup', 'listbox')
  btn.setAttribute('aria-expanded', 'false')
  const label = () => { btn.textContent = select.selectedOptions[0]?.textContent ?? '' }
  label()
  select.after(btn)
  select.addEventListener('change', label)

  btn.addEventListener('click', () => (openMenu?.owner === btn ? openMenu.close() : open()))
  btn.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open() }
  })

  function open() {
    openMenu?.close()
    const menu = document.createElement('div')
    menu.className = 'sm-menu'
    menu.setAttribute('role', 'listbox')
    const opts = [...select.options]
    menu.innerHTML = opts.map((o, i) => `
      <button type="button" class="sm-item${o.selected ? ' is-selected' : ''}" role="option" aria-selected="${o.selected}" data-i="${i}">
        <span class="sm-item-label">${o.textContent.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</span>${o.selected ? CHECK : ''}
      </button>`).join('')
    document.getElementById('overlays').appendChild(menu)

    // Under the trigger, right-aligned to it, at least as wide; flips up near the bottom.
    const r = btn.getBoundingClientRect()
    menu.style.minWidth = `${Math.max(r.width, 160)}px`
    menu.style.top = `${r.bottom + 6}px`
    menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`
    const m = menu.getBoundingClientRect()
    if (m.bottom > window.innerHeight - 8) { menu.style.top = `${r.top - m.height - 6}px`; menu.classList.add('is-above') }

    const items = [...menu.querySelectorAll('.sm-item')]
    let focusIdx = Math.max(0, select.selectedIndex)
    items[focusIdx]?.focus()

    const choose = i => {
      if (select.selectedIndex !== i) {
        select.selectedIndex = i
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
      close()
      btn.focus()
    }
    items.forEach((it, i) => it.addEventListener('click', () => choose(i)))

    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus() }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        focusIdx = (focusIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[focusIdx].focus()
      } else if (e.key === 'Tab') close()
    }
    const onDown = e => { if (!menu.contains(e.target) && e.target !== btn) close() }
    const onScroll = e => { if (!menu.contains(e.target)) close() }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)

    btn.classList.add('is-open')
    btn.setAttribute('aria-expanded', 'true')

    function close() {
      menu.remove()
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
      btn.classList.remove('is-open')
      btn.setAttribute('aria-expanded', 'false')
      if (openMenu?.owner === btn) openMenu = null
    }
    openMenu = { owner: btn, close }
  }
}
