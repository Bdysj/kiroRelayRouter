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
      title: '中转服务',
      items: [
        { title: '中转站管理', url: '/relays', icon: RadioTower },
        { title: '模型管理', url: '/models', icon: BrainCircuit },
        {
          title: '模型路由矩阵与价格',
          url: '/routes-pricing',
          icon: GitBranch,
        },
        {
          title: '访问分组与计费',
          url: '/access-groups',
          icon: BadgeDollarSign,
        },
        {
          title: '积分与计费规则',
          url: '/billing-rule',
          icon: CircleDollarSign,
        },
        { title: '用量与账单', url: '/billing', icon: ReceiptText },
      ],
    },
    {
      title: '内容管理',
      items: [
        { title: '教程管理', url: '/docs-management', icon: BookOpenText },
      ],
    },
  ],
}
