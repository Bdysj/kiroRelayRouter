import { type LinkProps } from '@tanstack/react-router'
import { type TranslationKey } from '@/lib/i18n'

type BaseNavItem = {
  /** 词典 key，渲染时才翻译，语言切换后侧边栏会跟着变。 */
  title: TranslationKey
  badge?: string
  icon?: React.ElementType
}

type NavLink = BaseNavItem & {
  url: LinkProps['to'] | (string & {})
  items?: never
}

type NavCollapsible = BaseNavItem & {
  items: (BaseNavItem & { url: LinkProps['to'] | (string & {}) })[]
  url?: never
}

type NavItem = NavCollapsible | NavLink

type NavGroup = {
  title: TranslationKey
  items: NavItem[]
}

type SidebarData = {
  navGroups: NavGroup[]
}

export type { SidebarData, NavGroup, NavItem, NavCollapsible, NavLink }
