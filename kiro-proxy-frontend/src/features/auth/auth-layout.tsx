import { ArrowRightLeft } from 'lucide-react'
import { useTranslation } from '@/lib/i18n'
import { LanguageSwitch } from '@/components/language-switch'
import { ThemeSwitch } from '@/components/theme-switch'

type AuthLayoutProps = {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  const { t } = useTranslation()
  return (
    <div className='relative min-h-svh overflow-hidden bg-background'>
      <div className='pointer-events-none absolute -top-28 -left-32 size-[28rem] rounded-full bg-indigo-200/45 blur-3xl dark:bg-indigo-950/30' />
      <div className='pointer-events-none absolute -right-40 -bottom-44 size-[38rem] rounded-full bg-blue-200/50 blur-3xl dark:bg-blue-950/30' />
      <div className='absolute top-5 right-5 z-20 flex items-center gap-1 rounded-xl border bg-background/80 p-1 shadow-sm backdrop-blur-sm sm:top-8 sm:right-8'>
        <LanguageSwitch />
        <ThemeSwitch />
      </div>

      <main className='relative z-10 mx-auto flex min-h-svh w-full flex-col items-center justify-center px-4 py-6 sm:px-6 sm:py-8'>
        <div className='mb-5 text-center sm:mb-6 [@media(max-height:760px)]:mb-4'>
          <div className='mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-400 via-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/20 sm:size-18 [@media(max-height:760px)]:size-14 [@media(max-height:760px)]:rounded-xl'>
            <ArrowRightLeft className='size-8 stroke-[2.2] sm:size-9 [@media(max-height:760px)]:size-7' />
          </div>
          <h1 className='text-2xl font-bold tracking-tight sm:text-3xl'>
            {t('nav.appName')}
          </h1>
          <p className='mt-2 text-base font-semibold text-muted-foreground sm:text-lg'>
            {t('nav.appSubtitle')}
          </p>
          <p className='mt-2 text-sm text-muted-foreground'>
            {t('auth.tagline')}
          </p>
        </div>
        {children}
        <p className='mt-5 text-xs tracking-wide text-muted-foreground sm:mt-6 sm:text-sm [@media(max-height:760px)]:mt-4'>
          {t('auth.slogan')}
        </p>
      </main>
    </div>
  )
}
