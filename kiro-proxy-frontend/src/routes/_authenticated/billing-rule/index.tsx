import { createFileRoute } from '@tanstack/react-router'
import { BillingRulePage } from '@/features/billing-rule'

export const Route = createFileRoute('/_authenticated/billing-rule/')({
  component: BillingRulePage,
})
