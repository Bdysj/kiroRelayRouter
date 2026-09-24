import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import DOMPurify from 'dompurify'
import { BookOpen, Loader2, Menu, X } from 'lucide-react'
import { getPublicDocs, type DocCategory } from '@/lib/api/docs'
import { useTranslation } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { LanguageSwitch } from '@/components/language-switch'
import { ThemeSwitch } from '@/components/theme-switch'

export function DocsPage() {
  const { t } = useTranslation()
  const docs = useQuery({ queryKey: ['public-docs'], queryFn: getPublicDocs })
  const [selectedArticle, setSelectedArticle] = useState(() =>
    decodeURIComponent(window.location.hash.slice(1))
  )
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const initialHashHandled = useRef(false)
  const sections = useMemo(() => docs.data?.sections ?? [], [docs.data])
  const articles = useMemo(
    () => sections.flatMap((section) => section.children),
    [sections]
  )
  const active = useMemo(
    () =>
      articles.some((item) => item.slug === selectedArticle)
        ? selectedArticle
        : (articles[0]?.slug ?? ''),
    [articles, selectedArticle]
  )

  useEffect(() => {
    document.title = t('docs.meta.title')
    setMeta('description', t('docs.meta.description'))
    setMeta('og:title', t('docs.meta.title'), true)
    setMeta('og:description', t('docs.meta.description'), true)
  }, [t])

  useEffect(() => {
    if (!articles.length) return
    const syncActiveArticle = () => {
      // The active entry is the last article whose heading has passed the
      // sticky header.  Unlike an IntersectionObserver activation band, this
      // remains on the current article while scrolling upward through the end
      // of the preceding one; it never turns a passive scroll into a jump.
      const headerOffset = 96
      const current = articles.reduce<string>((activeSlug, article) => {
        const node = document.getElementById(article.slug)
        return node && node.getBoundingClientRect().top <= headerOffset
          ? article.slug
          : activeSlug
      }, articles[0].slug)
      setSelectedArticle((previous) =>
        previous === current ? previous : current
      )
    }
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        syncActiveArticle()
      })
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [articles])

  useEffect(() => {
    if (!articles.length || initialHashHandled.current) return

    const hash = decodeURIComponent(window.location.hash.slice(1))
    const target = hash ? document.getElementById(hash) : null
    if (target) target.scrollIntoView({ block: 'start' })

    // Hash navigation is initialization-only. Public docs can be refetched
    // while the reader is scrolling; replaying it after a refetch would jump
    // from the end of the previous article back to its heading.
    initialHashHandled.current = true
  }, [articles])

  useEffect(() => {
    if (!lightbox) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightbox(null)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [lightbox])

  function navigate(slug: string) {
    setSelectedArticle(slug)
    setDrawerOpen(false)
    window.history.pushState(
      null,
      '',
      `${window.location.pathname}#${encodeURIComponent(slug)}`
    )
    document
      .getElementById(slug)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className='min-h-svh bg-background text-foreground'>
      <header className='sticky top-0 z-40 h-16 border-b bg-background/90 backdrop-blur-md'>
        <div className='mx-auto flex h-full max-w-[1360px] items-center px-5 sm:px-8'>
          <a
            href='/'
            className='flex items-center gap-2.5 font-semibold tracking-tight'
          >
            <span className='flex size-8 items-center justify-center rounded-lg border bg-foreground text-background'>
              <BookOpen className='size-4' />
            </span>
            <span>Kiro RelayRouter</span>
          </a>
          <span className='ml-4 hidden border-l pl-4 text-sm text-muted-foreground sm:inline'>
            {t('docs.subtitle')}
          </span>
          <nav className='ml-auto flex items-center gap-1 sm:gap-3'>
            <a
              href='/docs'
              className='hidden px-2 text-sm font-medium sm:block'
            >
              {t('docs.nav.guides')}
            </a>
            <LanguageSwitch />
            <ThemeSwitch />
          </nav>
        </div>
      </header>
      <div className='mx-auto max-w-[1360px] px-5 sm:px-8'>
        <div className='flex items-center border-b py-4 md:hidden'>
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <Button variant='outline' size='sm'>
                <Menu className='size-4' /> {t('docs.toc.trigger')}
              </Button>
            </SheetTrigger>
            <SheetContent side='left' className='w-[86%] max-w-80 gap-0 p-0'>
              <SheetHeader className='border-b px-5 py-5 text-left'>
                <SheetTitle>{t('docs.toc.label')}</SheetTitle>
                <SheetDescription>{t('docs.toc.description')}</SheetDescription>
              </SheetHeader>
              <div className='overflow-y-auto px-4 py-5'>
                <DocsNavigation
                  sections={sections}
                  active={active}
                  onSelect={navigate}
                />
              </div>
            </SheetContent>
          </Sheet>
          {active && (
            <span className='ml-3 truncate text-sm text-muted-foreground'>
              {articles.find((item) => item.slug === active)?.title}
            </span>
          )}
        </div>
        <div className='grid md:grid-cols-[250px_minmax(0,1fr)] md:gap-12 lg:gap-16'>
          <aside className='hidden md:block'>
            <div className='sticky top-[88px] max-h-[calc(100svh-112px)] overflow-y-auto py-9 pr-5'>
              <DocsNavigation
                sections={sections}
                active={active}
                onSelect={navigate}
              />
            </div>
          </aside>
          <main
            className='max-w-[840px] min-w-0 py-10 md:py-14'
            onClick={(event) => {
              if (event.target instanceof HTMLImageElement)
                setLightbox(event.target.src)
            }}
          >
            {docs.isLoading && (
              <div className='flex items-center gap-2 py-24 text-sm text-muted-foreground'>
                <Loader2 className='size-4 animate-spin' /> {t('docs.loading')}
              </div>
            )}
            {docs.isError && (
              <div className='rounded-xl border p-6'>
                <h1 className='text-xl font-semibold'>
                  {t('docs.error.title')}
                </h1>
                <p className='mt-2 text-sm text-muted-foreground'>
                  {t('docs.error.description')}
                </p>
              </div>
            )}
            {docs.isSuccess && articles.length === 0 && (
              <div className='py-20'>
                <p className='text-sm font-medium text-muted-foreground'>
                  Kiro RelayRouter
                </p>
                <h1 className='mt-3 text-3xl font-semibold tracking-tight sm:text-4xl'>
                  {t('docs.subtitle')}
                </h1>
                <p className='mt-5 max-w-xl text-base leading-8 text-muted-foreground'>
                  {t('docs.empty.description')}
                </p>
              </div>
            )}
            {sections.map((section) => (
              <div key={section.id} className='mb-14 last:mb-0'>
                <div className='mb-7 border-b pb-3'>
                  <p className='text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase'>
                    {section.title}
                  </p>
                </div>
                {section.children.map((article) => (
                  <section
                    id={article.slug}
                    key={article.id}
                    className='docs-prose mb-16 scroll-mt-24 last:mb-0'
                  >
                    <h1>{article.title}</h1>
                    <div
                      dangerouslySetInnerHTML={{
                        __html: DOMPurify.sanitize(article.contentHtml),
                      }}
                    />
                  </section>
                ))}
              </div>
            ))}
          </main>
        </div>
      </div>
      {lightbox && (
        <button
          type='button'
          aria-label={t('docs.lightbox.close')}
          className='fixed inset-0 z-[80] flex cursor-zoom-out items-center justify-center bg-black/85 p-5'
          onClick={() => setLightbox(null)}
        >
          <X className='absolute top-5 right-5 size-6 text-white' />
          <img
            src={lightbox}
            alt=''
            className='max-h-[92svh] max-w-full rounded-lg object-contain'
          />
        </button>
      )}
    </div>
  )
}

