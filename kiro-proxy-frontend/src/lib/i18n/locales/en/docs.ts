import type { docs as zh } from '../zh/docs'

export const docs: typeof zh = {
  meta: {
    title: 'Kiro RelayRouter Guides',
    description:
      'How to install Kiro RelayRouter, sign in with a token, pick a model, and get the most out of Kiro Agent.',
  },
  subtitle: 'Guides',
  nav: {
    guides: 'Guides',
  },
  toc: {
    trigger: 'Contents',
    label: 'Guide contents',
    description: 'Pick a section to jump straight to it.',
  },
  loading: 'Loading guides…',
  error: {
    title: 'Guides are unavailable right now',
    description: 'Make sure the backend is running, then refresh the page.',
  },
  empty: {
    description:
      'The guides are still being written. They will show up here as soon as they are published.',
  },
  lightbox: {
    close: 'Close image preview',
  },
}
