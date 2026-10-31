import { createApp } from 'vue'
import { i18n } from '../i18n'
import Overlay from './Overlay.vue'
import '../styles/base.css'

/**
 * The app's overlay (native/internal/overlay): the table, small, in a
 * see-through window over everything else, that clicks go straight through.
 * Its own little page, so the window it's in costs as little as it can: no
 * call, no audio, no room, just the table drawn from what the app tells it.
 */

createApp(Overlay).use(i18n).mount('#app')
