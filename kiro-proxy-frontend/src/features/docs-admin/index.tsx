import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  EyeOff,
  FilePlus2,
  FolderPlus,
  Loader2,
  Pencil,
  Save,
  Send,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  createDocArticle,
  createDocCategory,
  deleteDocArticle,
  deleteDocCategory,
  getAdminDocs,
  updateDocArticle,
  updateDocCategory,
  type ArticleInput,
  type CategoryInput,
  type DocArticle,
  type DocCategory,
} from '@/lib/api/docs'
import { t as translate, useTranslation } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ConfigDrawer } from '@/components/config-drawer'
import { LanguageSwitch } from '@/components/language-switch'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import { DocsEditor } from './editor'

const emptyCategory: CategoryInput = {
  title: '',
  sortOrder: 0,
  enabled: false,
}
const emptyArticle = (categoryId: number): ArticleInput => ({
  categoryId,
  title: '',
  slug: '',
  contentHtml: '<p></p>',
  sortOrder: 0,
  status: 'DRAFT',
  uploadSessionId: crypto.randomUUID(),
})

export function DocsAdminPage() {
  const { t } = useTranslation()
  const client = useQueryClient()
  const docs = useQuery({ queryKey: ['admin-docs'], queryFn: getAdminDocs })
  const categories = docs.data?.sections ?? []
  const allArticles = useMemo(
    () => categories.flatMap((item) => item.children),
    [categories]
  )
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const selected = allArticles.find((item) => item.id === selectedId)
  const [draft, setDraft] = useState<ArticleInput | null>(null)
  const [categoryDialog, setCategoryDialog] = useState<
    DocCategory | 'new' | null
  >(null)
  const [categoryDraft, setCategoryDraft] =
    useState<CategoryInput>(emptyCategory)

  useEffect(() => {
    if (selected)
      setDraft({
        categoryId: selected.categoryId,
        title: selected.title,
        slug: selected.slug,
        contentHtml: selected.contentHtml,
        sortOrder: selected.sortOrder,
        status: selected.status,
        uploadSessionId: crypto.randomUUID(),
      })
  }, [selected])
  useEffect(() => {
    if (selectedId === null && allArticles[0]) setSelectedId(allArticles[0].id)
  }, [allArticles, selectedId])

  const refresh = () => client.invalidateQueries({ queryKey: ['admin-docs'] })
  const saveArticle = useMutation({
    mutationFn: async (status: ArticleInput['status']) => {
      if (!draft) throw new Error(t('docsAdmin.error.noArticleSelected'))
      const payload = {
        ...draft,
        status,
      }
      return selected
        ? updateDocArticle(selected.id, payload)
        : createDocArticle(payload)
    },
    onSuccess: (article) => {
      setSelectedId(article.id)
      setDraft((current) =>
        current ? { ...current, status: article.status } : current
      )
      void refresh()
      toast.success(
        article.status === 'PUBLISHED'
          ? t('docsAdmin.toast.articlePublished')
          : selected?.status === 'PUBLISHED'
            ? t('docsAdmin.toast.articleHidden')
            : t('docsAdmin.toast.draftSaved')
      )
    },
    onError: (error) => toast.error(message(error)),
  })
  const categoryMutation = useMutation({
    mutationFn: () =>
      categoryDialog === 'new'
        ? createDocCategory(categoryDraft)
        : updateDocCategory((categoryDialog as DocCategory).id, categoryDraft),
    onSuccess: () => {
      setCategoryDialog(null)
      void refresh()
      toast.success(t('docsAdmin.toast.categorySaved'))
    },
    onError: (error) => toast.error(message(error)),
  })

  function openCategory(category?: DocCategory) {
    setCategoryDialog(category ?? 'new')
    setCategoryDraft(
      category
        ? {
            title: category.title,
            sortOrder: category.sortOrder,
            enabled: category.enabled,
          }
        : { ...emptyCategory, sortOrder: categories.length }
    )
  }
  function newArticle(category: DocCategory) {
    setSelectedId(-1)
    setDraft({
      ...emptyArticle(category.id),
      sortOrder: category.children.length,
    })
  }
  async function moveArticle(article: DocArticle, direction: -1 | 1) {
    const category = categories.find((item) => item.id === article.categoryId)
    if (!category) return
    const index = category.children.findIndex((item) => item.id === article.id)
    const other = category.children[index + direction]
    if (!other) return
    try {
      await Promise.all([
        updateDocArticle(article.id, toArticleInput(article, other.sortOrder)),
        updateDocArticle(other.id, toArticleInput(other, article.sortOrder)),
      ])
      await refresh()
    } catch (error) {
      toast.error(message(error))
    }
  }

  return (
    <>
      <Header fixed>
        <div>
          <h1 className='text-base font-semibold'>{t('docsAdmin.title')}</h1>
          <p className='text-xs text-muted-foreground'>
            {t('docsAdmin.description')}
          </p>
        </div>
        <div className='ml-auto flex items-center gap-2'>
          <Button variant='outline' size='sm' asChild>
            <a href='/docs' target='_blank' rel='noreferrer'>
              <BookOpen />
              {t('docsAdmin.previewDocs')}
            </a>
          </Button>
          <LanguageSwitch />
          <ThemeSwitch />
          <ConfigDrawer />
        </div>
      </Header>
      <Main fluid className='flex min-h-0 flex-1 flex-col'>
        <div className='mb-4 flex items-center justify-between'>
          <div>
            <h2 className='text-2xl font-bold tracking-tight'>
              {t('docsAdmin.contentTitle')}
            </h2>
            <p className='text-sm text-muted-foreground'>
              {t('docsAdmin.contentDescription')}
            </p>
          </div>
          <Button onClick={() => openCategory()}>
            <FolderPlus />
            {t('docsAdmin.category.create')}
          </Button>
        </div>
        <div className='grid min-h-[680px] flex-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]'>
          <Card className='gap-0 overflow-hidden py-0'>
            <div className='border-b px-4 py-3 text-sm font-semibold'>
              {t('docsAdmin.sidebar.title')}
            </div>
            <div className='max-h-[calc(100svh-210px)] overflow-y-auto p-2'>
              {docs.isLoading && (
                <div className='flex justify-center py-12'>
                  <Loader2 className='size-5 animate-spin' />
                </div>
              )}
              {categories.map((category) => (
                <div key={category.id} className='mb-3'>
                  <div className='group flex items-center gap-1 rounded-md px-2 py-1.5'>
                    <span className='min-w-0 flex-1 truncate text-sm font-semibold'>
                      {category.title}
                    </span>
                    <span className='text-[10px] text-muted-foreground'>
                      {category.enabled
                        ? t('common.state.enabled')
                        : t('docsAdmin.status.draft')}
                    </span>
                    <Button
                      variant='ghost'
                      size='icon'
                      className='size-7 opacity-60 group-hover:opacity-100'
                      onClick={() => openCategory(category)}
                    >
                      <Pencil className='size-3.5' />
                    </Button>
                    <Button
                      variant='ghost'
                      size='icon'
                      className='size-7'
                      onClick={() => newArticle(category)}
                    >
                      <FilePlus2 className='size-3.5' />
                    </Button>
                  </div>
                  <div className='ml-3 border-l pl-2'>
                    {category.children.map((article, index) => (
                      <div
                        key={article.id}
                        className={`group flex items-center rounded-md ${selectedId === article.id ? 'bg-muted' : ''}`}
                      >
                        <button
                          className='min-w-0 flex-1 truncate px-2 py-2 text-left text-sm'
                          onClick={() => setSelectedId(article.id)}
                        >
                          {article.title}
                          <span className='ml-1.5 text-[10px] text-muted-foreground'>
                            {article.status === 'PUBLISHED'
                              ? t('docsAdmin.status.published')
                              : t('docsAdmin.status.draft')}
                          </span>
                        </button>
                        <div className='hidden pr-1 group-hover:flex'>
                          <Button
                            variant='ghost'
                            size='icon'
                            className='size-6'
                            disabled={index === 0}
                            onClick={() => void moveArticle(article, -1)}
                          >
                            <ArrowUp className='size-3' />
                          </Button>
                          <Button
                            variant='ghost'
                            size='icon'
                            className='size-6'
                            disabled={index === category.children.length - 1}
                            onClick={() => void moveArticle(article, 1)}
                          >
                            <ArrowDown className='size-3' />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {!docs.isLoading && categories.length === 0 && (
                <p className='px-3 py-10 text-center text-sm text-muted-foreground'>
                  {t('docsAdmin.sidebar.emptyCategories')}
                </p>
              )}
            </div>
          </Card>
          <Card className='min-w-0 gap-0 overflow-hidden py-0'>
            {!draft ? (
              <div className='flex h-full min-h-[560px] items-center justify-center text-sm text-muted-foreground'>
                {t('docsAdmin.article.emptySelection')}
              </div>
            ) : (
              <>
                <div className='flex flex-wrap items-center gap-2 border-b px-5 py-3'>
                  <div className='mr-auto'>
                    <h3 className='font-semibold'>
                      {selected
                        ? t('docsAdmin.article.editTitle')
                        : t('docsAdmin.article.createTitle')}
                    </h3>
                    <p className='text-xs text-muted-foreground'>
                      {draft.status === 'PUBLISHED'
                        ? t('docsAdmin.article.publishedHint')
                        : t('docsAdmin.article.draftHint')}
                    </p>
                  </div>
                  {selected && (
                    <Button
                      variant='ghost'
                      size='sm'
                      className='text-destructive'
                      onClick={async () => {
                        if (
                          !window.confirm(t('docsAdmin.confirm.deleteArticle'))
                        )
                          return
                        try {
                          await deleteDocArticle(selected.id)
                          setSelectedId(null)
                          setDraft(null)
                          await refresh()
                          toast.success(t('docsAdmin.toast.articleDeleted'))
                        } catch (error) {
                          toast.error(message(error))
                        }
                      }}
                    >
                      <Trash2 />
                      {t('common.action.delete')}
                    </Button>
                  )}
                  <Button
                    variant='outline'
                    size='sm'
                    disabled={saveArticle.isPending}
                    onClick={() => saveArticle.mutate('DRAFT')}
                  >
                    {draft.status === 'PUBLISHED' ? <EyeOff /> : <Save />}
                    {draft.status === 'PUBLISHED'
                      ? t('docsAdmin.article.hide')
                      : t('docsAdmin.article.saveDraft')}
                  </Button>
                  <Button
                    size='sm'
                    disabled={saveArticle.isPending}
                    onClick={() => saveArticle.mutate('PUBLISHED')}
                  >
                    <Send />
                    {t('common.action.publish')}
                  </Button>
                </div>
                <div className='space-y-5 p-5'>
                  <div className='grid gap-4 sm:grid-cols-2'>
                    <Field label={t('docsAdmin.article.titleLabel')}>
                      <Input
                        value={draft.title}
                        onChange={(event) =>
                          setDraft({ ...draft, title: event.target.value })
                        }
                        placeholder={t('docsAdmin.article.titlePlaceholder')}
                      />
                    </Field>
                    <Field label={t('docsAdmin.article.categoryLabel')}>
                      <select
                        className='h-9 w-full rounded-md border bg-transparent px-3 text-sm'
                        value={draft.categoryId}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            categoryId: Number(event.target.value),
                          })
                        }
                      >
                        {categories.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.title}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t('docsAdmin.article.sortOrderLabel')}>
                      <Input
                        type='number'
                        value={draft.sortOrder}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            sortOrder: Number(event.target.value),
                          })
                        }
                      />
                    </Field>
                  </div>
                  <div>
                    <Label className='mb-2'>
                      {t('docsAdmin.article.contentLabel')}
                    </Label>
                    <DocsEditor
                      key={selected?.id ?? `new-${draft.categoryId}`}
                      content={draft.contentHtml}
                      articleId={selected?.id}
                      uploadSessionId={draft.uploadSessionId!}
                      onChange={(contentHtml) =>
                        setDraft((value) =>
                          value ? { ...value, contentHtml } : value
                        )
                      }
                    />
                    <p className='mt-2 text-xs text-muted-foreground'>
                      {t('docsAdmin.article.uploadHint')}
                    </p>
                  </div>
                </div>
              </>
            )}
          </Card>
        </div>
      </Main>
      <Dialog
        open={categoryDialog !== null}
        onOpenChange={(open) => {
          if (!open) setCategoryDialog(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {categoryDialog === 'new'
                ? t('docsAdmin.category.create')
                : t('docsAdmin.category.edit')}
            </DialogTitle>
            <DialogDescription>
              {t('docsAdmin.category.dialogDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-4'>
            <Field label={t('docsAdmin.category.nameLabel')}>
              <Input
                value={categoryDraft.title}
                onChange={(event) =>
                  setCategoryDraft({
                    ...categoryDraft,
                    title: event.target.value,
                  })
                }
              />
            </Field>
            <Field label={t('docsAdmin.category.sortOrderLabel')}>
              <Input
                type='number'
                value={categoryDraft.sortOrder}
                onChange={(event) =>
                  setCategoryDraft({
                    ...categoryDraft,
                    sortOrder: Number(event.target.value),
                  })
                }
              />
            </Field>
            <div className='flex items-center justify-between rounded-lg border p-3'>
              <div>
                <Label>{t('docsAdmin.category.publicLabel')}</Label>
                <p className='text-xs text-muted-foreground'>
                  {t('docsAdmin.category.publicHint')}
                </p>
              </div>
              <Switch
                checked={categoryDraft.enabled}
                onCheckedChange={(enabled) =>
                  setCategoryDraft({ ...categoryDraft, enabled })
                }
              />
            </div>
          </div>
          <DialogFooter>
            {categoryDialog !== 'new' && (
              <Button
                variant='destructive'
                className='mr-auto'
                onClick={async () => {
                  const category = categoryDialog as DocCategory
                  if (!window.confirm(t('docsAdmin.category.confirmDelete')))
                    return
                  try {
                    await deleteDocCategory(category.id)
                    setCategoryDialog(null)
                    await refresh()
                    toast.success(t('docsAdmin.toast.categoryDeleted'))
                  } catch (error) {
                    toast.error(message(error))
                  }
                }}
              >
                <Trash2 />
                {t('docsAdmin.category.delete')}
              </Button>
            )}
            <Button variant='outline' onClick={() => setCategoryDialog(null)}>
              {t('common.action.cancel')}
            </Button>
            <Button
              disabled={categoryMutation.isPending}
              onClick={() => categoryMutation.mutate()}
            >
              {categoryMutation.isPending && (
                <Loader2 className='animate-spin' />
              )}
              {t('common.action.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className='space-y-2'>
      <Label>{label}</Label>
      {children}
    </div>
  )
}
function toArticleInput(article: DocArticle, sortOrder: number): ArticleInput {
  return {
    categoryId: article.categoryId,
    title: article.title,
    slug: article.slug,
    contentHtml: article.contentHtml,
    sortOrder,
    status: article.status,
  }
}
function message(error: unknown) {
  if (typeof error === 'object' && error && 'response' in error) {
    const response = (
      error as {
        response?: {
          data?: { message?: string; detail?: string; error?: string }
        }
      }
    ).response
    return (
      response?.data?.message ??
      response?.data?.detail ??
      response?.data?.error ??
      translate('docsAdmin.error.actionFailed')
    )
  }
  return error instanceof Error
    ? error.message
    : translate('docsAdmin.error.actionFailed')
}
