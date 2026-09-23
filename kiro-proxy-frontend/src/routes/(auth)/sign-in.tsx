import { z } from 'zod'
import { createFileRoute, redirect } from '@tanstack/react-router'

const searchSchema = z.object({
  redirect: z.string().optional(),
})

export const Route = createFileRoute('/(auth)/sign-in')({
  validateSearch: searchSchema,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/adminLogin', search, replace: true })
  },
})
