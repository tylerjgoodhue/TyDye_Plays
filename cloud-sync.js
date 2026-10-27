import { createClient } from 'https://esm.sh/@supabase/supabase-js@2?bundle';

const CONFIG_KEY = 'creator-hq-cloud-config-v1';
const MAX_SNAPSHOT_BYTES = 1_500_000;
const SOCIAL_ANALYTICS_REFRESH_MS = 60_000;
const PLATFORM_METRICS_REFRESH_MS = 15 * 60_000;
const BUFFER_REFRESH_MS = 5 * 60_000;
let client = null;
let session = null;
let syncTimer = null;
let syncing = false;
let syncPending = false;
let recoveryMode = false;
let bufferOrganizations = [];
let bufferPosts = [];
let bufferLoadedForUser = null;
let bufferPostsCursor = null;
let bufferPostsHasNext = false;
let bufferScheduling = false;
let lastBufferRefresh = 0;
let bufferRefreshPromise = null;
let socialLinksSyncedForUser = null;
let platformAccounts = [];
let platformMetrics = [];
let platformCallbackNotice = '';
let platformCallbackNotices = {};
let lastSocialAnalyticsRefresh = 0;
let lastPlatformMetricsRefresh = 0;
let analyticsRefreshPromise = null;
let publicProfileConfigPromise = null;
let publicProfileSyncTimer = null;
let publicProfileSyncPromise = null;
let pendingPublicProfile = null;
let lastPublishedPublicProfile = '';
let publicProfileCheckedForUser = null;
let publicProfileCheckPromise = null;
let bufferCalendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let bufferQueueView = 'list';

const ui = () => window.CreatorHQCloudUI;
const storage = () => window.CreatorHQStorage;

function readConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); }
  catch { return {}; }
}

function writeConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function appRedirectUrl() {
  return `${window.location.origin}${window.location.pathname}`;
}

function message(error) {
  const errorCode = error?.code || error?.error_code;
  const detail = `${errorCode || ''} ${error?.message || error?.msg || ''}`.toLowerCase();
  if (detail.includes('unsupported provider') || detail.includes('provider is not enabled')) {
    return 'GitHub sign-in is not enabled in Supabase yet. In Supabase Dashboard, open Authentication → Sign In / Providers → GitHub, enable it, and add your GitHub OAuth App client ID and secret. You do not need a Supabase password for GitHub login.';
  }
  if (detail.includes('invalid login credentials') || detail.includes('invalid_credentials')) {
    return 'Creator HQ uses project user authentication, separate from signing in to the supabase.com dashboard. Make sure this email is listed under this project’s Authentication → Users and that Email auth is enabled. If you only use GitHub, choose Continue with GitHub (GitHub must be enabled under Authentication → Sign In / Providers). A dashboard password will not work here unless you created a project user with that password.';
  }
  return error?.message || 'The cloud request failed.';
}

function setAccountState() {
  const email = session?.user?.email || '';
  ui()?.setAccount(email, email ? `Signed in as ${email}` : 'Not signed in');
  document.getElementById('cloud-github-sign-in').hidden = Boolean(email);
  document.getElementById('cloud-forgot-password').hidden = Boolean(email) || recoveryMode;
  document.getElementById('cloud-recovery-section').hidden = !recoveryMode;
  ui()?.setSyncStatus(readConfig().syncEnabled ? 'Automatic sync is enabled for this browser.' : 'Automatic sync is paused.');
  if (session?.user && bufferLoadedForUser !== session.user.id) {
    bufferLoadedForUser = session.user.id;
    loadBufferWorkspace();
  } else if (!session?.user) {
    bufferLoadedForUser = null;
    setBufferStatus('Sign in to Creator HQ before connecting Buffer.', false);
  }
  if (session?.user && socialLinksSyncedForUser !== session.user.id) {
    socialLinksSyncedForUser = session.user.id;
    syncSocialLinks().catch(error => setSocialAnalyticsStatus(error.message || 'Could not register social links.'));
    loadPlatformAccounts().catch(error => setPlatformAccountsStatus(error.message || 'Could not load platform accounts.'));
    initializePublicProfile();
  } else if (!session?.user) {
    socialLinksSyncedForUser = null;
    publicProfileCheckedForUser = null;
    platformAccounts = [];
    platformMetrics = [];
    setSocialAnalyticsStatus('Sign in to view private social click analytics.');
    storage()?.refreshAnalytics?.();
  }
}

function withoutLocalImageBytes(workspace) {
  return {
    ...workspace,
    assets: (workspace.assets || []).map(asset => ({ ...asset, dataUrl: '', mimeType: '' }))
  };
}

async function currentUser() {
  if (!client) throw new Error('Connect a Supabase project first.');
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error('Sign in before syncing your workspace.');
  return data.user;
}

