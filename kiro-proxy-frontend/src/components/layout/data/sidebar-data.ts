import {
  RadioTower,
  BrainCircuit,
  GitBranch,
  ReceiptText,
  BadgeDollarSign,
  CircleDollarSign,
  BookOpenText,
} from 'lucide-react'
import { type SidebarData } from '../types'

export const sidebarData: SidebarData = {
  navGroups: [
    {
      title: 'nav.group.relayService',
      items: [
        { title: 'nav.item.relays', url: '/relays', icon: RadioTower },
        { title: 'nav.item.models', url: '/models', icon: BrainCircuit },
        {
          title: 'nav.item.routesPricing',
          url: '/routes-pricing',
          icon: GitBranch,
        },
        {
          title: 'nav.item.accessGroups',
          url: '/access-groups',
          icon: BadgeDollarSign,
        },
        {
          title: 'nav.item.billingRule',
          url: '/billing-rule',
          icon: CircleDollarSign,
        },
        { title: 'nav.item.billing', url: '/billing', icon: ReceiptText },
      ],
    },
    {
      title: 'nav.group.contentManagement',
      items: [
        {
          title: 'nav.item.docsManagement',
          url: '/docs-management',
          icon: BookOpenText,
        },
      ],
    },
  ],
}
