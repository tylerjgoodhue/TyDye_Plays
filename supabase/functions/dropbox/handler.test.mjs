import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { createState } from './oauth.mjs';
let handler;
let saved;
let authenticated = true;
let refreshRequests = 0;
const origin = 'https://creator.example';
const env = { SUPABASE_URL: 'https://project.example', SUPABASE_ANON_KEY: 'test-public', SUPABASE_SERVICE_ROLE_KEY: 'test-service', DROPBOX_APP_KEY: 'test-key', DROPBOX_APP_SECRET: 'test-secret', ALLOWED_APP_ORIGINS: origin, DROPBOX_REDIRECT_URI: 'https://project.example/functions/v1/dropbox' };
globalThis.Deno = { env: { get: key => env[key] }, serve: fn => handler = fn };
globalThis.__dropboxTestClient = () => ({ auth: { getUser: async () => ({ data: { user: authenticated ? { id: 'owner' } : null }, error: null }) }, from: () => ({ upsert: async row => { saved = row; return { error: null }; }, select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { refresh_token: 'saved-refresh', account_name: 'Test' }, error: null }) }) }) }) });
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes('oauth2/token')) {
    const grant = new URLSearchParams(options.body).get('grant_type');
    if (grant === 'refresh_token') {
      refreshRequests++;
      return new Response(JSON.stringify({ access_token: 'refreshed-access', expires_in: 14400, token_type: 'bearer' }), { status: 200 });
    }
    return new Response(JSON.stringify({ access_token: 'test-access', refresh_token: 'test-refresh' }), { status: 200 });
  }
  if (String(url).includes('content.dropboxapi.com/2/files/upload')) {
    assert.equal(options.headers.Authorization, 'Bearer refreshed-access');
    assert.equal(JSON.parse(options.headers['Dropbox-API-Arg']).path, '/upload-test.txt');
    assert.equal(await new Response(options.body).text(), 'upload test bytes');
    return new Response(JSON.stringify({ '.tag': 'file', name: 'upload-test.txt', path_lower: '/upload-test.txt', size: 17 }), { status: 200 });
  }
  if (String(url).includes('/files/get_thumbnail_batch')) {
    const entries = JSON.parse(options.body).entries;
    assert.equal(entries[0].size, 'w128h128');
    assert.equal(entries[0].format, 'jpeg');
    return new Response(JSON.stringify({entries: entries.map((entry, index) => index ? {'.tag':'failure'} : {'.tag':'success',thumbnail:'dGVzdA=='})}), {status:200});
  }
  if (String(url).includes('/files/list_folder')) {
    assert.equal(options.headers.Authorization, 'Bearer refreshed-access');
    return new Response(JSON.stringify({ entries: [{ '.tag': 'file', name: 'Stream notes.txt', path_lower: '/stream notes.txt', size: 42 }], cursor: '', has_more: false }), { status: 200 });
  }
  return new Response(JSON.stringify({ email: 'test@example.com' }), { status: 200 });
};
let source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
source = source.replace('import { createClient } from "npm:@supabase/supabase-js@2";', 'const createClient = globalThis.__dropboxTestClient;').replace('"./oauth.mjs"', JSON.stringify(new URL('./oauth.mjs', import.meta.url).href));
await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const start = body => new Request('https://project.example/functions/v1/dropbox?action=start', { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('start supports the old frontend and creates a user-level authorization URL', async () => {
  const response = await handler(start({}));
  assert.equal(response.status, 200);
  const url = new URL((await response.json()).authorizeUrl);
  assert.equal(url.searchParams.has('require_role'), false);
  assert.ok(url.searchParams.get('scope').includes('account_info.read'));
  assert.ok(!url.searchParams.get('scope').includes('team'));
});
test('bare registered callback finishes and returns to original page', async () => {
  const state = await createState('owner', `${origin}/CreatorHQ/`, env.DROPBOX_APP_SECRET);
  const response = await handler(new Request(`https://project.example/functions/v1/dropbox?code=test-code&state=${encodeURIComponent(state)}`));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `${origin}/CreatorHQ/#dropbox-connected=1`);
  assert.equal(saved.user_id, 'owner');
});
test('rejects forged callback, unauthenticated start and off-site return URL', async () => {
  const response = await handler(new Request('https://project.example/functions/v1/dropbox?code=test&state=owner'));
  assert.equal(response.status, 400);
  assert.equal((await handler(start({returnUrl:'https://evil.example'}))).status, 400);
  authenticated = false;
  assert.equal((await handler(start({}))).status, 400);
  authenticated = true;
});
test('cancellation returns a readable error to CreatorHQ', async () => {
  const state = await createState('owner', `${origin}/CreatorHQ/`, env.DROPBOX_APP_SECRET);
  const response = await handler(new Request(`https://project.example/functions/v1/dropbox?error=access_denied&state=${encodeURIComponent(state)}`));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `${origin}/CreatorHQ/#dropbox-error=access_denied`);
});

test('loads files with a refreshed access token even when Dropbox returns no new refresh token', async () => {
  const request = () => new Request('https://project.example/functions/v1/dropbox?action=list', { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify({path: ''}) });
  const response = await handler(request());
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.entries[0].name, 'Stream notes.txt');
  assert.equal(refreshRequests, 1);
  assert.equal((await handler(request())).status, 200);
  assert.equal(refreshRequests, 1, 'reuses the valid cached access token');
});

test('browser preflight permits the file upload metadata header', async () => {
  const response = await handler(new Request('https://project.example/functions/v1/dropbox?action=upload', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,apikey,content-type,dropbox-api-arg' } }));
  assert.equal(response.status, 204);
  const allowed = response.headers.get('Access-Control-Allow-Headers').toLowerCase().split(',').map(x => x.trim());
  for (const header of ['authorization', 'apikey', 'content-type', 'dropbox-api-arg']) assert.ok(allowed.includes(header), `Missing ${header}`);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
});
test('uploads raw file bytes and returns Dropbox metadata', async () => {
  const response = await handler(new Request('https://project.example/functions/v1/dropbox?action=upload', { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer test', 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({path:'/upload-test.txt',mode:'overwrite',mute:false}) }, body: 'upload test bytes' }));
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.name, 'upload-test.txt');
});
test('rejects upload preflight from an unapproved origin', async () => {
  const response = await handler(new Request('https://project.example/functions/v1/dropbox?action=upload', { method: 'OPTIONS', headers: { Origin: 'https://other.example' } }));
  assert.equal(response.status, 403);
});

test('loads small thumbnails and tolerates a preview failure', async () => {
  const response = await handler(new Request('https://project.example/functions/v1/dropbox?action=thumbnails', {method:'POST',headers:{Origin:origin,Authorization:'Bearer test','Content-Type':'application/json'},body:JSON.stringify({paths:['/one.png','/two.png']})}));
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).thumbnails,[{path:'/one.png',thumbnail:'dGVzdA=='},{path:'/two.png',thumbnail:null}]);
});
test('limits thumbnail batches and rejects non-file paths', async () => {
  for (const paths of [[],Array(26).fill('/one.png'),['https://other.example/file.png']]) {
    const response = await handler(new Request('https://project.example/functions/v1/dropbox?action=thumbnails', {method:'POST',headers:{Origin:origin,Authorization:'Bearer test','Content-Type':'application/json'},body:JSON.stringify({paths})}));
    assert.equal(response.status,400);
  }
});