async function uploadWorkspace({ confirmOverwrite = false } = {}) {
  const user = await currentUser();
  const existing = await client.from('creator_workspaces').select('user_id').eq('user_id', user.id).maybeSingle();
  if (existing.error) throw existing.error;
  if (confirmOverwrite && existing.data && !window.confirm('A cloud workspace already exists. Replace it with this browser\'s current workspace? Export a backup first if you are unsure.')) return;

  const snapshot = withoutLocalImageBytes(storage().getWorkspace());
  const snapshotText = JSON.stringify(snapshot);
  if (new TextEncoder().encode(snapshotText).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error('Workspace snapshot exceeds 1.5 MB. Remove large text or asset metadata before syncing.');
  }
  const { error } = await client.from('creator_workspaces').upsert({
    user_id: user.id,
    schema_version: 1,
    workspace_data: snapshot,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (error) throw error;
  writeConfig({ ...readConfig(), syncEnabled: true });
  ui()?.setSyncStatus(`Synced at ${new Date().toLocaleTimeString()}. Local image bytes remain on this device.`);
}

async function pullWorkspace() {
  const user = await currentUser();
  const { data, error } = await client.from('creator_workspaces')
    .select('workspace_data, updated_at, schema_version')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    ui()?.setSyncStatus('No cloud workspace exists yet. Upload this browser workspace to create one.');
    return;
  }
  if (!window.confirm(`Replace this browser's current workspace with the cloud snapshot last updated ${new Date(data.updated_at).toLocaleString()}? Export a backup first if you are unsure.`)) return;
  const localAssets = new Map((storage().getWorkspace().assets || []).map(asset => [asset.id, asset]));
  const restored = {
    ...data.workspace_data,
    assets: (data.workspace_data.assets || []).map(asset => {
      const local = localAssets.get(asset.id);
      return local?.dataUrl ? { ...asset, dataUrl: local.dataUrl, mimeType: local.mimeType, fileName: local.fileName } : asset;
    })
  };
  storage().replaceWorkspace(restored);
  writeConfig({ ...readConfig(), syncEnabled: true });
  ui()?.setSyncStatus(`Cloud workspace restored and sync enabled. Last cloud update: ${new Date(data.updated_at).toLocaleString()}.`);
}

async function flushSync() {
  if (syncing) { syncPending = true; return; }
  if (!client || !session?.user || !readConfig().syncEnabled) return;
  syncing = true;
  try {
    await uploadWorkspace();
  } catch (error) {
    ui()?.setSyncStatus(`Sync paused after an error: ${message(error)}`);
  } finally {
    syncing = false;
    if (syncPending) { syncPending = false; queueSync(); }
  }
}

function queueSync() {
  if (!readConfig().syncEnabled || !session?.user) return;
  clearTimeout(syncTimer);
  ui()?.setSyncStatus('Local changes saved. Cloud sync queued…');
  syncTimer = setTimeout(flushSync, 700);
}

async function getPublicProfileConfig() {
  if (!publicProfileConfigPromise) {
    const basePath = window.CREATOR_HQ_PUBLIC_BASE || '/';
    const configUrl = new URL(`${basePath.replace(/\/$/, '')}/public-profile.json`, window.location.origin);
    publicProfileConfigPromise = fetch(configUrl, { cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(config => config?.publication || null)
      .catch(() => null);
  }
  return publicProfileConfigPromise;
}

function setPublicProfileStatus(text) {
  const node = document.getElementById('creator-profile-publish-status');
  if (node) node.textContent = text;
}

function hasPublicProfileContent(profile) {
  if (!profile) return false;
  const website = profile.website || profile;
  const linktree = profile.linktree || {};
  const websiteName = String(website.name || '').trim();
  const linktreeName = String(linktree.name || '').trim();
  return Boolean(
    (websiteName && !['Your name', 'Your creator name', 'Creator'].includes(websiteName)) ||
    website.handle || website.bio || website.avatarUrl || website.website?.tagline || website.tagline || website.website?.heroImage || website.heroImage || website.website?.twitchUrl || website.twitchUrl || website.website?.about || website.about ||
    (website.website?.featured || website.featured || []).length || (website.website?.products || website.products || []).length ||
    (linktreeName && !['Your name', 'Your creator name', 'Creator'].includes(linktreeName)) || linktree.handle || linktree.bio || linktree.avatarUrl || (linktree.links || []).some(link => link.label && link.url)
  );
}

async function initializePublicProfile() {
  if (!client || !session?.user || publicProfileCheckedForUser === session.user.id || publicProfileCheckPromise) return publicProfileCheckPromise;
  const userId = session.user.id;
  publicProfileCheckPromise = (async () => {
    const config = await getPublicProfileConfig();
    if (!config?.userId || userId !== config.userId) {
      setPublicProfileStatus('Signed in, but this account does not own the public site.');
      return;
    }
    const { data, error } = await client.from('creator_public_profiles').select('profile').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    const currentProfiles = storage()?.getPublicCreatorProfiles?.() || { website: storage()?.getPublicCreatorProfile?.() };
    if (data?.profile) {
      const hasProfileEnvelope = data.profile.website && typeof data.profile.website === 'object' && data.profile.linktree && typeof data.profile.linktree === 'object';
      const savedProfiles = hasProfileEnvelope
        ? data.profile
        : { website: data.profile, linktree: currentProfiles.linktree || {} };
      storage()?.restorePublicCreatorProfiles?.(savedProfiles);
      const restoredProfiles = storage()?.getPublicCreatorProfiles?.() || currentProfiles;
      lastPublishedPublicProfile = JSON.stringify(data.profile);
      if (!hasProfileEnvelope) queuePublicProfileSync(restoredProfiles);
      setPublicProfileStatus('Database profile loaded. Website edits update the live site automatically.');
    } else if (hasPublicProfileContent(currentProfiles)) {
      queuePublicProfileSync(currentProfiles);
    } else {
      setPublicProfileStatus('Connected. Edit public website content to publish the first live version.');
    }
    publicProfileCheckedForUser = userId;
  })().catch(error => {
    setPublicProfileStatus(error.message || 'Could not check the live profile.');
  }).finally(() => { publicProfileCheckPromise = null; });
  return publicProfileCheckPromise;
}

function queuePublicProfileSync(profile = storage()?.getPublicCreatorProfiles?.()) {
  if (!profile) return;
  pendingPublicProfile = structuredClone(profile);
  clearTimeout(publicProfileSyncTimer);
  if (!client || !session?.user) {
    setPublicProfileStatus('Saved in this browser. Sign in to Supabase here to update the live site automatically.');
    return;
  }
  setPublicProfileStatus('Changes saved. Updating the live site…');
  publicProfileSyncTimer = setTimeout(() => { publishPendingPublicProfile(); }, 900);
}

async function publishPendingPublicProfile() {
  if (publicProfileSyncPromise || !pendingPublicProfile) return publicProfileSyncPromise;
  const profile = pendingPublicProfile;
  pendingPublicProfile = null;
  publicProfileSyncPromise = (async () => {
    if (!client || !session?.user) throw new Error('Connect and sign in to Supabase to publish website changes.');
    const config = await getPublicProfileConfig();
    if (!config?.userId || !config.supabaseUrl || !config.anonKey) throw new Error('The public profile config is missing its Supabase publication settings. Download and deploy a fresh public-profile.json.');
    if (session.user.id !== config.userId) throw new Error('Sign in with the Supabase account that owns this public site.');
    const profileText = JSON.stringify(profile);
    if (new TextEncoder().encode(profileText).byteLength > 500_000) throw new Error('The public profile is too large to publish. Reduce its text or product details.');
    if (profileText === lastPublishedPublicProfile) return;
    const { error } = await client.from('creator_public_profiles').upsert({
      user_id: session.user.id,
      profile,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) throw error;
    lastPublishedPublicProfile = profileText;
    setPublicProfileStatus(`Live site updated at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`);
  })().catch(error => {
    setPublicProfileStatus(error.message || 'Could not update the live site.');
  }).finally(() => {
    publicProfileSyncPromise = null;
    if (pendingPublicProfile) queuePublicProfileSync(pendingPublicProfile);
  });
  return publicProfileSyncPromise;
}

async function restoreSavedLinktree() {
  const status = document.getElementById('linktree-admin-status');
  try {
    const user = await currentUser();
    const { data, error } = await client.from('creator_workspaces').select('workspace_data').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    const savedProfile = data?.workspace_data?.creatorProfile;
    if (!savedProfile || !Array.isArray(savedProfile.links) || !savedProfile.links.length) {
      throw new Error('No saved Linktree links were found in this cloud workspace.');
    }
    const currentLinks = storage()?.getWorkspace?.()?.creatorProfile?.links || [];
    if (currentLinks.length && !window.confirm(`Replace the ${currentLinks.length} current Linktree links with ${savedProfile.links.length} links saved in your cloud workspace?`)) return;
    const count = storage()?.restoreLinktreeProfile?.(savedProfile);
    await syncSocialLinks();
    await publishPendingPublicProfile();
    if (status) status.textContent = `Restored ${count} saved links and updated the public Linktree.`;
  } catch (error) {
    if (status) status.textContent = error.message || 'Could not restore saved Linktree links.';
  }
}

function publicTrackingConfig() {
  const config = readConfig();
  if (!config.url || !config.anonKey) return null;
  return { endpoint: `${config.url.replace(/\/$/, '')}/functions/v1/social-analytics`, anonKey: config.anonKey };
}

window.CreatorHQCloud = {
  queueSync,
  queuePublicProfileSync,
  restoreSavedLinktree,
  getPublicProfileConfig,
  publicTrackingConfig,
  syncSocialLinks,
  loadSocialAnalytics,
  refreshAnalyticsData,
  refreshBufferData,
  loadPlatformAccounts,
  refreshPlatformMetrics,
  connectSocialPlatform,
  disconnectSocialPlatform,
  getPlatformAccounts: () => structuredClone(platformAccounts),
  getPlatformMetric: provider => structuredClone(platformMetrics.find(item => item.provider === provider) || null),
  getPlatformMetrics: provider => structuredClone(platformMetrics.filter(item => item.provider === provider)),
  getPlatformNotice: provider => platformCallbackNotices[provider] || ''
};

function setSocialAnalyticsStatus(text, connected = false) {
  const node = document.getElementById('social-analytics-status');
  const settingsNode = document.getElementById('settings-social-tracking-status');
  if (node) node.textContent = text;
  if (settingsNode) settingsNode.textContent = text;
  if (connected) storage()?.refreshSocialLinks?.();
}

async function socialAnalyticsRequest(action, params = {}, authenticated = true) {
  const config = readConfig();
  if (!client || !config.url || !config.anonKey) throw new Error('Connect a Supabase project to enable social click analytics.');
  if (authenticated && !session?.access_token) throw new Error('Sign in to view private social click analytics.');
  let response;
  try {
    response = await fetch(`${config.url}/functions/v1/social-analytics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.anonKey,
        ...(authenticated ? { Authorization: `Bearer ${session.access_token}` } : {})
      },
      body: JSON.stringify({ action, ...params })
    });
  } catch {
    throw new Error('Social click tracking is not active yet. Apply the social analytics migration, deploy the social-analytics function, and allow this site origin in ALLOWED_APP_ORIGINS.');
  }
  const result = await response.json().catch(() => ({}));
  if (response.status === 404) throw new Error('Social click tracking is not deployed yet. Apply supabase/migrations/20261026000000_social_link_analytics.sql, run `supabase functions deploy social-analytics`, and allow http://127.0.0.1:8765 in ALLOWED_APP_ORIGINS.');
  if (response.status === 403) throw new Error('This site origin is not allowed for social analytics. Add the exact origin (http://127.0.0.1:8765 locally) to ALLOWED_APP_ORIGINS, then redeploy the function.');
  if (!response.ok) throw new Error(result.error || `Social analytics request failed (${response.status}).`);
  return result;
}

async function syncSocialLinks() {
  if (!session?.user || !client) return;
  const links = (storage()?.getWorkspace()?.creatorProfile?.links || []).filter(link => link.id && link.label && /^https?:\/\//i.test(link.url));
  const payload = links.map(link => ({ linkId: link.id, label: link.label, platform: link.platform || link.icon || 'other', url: link.url }));
  const result = await socialAnalyticsRequest('register', { links: payload });
  setSocialAnalyticsStatus(`Tracking ${result.registered} Linktree ${result.registered === 1 ? 'link' : 'links'}.`, true);
}

async function loadSocialAnalytics() {
  try {
    const result = await socialAnalyticsRequest('report');
    const links = Array.isArray(result.links) ? result.links : [];
    const today = links.reduce((sum, link) => sum + Number(link.clicksToday || 0), 0);
    const week = links.reduce((sum, link) => sum + Number(link.clicks7d || 0), 0);
    const month = links.reduce((sum, link) => sum + Number(link.clicks30d || 0), 0);
    document.getElementById('social-clicks-today').textContent = today.toLocaleString();
    document.getElementById('social-clicks-week').textContent = week.toLocaleString();
    document.getElementById('social-clicks-month').textContent = month.toLocaleString();
    document.getElementById('social-click-links').innerHTML = links.length
      ? links.sort((first, second) => second.clicks30d - first.clicks30d).map(link => `<div class="social-click-row"><div><strong>${bufferHtml(link.label)}</strong><span>${bufferHtml(link.platform)} · ${bufferHtml(link.url)}</span></div><div><strong>${Number(link.clicks30d || 0).toLocaleString()}</strong><span>30 days</span></div></div>`).join('')
      : '<p class="shop-empty-state">Add links on the Linktree page and share it to begin collecting click counts.</p>';
    setSocialAnalyticsStatus(`Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, true);
  } catch (error) {
    setSocialAnalyticsStatus(error.message || 'Could not load social click data.');
  }
}

function setPlatformAccountsStatus(text) {
  const node = document.getElementById('social-platform-status');
  if (node) node.textContent = text;
}

async function socialAccountsRequest(action, params = {}) {
  const config = readConfig();
  if (!client || !config.url || !config.anonKey) throw new Error('Connect a Supabase project to connect social accounts.');
  if (!session?.access_token) throw new Error('Sign in to Creator HQ to connect social accounts.');
  let response;
  try {
    response = await fetch(`${config.url}/functions/v1/social-accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.anonKey, Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ action, ...params })
    });
  } catch {
    throw new Error('Platform account connections are not reachable. Deploy the social-accounts Edge Function and apply its database migration.');
  }
  const result = await response.json().catch(() => ({}));
  if (response.status === 404) throw new Error('The social-accounts function is not deployed, or the platform account migration has not been applied.');
  if (!response.ok) throw new Error(result.error || `Platform account request failed (${response.status}).`);
  return result;
}

async function loadPlatformAccounts() {
  if (!session?.user || !client) return;
  try {
    const result = await socialAccountsRequest('accounts');
    platformAccounts = Array.isArray(result.accounts) ? result.accounts : [];
    platformMetrics = Array.isArray(result.metrics) ? result.metrics : [];
    setPlatformAccountsStatus(platformCallbackNotice || (platformAccounts.length ? `${platformAccounts.length} account${platformAccounts.length === 1 ? '' : 's'} connected` : 'No platform accounts connected'));
    storage()?.refreshAnalytics?.();
  } catch (error) {
    setPlatformAccountsStatus(error.message || 'Could not load platform accounts.');
    throw error;
  }
}

async function refreshPlatformMetrics() {
  try {
    await loadPlatformAccounts();
    if (!platformAccounts.length) return;
    setPlatformAccountsStatus('Refreshing connected accounts…');
    const result = await socialAccountsRequest('sync');
    platformMetrics = Array.isArray(result.metrics) ? result.metrics : platformMetrics;
    const failures = (result.results || []).filter(item => !item.ok);
    await loadPlatformAccounts();
    if (failures.length) setPlatformAccountsStatus(`Updated with ${failures.length} provider issue${failures.length === 1 ? '' : 's'}`);
    else setPlatformAccountsStatus(platformCallbackNotice || `Metrics updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  } catch (error) {
    setPlatformAccountsStatus(error.message || 'Could not refresh platform metrics.');
  }
}

async function refreshAnalyticsData() {
  if (document.hidden || !session?.user || !client || analyticsRefreshPromise) return analyticsRefreshPromise;
  const analyticsVisible = !document.getElementById('view-analytics')?.hidden;
  const settingsVisible = !document.getElementById('view-settings')?.hidden;
  if (!analyticsVisible && !settingsVisible) return;
  const now = Date.now();
  const jobs = [];
  if (analyticsVisible && now - lastSocialAnalyticsRefresh >= SOCIAL_ANALYTICS_REFRESH_MS) {
    lastSocialAnalyticsRefresh = now;
    jobs.push(loadSocialAnalytics());
  }
  if ((analyticsVisible || settingsVisible) && now - lastPlatformMetricsRefresh >= PLATFORM_METRICS_REFRESH_MS) {
    lastPlatformMetricsRefresh = now;
    jobs.push(refreshPlatformMetrics());
  }
  if (!jobs.length) return;
  analyticsRefreshPromise = Promise.allSettled(jobs);
  try { await analyticsRefreshPromise; }
  finally { analyticsRefreshPromise = null; }
}

  async function refreshBufferData() {
    if (document.hidden || !session?.user || !client || bufferRefreshPromise) return bufferRefreshPromise;
    const composeVisible = !document.getElementById('view-buffer-compose')?.hidden;
    const scheduledVisible = !document.getElementById('view-buffer-scheduled')?.hidden;
    if (!composeVisible && !scheduledVisible || Date.now() - lastBufferRefresh < BUFFER_REFRESH_MS) return;
    bufferRefreshPromise = bufferOrganizations.length ? loadBufferPosts() : loadBufferWorkspace();
    try { await bufferRefreshPromise; }
    finally { bufferRefreshPromise = null; }
  }

  setInterval(() => {
    refreshAnalyticsData();
    refreshBufferData();
  }, 60_000);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshAnalyticsData();
      refreshBufferData();
    }
});
async function connectSocialPlatform(provider) {
  try {
    platformCallbackNotice = '';
    delete platformCallbackNotices[provider];
    setPlatformAccountsStatus(`Preparing ${provider} authorization…`);
    const result = await socialAccountsRequest('start', { provider, returnUrl: appRedirectUrl() });
    if (!result.authorizationUrl) throw new Error('The provider did not return an authorization URL.');
    window.location.assign(result.authorizationUrl);
  } catch (error) {
    setPlatformAccountsStatus(error.message || `Could not connect ${provider}.`);
  }
}

async function disconnectSocialPlatform(provider) {
  if (!window.confirm(`Disconnect ${provider} and remove its saved authorization and metrics?`)) return;
  try {
    await socialAccountsRequest('disconnect', { provider });
    platformAccounts = platformAccounts.filter(account => account.provider !== provider);
    platformMetrics = platformMetrics.filter(item => item.provider !== provider);
    storage()?.refreshAnalytics?.();
    setPlatformAccountsStatus(`${provider} disconnected`);
  } catch (error) {
    setPlatformAccountsStatus(error.message || `Could not disconnect ${provider}.`);
  }
}

document.getElementById('social-platform-connections')?.addEventListener('click', event => {
  const button = event.target.closest('[data-platform-action]');
  if (!button) return;
  const provider = button.dataset.provider;
  if (button.dataset.platformAction === 'connect') connectSocialPlatform(provider);
  if (button.dataset.platformAction === 'disconnect') disconnectSocialPlatform(provider);
});

const socialConnectionResult = new URLSearchParams(window.location.search).get('social_connection');
if (socialConnectionResult) {
  const provider = new URLSearchParams(window.location.search).get('provider') || 'social platform';
  const callbackError = new URLSearchParams(window.location.search).get('social_error');
  const notice = socialConnectionResult === 'success' ? `${provider} connected successfully.` : socialConnectionResult === 'denied' ? `${provider} authorization was canceled.` : socialConnectionResult === 'expired' ? `${provider} authorization timed out. Start the connection again.` : callbackError || `${provider} could not be connected. Start the connection again and check provider settings.`;
  platformCallbackNotice = notice;
  platformCallbackNotices[provider.toLowerCase()] = notice;
  setPlatformAccountsStatus(notice);
  const cleanUrl = new URL(window.location.href);
  ['social_connection', 'provider', 'social_error'].forEach(key => cleanUrl.searchParams.delete(key));
  window.history.replaceState({}, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
  document.querySelector('.nav-button[data-view="analytics"]')?.click();
}

async function callFourthwall(action, params = {}) {
  if (!client || !session?.access_token) throw new Error('Connect Supabase and sign in to Creator HQ before managing Fourthwall.');
  const config = readConfig();
  const response = await fetch(`${config.url}/functions/v1/fourthwall`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: config.anonKey,
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ action, ...params })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Fourthwall request failed (${response.status}).`);
  return result;
}

window.CreatorHQFourthwall = { request: callFourthwall, isSignedIn: () => Boolean(session?.user) };

async function connectProject(urlValue, keyValue) {
  let url;
  try { url = new URL(urlValue.trim()); }
  catch { throw new Error('Enter a valid Supabase Project URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('Use an HTTPS Supabase URL. HTTP is allowed only for local development.');
  }
  if (!keyValue.trim()) throw new Error('Enter the anon/publishable key from your Supabase project.');

  writeConfig({ ...readConfig(), url: url.origin, anonKey: keyValue.trim() });
  client = createClient(url.origin, keyValue.trim(), {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  ui()?.setConnection(true, 'Project client initialized. Sign in to check the database connection.');
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  session = data.session;
  setAccountState();
  client.auth.onAuthStateChange((event, nextSession) => {
    session = nextSession;
    if (event === 'PASSWORD_RECOVERY') recoveryMode = true;
    setAccountState();
  });
}

function reportError(error) {
  const text = message(error);
  ui()?.setConnection(Boolean(client), text);
  ui()?.notify(text);
}

function bufferHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function setBufferStatus(text, connected = false) {
  const enabled = Boolean(connected);
  const chip = document.getElementById('buffer-connection-chip');
  const messageNode = document.getElementById('buffer-connection-message');
  if (chip) chip.textContent = connected ? 'Connected' : 'Not connected';
  const scheduledConnection = document.getElementById('buffer-scheduled-connection');
  if (scheduledConnection) scheduledConnection.textContent = connected ? 'Buffer connected' : 'Not connected';
  if (messageNode) messageNode.textContent = text;
  const setupCopy = document.querySelector('#buffer-setup-panel .architecture-note p');
  if (setupCopy) {
    setupCopy.textContent = 'Create a personal API key at Buffer Settings → API. In the project folder, use an ignored .env.local file and Supabase CLI to set BUFFER_API_KEY, BUFFER_ALLOWED_USER_ID (your Creator HQ Auth user UUID), and ALLOWED_APP_ORIGINS=http://127.0.0.1:8765, then deploy the buffer Edge Function. Full commands are in README.md. Never enter the Buffer key in this browser.';
    const setupNote = setupCopy.closest('.architecture-note');
    if (setupNote) setupNote.hidden = enabled;
  }
  for (const id of ['buffer-organization', 'buffer-channel-filter', 'buffer-channel', 'buffer-post-text', 'buffer-schedule-mode']) {
    const element = document.getElementById(id);
    if (element) element.disabled = !enabled;
  }
  document.querySelectorAll('#buffer-channel-targets input, #buffer-channel-customizations textarea, #buffer-channel-customizations select, #buffer-channel-customizations input').forEach(element => { element.disabled = !enabled; });
  for (const id of ['buffer-media-type', 'buffer-media-url']) {
    const element = document.getElementById(id);
    if (element) element.disabled = !enabled || (id === 'buffer-media-url' && !document.getElementById('buffer-media-type')?.value);
  }
  const submit = document.getElementById('buffer-schedule-submit');
  if (submit) submit.disabled = !enabled;
}

async function callBuffer(action, params = {}) {
  if (!client || !session?.access_token) throw new Error('Sign in to Creator HQ before using Buffer.');
  const config = readConfig();
  const response = await fetch(`${config.url}/functions/v1/buffer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: config.anonKey,
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ action, ...params })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Buffer request failed (${response.status}).`);
  return result;
}

function selectedBufferOrganization() {
  return bufferOrganizations.find(organization => organization.id === document.getElementById('buffer-organization').value);
}

function renderBufferChannels() {
  const organization = selectedBufferOrganization();
  const channels = organization?.channels || [];
  const options = channels.map(channel => `<option value="${bufferHtml(channel.id)}">${bufferHtml(channel.name)} · ${bufferHtml(channel.service)}</option>`).join('');
  document.getElementById('buffer-channel').innerHTML = options || '<option value="">No connected channels in this organization</option>';
  const current = document.getElementById('buffer-channel-filter').value;
  document.getElementById('buffer-channel-filter').innerHTML = `<option value="all">All channels</option>${options}`;
  if (channels.some(channel => channel.id === current)) document.getElementById('buffer-channel-filter').value = current;
  renderBufferTargetChoices();
}

function ensureBufferQueueViews() {
  const queue = document.getElementById('buffer-queue');
  if (!queue || document.getElementById('buffer-view-tabs')) return;
  queue.insertAdjacentHTML('beforebegin', '<div id="buffer-view-tabs" class="buffer-view-tabs"><button type="button" class="buffer-view-tab active" data-buffer-view="list">List</button><button type="button" class="buffer-view-tab" data-buffer-view="calendar">Calendar</button><span class="nav-count" id="buffer-calendar-label" style="margin-left:auto"></span><button type="button" class="button" id="buffer-load-more" hidden>Load next 50</button></div><div id="buffer-calendar" hidden></div>');
  document.getElementById('buffer-view-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-buffer-view]');
    if (!button) return;
    bufferQueueView = button.dataset.bufferView;
    document.querySelectorAll('#buffer-view-tabs [data-buffer-view]').forEach(tab => tab.classList.toggle('active', tab === button));
    document.getElementById('buffer-calendar').hidden = bufferQueueView !== 'calendar';
    queue.hidden = bufferQueueView !== 'list';
    renderBufferCalendar();
  });
  document.getElementById('buffer-load-more').addEventListener('click', () => loadBufferPosts({ append: true }));
  queue.addEventListener('click', event => {
    const postButton = event.target.closest('[data-buffer-post]');
    if (!postButton) return;
    const post = bufferPosts.find(item => item.id === postButton.dataset.bufferPost);
    if (post) openBufferPost(post);
  });
  document.getElementById('buffer-calendar').addEventListener('click', event => {
    const postButton = event.target.closest('[data-buffer-post]');
    if (postButton) {
      const post = bufferPosts.find(item => item.id === postButton.dataset.bufferPost);
      if (post) openBufferPost(post);
      return;
    }
    const moreButton = event.target.closest('[data-buffer-day]');
    if (moreButton) {
      const dayPosts = bufferPosts.filter(post => post.dueAt && new Date(post.dueAt).toLocaleDateString('en-CA') === moreButton.dataset.bufferDay);
      openBufferPostList(dayPosts);
    }
  });
  renderBufferCalendar();
}

function bufferLocalDateTime(value) {
  const date = new Date(value);
  const pad = part => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function bufferPreviewMarkup(post, channel, idPrefix = 'buffer-preview') {
  const service = String(channel?.service || 'social').toLowerCase();
  const initials = (channel?.name || 'Creator').split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase();
  const media = Array.isArray(post.assets) ? post.assets.find(asset => asset.source || asset.thumbnail) : null;
  const mediaUrl = media?.source || media?.thumbnail || '';
  const safeMediaUrl = /^https:\/\//i.test(mediaUrl) ? bufferHtml(mediaUrl) : '';
  const mediaPreview = safeMediaUrl
    ? (media.type === 'video'
      ? `<video class="buffer-preview-media" controls playsinline preload="metadata" src="${safeMediaUrl}" poster="${bufferHtml(/^https:\/\//i.test(media.thumbnail || '') ? media.thumbnail : '')}"></video>`
      : `<img class="buffer-preview-media" src="${safeMediaUrl}" alt="Attached post media">`)
    : '';
  return `<article class="buffer-preview-card"><div class="buffer-preview-account"><span class="buffer-preview-avatar">${bufferHtml(initials || 'C')}</span><span><strong>${bufferHtml(channel?.name || 'Creator')}</strong><small>${bufferHtml(channel?.service || 'Social channel')}</small></span><span class="buffer-preview-menu" aria-hidden="true">···</span></div><p class="buffer-preview-text" id="${idPrefix}-text">${bufferHtml(post.text || '')}</p>${mediaPreview}<div class="buffer-preview-actions"><span aria-hidden="true">♡</span><span aria-hidden="true">◌</span><span aria-hidden="true">↗</span><span class="buffer-preview-channel">${bufferHtml(service)}</span></div><div class="buffer-preview-schedule" id="${idPrefix}-schedule">${bufferHtml(post.previewSchedule || `Scheduled ${post.dueAt ? new Date(post.dueAt).toLocaleString() : 'time not set'}`)}</div></article>`;
}

function ensureBufferComposerLayout() {
  const submit = document.getElementById('buffer-schedule-submit');
  const composerPanel = submit?.closest('.panel');
  const body = composerPanel?.querySelector('.panel-body');
  if (!body || body.querySelector('.buffer-composer-layout')) return;
  composerPanel.classList.add('buffer-composer-panel');
  const grid = composerPanel.closest('.analytics-grid');
  const rightStack = composerPanel.closest('.right-stack');
  if (grid && rightStack) {
    const queuePanel = grid.querySelector('#buffer-queue')?.closest('.panel');
    const guidePanel = [...rightStack.children].find(child => child !== composerPanel);
    const workspace = document.createElement('div');
    workspace.className = 'buffer-publishing-workspace';
    grid.replaceWith(workspace);
    workspace.append(composerPanel);
    if (guidePanel) { guidePanel.classList.add('buffer-guide-panel'); workspace.append(guidePanel); }
    if (queuePanel) {
      const page = composerPanel.closest('.view')?.parentElement;
      let scheduledView = document.getElementById('view-buffer-scheduled');
      if (!scheduledView && page) {
        scheduledView = document.createElement('section');
        scheduledView.className = 'view buffer-scheduled-view';
        scheduledView.id = 'view-buffer-scheduled';
        scheduledView.hidden = true;
        scheduledView.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Social Media Management</div><h1>Scheduled</h1><p class="subtitle">Review your Buffer queue in a list or calendar, and edit posts when plans change.</p></div><div class="button-row"><span class="chip" id="buffer-scheduled-connection">Checking Buffer</span><button class="button primary" type="button" data-view="buffer-compose">Compose post</button></div></div>`;
        document.getElementById('view-buffer-compose')?.insertAdjacentElement('afterend', scheduledView);
      }
      if (scheduledView) scheduledView.append(queuePanel);
    }
  }
  body.classList.add('buffer-composer-body');
  const layout = document.createElement('div');
  layout.className = 'buffer-composer-layout';
  const fields = document.createElement('div');
  fields.className = 'buffer-composer-fields';
  fields.id = 'buffer-composer-fields';
  const preview = document.createElement('aside');
  preview.className = 'buffer-composer-preview';
  preview.innerHTML = `<div class="buffer-preview-heading"><div><p class="buffer-editor-kicker">LIVE PREVIEW</p><h3>Post appearance</h3></div><span class="buffer-preview-live"><span></span>Preview</span></div><label class="form-field buffer-preview-channel-picker"><span>Preview channel</span><select class="field-control" id="buffer-preview-target" aria-label="Choose channel for preview"></select></label><div id="buffer-compose-preview">${bufferPreviewMarkup({ text: '', previewSchedule: 'Added to next available queue slot.' }, null, 'buffer-compose-preview')}</div>`;
  while (body.firstChild) fields.append(body.firstChild);
  const outdatedMediaNote = [...fields.querySelectorAll('.settings-hint')].find(node => node.textContent.includes('Media isn’t attached yet'));
  outdatedMediaNote?.remove();
  layout.append(fields, preview);
  body.append(layout);
  const footer = document.createElement('div');
  footer.className = 'buffer-composer-footer';
  footer.innerHTML = '<p class="settings-hint">Media must be publicly accessible over HTTPS. Local device files are not uploaded.</p>';
  footer.append(submit);
  body.append(footer);
  fields.addEventListener('input', renderBufferComposerPreview);
  fields.addEventListener('change', renderBufferComposerPreview);
  preview.querySelector('#buffer-preview-target').addEventListener('change', renderBufferComposerPreview);
}

