import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { TokenInput } from './token-input'

it('allows replacing zero without a number stepper', async () => {
  const change = vi.fn()
  const { getByRole } = await render(
    <TokenInput value={0} onValueChange={change} aria-label='Minimum tokens' />
  )
  const input = getByRole('textbox', { name: 'Minimum tokens' })

  await expect.element(input).toHaveAttribute('type', 'text')
  await userEvent.clear(input)
  await expect.element(input).toHaveValue('')
  await userEvent.type(input, '272001')

  await expect.element(input).toHaveValue('272001')
  expect(change).toHaveBeenLastCalledWith(272001)
})

it('keeps an empty maximum token value as null', async () => {
  const change = vi.fn()
  const { getByRole } = await render(
    <TokenInput
      nullable
      value={272000}
      onValueChange={change}
      aria-label='Maximum tokens'
    />
  )

  await userEvent.clear(getByRole('textbox', { name: 'Maximum tokens' }))

  expect(change).toHaveBeenLastCalledWith(null)
})
