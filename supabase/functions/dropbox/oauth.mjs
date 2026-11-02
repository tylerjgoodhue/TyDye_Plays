// Request only user permissions. Omitted scopes inherit team-only app permissions.
export const DROPBOX_USER_SCOPES = 'account_info.read files.metadata.read files.content.read files.content.write';

export function authorizationUrl(appKey, redirectUri, state) {
  const url = new URL('https://www.dropbox.com/oauth2/authorize');
  for (const [key, value] of Object.entries({ client_id: appKey, response_type: 'code', token_access_type: 'offline', redirect_uri: redirectUri, scope: DROPBOX_USER_SCOPES, state })) url.searchParams.set(key, value);
  return url.toString();
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
async function stateKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function createState(userId, returnUrl, secret, now = Date.now()) {
  const payload = encode(new TextEncoder().encode(JSON.stringify({ userId, returnUrl, expires: now + 600000, nonce: crypto.randomUUID() })));
  const signature = await crypto.subtle.sign('HMAC', await stateKey(secret), new TextEncoder().encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}
export async function verifyState(state, secret, origins, now = Date.now()) {
  try {
    const [payload, signature, extra] = state.split('.');
    if (!payload || !signature || extra) throw new Error();
    if (!await crypto.subtle.verify('HMAC', await stateKey(secret), decode(signature), new TextEncoder().encode(payload))) throw new Error();
    const data = JSON.parse(new TextDecoder().decode(decode(payload)));
    const url = new URL(data.returnUrl);
    if (typeof data.userId !== 'string' || !data.userId || !Number.isFinite(data.expires) || data.expires <= now || !origins.includes(url.origin) || url.username || url.password) throw new Error();
    return data;
  } catch { throw new Error('This Dropbox connection link expired or is invalid. Return to Creator HQ and connect again.'); }
}