function ensureBufferComposerSections() {
  const fields = document.getElementById('buffer-composer-fields');
  if (!fields || fields.dataset.sectionsReady === 'true') return;
  const contentField = document.getElementById('buffer-content-source')?.closest('.form-field');
  const targetsField = document.getElementById('buffer-channel-targets')?.closest('.form-field');
  const textField = document.getElementById('buffer-post-text')?.closest('.form-field');
  const mediaControls = document.getElementById('buffer-media-controls');
  const scheduleField = document.getElementById('buffer-schedule-mode')?.closest('.form-field');
  const dueField = document.getElementById('buffer-due-field');
  const sections = [
    { title: 'Choose destinations', description: 'Start from planned content or tailor the post for selected channels.', elements: [contentField, targetsField] },
    { title: 'Write your post', description: 'Your copy can be customized independently for each channel.', elements: [textField] },
    { title: 'Add media', description: 'Use a stable public HTTPS image or video URL.', elements: [mediaControls] },
    { title: 'Choose when to publish', description: 'Add to the next queue slot or choose an exact local time.', elements: [scheduleField, dueField] }
  ];
  const activeSections = sections.map((section, index) => {
    const elements = section.elements.filter(element => element && fields.contains(element));
    if (!elements.length) return null;
    const wrapper = document.createElement('section');
    wrapper.className = 'buffer-compose-section';
    wrapper.innerHTML = `<div class="buffer-compose-section-head"><span class="buffer-compose-step">${String(index + 1).padStart(2, '0')}</span><div><h3>${bufferHtml(section.title)}</h3><p>${bufferHtml(section.description)}</p></div></div>`;
    elements.forEach(element => wrapper.append(element));
    return wrapper;
  }).filter(Boolean);
  activeSections.forEach(section => fields.append(section));
  fields.dataset.sectionsReady = 'true';
  renderBufferComposerPreview();
}

