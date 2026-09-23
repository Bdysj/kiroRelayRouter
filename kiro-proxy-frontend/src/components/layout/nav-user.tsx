import { LogOut } from 'lucide-react'
import useDialogState from '@/hooks/use-dialog-state'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { SignOutDialog } from '@/components/sign-out-dialog'

export function NavUser() {
  const [open, setOpen] = useDialogState()

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size='lg'
            tooltip='退出登录'
            onClick={() => setOpen(true)}
          >
            <LogOut />
            <span className='font-medium'>退出登录</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>

      <SignOutDialog open={!!open} onOpenChange={setOpen} />
    </>
  )
}
