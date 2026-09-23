import { useEffect, useRef, useState } from 'react'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  Bold,
  Code,
  Code2,
  ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import { uploadDocImage } from '@/lib/api/docs'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export function DocsEditor({
  content,
  articleId,
  uploadSessionId,
  onChange,
}: {
  content: string
  articleId?: number
  uploadSessionId: string
  onChange: (html: string) => void
}) {
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      Image.configure({ allowBase64: false }),
    ],
    content,
    editorProps: {
      attributes: {
        class: 'docs-editor-content min-h-[500px] px-5 py-5 focus:outline-none',
      },
    },
    onUpdate: ({ editor: instance }) => onChange(instance.getHTML()),
  })

  useEffect(() => {
    if (editor && editor.getHTML() !== content)
      editor.commands.setContent(content || '<p></p>', { emitUpdate: false })
  }, [content, editor])

  async function addImage(file?: File) {
    if (!file || !editor) return
    setUploading(true)
    try {
      const asset = await uploadDocImage(file, articleId, uploadSessionId)
      editor.chain().focus().setImage({ src: asset.url, alt: file.name }).run()
      toast.success('图片已上传')
    } catch (error) {
      toast.error(apiMessage(error, '图片上传失败'))
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  if (!editor) return null
  const tool = (
    label: string,
    active: boolean,
    action: () => void,
    icon: React.ReactNode
  ) => (
    <Button
      type='button'
      aria-label={label}
      title={label}
      variant={active ? 'secondary' : 'ghost'}
      size='sm'
      className='h-8 min-w-8 px-2'
      onClick={action}
    >
      {icon}
    </Button>
  )

  return (
    <div
      className='overflow-hidden rounded-lg border bg-background'
      onPasteCapture={(event) => {
        const imageItem = Array.from(event.clipboardData.items).find(
          (item) => item.kind === 'file' && item.type.startsWith('image/')
        )
        const image = imageItem?.getAsFile()
        if (!image) return
        event.preventDefault()
        void addImage(image)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        void addImage(
          Array.from(event.dataTransfer.files).find((file) =>
            file.type.startsWith('image/')
          )
        )
      }}
    >
      <div className='flex flex-wrap items-center gap-0.5 border-b bg-muted/30 p-2'>
        {tool(
          '一级标题',
          editor.isActive('heading', { level: 1 }),
          () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
          <span className='text-xs font-bold'>H1</span>
        )}
        {tool(
          '二级标题',
          editor.isActive('heading', { level: 2 }),
          () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
          <span className='text-xs font-bold'>H2</span>
        )}
        {tool(
          '三级标题',
          editor.isActive('heading', { level: 3 }),
          () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
          <span className='text-xs font-bold'>H3</span>
        )}
        <span className='mx-1 h-5 border-l' />
        {tool(
          '粗体',
          editor.isActive('bold'),
          () => editor.chain().focus().toggleBold().run(),
          <Bold className='size-4' />
        )}
        {tool(
          '斜体',
          editor.isActive('italic'),
          () => editor.chain().focus().toggleItalic().run(),
          <Italic className='size-4' />
        )}
        {tool(
          '行内代码',
          editor.isActive('code'),
          () => editor.chain().focus().toggleCode().run(),
          <Code className='size-4' />
        )}
        {tool(
          '代码块',
          editor.isActive('codeBlock'),
          () => editor.chain().focus().toggleCodeBlock().run(),
          <Code2 className='size-4' />
        )}
        {tool(
          '无序列表',
          editor.isActive('bulletList'),
          () => editor.chain().focus().toggleBulletList().run(),
          <List className='size-4' />
        )}
        {tool(
          '有序列表',
          editor.isActive('orderedList'),
          () => editor.chain().focus().toggleOrderedList().run(),
          <ListOrdered className='size-4' />
        )}
        {tool(
          '引用',
          editor.isActive('blockquote'),
          () => editor.chain().focus().toggleBlockquote().run(),
          <Quote className='size-4' />
        )}
        {tool(
          '链接',
          editor.isActive('link'),
          () => {
            const url = window.prompt(
              '请输入链接地址',
              editor.getAttributes('link').href ?? 'https://'
            )
            if (url === null) return
            if (!url) editor.chain().focus().unsetLink().run()
            else
              editor
                .chain()
                .focus()
                .extendMarkRange('link')
                .setLink({ href: url })
                .run()
          },
          <Link2 className='size-4' />
        )}
        {tool(
          '分隔线',
          false,
          () => editor.chain().focus().setHorizontalRule().run(),
          <Minus className='size-4' />
        )}
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='h-8 px-2'
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? (
            <Upload className='size-4 animate-pulse' />
          ) : (
            <ImageIcon className='size-4' />
          )}
          <span className='sr-only'>上传图片</span>
        </Button>
        <input
          ref={inputRef}
          type='file'
          accept='image/png,image/jpeg,image/gif,image/webp'
          className='hidden'
          onChange={(event) => void addImage(event.target.files?.[0])}
        />
      </div>
      <EditorContent editor={editor} className={cn('docs-editor')} />
    </div>
  )
}

function apiMessage(error: unknown, fallback: string) {
  if (typeof error === 'object' && error && 'response' in error) {
    const response = (
      error as { response?: { data?: { message?: string; detail?: string } } }
    ).response
    return response?.data?.message ?? response?.data?.detail ?? fallback
  }
  return error instanceof Error ? error.message : fallback
}
