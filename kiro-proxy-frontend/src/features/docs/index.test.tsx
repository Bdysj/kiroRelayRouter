import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { DocsPayload } from '@/lib/api/docs'
import { DocsPage } from './index'

let payload: DocsPayload

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: payload,
    isLoading: false,
    isError: false,
    isSuccess: true,
  }),
}))

describe('DocsPage scrolling', () => {
  beforeEach(() => {
    payload = createPayload()
    window.history.replaceState(null, '', `${window.location.pathname}#first`)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState(null, '', window.location.pathname)
  })

  it('does not replay initial hash navigation when docs are refreshed', async () => {
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => undefined)
    const view = await render(<DocsPage />)

    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce())

    payload = { ...payload, sections: [...payload.sections] }
    await view.rerender(<DocsPage />)

    expect(scrollIntoView).toHaveBeenCalledOnce()
  })

  it('does not turn passive scrolling into hash navigation', async () => {
    payload = createPayloadWithTwoArticles()
    window.history.replaceState(null, '', `${window.location.pathname}#second`)
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => undefined)
    await render(<DocsPage />)

    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce())
    vi.spyOn(
      document.getElementById('first')!,
      'getBoundingClientRect'
    ).mockReturnValue(rect(-200))
    vi.spyOn(
      document.getElementById('second')!,
      'getBoundingClientRect'
    ).mockReturnValue(rect(140))

    window.dispatchEvent(new Event('scroll'))

    await vi.waitFor(() =>
      expect(
        document.querySelector('button[aria-current="location"]')?.textContent
      ).toContain('First article')
    )
    expect(window.location.hash).toBe('#second')
    expect(scrollIntoView).toHaveBeenCalledOnce()
  })
})

function createPayload(): DocsPayload {
  return {
    title: 'Guide',
    updatedAt: null,
    sections: [
      {
        id: 1,
        title: 'Getting started',
        sortOrder: 0,
        enabled: true,
        createdAt: '',
        updatedAt: '',
        children: [
          {
            id: 1,
            categoryId: 1,
            title: 'First article',
            slug: 'first',
            contentHtml: '<p>Long article</p>',
            sortOrder: 0,
            status: 'PUBLISHED',
            publishedAt: null,
            createdAt: '',
            updatedAt: '',
          },
        ],
      },
    ],
  }
}

function createPayloadWithTwoArticles(): DocsPayload {
  const value = createPayload()
  return {
    ...value,
    sections: [
      {
        ...value.sections[0],
        children: [
          ...value.sections[0].children,
          {
            ...value.sections[0].children[0],
            id: 2,
            title: 'Second article',
            slug: 'second',
          },
        ],
      },
    ],
  }
}

function rect(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 0,
    bottom: top,
    left: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  }
}
