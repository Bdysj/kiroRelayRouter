import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { DocsEditor } from './editor'

const { uploadDocImage } = vi.hoisted(() => ({
  uploadDocImage: vi.fn(async () => ({
    id: 1,
    key: 'relayrouter/docs/pasted.png',
    url: 'https://files.example.test/relayrouter/docs/pasted.png',
  })),
}))

vi.mock('@/lib/api/docs', () => ({ uploadDocImage }))

describe('DocsEditor', () => {
  it('uploads and inserts an image pasted from the clipboard', async () => {
    await render(
      <DocsEditor
        content='<p>Paste here</p>'
        uploadSessionId='test-session-123'
        onChange={vi.fn()}
      />
    )
    const editor = document.querySelector('.docs-editor-content')
    expect(editor).not.toBeNull()

    const image = new File(['image'], 'clipboard.png', { type: 'image/png' })
    const clipboard = new DataTransfer()
    clipboard.items.add(image)
    editor!.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      })
    )

    await vi.waitFor(() =>
      expect(uploadDocImage).toHaveBeenCalledWith(
        image,
        undefined,
        'test-session-123'
      )
    )
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLImageElement>('.docs-editor-content img')
          ?.src
      ).toBe('https://files.example.test/relayrouter/docs/pasted.png')
    )
  })
})
