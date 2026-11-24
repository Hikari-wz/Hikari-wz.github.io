import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwind from '@tailwindcss/vite';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

const math = {
  remarkPlugins: [remarkMath],
  rehypePlugins: [[rehypeKatex, { output: 'mathml' }]]
};

export default defineConfig({
  site: 'https://hikari.wang',
  output: 'static',
  trailingSlash: 'always',
  prerenderConflictBehavior: 'error',
  integrations: [mdx(), sitemap()],
  vite: { plugins: [tailwind()] },
  devToolbar: { enabled: false },
  markdown: {
    processor: unified(math),
    shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' } }
  }
});
