import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const creatorHq = path.join(output, 'CreatorHQ');
const [repositoryOwner, repositoryName] = process.env.GITHUB_REPOSITORY?.split('/') || [];
const configuredBasePath = process.env.PAGES_BASE_PATH?.trim();
const publicBasePath = configuredBasePath
	? `/${configuredBasePath.split('/').filter(Boolean).join('/')}${configuredBasePath.endsWith('/') ? '' : '/'}`
	: repositoryName && repositoryName !== `${repositoryOwner}.github.io` ? `/${repositoryName}/` : '/';

await rm(output, { recursive: true, force: true });
await mkdir(creatorHq, { recursive: true });

await cp(path.join(root, 'profile.html'), path.join(output, 'index.html'));
await cp(path.join(root, 'profile.html'), path.join(output, 'profile.html'));
await cp(path.join(root, 'product.html'), path.join(output, 'product.html'));
await cp(path.join(root, 'linktree.html'), path.join(output, 'linktree.html'));
await cp(path.join(root, 'public-profile.json'), path.join(output, 'public-profile.json'));
const customDomain = process.env.PAGES_CUSTOM_DOMAIN?.trim().toLowerCase();
if (customDomain) {
	if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(customDomain)) {
		throw new Error('PAGES_CUSTOM_DOMAIN must be a hostname such as creator.example.com.');
	}
	await writeFile(path.join(output, 'CNAME'), `${customDomain}\n`);
}
const appHtml = await readFile(path.join(root, 'index.html'), 'utf8');
const configuredAppHtml = appHtml.replace(
	'<script type="module" src="./cloud-sync.js',
	`<script>window.CREATOR_HQ_PUBLIC_BASE=${JSON.stringify(publicBasePath)};</script>\n  <script type="module" src="./cloud-sync.js`
);
await writeFile(path.join(creatorHq, 'index.html'), configuredAppHtml);
await cp(path.join(root, 'cloud-sync.js'), path.join(creatorHq, 'cloud-sync.js'));

console.log(`Built public creator site at ${publicBasePath} and Creator HQ at ${publicBasePath}CreatorHQ/.`);