// Call only AFTER auth.getUser(token) succeeds. That validates the JWT signature
// and supplies current server-side factors, including factors added since login.
export function requireMfa(user, token) {
  if (!(user?.factors || []).some(factor => factor.status === 'verified')) return;
  let claims;
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')));
  } catch { /* A malformed or missing AAL must never pass. */ }
  if (claims?.sub !== user.id || claims?.aal !== 'aal2') {
    const error = new Error('Verify your authenticator code in CreatorHQ before continuing.');
    error.status = 403;
    throw error;
  }
}
