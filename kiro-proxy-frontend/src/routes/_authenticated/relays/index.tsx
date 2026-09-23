import { createFileRoute } from '@tanstack/react-router'
import { RelaysPage } from '@/features/relays'

export const Route = createFileRoute('/_authenticated/relays/')({
  component: RelaysPage,
})
