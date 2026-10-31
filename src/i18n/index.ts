import { createI18n } from 'vue-i18n'
import { en, type MessageKey } from './en'

/**
 * The site's words, by vue-i18n. All of them live in the catalog files next
 * to this one (en.ts); code asks for them by key, `t('home.join')`, with
 * values for the `{name}` slots, `t('room.inCall', { count: 3 })`.
 *
 * To add a language: add a catalog with the same keys (de.ts, say) and list it
 * in `messages`. Anything it lacks falls back to English.
 */

export type { MessageKey }

export const i18n = createI18n({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  messages: { en }
})

type Params = Record<string, string | number>

/** Outside components (and inside, in templates and scripts alike): the words for `key`. A `count` param picks the plural. */
export function t(key: MessageKey, params: Params = {}): string {
  const { t: translate } = i18n.global
  return 'count' in params ? translate(key, params, Number(params.count)) : translate(key, params)
}
