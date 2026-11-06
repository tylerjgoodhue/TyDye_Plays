// Run after the build; only inspect the files that will actually be published.
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../dist/', import.meta.url));
const pages = ['index.html', 'profile.html', 'shop.html', 'product.html', 'cart.html', 'linktree.html', 'blog.html', 'blog-post.html', 'CreatorHQ/index.html'];
let checked = 0;
function syntax(source, module, label) {
  const result = spawnSync(process.execPath, ['--check', ...(module ? ['--input-type=module'] : [])], { input: source, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`Invalid JavaScript in ${label}: ${result.stderr || result.error}`);
  checked++;
}
for (const page of pages) {
  const filename = path.join(output, page);
  const html = await readFile(filename, 'utf8');
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) throw new Error(`Incomplete page: ${page}`);
  for (const [, attributes, source] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/.test(attributes) || /type=["']application\//i.test(attributes)) continue;
    syntax(source, /type=["']module["']/i.test(attributes), page);
  }
  for (const [, reference] of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)) {
    if (/^(?:https?:|data:|\/\/|#)/.test(reference)) continue;
    const asset = path.resolve(path.dirname(filename), reference.split(/[?#]/)[0]);
    if (!asset.startsWith(output)) throw new Error(`Asset outside published folder: ${reference}`);
    if (!(await stat(asset)).isFile()) throw new Error(`Missing asset in ${page}: ${reference}`);
  }
}
for (const script of ['storefront.js', 'public-site-utils.js', 'CreatorHQ/cloud-sync.js', 'CreatorHQ/auth-mfa.mjs','CreatorHQ/buffer-workflow.mjs','CreatorHQ/cloud-persistence.mjs','CreatorHQ/gloss-entry.mjs','CreatorHQ/gloss-studio.mjs','CreatorHQ/gloss-utils.mjs','CreatorHQ/blog-admin.mjs','CreatorHQ/blog-utils.mjs','blog-public.mjs','blog-utils.mjs']) {
  syntax(await readFile(path.join(output, script), 'utf8'), script.endsWith('cloud-sync.js') || script.endsWith('.mjs'), script);
}
for (const config of ['public-profile.json', 'storefront-config.json']) JSON.parse(await readFile(path.join(output, config), 'utf8'));
console.log(`Release check passed: ${pages.length} pages, ${checked} scripts, local assets, and public configuration.`);

for(const file of ['candy-pink.ttf','candy-lilac.ttf','outfit-extrabold.ttf','outfit-semibold.ttf','nunito-sans-regular.ttf','nunito-sans-semibold.ttf'])if((await stat(path.join(output,'CreatorHQ/gloss-fonts',file))).size<1000)throw new Error('Missing Gloss Studio font');