function DocsNavigation({
  sections,
  active,
  onSelect,
}: {
  sections: DocCategory[]
  active: string
  onSelect: (slug: string) => void
}) {
  const { t } = useTranslation()

  return (
    <nav aria-label={t('docs.toc.label')} className='space-y-7'>
      {sections.map((section) => {
        const sectionActive = section.children.some(
          (article) => article.slug === active
        )
        return (
          <section
            key={section.id}
            aria-labelledby={`docs-section-${section.id}`}
          >
            <div
              id={`docs-section-${section.id}`}
              className={cn(
                'flex items-center gap-2.5 px-2 text-[15px] font-semibold tracking-tight transition-colors',
                sectionActive ? 'text-foreground' : 'text-foreground/80'
              )}
            >
              <span
                aria-hidden='true'
                className={cn(
                  'size-2 rounded-full border transition-colors',
                  sectionActive
                    ? 'border-foreground bg-foreground'
                    : 'border-muted-foreground/40 bg-background'
                )}
              />
              <span className='min-w-0 truncate' title={section.title}>
                {section.title}
              </span>
            </div>
            <div className='mt-2 ml-[11px] space-y-1 border-l pl-3'>
              {section.children.map((article) => (
                <button
                  type='button'
                  key={article.id}
                  onClick={() => onSelect(article.slug)}
                  aria-current={
                    active === article.slug ? 'location' : undefined
                  }
                  title={article.title}
                  className={cn(
                    'relative block w-full rounded-r-md px-3 py-2 text-left text-sm leading-5 transition-colors before:absolute before:top-1/2 before:-left-[13px] before:h-px before:w-3 before:bg-border',
                    active === article.slug
                      ? 'bg-muted font-medium text-foreground before:bg-foreground'
                      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  )}
                >
                  <span className='block truncate'>{article.title}</span>
                </button>
              ))}
            </div>
          </section>
        )
      })}
    </nav>
  )
}

function setMeta(name: string, content: string, property = false) {
  const selector = property
    ? `meta[property="${name}"]`
    : `meta[name="${name}"]`
  let element = document.head.querySelector<HTMLMetaElement>(selector)
  if (!element) {
    element = document.createElement('meta')
    element.setAttribute(property ? 'property' : 'name', name)
    document.head.appendChild(element)
  }
  element.content = content
}
