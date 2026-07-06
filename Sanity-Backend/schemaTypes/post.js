import {defineField, defineType} from 'sanity'

export default defineType({
  name: 'post',
  title: 'Post',
  type: 'document',
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      options: {
        source: 'title',
        maxLength: 96,
      },
    }),
    defineField({
      name: 'author',
      title: 'Author',
      type: 'reference',
      to: {type: 'author'},
    }),
    defineField({
      name: 'mainImage',
      title: 'Main image',
      type: 'image',
      options: {
        hotspot: true,
      },
    }),
    defineField({
      name: 'ogImage',
      title: 'Open Graph Image',
      description: 'Image for social media sharing (1200x630 recommended)',
      type: 'image',
      options: {
        hotspot: true,
      },
    }),
    defineField({
      name: 'categories',
      title: 'Categories',
      type: 'array',
      of: [{type: 'reference', to: {type: 'category'}}],
    }),
    defineField({
      name: 'tags',
      title: 'Tags',
      type: 'array',
      of: [{type: 'string'}],
      options: {
        layout: 'tags',
      },
    }),
    defineField({
      name: 'publishedAt',
      title: 'Published at',
      type: 'datetime',
    }),
    defineField({
      name: 'postType',
      title: 'Post Type',
      type: 'string',
      initialValue: 'blog',
      description: 'Choose whether this post is a normal blog, premium, or journal entry.',
      options: {
        list: [
          {title: 'Blog', value: 'blog'},
          {title: 'Premium', value: 'premium'},
          {title: 'Journal', value: 'journal'},
        ],
        layout: 'dropdown',
      },
    }),
    defineField({
      name: 'isPrivate',
      title: 'Private Post',
      description: 'Show this post with a lock icon and require access before opening.',
      type: 'boolean',
      initialValue: false,
    }),
    defineField({
      name: 'isPremium',
      title: 'Premium Post',
      description: 'Show this post as premium. Premium posts display a preview and badge.',
      type: 'boolean',
      initialValue: false,
    }),
    defineField({
      name: 'excerpt',
      title: 'Excerpt',
      type: 'text',
    }),
    defineField({
      name: 'readingTime',
      title: 'Reading Time (minutes)',
      type: 'number',
    }),
    defineField({
      name: 'body',
      title: 'Body',
      type: 'blockContent',
    }),
  ],

  preview: {
    select: {
      title: 'title',
      author: 'author.name',
      media: 'mainImage',
    },
    prepare(selection) {
      const {author} = selection
      return {...selection, subtitle: author && `by ${author}`}
    },
  },
})