function renderBufferComposerPreview() {
  const host = document.getElementById('buffer-compose-preview');
  const targetPicker = document.getElementById('buffer-preview-target');
  if (!host || !targetPicker) return;
  const organization = selectedBufferOrganization();
  const selectedIds = [...document.querySelectorAll('#buffer-channel-targets [data-buffer-target]:checked')].map(input => input.value);
  const channels = organization?.channels || [];
  const previewIds = selectedIds.length ? selectedIds : channels.slice(0, 1).map(channel => channel.id);
  const previousId = targetPicker.value;
  targetPicker.innerHTML = previewIds.length
    ? previewIds.map(id => {
      const channel = channels.find(item => item.id === id);
      return `<option value="${bufferHtml(id)}">${bufferHtml(channel?.name || 'Buffer channel')} · ${bufferHtml(channel?.service || 'Social')}</option>`;
    }).join('')
    : '<option value="">Select a channel to preview</option>';
  if (previewIds.includes(previousId)) targetPicker.value = previousId;
  targetPicker.disabled = !previewIds.length;
  const channelId = targetPicker.value || previewIds[0] || '';
  const channel = channels.find(item => item.id === channelId);
  const override = channelId ? document.querySelector(`[data-target-text="${CSS.escape(channelId)}"]`)?.value.trim() : '';
  const mediaMode = channelId ? document.querySelector(`[data-target-media="${CSS.escape(channelId)}"]`)?.value || 'inherit' : 'inherit';
  const sharedMediaType = document.getElementById('buffer-media-type')?.value || '';
  const mediaType = mediaMode === 'none' ? '' : mediaMode === 'inherit' ? sharedMediaType : mediaMode;
  const mediaUrl = mediaMode === 'inherit'
    ? document.getElementById('buffer-media-url')?.value.trim() || ''
    : channelId ? document.querySelector(`[data-target-url="${CSS.escape(channelId)}"]`)?.value.trim() || '' : '';
  const media = mediaType && /^https:\/\//i.test(mediaUrl) ? [{ type: mediaType, source: mediaUrl }] : [];
  const custom = document.getElementById('buffer-schedule-mode')?.value === 'custom';
  const localDateTime = document.getElementById('buffer-due-at')?.value || '';
  const dueAt = custom && localDateTime ? new Date(localDateTime) : null;
  const post = {
    text: override || document.getElementById('buffer-post-text')?.value || '',
    assets: media,
    dueAt: dueAt && !Number.isNaN(dueAt.getTime()) ? dueAt.toISOString() : '',
    previewSchedule: custom
      ? dueAt && !Number.isNaN(dueAt.getTime()) ? `Scheduled ${dueAt.toLocaleString()}` : 'Choose a date and time.'
      : 'Added to next available queue slot.'
  };
  host.innerHTML = bufferPreviewMarkup(post, channel, 'buffer-compose-preview');
}

