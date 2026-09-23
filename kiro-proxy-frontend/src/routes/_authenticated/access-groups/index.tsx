import { createFileRoute } from '@tanstack/react-router'
import { AccessGroupsPage } from '@/features/access-groups'

export const Route = createFileRoute('/_authenticated/access-groups/')({
  component: AccessGroupsPage,
})
