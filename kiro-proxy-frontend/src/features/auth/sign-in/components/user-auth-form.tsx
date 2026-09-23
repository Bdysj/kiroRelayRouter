import { useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, LockKeyhole, LogIn, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { loginAdmin } from '@/lib/api/admin'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/password-input'

const formSchema = z.object({
  username: z.string().trim().min(1, '请输入管理员账号'),
  password: z.string().min(1, '请输入管理员密码'),
})

const adminRoutes = [
  '/relays',
  '/models',
  '/routes-pricing',
  '/access-groups',
  '/billing-rule',
  '/billing',
  '/docs-management',
]

export function resolveAdminRedirect(redirectTo?: string) {
  if (!redirectTo || typeof window === 'undefined') return '/relays'
  try {
    const target = new URL(redirectTo, window.location.origin)
    const isAdminRoute = adminRoutes.some(
      (route) =>
        target.pathname === route || target.pathname.startsWith(`${route}/`)
    )
    if (target.origin !== window.location.origin || !isAdminRoute)
      return '/relays'
    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return '/relays'
  }
}

interface UserAuthFormProps extends React.HTMLAttributes<HTMLFormElement> {
  redirectTo?: string
}

export function UserAuthForm({
  className,
  redirectTo,
  ...props
}: UserAuthFormProps) {
  const [isLoading, setIsLoading] = useState(false)
  const navigate = useNavigate()
  const { auth } = useAuthStore()

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      username: '',
      password: '',
    },
  })

  async function onSubmit(data: z.infer<typeof formSchema>) {
    setIsLoading(true)
    try {
      const result = await loginAdmin(data.username, data.password)
      auth.setAccessToken(result.token)
      auth.setUser({
        accountNo: result.username,
        email: result.username,
        role: ['admin'],
        exp: new Date(result.expiresAt).getTime(),
      })
      toast.success('登录成功')
      await navigate({ to: resolveAdminRedirect(redirectTo), replace: true })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '登录失败')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className={cn('grid gap-4', className)}
        {...props}
      >
        <FormField
          control={form.control}
          name='username'
          render={({ field }) => (
            <FormItem>
              <FormLabel className='text-sm font-semibold'>
                <UserRound className='size-4' />
                管理员账号
              </FormLabel>
              <FormControl>
                <Input
                  className='h-11 rounded-lg px-4 text-sm shadow-none'
                  autoComplete='username'
                  placeholder='请输入账号'
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name='password'
          render={({ field }) => (
            <FormItem className='relative'>
              <FormLabel className='text-sm font-semibold'>
                <LockKeyhole className='size-4' />
                密码
              </FormLabel>
              <FormControl>
                <PasswordInput
                  className='[&_button]:right-2 [&_button]:size-7 [&_input]:h-11 [&_input]:rounded-lg [&_input]:pr-11 [&_input]:pl-4 [&_input]:text-sm [&_input]:shadow-none'
                  autoComplete='current-password'
                  placeholder='请输入密码'
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button
          className='mt-1 h-11 rounded-lg bg-slate-950 text-sm font-semibold text-white shadow-lg shadow-slate-950/15 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-950 dark:hover:bg-white'
          disabled={isLoading}
        >
          {isLoading ? <Loader2 className='animate-spin' /> : <LogIn />}
          登录
        </Button>
      </form>
    </Form>
  )
}
