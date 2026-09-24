import { useSearch } from '@tanstack/react-router'
import { useTranslation } from '@/lib/i18n'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { AuthLayout } from '../auth-layout'
import { UserAuthForm } from './components/user-auth-form'

export function SignIn() {
  const { redirect } = useSearch({ from: '/adminLogin' })
  const { t } = useTranslation()

  return (
    <AuthLayout>
      <Card className='w-full max-w-[460px] gap-4 rounded-2xl border-border/70 bg-card/90 py-6 shadow-xl shadow-slate-200/35 backdrop-blur-sm sm:py-7 dark:shadow-black/20'>
        <CardHeader className='px-6 sm:px-8'>
          <CardTitle className='text-xl font-bold tracking-tight sm:text-2xl'>
            {t('auth.signIn.title')}
          </CardTitle>
          <CardDescription className='mt-1.5 text-sm'>
            {t('auth.signIn.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className='px-6 sm:px-8'>
          <UserAuthForm redirectTo={redirect} />
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
