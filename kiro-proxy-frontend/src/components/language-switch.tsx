import { Check, Languages } from 'lucide-react'
import { LOCALES, LOCALE_LABELS, useTranslation } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/** 顶栏语言切换，放在主题切换旁边。 */
export function LanguageSwitch() {
  const { locale, setLocale, t } = useTranslation()

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant='ghost' size='icon' className='scale-95 rounded-full'>
          <Languages className='size-[1.2rem]' />
          <span className='sr-only'>{t('settings.language.toggle')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align='end'
        aria-label={t('settings.language.selectAria')}
      >
        {LOCALES.map((item) => (
          <DropdownMenuItem key={item} onClick={() => setLocale(item)}>
            {LOCALE_LABELS[item]}
            <Check
              size={14}
              className={cn('ms-auto', locale !== item && 'hidden')}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
