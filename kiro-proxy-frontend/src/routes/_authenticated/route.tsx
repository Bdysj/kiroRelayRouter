import { createFileRoute, redirect } from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ location }) => {
    if (!useAuthStore.getState().auth.accessToken) {
      throw redirect({
        to: '/adminLogin',
        search: { redirect: location.href },
      })
    }
  },
  component: AuthenticatedLayout,
})
