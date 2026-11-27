import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwind from '@tailwindcss/vite';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import studyPwa from './scripts/study-pwa.mjs';
import { loadEnv } from 'vite';

const publicEnv = { ...loadEnv(process.env.NODE_ENV || 'production', process.cwd(), 'PUBLIC_'), ...process.env };
if (publicEnv.PUBLIC_DESK_DATA_MODE && !['local','cloud'].includes(publicEnv.PUBLIC_DESK_DATA_MODE)) throw new Error('Invalid PUBLIC_DESK_DATA_MODE');
if (publicEnv.PUBLIC_DESK_DATA_MODE === 'cloud') {
  if (!publicEnv.PUBLIC_SUPABASE_URL || !publicEnv.PUBLIC_SUPABASE_PUBLISHABLE_KEY) throw new Error('Cloud build requires Supabase URL and publishable key.');
  const key = publicEnv.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (key.startsWith('sb_secret_')) throw new Error('Secret keys are forbidden in frontend configuration.');
  if (key.split('.').length === 3 && JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role !== 'anon') throw new Error('Only anon or publishable keys may enter a frontend build.');
}

const math = {
  remarkPlugins: [remarkMath],
  rehypePlugins: [[rehypeKatex, { output: 'mathml' }]]
};

export default defineConfig({
  site: 'https://hikari.wang',
  output: 'static',
  trailingSlash: 'always',
  prerenderConflictBehavior: 'error',
  integrations: [mdx(), sitemap(), studyPwa()],
  vite: { plugins: [tailwind()] },
  devToolbar: { enabled: false },
  markdown: {
    processor: unified(math),
    shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' } }
  }
});