function openBufferPost(post) {
  const organization = selectedBufferOrganization();
  const channel = organization?.channels?.find(item => item.id === post.channelId);
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  modalRoot.innerHTML = `<div class="modal-backdrop" data-backdrop><form class="modal buffer-editor-modal" id="buffer-post-edit-form" role="dialog" aria-modal="true" aria-labelledby="buffer-post-title"><div class="modal-head"><div><p class="buffer-editor-kicker">SCHEDULED CONTENT</p><h2 id="buffer-post-title">Edit scheduled post</h2><p class="buffer-editor-channel">${bufferHtml(channel?.name || 'Buffer channel')} · ${bufferHtml(channel?.service || 'Social')}</p></div><button type="button" class="mini-button" data-close-modal aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div class="buffer-editor-layout"><div class="buffer-editor-fields"><div class="buffer-editor-section"><div class="buffer-editor-section-heading"><span class="buffer-editor-step">01</span><div><h3>Post copy</h3><p>Shape the message your audience will see.</p></div></div><div class="form-field"><label class="sr-only" for="buffer-edit-text">Post copy</label><textarea id="buffer-edit-text" name="text" maxlength="5000" required>${bufferHtml(post.text || '')}</textarea><div class="workflow-meta"><span id="buffer-edit-character-count">${(post.text || '').length.toLocaleString()} / 5,000</span><span>${bufferHtml(post.status || 'Scheduled')}</span></div></div></div><div class="buffer-editor-section"><div class="buffer-editor-section-heading"><span class="buffer-editor-step">02</span><div><h3>Publishing time</h3><p>All times are shown in your local time zone.</p></div></div><div class="form-field"><label for="buffer-edit-due">Schedule date and time</label><input id="buffer-edit-due" name="dueAt" type="datetime-local" value="${bufferLocalDateTime(post.dueAt)}" required></div></div><p class="buffer-editor-note">Existing media and channel settings will be preserved.</p></div><aside class="buffer-editor-preview"><div class="buffer-preview-heading"><div><p class="buffer-editor-kicker">LIVE PREVIEW</p><h3>How it will appear</h3></div><span class="buffer-preview-live"><span></span>Preview</span></div><div id="buffer-post-preview">${bufferPreviewMarkup(post, channel)}</div></aside></div><div class="modal-actions"><span class="buffer-editor-save-note">Changes save directly to Buffer.</span><div><button type="button" class="button" data-close-modal>Cancel</button><button class="button primary" type="submit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m5 12 4 4L19 6"/></svg>Save changes</button></div></div></form></div>`;
  const form = document.getElementById('buffer-post-edit-form');
  const updatePreview = () => {
    const previewText = document.getElementById('buffer-preview-text');
    const characterCount = document.getElementById('buffer-edit-character-count');
    if (previewText) previewText.textContent = form.elements.text.value;
    if (characterCount) characterCount.textContent = `${form.elements.text.value.length.toLocaleString()} / 5,000`;
  };
  const updateSchedulePreview = () => {
    const schedule = document.getElementById('buffer-preview-schedule');
    const dueAt = new Date(form.elements.dueAt.value);
    if (schedule && !Number.isNaN(dueAt.getTime())) schedule.textContent = `Scheduled ${dueAt.toLocaleString()}`;
  };
  form.elements.text.addEventListener('input', updatePreview);
  form.elements.dueAt.addEventListener('input', updateSchedulePreview);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    const values = new FormData(form);
    const text = String(values.get('text') || '').trim();
    const dueAtDate = new Date(String(values.get('dueAt') || ''));
    if (!text || Number.isNaN(dueAtDate.getTime()) || dueAtDate.getTime() <= Date.now()) { ui()?.notify('Enter post copy and a future schedule time.'); return; }
    const dueAt = dueAtDate.toISOString();
    submit.disabled = true;
    submit.textContent = 'Saving…';
    try {
      await callBuffer('editPost', { id: post.id, text, dueAt });
      modalRoot.innerHTML = '';
      await loadBufferPosts();
      ui()?.notify('Scheduled post updated in Buffer.');
    } catch (error) {
      ui()?.notify(error.message || 'Could not update the scheduled post.');
      submit.disabled = false;
      submit.textContent = 'Save changes';
    }
  });
}

