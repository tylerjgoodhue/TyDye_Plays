// Secrets live only in the enrollment response and setup DOM, never workspace storage.
export function createMfa(getClient) {
  let pending = null;
  const api = () => {
    const client = getClient();
    if (!client) throw new Error('Sign in to CreatorHQ first.');
    return client.auth.mfa;
  };
  const unwrap = result => { if (result.error) throw result.error; return result.data; };
  async function status() {
    const factors = unwrap(await api().listFactors());
    const assurance = unwrap(await api().getAuthenticatorAssuranceLevel());
    const verified = (factors.totp || []).filter(factor => factor.status === 'verified');
    return { factors: verified, required: assurance.currentLevel !== 'aal2' && (verified.length > 0 || assurance.nextLevel === 'aal2'), currentLevel: assurance.currentLevel };
  }
  async function verify(factorId, value) {
    const code = String(value || '').trim();
    if (!/^\d{6}$/.test(code)) throw new Error('Enter the six-digit code from your authenticator app.');
    return unwrap(await api().challengeAndVerify({ factorId, code }));
  }
  async function cancel() {
    if (!pending) return;
    // Never remove an already verified factor when setup is cancelled.
    const factors = unwrap(await api().listFactors());
    const factor = (factors.all || []).find(item => item.id === pending);
    if (factor?.status === 'verified') { pending = null; return; }
    if (factor) unwrap(await api().unenroll({ factorId: pending }));
    pending = null;
  }
  async function enroll() {
    await cancel();
    // Clear only abandoned, unverified setups created by this screen.
    const factors = unwrap(await api().listFactors());
    for (const factor of factors.all || []) {
      if (factor.factor_type === 'totp' && factor.status === 'unverified' && factor.friendly_name?.startsWith('CreatorHQ setup ')) {
        unwrap(await api().unenroll({ factorId: factor.id }));
      }
    }
    const data = unwrap(await api().enroll({ factorType: 'totp', friendlyName: `CreatorHQ setup ${Date.now()}`, issuer: 'CreatorHQ' }));
    pending = data.id;
    return data;
  }
  async function confirm(code) {
    if (!pending) throw new Error('Start authenticator setup again.');
    await verify(pending, code);
    pending = null;
  }
  async function remove(factorId, code) {
    const current = await status();
    if (!current.factors.some(factor => factor.id === factorId)) throw new Error('That authenticator is no longer connected. Refresh this page.');
    await verify(factorId, code);
    unwrap(await api().unenroll({ factorId }));
  }
  function reset() { pending = null; }
  return { status, verify, enroll, confirm, cancel, remove, reset };
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const codeField = '<div class="form-field"><label for="security-code">Authenticator code</label><input id="security-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required></div>';
export async function renderSecurity(host, mfa, changed) {
  if (!host || host.dataset.busy === 'true') return;
  host.innerHTML = '<p class="settings-hint" role="status">Checking account security…</p>';
  try {
    const current = await mfa.status();
    host.innerHTML = `<h3>Two-factor authentication</h3><p class="settings-hint">${current.factors.length ? 'Enabled. Sign-in requires a code from your authenticator app.' : 'Add a six-digit authenticator code after your password to protect your account.'}</p><p class="settings-hint">Works with Google Authenticator, Microsoft Authenticator, 1Password, and other TOTP apps. Keep your authenticator backup secure. Lost access? Contact the workspace owner for a verified reset; a password reset does not remove two-factor authentication.</p><button type="button" class="button" data-mfa-add>${current.factors.length ? 'Add a backup authenticator' : 'Set up authenticator app'}</button>${current.factors.length ? `<form data-mfa-remove style="margin-top:18px"><div class="form-field"><label for="security-factor">Authenticator to remove</label><select id="security-factor">${current.factors.map((factor,index)=>`<option value="${escape(factor.id)}">Authenticator ${index+1}</option>`).join('')}</select></div><p class="settings-hint">Enter a fresh code from the selected app to remove it. Removing your last authenticator turns two-factor authentication off.</p>${codeField}<button class="button" style="margin-top:10px" type="submit">Remove selected authenticator</button></form>` : ''}<div data-mfa-setup></div><p class="settings-hint" data-mfa-status role="status"></p>`;
    const note = text => {
      let node = host.querySelector('[data-mfa-status]');
      if (!node) { node = document.createElement('p'); node.className = 'settings-hint'; node.dataset.mfaStatus = ''; node.setAttribute('role','status'); host.append(node); }
      node.textContent = text;
    };
    const busy = value => { host.dataset.busy = String(value); host.querySelectorAll('button').forEach(button => button.disabled = value); };
    host.querySelector('[data-mfa-add]').addEventListener('click', async () => {
      busy(true); note('Preparing your authenticator…');
      try {
        const enrollment = await mfa.enroll();
        let qr = enrollment.totp.qr_code;
        if (qr.startsWith('<svg')) qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`;
        if (!qr.startsWith('data:image/svg+xml')) throw new Error('The setup QR code could not load. Try setup again.');
        host.querySelector('[data-mfa-remove]')?.remove();
        host.querySelector('[data-mfa-add]').hidden = true;
        host.querySelector('[data-mfa-setup]').innerHTML = `<form data-mfa-confirm style="margin-top:18px"><p class="settings-hint">1. In your authenticator app, add an account and scan this QR code.</p><img alt="Scan this QR code in your authenticator app" src="${escape(qr)}" width="200" height="200" style="display:block;background:white;padding:10px;max-width:100%;height:auto;border-radius:10px"><details style="margin:12px 0"><summary>Can’t scan? Enter a setup key</summary><p class="settings-hint">Choose a time-based code, name the account CreatorHQ, and enter:</p><code style="display:block;overflow-wrap:anywhere;user-select:all">${escape(enrollment.totp.secret)}</code></details><p class="settings-hint">2. Save a secure backup in your authenticator app, then enter the current code below. Protection starts only after verification.</p>${codeField}<div class="button-row" style="margin-top:12px"><button type="submit" class="button primary">Verify and enable</button><button type="button" class="button" data-mfa-cancel>Cancel setup</button></div></form>`;
        note('Scan the QR code, then verify your first code.');
        host.querySelector('[data-mfa-confirm]').addEventListener('submit', async event => {
          event.preventDefault(); busy(true);
          try {
            await mfa.confirm(host.querySelector('#security-code').value);
            host.replaceChildren(); // Remove the QR and secret immediately after verification.
            busy(false); await changed(); await renderSecurity(host,mfa,changed);
          } catch (error) { note(error.message || 'That code did not work. Wait for a new code and try again.'); }
          finally { busy(false); }
        });
        host.querySelector('[data-mfa-cancel]').addEventListener('click', async () => {
          busy(true);
          try { await mfa.cancel(); busy(false); await renderSecurity(host,mfa,changed); }
          catch (error) { note(error.message || 'Could not cancel setup. Try again.'); }
          finally { busy(false); }
        });
      } catch (error) { note(error.message || 'Authenticator setup failed. Try again.'); }
      finally { busy(false); }
    });
    host.querySelector('[data-mfa-remove]')?.addEventListener('submit', async event => {
      event.preventDefault(); busy(true);
      try {
        await mfa.remove(host.querySelector('#security-factor').value,host.querySelector('#security-code').value);
        host.replaceChildren(); busy(false); await changed(); await renderSecurity(host,mfa,changed);
      } catch (error) { note(error.message || 'Could not remove the authenticator. Try a fresh code.'); }
      finally { busy(false); }
    });
  } catch (error) { host.textContent = `Account security could not load: ${error.message || 'Try again later.'}`; }
}
