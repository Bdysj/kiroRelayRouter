import { accessGroups } from './access-groups'
import { auth } from './auth'
import { billing } from './billing'
import { billingRule } from './billing-rule'
import { common } from './common'
import { docs } from './docs'
import { docsAdmin } from './docs-admin'
import { models } from './models'
import { nav } from './nav'
import { relays } from './relays'
import { routeMatrix } from './route-matrix'
import { settings } from './settings'

/**
 * 中文词典，也是全部词条的基准：
 * key 由这里定义，英文词典必须逐条对齐，缺词条会在编译期报错。
 */
export const zh = {
  common,
  nav,
  auth,
  settings,
  relays,
  models,
  routeMatrix,
  accessGroups,
  billing,
  billingRule,
  docs,
  docsAdmin,
}