function openBufferPostList(posts) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot || !posts.length) return;
  const organization = selectedBufferOrganization();
  modalRoot.innerHTML = `<div class="modal-backdrop" data-backdrop><section class="modal" role="dialog" aria-modal="true" aria-labelledby="buffer-day-posts-title"><div class="modal-head"><h2 id="buffer-day-posts-title">Scheduled posts</h2><button type="button" class="mini-button" data-close-modal aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div class="modal-body">${posts.map(post => {
    const channel = organization?.channels?.find(item => item.id === post.channelId);
    return `<button type="button" class="buffer-calendar-post" data-buffer-post="${bufferHtml(post.id)}">${bufferHtml(post.dueAt ? new Date(post.dueAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '')} · ${bufferHtml(channel?.name || 'Buffer post')} — ${bufferHtml(post.text || '')}</button>`;
  }).join('')}<div class="modal-actions"><button type="button" class="button" data-close-modal>Close</button></div></div></section></div>`;
  modalRoot.addEventListener('click', event => {
    const button = event.target.closest('[data-buffer-post]');
    const post = posts.find(item => item.id === button?.dataset.bufferPost);
    if (post) openBufferPost(post);
  }, { once: true });
}

function renderBufferCalendar() {
  const calendar = document.getElementById('buffer-calendar');
  if (!calendar) return;
  const year = bufferCalendarMonth.getFullYear();
  const month = bufferCalendarMonth.getMonth();
  const firstDay = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - firstDay.getDay());
  const todayKey = new Date().toLocaleDateString('en-CA');
  const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(firstDay);
  document.getElementById('buffer-calendar-label').innerHTML = `<button class="mini-button" type="button" data-calendar-prev aria-label="Previous month">‹</button>${bufferHtml(monthName)}<button class="mini-button" type="button" data-calendar-next aria-label="Next month">›</button>`;
  document.getElementById('buffer-calendar-label').onclick = event => {
    if (event.target.closest('[data-calendar-prev]')) bufferCalendarMonth = new Date(year, month - 1, 1);
    else if (event.target.closest('[data-calendar-next]')) bufferCalendarMonth = new Date(year, month + 1, 1);
    renderBufferCalendar();
  };
  const organization = selectedBufferOrganization();
  const channelFilter = document.getElementById('buffer-channel-filter')?.value || 'all';
  const posts = bufferPosts.filter(post => channelFilter === 'all' || post.channelId === channelFilter);
  const days = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
    const key = day.toLocaleDateString('en-CA');
    const dayPosts = posts.filter(post => post.dueAt && new Date(post.dueAt).toLocaleDateString('en-CA') === key);
    const items = dayPosts.slice(0, 3).map(post => {
      const channel = organization?.channels?.find(item => item.id === post.channelId);
      const time = new Date(post.dueAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return `<button type="button" class="buffer-calendar-post" data-buffer-post="${bufferHtml(post.id)}" aria-label="Preview and edit scheduled post for ${bufferHtml(channel?.name || 'Buffer channel')}" title="${bufferHtml(post.text)}">${bufferHtml(time)} · ${bufferHtml(channel?.name || post.text || 'Post')}</button>`;
    }).join('');
    const more = dayPosts.length > 3 ? `<button type="button" class="buffer-calendar-post buffer-calendar-post-more" data-buffer-day="${bufferHtml(key)}">+${dayPosts.length - 3} more</button>` : '';
    return `<div class="buffer-calendar-day ${day.getMonth() !== month ? 'outside' : ''} ${key === todayKey ? 'today' : ''}"><div class="buffer-calendar-number">${day.getDate()}</div>${items}${more}</div>`;
  }).join('');
  calendar.innerHTML = `<div class="buffer-calendar"><div class="buffer-calendar-head">Sun</div><div class="buffer-calendar-head">Mon</div><div class="buffer-calendar-head">Tue</div><div class="buffer-calendar-head">Wed</div><div class="buffer-calendar-head">Thu</div><div class="buffer-calendar-head">Fri</div><div class="buffer-calendar-head">Sat</div>${days}</div><p class="settings-hint" style="margin:10px 0 0">Showing ${bufferPosts.length}${bufferPostsHasNext ? '+ loaded' : ''} scheduled posts. Use “Load next 50” to extend the calendar. Buffer remains the source of truth for queue status.</p>`;
}

function ensureBufferTargetPicker() {
  if (document.getElementById('buffer-channel-targets')) return;
  const channel = document.getElementById('buffer-channel');
  const channelField = channel?.closest('.form-field');
  if (!channelField) return;
  channelField.hidden = true;
  channelField.insertAdjacentHTML('beforebegin', '<div class="form-field"><label>Publish to channels</label><div id="buffer-channel-targets" class="buffer-target-list"><span class="settings-hint">Connect Buffer to load channels.</span></div><div id="buffer-channel-customizations"></div></div>');
  const submit = document.getElementById('buffer-schedule-submit');
  if (submit && !document.getElementById('buffer-batch-result')) submit.insertAdjacentHTML('beforebegin', '<div id="buffer-batch-result" class="buffer-batch-result" hidden></div>');
}

function renderBufferTargetChoices() {
  ensureBufferTargetPicker();
  const host = document.getElementById('buffer-channel-targets');
  if (!host) return;
  const org = selectedBufferOrganization();
  const channels = org?.channels || [];
  const selected = new Set([...host.querySelectorAll('input:checked')].map(input => input.value));
  const hasSelectedChannel = channels.some(channel => selected.has(channel.id));
  host.innerHTML = channels.length ? channels.map((channel, index) => `<label class="buffer-target-choice"><input type="checkbox" data-buffer-target="${bufferHtml(channel.id)}" value="${bufferHtml(channel.id)}" ${hasSelectedChannel ? (selected.has(channel.id) ? 'checked' : '') : (index === 0 ? 'checked' : '')}><span>${bufferHtml(channel.name)}</span><span class="chip">${bufferHtml(channel.service)}</span></label>`).join('') : '<span class="settings-hint">No channels available for this organization.</span>';
  host.onchange = () => { renderBufferTargetCustomizations(); updateBufferBatchLabel(); };
  renderBufferTargetCustomizations();
  ensureBufferComposerSections();
  updateBufferBatchLabel();
}

function updateBufferBatchLabel() {
  const count = document.querySelectorAll('#buffer-channel-targets [data-buffer-target]:checked').length;
  const button = document.getElementById('buffer-schedule-submit');
  if (button) button.textContent = count > 1 ? `Schedule ${count} posts in Buffer` : 'Schedule in Buffer';
}

