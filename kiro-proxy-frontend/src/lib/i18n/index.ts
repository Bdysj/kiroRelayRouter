import { useCallback } from 'react'
import { create } from 'zustand'
import { getCookie, setCookie } from '@/lib/cookies'
import { en } from './locales/en'
import { zh } from './locales/zh'
import {
  LOCALES,
  LOCALE_TAGS,
  type Dictionary,
  type Locale,
  type TranslationKey,
  type TranslationVars,
} from './types'

export {
  LOCALES,
  LOCALE_LABELS,
  LOCALE_TAGS,
  type Locale,
  type TranslationKey,
} from './types'

const LOCALE_COOKIE_NAME = 'ui-locale'
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 1 year
const DEFAULT_LOCALE: Locale = 'zh'

const dictionaries: Record<Locale, Dictionary> = { zh, en }

/** 摊平后的词典缓存，`t()` 靠它做 O(1) 查找。 */
const flatCache = new Map<Locale, Map<string, string>>()

function flatten(
  source: Record<string, unknown>,
  prefix: string,
  target: Map<string, string>
) {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      target.set(path, value)
    } else if (value && typeof value === 'object') {
      flatten(value as Record<string, unknown>, path, target)
    }
  }
}

function flatDictionary(locale: Locale) {
  const cached = flatCache.get(locale)
  if (cached) return cached
  const flat = new Map<string, string>()
  flatten(dictionaries[locale] as unknown as Record<string, unknown>, '', flat)
  flatCache.set(locale, flat)
  return flat
}

/** 用 `{name}` 占位符做插值；未提供的占位符原样保留，便于发现漏传。 */
function interpolate(template: string, vars?: TranslationVars) {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  )
}

function isLocale(value: string | undefined): value is Locale {
  return !!value && (LOCALES as string[]).includes(value)
}

/** 首次进入时的语言：cookie > 浏览器语言 > 中文。 */
function detectLocale(): Locale {
  const fromCookie = getCookie(LOCALE_COOKIE_NAME)
  if (isLocale(fromCookie)) return fromCookie
  if (typeof navigator !== 'undefined') {
    const preferred = navigator.languages?.[0] ?? navigator.language
    if (preferred && !preferred.toLowerCase().startsWith('zh')) return 'en'
  }
  return DEFAULT_LOCALE
}

type I18nState = {
  locale: Locale
  setLocale: (locale: Locale) => void
}

function applyDocumentLocale(locale: Locale) {
  if (typeof document === 'undefined') return
  document.documentElement.lang = LOCALE_TAGS[locale]
}

export const useI18nStore = create<I18nState>()((set) => {
  const initial = detectLocale()
  applyDocumentLocale(initial)
  return {
    locale: initial,
    setLocale: (locale) => {
      setCookie(LOCALE_COOKIE_NAME, locale, LOCALE_COOKIE_MAX_AGE)
      applyDocumentLocale(locale)
      set({ locale })
    },
  }
})

/**
 * 按指定语言取词条。找不到时依次回退到中文词典，最后回退到 key 本身，
 * 保证界面永远不会渲染出 `undefined`。
 */
export function translate(
  locale: Locale,
  key: TranslationKey,
  vars?: TranslationVars
) {
  const template =
    flatDictionary(locale).get(key) ??
    flatDictionary(DEFAULT_LOCALE).get(key) ??
    key
  return interpolate(template, vars)
}

/**
 * 组件外（axios 拦截器、store、工具函数）取词条用这个，
 * 它直接读 store 的当前语言，不需要 React 上下文。
 */
export function t(key: TranslationKey, vars?: TranslationVars) {
  return translate(useI18nStore.getState().locale, key, vars)
}

/** 当前语言对应的 BCP 47 标签，传给 `Intl` / `toLocaleString` 用。 */
export function currentLocaleTag() {
  return LOCALE_TAGS[useI18nStore.getState().locale]
}

/** 组件里取词条的钩子：语言变化时会触发重渲染。 */
export function useTranslation() {
  const locale = useI18nStore((state) => state.locale)
  const setLocale = useI18nStore((state) => state.setLocale)
  const translateWithLocale = useCallback(
    (key: TranslationKey, vars?: TranslationVars) =>
      translate(locale, key, vars),
    [locale]
  )
  return {
    locale,
    setLocale,
    localeTag: LOCALE_TAGS[locale],
    t: translateWithLocale,
  }
}
