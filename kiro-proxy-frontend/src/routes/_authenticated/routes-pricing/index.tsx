import { createFileRoute } from '@tanstack/react-router'
import { RouteMatrixPage } from '@/features/route-matrix'

export const Route = createFileRoute('/_authenticated/routes-pricing/')({
  component: RouteMatrixPage,
})
