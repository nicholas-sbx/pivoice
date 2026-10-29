import { shallowRef } from 'vue'
import { call, toast } from './call'
import { touchFirst } from './lib/viewport'
import { isNative } from './native/bridge'

/**
 * The table in a small always-on-top window (Document Picture-in-Picture),
 * so you can see where people sit while you're in something else. The page
 * in it is ours and runs in this same tab's JavaScript, so Room.vue
 * teleports the table into it and everything stays reactive.
 *
 * Only on desktop browsers that have it (Chrome and Edge 116+, recent
 * Firefox). Not on phones, and not in the app, which will get a real
 * overlay of its own.
 */

export const pipSupported = typeof window !== 'undefined' && 'documentPictureInPicture' in window && !isNative && !touchFirst

/** The window, once it's open. */
export const pipWindow = shallowRef<Window | null>(null)
/** The element in it to draw into: set once the page's styles are in, so nothing flashes unstyled. */
export const pipRoot = shallowRef<HTMLElement | null>(null)

let opening = false

/** Open the pop-out, or close it if it is. Call straight from a click: the browser wants one to open a window. */
export async function togglePip() {
  if (pipWindow.value) return closePip()
  if (opening || !pipSupported) return
  opening = true
  try {
    const win = await window.documentPictureInPicture!.requestWindow({ width: 320, height: 320 })
    if (call.phase !== 'room') return win.close()
    // Closed from its own title bar.
    win.addEventListener('pagehide', () => {
      if (pipWindow.value === win) reset()
    })
    pipWindow.value = win
    const root = await setUp(win)
    if (pipWindow.value === win) pipRoot.value = root
  } catch {
    toast("Couldn't open the pop-out window.", 'error')
  } finally {
    opening = false
  }
}

export function closePip() {
  const win = pipWindow.value
  reset()
  win?.close()
}

function reset() {
  pipRoot.value = null
  pipWindow.value = null
}

/** The new window's document starts blank: give it the page's look, and somewhere to put the table. */
async function setUp(win: Window): Promise<HTMLElement> {
  const doc = win.document
  doc.title = 'Pivoice'
  doc.documentElement.lang = document.documentElement.lang
  const scheme = doc.createElement('meta')
  scheme.name = 'color-scheme'
  scheme.content = 'dark'
  doc.head.append(scheme)
  const loading = copyStyles(doc)
  // The stage's colour, from the same tokens as everywhere else (the sheets are in by the time anyone sees it).
  doc.documentElement.style.background = doc.body.style.background = 'var(--bg-stage)'
  const root = doc.createElement('div')
  root.style.cssText = 'width:100%;height:100%;overflow:hidden'
  doc.body.append(root)
  await Promise.race([loading, new Promise(r => setTimeout(r, 1500))])
  return root
}

/**
 * Copies every stylesheet in the page: linked ones by address (relative
 * addresses inside them would break if their text were copied into a document
 * whose own address is about:blank), inline ones, which is what Vite's dev
 * server makes, and constructed ones, by their rules. Resolves when the
 * linked ones have loaded.
 */
function copyStyles(to: Document): Promise<unknown> {
  const loaded: Promise<unknown>[] = []
  const inline = (css: string) => {
    const style = to.createElement('style')
    style.textContent = css
    to.head.append(style)
  }
  const rules = (sheet: CSSStyleSheet) => [...sheet.cssRules].map(r => r.cssText).join('\n')
  for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
    if (sheet.href) {
      const link = to.createElement('link')
      link.rel = 'stylesheet'
      link.href = sheet.href
      loaded.push(
        new Promise(done => {
          link.onload = link.onerror = done
        })
      )
      to.head.append(link)
      continue
    }
    try {
      inline(rules(sheet))
    } catch {
      // A sheet we're not allowed to read, and with no address of its own.
    }
  }
  return Promise.all(loaded)
}
