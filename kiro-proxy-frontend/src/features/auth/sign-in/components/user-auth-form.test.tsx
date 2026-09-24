import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, type RenderResult } from 'vitest-browser-react'
import { type Locator, userEvent } from 'vitest/browser'
import { useI18nStore } from '@/lib/i18n'
import { UserAuthForm } from './user-auth-form'

const FORM_MESSAGES = {
  usernameEmpty: '请输入管理员账号',
  passwordEmpty: '请输入管理员密码',
} as const

const navigate = vi.fn()
const setUserMock = vi.fn()
const setAccessTokenMock = vi.fn()

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({
    auth: {
      setUser: setUserMock,
      setAccessToken: setAccessTokenMock,
    },
  }),
}))

vi.mock('@/lib/api/admin', () => ({
  loginAdmin: vi.fn((username: string) =>
    Promise.resolve({
      token: 'admin-jwt-token',
      tokenType: 'Bearer',
      username,
      expiresAt: '2026-09-13T00:00:00Z',
    })
  ),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    Link: ({
      children,
      to,
      className,
      ...rest
    }: {
      children?: React.ReactNode
      to: string
      className?: string
    }) => (
      <a href={to} className={className} {...rest}>
        {children}
      </a>
    ),
  }
})

vi.mock('@/lib/utils', async (orig) => ({
  ...(await orig()),
  sleep: vi.fn(() => Promise.resolve()),
}))

describe('UserAuthForm', () => {
  // 断言用的是中文文案，显式固定语言。
  beforeEach(() => {
    useI18nStore.getState().setLocale('zh')
  })

  describe('Rendering without redirectTo', () => {
    let screen: RenderResult
    let usernameInput: Locator
    let passwordInput: Locator
    let signInButton: Locator

    beforeEach(async () => {
      vi.clearAllMocks()
      screen = await render(<UserAuthForm />)
      usernameInput = screen.getByRole('textbox', { name: '管理员账号' })
      passwordInput = screen.getByLabelText('密码')
      signInButton = screen.getByRole('button', { name: '登录' })
    })

    it('renders administrator credential fields and submit button', async () => {
      await expect.element(usernameInput).toBeInTheDocument()
      await expect.element(passwordInput).toBeInTheDocument()
      await expect.element(signInButton).toBeInTheDocument()
    })

    it('shows validation messages when submitting empty form', async () => {
      await userEvent.click(signInButton)

      await expect
        .element(screen.getByText(FORM_MESSAGES.usernameEmpty))
        .toBeInTheDocument()
      await expect
        .element(screen.getByText(FORM_MESSAGES.passwordEmpty))
        .toBeInTheDocument()
    })

    it('authenticates and navigates to default route on success', async () => {
      await userEvent.fill(usernameInput, 'admin')
      await userEvent.fill(passwordInput, 'admin')

      await userEvent.click(signInButton)

      await vi.waitFor(() => expect(setUserMock).toHaveBeenCalledOnce())
      expect(setUserMock).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'admin',
          accountNo: 'admin',
          role: ['admin'],
          exp: expect.any(Number),
        })
      )
      expect(setAccessTokenMock).toHaveBeenCalledOnce()
      expect(setAccessTokenMock).toHaveBeenCalledWith('admin-jwt-token')

      await vi.waitFor(() =>
        expect(navigate).toHaveBeenCalledWith({ to: '/relays', replace: true })
      )
    })
  })

  it('navigates to redirectTo when provided', async () => {
    vi.clearAllMocks()

    const { getByRole, getByLabelText } = await render(
      <UserAuthForm redirectTo='/models' />
    )

    await userEvent.fill(getByRole('textbox', { name: '管理员账号' }), 'admin')
    await userEvent.fill(getByLabelText('密码'), 'admin')

    await userEvent.click(getByRole('button', { name: '登录' }))

    await vi.waitFor(() => expect(setUserMock).toHaveBeenCalledOnce())
    expect(setAccessTokenMock).toHaveBeenCalledOnce()

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: '/models',
        replace: true,
      })
    )
  })

  it('does not redirect an administrator to the public tutorial', async () => {
    vi.clearAllMocks()

    const { getByRole, getByLabelText } = await render(
      <UserAuthForm redirectTo='/#quick-start' />
    )

    await userEvent.fill(getByRole('textbox', { name: '管理员账号' }), 'admin')
    await userEvent.fill(getByLabelText('密码'), 'admin')
    await userEvent.click(getByRole('button', { name: '登录' }))

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/relays', replace: true })
    )
  })
})
