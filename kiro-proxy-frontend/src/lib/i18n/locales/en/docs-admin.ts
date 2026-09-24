import type { docsAdmin as zh } from '../zh/docs-admin'

export const docsAdmin: typeof zh = {
  title: 'Guide management',
  description: 'Edit public guides and categories',
  previewDocs: 'Preview guides',
  contentTitle: 'Content',
  contentDescription:
    'Only published articles in enabled categories are visible to the public.',
  sidebar: {
    title: 'Categories',
    emptyCategories: 'Create a category first',
  },
  status: {
    published: 'Published',
    draft: 'Draft',
  },
  article: {
    emptySelection: 'Select an article, or create one from a category',
    editTitle: 'Edit guide',
    createTitle: 'New guide',
    publishedHint: 'Published · hide it to edit, then publish again',
    draftHint: 'Drafts are admin-only and go public once published',
    hide: 'Hide',
    saveDraft: 'Save draft',
    titleLabel: 'Title',
    titlePlaceholder: 'e.g. Token sign-in',
    categoryLabel: 'Category',
    sortOrderLabel: 'Order',
    contentLabel: 'Body',
    uploadHint:
      'Use the image button, paste directly, or drop images into the editor. Files are uploaded to Cloudflare R2 by the backend.',
  },
  category: {
    create: 'New category',
    edit: 'Edit category',
    dialogDescription:
      'Categories are the top-level grouping for guides and only show publicly once enabled.',
    nameLabel: 'Category name',
    sortOrderLabel: 'Order',
    publicLabel: 'Public category',
    publicHint: 'Once enabled, published articles become publicly accessible',
    delete: 'Delete category',
    confirmDelete:
      'Deleting this category also deletes every guide inside it. Continue?',
  },
  toast: {
    articlePublished: 'Article published',
    articleHidden: 'Article hidden and saved as a draft',
    draftSaved: 'Draft saved',
    articleDeleted: 'Article deleted',
    categorySaved: 'Category saved',
    categoryDeleted: 'Category deleted',
  },
  confirm: {
    deleteArticle: 'Delete this guide?',
  },
  error: {
    noArticleSelected: 'Select an article first',
    actionFailed: 'Action failed',
  },
  editor: {
    heading1: 'Heading 1',
    heading2: 'Heading 2',
    heading3: 'Heading 3',
    bold: 'Bold',
    italic: 'Italic',
    inlineCode: 'Inline code',
    codeBlock: 'Code block',
    bulletList: 'Bullet list',
    orderedList: 'Ordered list',
    blockquote: 'Quote',
    link: 'Link',
    linkPrompt: 'Enter the link URL',
    horizontalRule: 'Divider',
    uploadImage: 'Upload image',
    imageUploaded: 'Image uploaded',
    imageUploadFailed: 'Image upload failed',
  },
}
