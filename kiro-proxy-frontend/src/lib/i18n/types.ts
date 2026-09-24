import { type zh } from './locales/zh'

/** 支持的界面语言。中文是默认语言，也是词条的基准。 */
export type Locale = 'zh' | 'en'

export const LOCALES: Locale[] = ['zh', 'en']

/** 语言在各自语言里的自称，切换菜单直接用它显示。 */
export const LOCALE_LABELS: Record<Locale, string> = {
  zh: '简体中文',
  en: 'English',
}

/** 传给 `<html lang>` 与 `Intl` 的 BCP 47 标签。 */
export const LOCALE_TAGS: Record<Locale, string> = {
  zh: 'zh-CN',
  en: 'en-US',
}

export type Dictionary = typeof zh

/**
 * 把嵌套词典摊平成 `'relays.title'` 这种点号路径的联合类型。
 * 让 `t()` 的 key 在编译期就能被检查，拼错或删词条会直接报错。
 */
type Leaves<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`
}[keyof T & string]

export type TranslationKey = Leaves<Dictionary>

/** `t()` 的插值参数，词条里用 `{name}` 占位。 */
export type TranslationVars = Record<string, string | number>
