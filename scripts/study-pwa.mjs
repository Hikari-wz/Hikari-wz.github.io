import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const route = '/desk/study/';

export default function studyPwa() {
  return {
    name: 'hikari-study-pwa',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        const shell = await readFile(new URL('.' + route + 'index.html', dir), 'utf8');
        const paths = new Set([route, route + 'app.webmanifest']);
        for (const match of shell.matchAll(/<(?:script|link|img)\b[^>]*? (?:src|href)="(\/[^"]+)"/g)) {
          if (match[1].startsWith('/_astro/') || match[1].startsWith(route) || match[1] === '/mark.svg') paths.add(match[1]);
        }
        const manifest = JSON.parse(await readFile(new URL('.' + route + 'app.webmanifest', dir), 'utf8'));
        for (const icon of manifest.icons) paths.add(new URL(icon.src, 'https://localhost' + route).pathname);

        const hash = createHash('sha256');
        const worker = await readFile(new URL('./study-worker.js', import.meta.url), 'utf8');
        hash.update(worker);
        for (const path of paths) {
          const bytes = await readFile(new URL('.' + (path === route ? route + 'index.html' : path), dir));
          hash.update(path).update(bytes);
          // Vite can put a shared static import in a separate hashed chunk.
          if (path.startsWith('/_astro/') && path.endsWith('.js')) {
            for (const dependency of bytes.toString().matchAll(/\b(?:from\s*|import\s*\(?)["']\.\/([\w.-]+\.js)["']/g)) {
              paths.add('/_astro/' + dependency[1]);
            }
          }
        }
        await writeFile(new URL('.' + route + 'sw.js', dir),
          `const BUILD_VERSION = ${JSON.stringify(hash.digest('hex').slice(0, 16))};\nconst SHELL_PATHS = ${JSON.stringify([...paths])};\n${worker}`);
      },
    },
  };
}
