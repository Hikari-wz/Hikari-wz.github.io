// Smoke-test the generated HTML using installed Chrome. No browser download or test runner.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { preview } from 'astro';
import { chromium } from 'playwright-core';

const files = await readdir('dist', { recursive: true });
const routes = files.filter(path => path.endsWith('index.html')).map(path => '/' + path.replaceAll('\\', '/').slice(0, -10));
const server = await preview({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: 'chrome' });
  const page = await browser.newPage({ baseURL: 'http://127.0.0.1:' + server.port, reducedMotion: 'reduce', colorScheme: 'light' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [375, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    for (const route of routes) {
      assert.equal((await page.goto(route)).status(), 200, route);
      if (width === 375) {
        // Force a long unbroken line in rendered code and MathML, even in short articles.
        for (const [selector, kind] of [['.prose pre', 'code'], ['.prose .katex:has(math[display="block"])', 'math']]) {
          const region = page.locator(selector).first();
          if (await region.count()) {
            const scrolled = await region.evaluate((element, kind) => {
              if (kind === 'code') {
                element.querySelector('code').textContent = 'long_identifier_'.repeat(60);
              } else {
                const text = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'mtext');
                text.textContent = 'abcdefghijk'.repeat(60);
                element.querySelector('math').replaceChildren(text);
              }
              element.scrollLeft = 40;
              return element.scrollLeft > 0;
            }, kind);
            assert.ok(scrolled, 'Long ' + kind + ' must scroll within its container on ' + route);
          }
        }
      }
      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        if (root.scrollWidth <= root.clientWidth) return null;
        const wide = [...document.body.querySelectorAll('*')].filter(el =>
          el.getBoundingClientRect().right > root.clientWidth);
        return wide.slice(0, 6).map(el => el.localName + '.' + el.className).join(', ');
      });
      assert.equal(overflow, null, 'Horizontal overflow at ' + width + 'px on ' + route + ': ' + overflow);
      assert.ok(await page.locator('img').evaluateAll(images => images.every(img =>
        img.getBoundingClientRect().width <= document.documentElement.clientWidth)), 'Image too wide on ' + route);
    }
  }

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').getAttribute('href'), '#main');
  assert.ok(await page.locator(':focus').evaluate(el => getComputedStyle(el).outlineStyle !== 'none'));
  await page.keyboard.press('Enter');
  assert.equal(await page.locator(':focus').getAttribute('id'), 'main');

  const menu = page.locator('.mobile-menu summary');
  const mobileNav = page.getByRole('navigation', { name: '移动导航' });
  await menu.focus();
  await page.keyboard.press('Enter');
  assert.equal(await mobileNav.isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await mobileNav.isVisible(), false);
  assert.equal(await menu.evaluate(el => el === document.activeElement), true);

  const theme = page.getByRole('combobox', { name: '主题偏好' });
  const background = () => page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor);
  await theme.selectOption('light');
  const light = await background();
  await theme.selectOption('dark');
  const dark = await background();
  assert.notEqual(light, dark);
  await menu.click();
  await mobileNav.getByRole('link', { name: '学习', exact: true }).click();
  assert.equal(new URL(page.url()).pathname, '/learn/');
  await page.reload();
  assert.equal(await theme.inputValue(), 'dark');
  assert.equal(await background(), dark);
  await theme.selectOption('system');
  assert.equal(await background(), light);
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await background(), dark);

  assert.equal((await page.goto('/missing-for-ci/')).status(), 404);
  assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex');
  await page.getByRole('link', { name: '返回首页' }).click();
  assert.equal(new URL(page.url()).pathname, '/');
  assert.deepEqual(errors, []);
  console.log('Verified ' + routes.length + ' routes at five widths, keyboard navigation, theme persistence, system theme and 404.');
} finally {
  await browser?.close();
  await server.stop();
}
