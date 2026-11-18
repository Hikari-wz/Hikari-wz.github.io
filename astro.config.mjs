import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwind from '@tailwindcss/vite';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

export default defineConfig({
  site: 'https://hikari-wz.github.io',
  output: 'static',
  trailingSlash: 'always',
  integrations: [mdx(), sitemap()],
  vite: { plugins: [tailwind()] },
  devToolbar: { enabled: false },
  markdown: {
    remarkPlugins: [remarkMath],
    rehypePlugins: [[rehypeKatex, { output: 'mathml' }]],
    shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' } }
  }
});