function renderBufferTargetCustomizations() {
  const org = selectedBufferOrganization();
  const selectedIds = [...document.querySelectorAll('#buffer-channel-targets [data-buffer-target]:checked')].map(input => input.value);
  const host = document.getElementById('buffer-channel-customizations');
  if (!host) return;
  host.innerHTML = selectedIds.map(id => {
    const channel = org?.channels?.find(item => item.id === id);
    return `<details class="buffer-target-detail"><summary><span>${bufferHtml(channel?.name || 'Channel')}</span><span class="buffer-target-customize-hint">Customize copy and media</span></summary><label class="form-field"><span>Copy override <small>Leave blank to use shared copy</small></span><textarea data-target-text="${bufferHtml(id)}" maxlength="5000" placeholder="Use the main post copy"></textarea><span class="workflow-meta"><span data-target-character-count="${bufferHtml(id)}">0 / 5,000</span><span>Buffer validates channel limits</span></span></label><div class="form-grid"><label class="form-field"><span>Media for this channel</span><select class="field-control" data-target-media="${bufferHtml(id)}"><option value="inherit">Use shared media</option><option value="none">No media</option><option value="image">Different image</option><option value="video">Different video</option></select></label><label class="form-field"><span>Channel media URL</span><input class="field-control" data-target-url="${bufferHtml(id)}" type="url" placeholder="https://..." disabled></label></div></details>`;
  }).join('');
  host.querySelectorAll('[data-target-text]').forEach(input => input.addEventListener('input', () => {
    const counter = host.querySelector(`[data-target-character-count="${CSS.escape(input.dataset.targetText)}"]`);
    if (counter) counter.textContent = `${input.value.length.toLocaleString()} / 5,000`;
    renderBufferComposerPreview();
  }));
  host.querySelectorAll('[data-target-media]').forEach(select => {
    const url = host.querySelector(`[data-target-url="${CSS.escape(select.dataset.targetMedia)}"]`);
    const update = () => { if (url) { url.disabled = ['inherit', 'none'].includes(select.value); if (url.disabled) url.value = ''; } renderBufferComposerPreview(); };
    select.addEventListener('change', update);
    url?.addEventListener('input', renderBufferComposerPreview);
    update();
  });
  renderBufferComposerPreview();
}

function ensureBufferContentPicker() {
  let picker = document.getElementById('buffer-content-source');
  if (!picker) {
    const channelField = document.getElementById('buffer-channel')?.closest('.form-field');
    if (!channelField) return;
    channelField.insertAdjacentHTML('beforebegin', '<div class="form-field" style="margin-bottom:11px"><label for="buffer-content-source">Start from planned content</label><select id="buffer-content-source" class="field-control"><option value="">Write a new post</option></select></div>');
    picker = document.getElementById('buffer-content-source');
  }
  return picker;
}

function ensureBufferMediaControls() {
  if (document.getElementById('buffer-media-type')) return;
  const scheduleField = document.getElementById('buffer-schedule-mode')?.closest('.form-field');
  if (!scheduleField) return;
  scheduleField.insertAdjacentHTML('beforebegin', '<div class="form-grid" id="buffer-media-controls" style="margin-top:11px"><div class="form-field"><label for="buffer-media-type">Media attachment</label><select id="buffer-media-type" class="field-control"><option value="">No media</option><option value="image">Image</option><option value="video">Video</option></select></div><div class="form-field"><label for="buffer-media-url">Public media URL</label><input id="buffer-media-url" class="field-control" type="url" placeholder="https://..." disabled></div></div>');
  document.getElementById('buffer-media-type').addEventListener('change', event => {
    const input = document.getElementById('buffer-media-url');
    input.disabled = !event.target.value;
    if (!event.target.value) input.value = '';
  });
}

function renderBufferContentSources() {
  const picker = ensureBufferContentPicker();
  if (!picker) return;
  const items = storage()?.getWorkspace()?.content || [];
  picker.innerHTML = '<option value="">Write a new post</option>' + items
    .filter(item => item.status !== 'Published')
    .map(item => `<option value="${bufferHtml(item.id)}">${bufferHtml(item.title)}${item.platform ? ` · ${bufferHtml(item.platform)}` : ''}</option>`)
    .join('');
}

async function loadBufferWorkspace() {
  if (!session?.user || !client) return setBufferStatus('Sign in to Creator HQ before connecting Buffer.', false);
  lastBufferRefresh = Date.now();
  setBufferStatus('Checking your Buffer connection…', false);
  renderBufferContentSources();
  try {
    const result = await callBuffer('workspace');
    bufferOrganizations = Array.isArray(result.organizations) ? result.organizations : [];
    const selector = document.getElementById('buffer-organization');
    selector.innerHTML = bufferOrganizations.length
      ? bufferOrganizations.map(organization => `<option value="${bufferHtml(organization.id)}">${bufferHtml(organization.name)}</option>`).join('')
      : '<option value="">No Buffer organizations found</option>';
    renderBufferChannels();
    setBufferStatus(bufferOrganizations.length ? `Connected to Buffer account ${result.account?.email || ''}. Your channels are ready.` : 'Buffer is connected, but this account has no organizations or channels yet.', true);
    if (bufferOrganizations.length) await loadBufferPosts();
  } catch (error) {
    const detail = error.message || 'Buffer connection failed.';
    if (detail.includes('BUFFER_API_KEY')) {
      setBufferStatus('Buffer API key is not configured on Supabase yet. Follow the secure setup instructions below.', false);
    } else if (detail.toLowerCase().includes('failed to fetch') || detail.toLowerCase().includes('load failed')) {
      setBufferStatus('The Buffer Edge Function is not reachable yet. Deploy it to your connected Supabase project, set BUFFER_API_KEY and BUFFER_ALLOWED_USER_ID as Edge Function secrets, and allow this app origin. Follow the full setup in README.md.', false);
    } else if (detail.includes('Sign in') || detail.includes('session expired')) {
      setBufferStatus(detail, false);
    } else {
      setBufferStatus(detail, false);
    }
  }
}

async function loadBufferPosts({ append = false } = {}) {
  const organization = selectedBufferOrganization();
  if (!organization) return;
  const channelId = document.getElementById('buffer-channel-filter').value;
  if (!append) {
    bufferPosts = [];
    bufferPostsCursor = null;
    bufferPostsHasNext = false;
    document.getElementById('buffer-queue').innerHTML = '<div class="empty-state"><span>Loading Buffer queue…</span></div>';
  }
  const loadMoreButton = document.getElementById('buffer-load-more');
  if (append && loadMoreButton) { loadMoreButton.disabled = true; loadMoreButton.textContent = 'Loading…'; }
  try {
    const result = await callBuffer('posts', { organizationId: organization.id, channelId: channelId === 'all' ? '' : channelId, after: append ? bufferPostsCursor : '' });
    const pagePosts = Array.isArray(result.posts) ? result.posts : [];
    bufferPosts = append ? [...bufferPosts, ...pagePosts] : pagePosts;
    if (!append) lastBufferRefresh = Date.now();
    bufferPostsCursor = result.endCursor || null;
    bufferPostsHasNext = Boolean(result.hasNextPage);
    const channels = organization.channels || [];
    document.getElementById('buffer-queue-count').textContent = `${bufferPosts.length}${bufferPostsHasNext ? '+' : ''} posts`;
    document.getElementById('buffer-queue').innerHTML = bufferPosts.length ? bufferPosts.map(post => {
      const channel = channels.find(item => item.id === post.channelId);
      const date = post.dueAt ? new Date(post.dueAt) : null;
      return `<button type="button" class="data-entry-row buffer-post-row" data-buffer-post="${bufferHtml(post.id)}" aria-label="Preview and edit scheduled post for ${bufferHtml(channel?.name || 'Buffer channel')}"><span class="buffer-post-row-copy"><strong>${bufferHtml(channel?.name || 'Buffer channel')}</strong><span>${bufferHtml(post.text || '')}</span><span>${bufferHtml(post.status || 'Scheduled')}${date ? ` · ${bufferHtml(date.toLocaleString())}` : ''}</span></span><span class="chip">${bufferHtml(channel?.service || 'Buffer')}</span></button>`;
    }).join('') : '<div class="empty-state"><div><div class="empty-icon">✓</div><strong>No queued posts found</strong><span>Schedule a new post here or use Add to queue in the composer.</span></div></div>';
    ensureBufferQueueViews();
    document.getElementById('buffer-load-more').hidden = !bufferPostsHasNext;
    document.getElementById('buffer-load-more').disabled = false;
    document.getElementById('buffer-load-more').textContent = 'Load next 50';
    document.getElementById('buffer-queue').hidden = bufferQueueView !== 'list';
    document.getElementById('buffer-calendar').hidden = bufferQueueView !== 'calendar';
    renderBufferCalendar();
  } catch (error) {
    if (append) {
      document.getElementById('buffer-load-more').disabled = false;
      ui()?.notify(error.message || 'Could not load more Buffer posts.');
      return;
    }
    document.getElementById('buffer-queue-count').textContent = 'Unavailable';
    document.getElementById('buffer-queue').innerHTML = `<div class="empty-state"><div><strong>Could not load the queue</strong><span>${bufferHtml(error.message)}</span></div></div>`;
  }
}

