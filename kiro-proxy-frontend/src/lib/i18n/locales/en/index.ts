import { type Dictionary } from '../../types'
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

/** 英文词典。类型标注保证它与中文词典的 key 集合完全一致。 */
export const en: Dictionary = {
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
