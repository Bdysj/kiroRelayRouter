import { type nav as zhNav } from '../zh/nav'

export const nav: typeof zhNav = {
  appName: 'kiro Relayrouter',
  appSubtitle: 'Control Center',
  toggleSidebar: 'Toggle sidebar',
  group: {
    relayService: 'Relay service',
    contentManagement: 'Content',
  },
  item: {
    relays: 'Relays',
    models: 'Models',
    routesPricing: 'Routing matrix & pricing',
    accessGroups: 'Access groups & billing',
    billingRule: 'Credits & billing rules',
    billing: 'Usage & invoices',
    docsManagement: 'Guide management',
  },
  signOut: {
    title: 'Sign out',
    desc: 'Sign out of this account? You will need to sign in again to reach the control center.',
  },
}