async function scheduleBufferPost() {
  const contentId = document.getElementById('buffer-content-source').value;
  const sharedText = document.getElementById('buffer-post-text').value.trim();
  const custom = document.getElementById('buffer-schedule-mode').value === 'custom';
  const localDateTime = document.getElementById('buffer-due-at').value;
  const sharedAssetType = document.getElementById('buffer-media-type').value;
  const sharedAssetUrl = document.getElementById('buffer-media-url').value.trim();
  const channels = selectedBufferOrganization()?.channels || [];
  const selectedIds = [...document.querySelectorAll('#buffer-channel-targets [data-buffer-target]:checked')].map(input => input.value);
  if (!selectedIds.length) throw new Error('Select at least one Buffer channel.');
  if (selectedIds.length > 10) throw new Error('Select no more than 10 channels per batch.');
  if (!sharedText) throw new Error('Write shared post copy first.');
  if (custom && !localDateTime) throw new Error('Choose a date and time for the post.');
  const targets = selectedIds.map(channelId => {
    const override = document.querySelector(`[data-target-text="${CSS.escape(channelId)}"]`)?.value.trim() || '';
    const mediaMode = document.querySelector(`[data-target-media="${CSS.escape(channelId)}"]`)?.value || 'inherit';
    const targetMediaType = mediaMode === 'inherit' ? sharedAssetType : mediaMode === 'none' ? '' : mediaMode;
    const targetMediaUrl = mediaMode === 'inherit' ? sharedAssetUrl : document.querySelector(`[data-target-url="${CSS.escape(channelId)}"]`)?.value.trim() || '';
    return { channelId, text: override || sharedText, assetType: targetMediaType, assetUrl: targetMediaUrl };
  });
  const result = await callBuffer('schedule', {
    targets,
    mode: custom ? 'customScheduled' : 'addToQueue',
    dueAt: custom ? new Date(localDateTime).toISOString() : undefined
  });
  const successes = (result.results || []).filter(entry => entry.post);
  const failures = (result.results || []).filter(entry => entry.error);
  if (contentId && successes.length) storage()?.markContentScheduled?.(contentId, successes.map(entry => entry.post));
  const channelNames = new Map(channels.map(channel => [channel.id, channel.name]));
  const summary = `${successes.length} of ${targets.length} channel${targets.length === 1 ? '' : 's'} ${custom ? 'scheduled' : 'added to queue'}.`;
  document.getElementById('buffer-batch-result').innerHTML = `<strong>${bufferHtml(summary)}</strong>${failures.length ? `<ul>${failures.map(item => `<li>${bufferHtml(channelNames.get(item.channelId) || 'Channel')}: ${bufferHtml(item.error)}</li>`).join('')}</ul>` : ''}`;
  document.getElementById('buffer-batch-result').hidden = false;
  if (!successes.length) throw new Error(failures.map(item => item.error).join('; ') || 'Buffer did not schedule any posts.');
  if (!failures.length) {
    document.getElementById('buffer-post-text').value = '';
    document.getElementById('buffer-content-source').value = '';
    document.getElementById('buffer-media-type').value = '';
    document.getElementById('buffer-media-url').value = '';
    document.getElementById('buffer-media-url').disabled = true;
    document.querySelectorAll('#buffer-channel-customizations textarea').forEach(input => { input.value = ''; });
    document.querySelectorAll('#buffer-channel-customizations select').forEach(select => { select.value = 'inherit'; });
    document.querySelectorAll('#buffer-channel-customizations input').forEach(input => { input.value = ''; });
    document.getElementById('buffer-character-count').textContent = '0 / 5,000';
    renderBufferComposerPreview();
  }
  ui()?.notify(summary);
  await loadBufferPosts();
  return result;
}

document.getElementById('buffer-organization').addEventListener('change', () => { renderBufferChannels(); loadBufferPosts(); });
document.getElementById('buffer-channel-filter').addEventListener('change', loadBufferPosts);
ensureBufferContentPicker();
ensureBufferMediaControls();
ensureBufferComposerLayout();
document.getElementById('buffer-content-source').addEventListener('change', event => {
  const item = (storage()?.getWorkspace()?.content || []).find(content => content.id === event.target.value);
  if (!item) return;
  const text = [item.title, item.description].filter(Boolean).join('\n\n');
  document.getElementById('buffer-post-text').value = text;
  document.getElementById('buffer-character-count').textContent = `${text.length.toLocaleString()} / 5,000`;
  renderBufferComposerPreview();
});
document.getElementById('buffer-schedule-mode').addEventListener('change', event => {
  document.getElementById('buffer-due-field').hidden = event.target.value !== 'custom';
  renderBufferComposerPreview();
});
document.getElementById('buffer-due-at').addEventListener('input', renderBufferComposerPreview);
document.getElementById('buffer-post-text').addEventListener('input', event => {
  document.getElementById('buffer-character-count').textContent = `${event.target.value.length.toLocaleString()} / 5,000`;
  renderBufferComposerPreview();
});
document.getElementById('buffer-schedule-submit').addEventListener('click', async () => {
  const button = document.getElementById('buffer-schedule-submit');
  if (bufferScheduling) return;
  bufferScheduling = true;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = 'Scheduling…';
  try { await scheduleBufferPost(); }
  catch (error) { ui()?.notify(error.message || 'Could not schedule the post.'); }
  finally { bufferScheduling = false; button.disabled = false; updateBufferBatchLabel(); if (button.textContent === 'Scheduling…') button.textContent = originalText; }
});

document.getElementById('cloud-connect').addEventListener('click', async () => {
  try {
    await connectProject(document.getElementById('cloud-url').value, document.getElementById('cloud-anon-key').value);
    storage()?.refreshSocialLinks?.();
  } catch (error) { reportError(error); }
});

document.getElementById('cloud-sign-in').addEventListener('click', async () => {
  try {
    if (!client) throw new Error('Connect a Supabase project first.');
    const email = document.getElementById('cloud-email').value.trim();
    const password = document.getElementById('cloud-password').value;
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    session = data.session;
    setAccountState();
  } catch (error) { reportError(error); }
});

document.getElementById('cloud-forgot-password').addEventListener('click', async () => {
  try {
    if (!client) throw new Error('Connect a Supabase project first.');
    const email = document.getElementById('cloud-email').value.trim();
    if (!email) throw new Error('Enter your account email first.');
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: appRedirectUrl() });
    if (error) throw error;
    ui()?.setAccount('', 'If that email belongs to a Supabase Auth user, a password reset link has been sent. Check your inbox and spam folder.');
  } catch (error) { reportError(error); }
});

document.getElementById('cloud-update-password').addEventListener('click', async () => {
  try {
    if (!client || !session) throw new Error('Open the password-reset link from your email first.');
    const password = document.getElementById('cloud-new-password').value;
    if (password.length < 8) throw new Error('Use a password with at least 8 characters.');
    const { data, error } = await client.auth.updateUser({ password });
    if (error) throw error;
    session = data.session || session;
    recoveryMode = false;
    document.getElementById('cloud-new-password').value = '';
    setAccountState();
    ui()?.setAccount(session?.user?.email || '', 'Password updated. You can now sign in with your Supabase email and password.');
  } catch (error) { reportError(error); }
});

document.getElementById('cloud-github-sign-in').addEventListener('click', async () => {
  try {
    if (!client) throw new Error('Connect a Supabase project first.');
    const { error } = await client.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: appRedirectUrl() }
    });
    if (error) throw error;
  } catch (error) { reportError(error); }
});

document.getElementById('cloud-sign-up').addEventListener('click', async () => {
  try {
    if (!client) throw new Error('Connect a Supabase project first.');
    const email = document.getElementById('cloud-email').value.trim();
    const password = document.getElementById('cloud-password').value;
    if (password.length < 8) throw new Error('Use a password with at least 8 characters.');
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: appRedirectUrl() }
    });
    if (error) throw error;
    session = data.session;
    setAccountState();
    if (!session) ui()?.setAccount('', 'Check your email to confirm the new account, then sign in.');
  } catch (error) { reportError(error); }
});

document.getElementById('cloud-resend-confirmation').addEventListener('click', async () => {
  try {
    if (!client) throw new Error('Connect a Supabase project first.');
    const email = document.getElementById('cloud-email').value.trim();
    if (!email) throw new Error('Enter the email address you registered first.');
    const { error } = await client.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: appRedirectUrl() }
    });
    if (error) throw error;
    ui()?.setAccount('', 'If confirmation is still pending, Supabase sent a fresh link. Check your inbox and spam folder.');
  } catch (error) { reportError(error); }
});

document.getElementById('cloud-sign-out').addEventListener('click', async () => {
  try {
    writeConfig({ ...readConfig(), syncEnabled: false });
    if (client) {
      const { error } = await client.auth.signOut();
      if (error) throw error;
    }
    session = null;
    setAccountState();
  } catch (error) { reportError(error); }
});

document.getElementById('cloud-push').addEventListener('click', async () => {
  try { await uploadWorkspace({ confirmOverwrite: true }); }
  catch (error) { reportError(error); }
});

document.getElementById('cloud-pull').addEventListener('click', async () => {
  try { await pullWorkspace(); }
  catch (error) { reportError(error); }
});

document.getElementById('cloud-disable').addEventListener('click', () => {
  writeConfig({ ...readConfig(), syncEnabled: false });
  ui()?.setSyncStatus('Automatic sync paused. Local changes will not be uploaded.');
});

try {
  const config = readConfig();
  if (config.url && config.anonKey) {
    document.getElementById('cloud-url').value = config.url;
    document.getElementById('cloud-anon-key').value = config.anonKey;
    await connectProject(config.url, config.anonKey);
    storage()?.refreshSocialLinks?.();
    if (config.syncEnabled && session?.user) queueSync();
  }
} catch (error) {
  ui()?.setConnection(false, `Could not initialize Supabase: ${message(error)}`);
}