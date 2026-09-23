import { createFileRoute } from '@tanstack/react-router'
import { DocsAdminPage } from '@/features/docs-admin'

export const Route = createFileRoute('/_authenticated/docs-management/')({
  component: DocsAdminPage,
})
