import { defineCollection, type SchemaContext } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';
import { categories, topics } from './data/site';

const common = ({ image }: SchemaContext) => ({
  title: z.string().min(1),
  description: z.string().min(1),
  date: z.coerce.date(),
  updated: z.coerce.date().optional(),
  tags: z.array(z.string()).default([]),
  demo: z.boolean().default(false),
  draft: z.boolean().default(false),
  cover: z.object({ src: image(), alt: z.string().trim().min(1) }).optional()
});
function keys<T extends string>(record: Record<T, string>) {
  return Object.keys(record) as [T, ...T[]];
}
function files(collection: string) {
  return glob({ pattern: '**/[^_]*.{md,mdx}', base: './src/content/' + collection });
}
export const collections = {
  journal: defineCollection({
    loader: files('journal'),
    schema: context => z.object({ ...common(context), category: z.enum(keys(categories)) })
  }),
  learn: defineCollection({
    loader: files('learn'),
    schema: context => z.object({
      ...common(context), topic: z.enum(keys(topics)), section: z.string().min(1),
      order: z.number().int().default(0)
    })
  }),
  lab: defineCollection({
    loader: files('lab'),
    schema: context => z.object({ ...common(context), projectUrl: z.url({ protocol: /^https$/ }).optional() })
  })
};
