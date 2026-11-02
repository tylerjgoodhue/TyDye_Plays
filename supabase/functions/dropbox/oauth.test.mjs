import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { authorizationUrl, createState, verifyState } from './oauth.mjs';
globalThis.crypto ??= webcrypto;
const origin = 'https://creator.example';
const secret = 'test-only-secret';
test('authorization requests user scopes, offline access, and no work role', () => {
  const url = new URL(authorizationUrl('test-key', 'https://project.example/functions/v1/dropbox', 'state'));
  assert.equal(url.searchParams.get('scope'), 'account_info.read files.metadata.read files.content.read files.content.write');
  assert.equal(url.searchParams.get('token_access_type'), 'offline');
  assert.equal(url.searchParams.has('require_role'), false);
  assert.equal(url.searchParams.has('include_granted_scopes'), false);
});
test('state returns the correct user and original CreatorHQ path', async () => {
  const state = await createState('test-user', `${origin}/CreatorHQ/`, secret, 1000);
  const flow = await verifyState(state, secret, [origin], 1001);
  assert.equal(flow.userId, 'test-user');
  assert.equal(flow.returnUrl, `${origin}/CreatorHQ/`);
});
test('rejects unsigned legacy user IDs and tampered state', async () => {
  const state = await createState('test-user', `${origin}/CreatorHQ/`, secret, 1000);
  await assert.rejects(verifyState('test-user', secret, [origin], 1001));
  await assert.rejects(verifyState(state + 'extra', secret, [origin], 1001));
  await assert.rejects(verifyState(state, 'wrong-secret', [origin], 1001));
});
test('rejects expired links and off-site return addresses', async () => {
  const state = await createState('test-user', `${origin}/CreatorHQ/`, secret, 1000);
  await assert.rejects(verifyState(state, secret, [origin], 601000));
  await assert.rejects(verifyState(state, secret, ['https://other.example'], 1001));
});
