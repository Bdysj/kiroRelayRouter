import { LogOut } from 'lucide-react'
import { useTranslation } from '@/lib/i18n'
import useDialogState from '@/hooks/use-dialog-state'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { SignOutDialog } from '@/components/sign-out-dialog'

export function NavUser() {
  const [open, setOpen] = useDialogState()
  const { t } = useTranslation()

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size='lg'
            tooltip={t('common.action.signOut')}
            onClick={() => setOpen(true)}
          >
            <LogOut />
            <span className='font-medium'>{t('common.action.signOut')}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>

      <SignOutDialog open={!!open} onOpenChange={setOpen} />
    </>
  )
}
