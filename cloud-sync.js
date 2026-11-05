import { createCloudPersistence } from './cloud-persistence.mjs';
import { createBlogAdmin } from './blog-admin.mjs';
import { createMfa, renderSecurity } from './auth-mfa.mjs';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2?bundle';

let memoryConfig = {syncEnabled:true};
let memoryBufferDrafts = [];
let currentBufferDraft = null;
let pendingWorkspaceSave = Promise.resolve();
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
const bufferCustomizations = new Map();
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
let publicProfileHydrated = false;
let publicProfileSyncTimer = null;
let publicProfileSyncPromise = null;
let pendingPublicProfile = null;
let lastPublishedPublicProfile = '';
let publicProfileCheckedForUser = null;
let publicProfileCheckPromise = null;
let bufferCalendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let bufferQueueView = 'list';
let authListeners = [];
let workspaceContext = null;
let workspaceRevision = null;
let workspaceDirty = false;
let workspaceChangeCount = 0;
let preparedForUser = null;
let preparingWorkplace = null;
let workplacePoll = null;
let mfaReady = false;
const workplaceOwner = () => workspaceContext?.owner_id;
const workplaceCan = permission => workspaceContext?.role === 'owner' || workspaceContext?.permissions?.includes(permission);
async function loadWorkplaceContext() {
  const {data,error}=await client.rpc('creator_workspace_context');
  if(error || !data?.owner_id)throw new Error(error?.message || 'Ask the owner to add your account to this workplace in Staff.');
  workspaceContext=data;
  return data;
}
async function prepareWorkplace() {
  if(preparedForUser===session?.user?.id)return;
  if(preparingWorkplace)return preparingWorkplace;
  preparingWorkplace=(async()=>{
    if(!mfaReady)throw new Error('Verify your authenticator first.');
    await loadWorkplaceContext();
    const actor=session.user.id;
    const {data,error}=await client.rpc('load_creator_workspace');
    if(error)throw error;
    if(session?.user?.id!==actor)throw new Error('Your account changed. Sign in again.');
    const legacyPreferences=await cloudPersistence.migrateLegacy();
    storage()?.setPersonalPreferences?.(await cloudPersistence.loadPreferences(legacyPreferences));
    if(data?.workspace_data)storage().replaceWorkspace(await cloudPersistence.hydrateAssets(data.workspace_data));
    else if(workspaceContext.role!=='owner')throw new Error('The owner needs to create the shared workplace first.');
    workspaceRevision=data?.revision ?? null;workspaceDirty=false;preparedForUser=actor;
    writeConfig({...readConfig(),syncEnabled:true});
    setAccountState();
    clearInterval(workplacePoll);
    workplacePoll=setInterval(refreshSharedWorkplace,15000);
  })().finally(()=>{preparingWorkplace=null;});
  return preparingWorkplace;
}
async function refreshSharedWorkplace() {
  if(!session?.user || !mfaReady || !preparedForUser || workspaceDirty || syncing || document.hidden)return;
  // A form can contain unsaved edits before it reaches state/queueSync.
  const editing=()=>{
    if(document.querySelector?.('.modal-backdrop'))return true;
    const view=document.querySelector?.('.view:not([hidden])')?.id;
    return ['view-settings','view-website','view-linktree','view-buffer-compose','view-account'].includes(view) || Boolean(document.activeElement?.matches?.('input,textarea,select,[contenteditable="true"]'));
  };
  if(editing())return;
  const at=workspaceChangeCount,actor=session.user.id,baseRevision=workspaceRevision;
  try {
    const {data,error}=await client.rpc('load_creator_workspace');
    if(error)throw error;
    if(session?.user?.id!==actor || workspaceDirty || syncing || at!==workspaceChangeCount || workspaceRevision!==baseRevision || editing())return;
    if(data?.workspace_data && data.revision!==workspaceRevision){storage().replaceWorkspace(await cloudPersistence.hydrateAssets(data.workspace_data));workspaceRevision=data.revision;ui()?.setSyncStatus('Shared workplace updated from your team.');}
  }catch(error){ui()?.setSyncStatus(`Team updates paused: ${message(error)}`);}
}
let authRevision = 0;
const mfa = createMfa(() => client);
const cloudPersistence = createCloudPersistence({getClient:()=>client,getUser:()=>session?.user,getContext:()=>workspaceContext,getUrl:()=>readConfig().url,getWorkspace:()=>storage()?.getWorkspace(),patchAsset:(...args)=>storage()?.patchCloudAsset?.(...args)});
const blogAdmin = createBlogAdmin({getClient:()=>client,getContext:()=>workspaceContext,getName:()=>storage()?.getPublicCreatorProfile?.()?.name});
async function checkedGateUser() {
  if (!session?.user) { mfaReady = false; return null; }
  const checkingSession = session;
  mfaReady = false;
  const status = await mfa.status();
  if (session?.user?.id !== checkingSession.user.id || session?.access_token !== checkingSession.access_token) return null;
  if (!status.required) await loadWorkplaceContext();
  mfaReady = !status.required;
  return { ...gateUser(session), ...(workspaceContext && !status.required ? {role:workspaceContext.role,permissions:workspaceContext.permissions} : {}), mfaRequired: status.required, mfaFactors: status.factors.map(f => ({ id:f.id })) };
}
async function updateSecurity() {
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  session = data.session;
  await checkedGateUser();
  setAccountState();
}
async function showSecuritySettings() {
  await renderSecurity(document.getElementById('account-security'), mfa, updateSecurity);
}

const ui = () => window.CreatorHQCloudUI;
const storage = () => window.CreatorHQStorage;

function readConfig() { return memoryConfig; }
function writeConfig(config) { memoryConfig={...config}; }

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
  if (session?.user && (!mfaReady || preparedForUser!==session.user.id)) return;
  if (session?.user && workplaceCan('social') && bufferLoadedForUser !== session.user.id) {
    bufferLoadedForUser = session.user.id;
    loadBufferWorkspace();
  } else if (!session?.user) {
    bufferLoadedForUser = null;
    setBufferStatus('Sign in to Creator HQ before connecting Buffer.', false);
  }
  if (session?.user && socialLinksSyncedForUser !== session.user.id) {
    socialLinksSyncedForUser = session.user.id;
    if(workplaceCan('website') || workplaceCan('linktree') || workplaceCan('settings')) syncSocialLinks().catch(error => setSocialAnalyticsStatus(error.message || 'Could not register social links.'));
    if(workplaceCan('analytics') || workplaceCan('social') || workplaceCan('settings'))loadPlatformAccounts().catch(error => setPlatformAccountsStatus(error.message || 'Could not load platform accounts.'));
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
  const cleanAsset=asset=>{const {previewUrl,downloadUrl,...record}=asset;return {...record,dataUrl:'',mimeType:record.storagePath?record.mimeType:''};};
  return {...workspace,assets:(workspace.assets||[]).map(cleanAsset),recoveryTrash:(workspace.recoveryTrash||[]).map(item=>({...item,record:item.collection==='assets'?cleanAsset(item.record):item.record}))};
}

async function currentUser() {
  if (!client) throw new Error('Connect a Supabase project first.');
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error('Sign in before syncing your workspace.');
  if (!mfaReady) throw new Error('Verify your authenticator code before accessing your workspace.');
  if(!workspaceContext)await loadWorkplaceContext();
  return {...data.user,id:workplaceOwner(),actorId:data.user.id};
}

async function uploadWorkspace(options={}) {
  clearTimeout(syncTimer);
  const operation=pendingWorkspaceSave.catch(()=>{}).then(()=>performWorkspaceSave(options));
  pendingWorkspaceSave=operation;return operation;
}
async function performWorkspaceSave({confirmOverwrite=false}={}) {
  await currentUser();
  if(preparedForUser!==session.user.id)throw new Error('Load the shared workplace before saving.');
  if(confirmOverwrite && !await window.CreatorHQDialogs.confirm('Save this shared workplace?', 'Your changes will update the workplace your editors use. Newer team changes will never be overwritten silently.', 'Save shared workplace'))return;
  const at=workspaceChangeCount;
  const snapshot=withoutLocalImageBytes(await cloudPersistence.persistAssets(storage().getWorkspace()));
  if(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength>MAX_SNAPSHOT_BYTES)throw new Error('Workspace snapshot exceeds 1.5 MB.');
  const {data,error}=await client.rpc('save_creator_workspace',{snapshot,expected_revision:workspaceRevision});
  if(error){const failure=new Error(error.message || 'Could not save the shared workplace. Your changes remain in this open page.');failure.code=error.code;throw failure;}
  workspaceRevision=data.revision;
  if(at===workspaceChangeCount)workspaceDirty=false;
  writeConfig({...readConfig(),syncEnabled:true});
  ui()?.setSyncStatus(`Shared workplace saved at ${new Date().toLocaleTimeString()}.`);
}

async function listWorkspaceHistory(){
  const user=await currentUser();
  const {data,error}=await client.from('creator_workspace_history').select('id,workspace_updated_at,captured_at').eq('user_id',user.id).order('captured_at',{ascending:false}).limit(20);
  if(error)throw new Error('Cloud history is unavailable. Your current workspace is still saved.');
  return data||[];
}
async function restoreWorkspaceHistory(id){
  const user=await currentUser();
  const {data,error}=await client.from('creator_workspace_history').select('workspace_data').eq('user_id',user.id).eq('id',id).single();
  if(error||!data?.workspace_data)throw new Error('This cloud save could not be loaded.');
  storage().replaceWorkspace(data.workspace_data);queueSync();
}

async function pullWorkspace() {
  await currentUser();
  if(!await window.CreatorHQDialogs.confirm('Load the shared workplace?', 'Your current changes will be kept in a private Supabase recovery checkpoint before loading the team’s latest version.', 'Load shared workplace'))return;
  const {data,error}=await client.rpc('load_creator_workspace');
  if(error)throw error;
  if(!data?.workspace_data)throw new Error('No shared workplace has been saved yet.');
  storage().replaceWorkspace(await cloudPersistence.hydrateAssets(data.workspace_data));
  workspaceRevision=data.revision;workspaceDirty=false;
  writeConfig({...readConfig(),syncEnabled:true});
  ui()?.setSyncStatus('Loaded the latest shared workplace.');
}

async function flushSync() {
  if (syncing) { syncPending = true; return; }
  if (!client || !session?.user || !mfaReady || !readConfig().syncEnabled) return;
  syncing = true;
  ui()?.setSyncStatus('Syncing workspace…');
  try {
    await uploadWorkspace();
  } catch (error) {
    if(error.code==='40001'){writeConfig({...readConfig(),syncEnabled:false});ui()?.notify('Someone else saved newer team changes. Your edits remain in this open page. Use Load team changes to keep a recovery checkpoint and load the latest version.');}
    ui()?.setSyncStatus(`Sync paused after an error: ${message(error)}`);
  } finally {
    syncing = false;
    if (syncPending) { syncPending = false; queueSync(); }
  }
}

function queueSync() {
  if (!session?.user || !mfaReady || preparedForUser!==session.user.id) return;
  workspaceDirty=true;workspaceChangeCount++;
  if (!readConfig().syncEnabled)return;
  clearTimeout(syncTimer);
  ui()?.setSyncStatus('Saving shared changes to Supabase…');
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
  if (!client || !session?.user || publicProfileCheckedForUser === workplaceOwner() || publicProfileCheckPromise) return publicProfileCheckPromise;
  const userId = workplaceOwner();
  publicProfileCheckPromise = (async () => {
    const config = await getPublicProfileConfig();
    if (!config?.userId || userId !== config.userId || !(workplaceCan('website') || workplaceCan('linktree') || workplaceCan('settings'))) {
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
    publicProfileHydrated = true;
  })().catch(error => {
    setPublicProfileStatus(error.message || 'Could not check the live profile.');
    // Do not block publishing forever if the database is unreachable; unlock shortly after.
    setTimeout(() => { publicProfileHydrated = true; }, 10000);
  }).finally(() => { publicProfileCheckPromise = null; });
  return publicProfileCheckPromise;
}

function queuePublicProfileSync(profile = storage()?.getPublicCreatorProfiles?.()) {
  if (!profile || !(workplaceCan('website') || workplaceCan('linktree') || workplaceCan('settings'))) return;
  pendingPublicProfile = structuredClone(profile);
  clearTimeout(publicProfileSyncTimer);
  if (!publicProfileHydrated) {
    // The initial database profile may still be loading. Never publish before it
    // completes, or a local gap (like empty Linktree links) could wipe cloud data.
    setPublicProfileStatus('Waiting for the saved profile to finish loading before publishing…');
    publicProfileSyncTimer = setTimeout(() => { queuePublicProfileSync(pendingPublicProfile || profile); }, 500);
    return;
  }
  if (!client || !session?.user) {
    setPublicProfileStatus('Saved in this browser. Sign in to Supabase here to update the live site automatically.');
    return;
  }
  setPublicProfileStatus('Changes saved. Updating the live site…');
  publicProfileSyncTimer = setTimeout(() => { publishPendingPublicProfile(); }, 900);
}

async function publishPendingPublicProfile() {
  if (publicProfileSyncPromise || !pendingPublicProfile) return publicProfileSyncPromise;
  let profile = pendingPublicProfile;
  pendingPublicProfile = null;
  publicProfileSyncPromise = (async () => {
    if (!client || !session?.user) throw new Error('Connect and sign in to Supabase to publish website changes.');
    const config = await getPublicProfileConfig();
    if (!config?.userId || !config.supabaseUrl || !config.anonKey) throw new Error('The public profile config is missing its Supabase publication settings. Download and deploy a fresh public-profile.json.');
    if (workplaceOwner() !== config.userId || !(workplaceCan('website') || workplaceCan('linktree') || workplaceCan('settings'))) throw new Error('Your workplace role does not allow publishing website changes.');
    // Safety net: if the local Linktree links are empty but the database still has
    // links, keep the database links instead of publishing an empty wipe.
    const localLinks = Array.isArray(profile.linktree?.links) ? profile.linktree.links : [];
    if (!localLinks.length) {
      const { data: existingProfile } = await client.from('creator_public_profiles').select('profile').eq('user_id', workplaceOwner()).maybeSingle();
      const dbLinks = existingProfile?.profile?.linktree?.links || (Array.isArray(existingProfile?.profile?.links) ? existingProfile.profile.links : []);
      if (Array.isArray(dbLinks) && dbLinks.length) {
        profile = structuredClone(profile);
        profile.linktree = { ...profile.linktree, links: dbLinks };
        setPublicProfileStatus('Local Linktree links were empty, so the saved cloud links were kept.');
      }
    }
    const profileText = JSON.stringify(profile);
    if (new TextEncoder().encode(profileText).byteLength > 500_000) throw new Error('The public profile is too large to publish. Reduce its text or product details.');
    if (profileText === lastPublishedPublicProfile) return;
    const { error } = await client.from('creator_public_profiles').upsert({
      user_id: workplaceOwner(),
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
    await currentUser();
    const { data, error } = await client.rpc('load_creator_workspace');
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

async function ensureProject() {
  if (client) return true;
  const config = readConfig();
  const publication = config.url && config.anonKey ? null : await getPublicProfileConfig();
  const url = config.url || publication?.supabaseUrl;
  const key = config.anonKey || publication?.anonKey;
  if (!url || !key) return false;
  await connectProject(url, key);
  return true;
}

function gateUser(sessionValue) {
  const user = sessionValue?.user;
  if (!user) return null;
  const metadata = user.user_metadata || {};
  return {
    id: user.id,
    email: user.email || '',
    role: typeof metadata.assignedRole === 'string' ? metadata.assignedRole : '',
    permissions: Array.isArray(metadata.permissions) ? metadata.permissions.filter(item => typeof item === 'string') : []
  };
}

async function staffAdminRequest(payload) {
  const config = readConfig();
  if (!client || !config.url || !config.anonKey) throw new Error('Connect a Supabase project to manage staff accounts.');
  if (!session?.access_token) throw new Error('Sign in to Creator HQ to manage staff accounts.');
  const response = await fetch(`${config.url.replace(/\/$/, '')}/functions/v1/staff-admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: config.anonKey, Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Staff request failed (${response.status}).`);
  return data;
}

async function dropboxRequest(action, payload, options = {}) {
  const config = readConfig();
  if (!client || !config.url || !config.anonKey) throw new Error('Connect a Supabase project to use Dropbox.');
  if (!session?.access_token) throw new Error('Sign in to Creator HQ to use Dropbox.');
  const headers = { 'Content-Type': 'application/json', apikey: config.anonKey, Authorization: `Bearer ${session.access_token}` };
  const init = { method: 'POST', headers, body: payload === undefined ? '{}' : (options.raw ? payload : JSON.stringify(payload || {})) };
  const response = await fetch(`${config.url.replace(/\/$/, '')}/functions/v1/dropbox?action=${encodeURIComponent(action)}`, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Dropbox request failed (${response.status}).`);
  return data;
}

const dropboxApi = {
  status: () => dropboxRequest('status'),
  disconnect: () => dropboxRequest('disconnect'),
  connectUrl: async () => (await dropboxRequest('start', { returnUrl: `${location.origin}${location.pathname}` })).authorizeUrl,
  list: (path, cursor) => dropboxRequest('list', { path, cursor }),
  thumbnails: paths => dropboxRequest('thumbnails', { paths }),
  move: (fromPath, toPath) => dropboxRequest('move', { fromPath, toPath }),
  batchMove: (entries, toFolder) => dropboxRequest('batch-move', { entries, toFolder }),
  createFolder: path => dropboxRequest('create-folder', { path }),
  remove: path => dropboxRequest('delete', { path }),
  downloadLink: path => dropboxRequest('download-link', { path }),
  upload: async (path,file,options={})=>{
    const config=readConfig();if(!client||!session?.access_token)throw new Error('Sign in to Creator HQ before uploading.');
    const argument=JSON.stringify({path,mode:options.replace?'overwrite':'add',autorename:!options.replace,mute:false}).replace(/[\u007f-\uffff]/g,character=>'\\u'+character.charCodeAt(0).toString(16).padStart(4,'0'));
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();xhr.open('POST',`${config.url.replace(/\/$/,'')}/functions/v1/dropbox?action=upload`);
      xhr.setRequestHeader('Authorization',`Bearer ${session.access_token}`);xhr.setRequestHeader('apikey',config.anonKey);xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.setRequestHeader('Dropbox-API-Arg',argument);
      xhr.upload.onprogress=event=>{if(event.lengthComputable)options.onProgress?.(Math.round(event.loaded/event.total*100));};
      xhr.onload=()=>{let data={};try{data=JSON.parse(xhr.responseText);}catch{}if(xhr.status>=200&&xhr.status<300)resolve(data);else reject(new Error(data.error||`Upload failed (${xhr.status}).`));};
      xhr.onerror=()=>reject(new Error('The upload connection was interrupted. Check your connection and retry.'));
      xhr.timeout=10*60*1000;xhr.ontimeout=()=>reject(new Error('This upload took too long. Retry with a smaller file.'));
      xhr.send(file);
    });
  }
};

const authGate = {
  async user() {
    if (!(await ensureProject())) return null;
    const { data, error } = await client.auth.getSession();
    if (error) return null;
    session = data.session;
    return checkedGateUser();
  },
  async signIn(email, password) {
    if (!(await ensureProject())) throw new Error('Connect the Supabase project to sign in.');
    const { data, error } = await client.auth.signInWithPassword({ email: String(email || '').trim(), password: String(password || '') });
    if (error) throw error;
    session = data.session;
    return checkedGateUser();
  },
  async signUp(email, password) {
    if (!(await ensureProject())) throw new Error('Connect the Supabase project to create an account.');
    const { data, error } = await client.auth.signUp({ email: String(email || '').trim(), password: String(password || '') });
    if (error) throw error;
    session = data.session;
    return { user: await checkedGateUser(), needsConfirmation: !session && !error };
  },
  async requestPasswordReset(email) {
    if (!(await ensureProject())) throw new Error('Connect the Supabase project first.');
    const { error } = await client.auth.resetPasswordForEmail(String(email || '').trim(), { redirectTo: appRedirectUrl() });
    if (error) throw error;
  },
  async signOut() {
    await blogAdmin.prepareSignOut();
    if(workspaceDirty){try{await uploadWorkspace();}catch(error){if(error.code!=='40001')throw error;await cloudPersistence.checkpoint(withoutLocalImageBytes(storage().getWorkspace()),'Unsaved team edits before sign-out');}}
    if (client) { const { error } = await client.auth.signOut({scope:'local'}); if (error) throw error; }
    session = null; mfaReady = false; mfa.reset();
  },
  async verifyMfa(factorId, code) {
    await mfa.verify(factorId, code);
    await updateSecurity();
    return checkedGateUser();
  },
  showSecuritySettings,
  prepareWorkplace,
  openBlog:()=>blogAdmin.refresh(),
  onChange(listener) { if (typeof listener === 'function') authListeners.push(listener); }
};

window.CreatorHQCloud = {
  queueSync,
  reloadWorkplace:pullWorkspace,
  saveNow:uploadWorkspace,
  projectUrl:()=>readConfig().url,
  refreshBlog:()=>blogAdmin.refresh(true),
  savePersonalPreferences:preferences=>cloudPersistence.savePreferences(preferences),
  captureCheckpoint:(snapshot,reason)=>cloudPersistence.checkpoint(withoutLocalImageBytes(snapshot),reason),
  listCloudCheckpoints:()=>cloudPersistence.listCheckpoints(),
  restoreCloudCheckpoint:async id=>{storage().replaceWorkspace(await cloudPersistence.restoreCheckpoint(id));queueSync();await uploadWorkspace();},
  listMigrationArchives:()=>cloudPersistence.listImports(),
  getMigrationArchive:id=>cloudPersistence.getImport(id),
  listWorkspaceHistory,
  restoreWorkspaceHistory,
  startContentPost,
  showContentPosts,
  refreshLinkedContentPosts,
  getDraftLibrary:()=>structuredClone(bufferLibrary()),
  restoreDraftLibrary:drafts=>{memoryBufferDrafts=structuredClone(Array.isArray(drafts)?drafts:[]);renderBufferDraftLibrary();},
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
  getPlatformNotice: provider => platformCallbackNotices[provider] || '',
  authGate,
  dropbox: dropboxApi,
  staffAdmin: {
    list: page => staffAdminRequest({ action: 'list', page }),
    create: (email, password) => staffAdminRequest({ action: 'create', email, password }),
    update: (id, changes) => staffAdminRequest({ action: 'update', id, ...changes }),
    remove: id => staffAdminRequest({ action: 'delete', id })
  }
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
  if (!session?.user || !client || !(workplaceCan('website') || workplaceCan('linktree') || workplaceCan('settings'))) return;
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
  if(!(workplaceCan('analytics') || workplaceCan('social') || workplaceCan('settings')))return;
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
    if (document.hidden || !session?.user || !client || !workplaceCan('social') || bufferRefreshPromise) return bufferRefreshPromise;
    const composeVisible = !document.getElementById('view-buffer-compose')?.hidden;
    const scheduledVisible = !document.getElementById('view-buffer-scheduled')?.hidden;
    if (!composeVisible && !scheduledVisible || Date.now() - lastBufferRefresh < BUFFER_REFRESH_MS) return;
    bufferRefreshPromise = bufferOrganizations.length ? loadBufferPosts() : loadBufferWorkspace();
    try { await bufferRefreshPromise; }
    finally { bufferRefreshPromise = null; }
  }

  let lastAssetUrlRefresh=0;
  async function refreshPrivateAssetUrls(){
    if(document.hidden||!session?.user||!mfaReady||preparedForUser!==session.user.id||Date.now()-lastAssetUrlRefresh<600000)return;
    lastAssetUrlRefresh=Date.now();
    try{const snapshot=await cloudPersistence.hydrateAssets(storage().getWorkspace());for(const asset of snapshot.assets||[])if(asset.storagePath)storage().patchCloudAsset?.(asset.id,{previewUrl:asset.previewUrl||'',downloadUrl:asset.downloadUrl||''});}catch{lastAssetUrlRefresh=0;}
  }
  window.addEventListener('beforeunload',event=>{if(workspaceDirty){event.preventDefault();event.returnValue='';}});
  setInterval(() => {
    refreshAnalyticsData();
    refreshBufferData();
    refreshPrivateAssetUrls();
  }, 60_000);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshAnalyticsData();
      refreshBufferData();
      refreshPrivateAssetUrls();
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
  if(!await window.CreatorHQDialogs.confirm('Disconnect this platform?',`Disconnect ${provider} and remove its saved connection and metrics?`,'Disconnect'))return;
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
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: true, flowType:'implicit' }
  });
  ui()?.setConnection(true, 'Project client initialized. Sign in to check the database connection.');
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  session = data.session;
  await checkedGateUser();
  setAccountState();
  client.auth.onAuthStateChange((event, nextSession) => {
    const revision = ++authRevision;
    session = nextSession;
    mfaReady = false;
    clearTimeout(syncTimer); clearTimeout(publicProfileSyncTimer);
    if (!nextSession) {
      workspaceContext=null;preparedForUser=null;workspaceDirty=false;workspaceRevision=null;clearInterval(workplacePoll);
      mfa.reset();blogAdmin.reset();memoryBufferDrafts=[];currentBufferDraft=null;storage()?.setPersonalPreferences?.({});
      document.getElementById('account-security')?.replaceChildren();
    }
    if (event === 'PASSWORD_RECOVERY') recoveryMode = true;
    // Supabase auth callbacks hold the auth lock: do subsequent API calls outside it.
    setTimeout(async () => {
      try {
        const user = await checkedGateUser();
        if (revision !== authRevision) return;
        setAccountState();
        if(workspaceDirty && preparedForUser===session?.user?.id && readConfig().syncEnabled)queueSync();
        authListeners.forEach(listener => { try { listener(event, user); } catch {} });
      } catch {
        if (revision !== authRevision) return;
        mfaReady = false;
        authListeners.forEach(listener => { try { listener('AUTH_CHECK_FAILED', null); } catch {} });
      }
    }, 0);
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
    setupCopy.textContent = 'Your Buffer connection is managed by the site owner. Sign in to Creator HQ and refresh Buffer. If a channel needs attention, reconnect that channel in Buffer. The project README contains setup details for the owner.';
    const setupNote = setupCopy.closest('.architecture-note');
    if (setupNote) setupNote.hidden = enabled;
  }
  for (const id of ['buffer-organization', 'buffer-channel-filter', 'buffer-channel']) {
    const element = document.getElementById(id);
    if (element) element.disabled = !enabled;
  }
  document.querySelectorAll('#buffer-channel-targets input, #buffer-channel-customizations textarea, #buffer-channel-customizations select, #buffer-channel-customizations input').forEach(element => { element.disabled = !enabled; });
  for (const id of ['buffer-media-type', 'buffer-media-url']) {
    const element = document.getElementById(id);
    if (element) element.disabled = id === 'buffer-media-url' && !document.getElementById('buffer-media-type')?.value;
  }
  for (const id of ['buffer-post-text', 'buffer-schedule-mode']) document.getElementById(id).disabled = false;
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
    const composeDay = event.target.closest('[data-buffer-compose-day]');
    if (composeDay) {
      const date = new Date(`${composeDay.dataset.bufferComposeDay}T12:00:00`);
      if (date <= new Date()) { ui()?.notify('Choose a future day to plan a new post.'); return; }
      document.getElementById('buffer-schedule-mode').value = 'custom';
      document.getElementById('buffer-due-at').value = bufferLocalDateTime(date);
      document.getElementById('buffer-due-field').hidden = false;
      renderBufferComposerPreview(); updateBufferBatchLabel();
      document.querySelector('.nav-button[data-view="buffer-compose"]')?.click();
      return;
    }
    const moreButton = event.target.closest('[data-buffer-day]');
    if (moreButton) {
      const dayPosts = bufferPosts.filter(post => matchesBufferSearch(post) && post.dueAt && new Date(post.dueAt).toLocaleDateString('en-CA') === moreButton.dataset.bufferDay);
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
        scheduledView.innerHTML = `<nav class="button-row" aria-label="Buffer workflow" style="margin-bottom:18px"><button class="button" data-view="content" data-buffer-view="content">Content pipeline</button><button class="button" data-view="buffer-compose" data-buffer-view="buffer-compose">Compose in Buffer</button><button class="button" data-view="buffer-scheduled" data-buffer-view="buffer-scheduled">Publishing planner</button></nav><div class="page-heading"><div><div class="eyebrow">Social Media Management</div><h1>Publishing planner</h1><p class="subtitle">Plan drafts, manage your queue, and follow posts from idea to published.</p></div><div class="button-row"><span class="chip" id="buffer-scheduled-connection">Checking Buffer</span><button class="button primary" type="button" data-view="buffer-compose">Compose post</button></div></div>`;
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
  footer.innerHTML = '<p class="settings-hint">Publishing media uses public HTTPS links. Upload a file above or paste its direct link.</p>';
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
      : document.getElementById('buffer-schedule-mode')?.value === 'draft' ? 'Saved in Buffer as a draft. Will not publish.' : 'Added to next available queue slot.'
  };
  host.innerHTML = bufferPreviewMarkup(post, channel, 'buffer-compose-preview');
}

function openBufferPost(post) {
  const channel = selectedBufferOrganization()?.channels?.find(item => item.id === post.channelId);
  const modal = document.getElementById('modal-root');
  const readOnly = ['sent', 'sending', 'needs_approval'].includes(post.status) || (Array.isArray(post.allowedActions) && !post.allowedActions.includes('updatePost'));
  modal.innerHTML = `<div class="modal-backdrop" data-backdrop><form class="modal buffer-editor-modal" id="buffer-post-edit-form" role="dialog" aria-modal="true" aria-labelledby="buffer-post-title"><div class="modal-head"><div><p class="buffer-editor-kicker">${bufferHtml(post.status)}</p><h2 id="buffer-post-title">${readOnly ? 'Post details' : 'Edit post'}</h2><p>${bufferHtml(channel?.name || 'Channel')} · ${bufferHtml(channel?.service || '')}</p></div><button type="button" class="mini-button" data-close-modal aria-label="Close">×</button></div><div class="buffer-editor-layout"><div class="buffer-editor-fields"><label class="form-field"><span>Post copy</span><textarea name="text" maxlength="5000" required ${readOnly ? 'readonly' : ''}>${bufferHtml(post.text)}</textarea></label>${readOnly ? '<p class="settings-hint">Reuse this post to create a new version. Approval and delivery stay managed by Buffer.</p>' : `<label class="form-field"><span>What should happen?</span><select class="field-control" name="mode"><option value="">Keep current schedule / draft</option><option value="addToQueue">Add to next queue slot</option><option value="customScheduled">Choose a new publishing time</option><option value="draft">Save as draft (remove from queue)</option></select></label><label class="form-field" id="buffer-edit-date-field" hidden><span>Publishing time (this device’s timezone)</span><input class="field-control" name="dueAt" type="datetime-local" value="${post.dueAt ? bufferLocalDateTime(post.dueAt) : ''}"></label><p class="settings-hint">Existing media and platform settings are preserved. Keeping the schedule only updates the copy.</p>`}${post.error?.message ? `<p class="buffer-post-failure">${bufferHtml(post.error.message)}</p>` : ''}${/^https:\/\//.test(post.externalLink || '') ? `<a class="button" target="_blank" rel="noopener noreferrer" href="${bufferHtml(post.externalLink)}">View published post ↗</a>` : ''}<p role="status" id="buffer-edit-error" class="settings-hint"></p></div><aside class="buffer-editor-preview" id="buffer-edit-live">${bufferPreviewMarkup(post,channel)}</aside></div><div class="modal-actions"><button class="button" type="button" id="buffer-reuse">Reuse in composer</button>${readOnly ? '' : '<button class="button primary" type="submit">Save changes</button>'}</div></form></div>`;
  const form = document.getElementById('buffer-post-edit-form');
  form.elements.text.oninput = () => { document.getElementById('buffer-edit-live').innerHTML = bufferPreviewMarkup({...post,text:form.elements.text.value},channel); };
  if (!readOnly) form.elements.mode.onchange = () => { document.getElementById('buffer-edit-date-field').hidden = form.elements.mode.value !== 'customScheduled'; };
  document.getElementById('buffer-reuse').onclick = async () => {
    if (document.getElementById('buffer-post-text').value.trim() && !await window.CreatorHQDialogs.confirm('Reuse this post?','Replace the current composer with this post? Save a draft first if you want to keep it.','Reuse post')) return;
    document.getElementById('buffer-post-text').value = form.elements.text.value;
    const asset = post.assets?.[0];
    document.getElementById('buffer-media-type').value = asset ? (String(asset.type).toLowerCase().includes('video') ? 'video' : 'image') : '';
    document.getElementById('buffer-media-url').value = asset?.source || '';
    document.getElementById('buffer-media-url').disabled = !asset;
    document.querySelectorAll('[data-buffer-target]').forEach(input => { input.checked = input.value === post.channelId; });
    document.getElementById('buffer-channel-customizations').innerHTML = ''; bufferCustomizations.clear(); renderBufferTargetCustomizations();
    document.getElementById('buffer-schedule-mode').value = 'queue'; document.getElementById('buffer-due-field').hidden = true;
    document.getElementById('buffer-post-text').dispatchEvent(new Event('input',{bubbles:true}));
    modal.innerHTML = '';
    document.querySelector('.nav-button[data-view="buffer-compose"]')?.click();
  };
  form.onsubmit = async event => {
    event.preventDefault(); if (readOnly) return;
    const button = form.querySelector('[type="submit"]'); button.disabled = true;
    try {
      const mode = form.elements.mode.value;
      const due = new Date(form.elements.dueAt.value);
      if (mode === 'customScheduled' && (!Number.isFinite(due.getTime()) || due <= new Date())) throw new Error('Choose a future publishing time.');
      await callBuffer('editPost',{id:post.id,text:form.elements.text.value.trim(),mode:mode || undefined,dueAt:mode === 'customScheduled' ? due.toISOString() : undefined});
      modal.innerHTML = ''; await loadBufferPosts(); ui()?.notify('Post updated in Buffer.');
    } catch(error) { document.getElementById('buffer-edit-error').textContent = error.message; }
    finally { button.disabled = false; }
  };
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
  const posts = bufferPosts.filter(post => (channelFilter === 'all' || post.channelId === channelFilter) && matchesBufferSearch(post));
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
    return `<div class="buffer-calendar-day ${day.getMonth() !== month ? 'outside' : ''} ${key === todayKey ? 'today' : ''}"><button type="button" class="buffer-calendar-number" data-buffer-compose-day="${bufferHtml(key)}" aria-label="Plan a post for ${bufferHtml(key)}">${day.getDate()}</button>${items}${more}</div>`;
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
  if (button) button.textContent = document.getElementById('buffer-schedule-mode').value === 'draft' ? `Save ${count || ''} Buffer draft${count === 1 ? '' : 's'}` : document.getElementById('buffer-schedule-mode').value === 'custom' ? `Schedule ${count || ''} post${count === 1 ? '' : 's'}` : `Add ${count || ''} post${count === 1 ? '' : 's'} to queue`;
  updateBufferReadiness();
}

function renderBufferTargetCustomizations() {
  rememberBufferCustomizations();
  const org = selectedBufferOrganization();
  const selectedIds = [...document.querySelectorAll('#buffer-channel-targets [data-buffer-target]:checked')].map(input => input.value);
  const host = document.getElementById('buffer-channel-customizations');
  if (!host) return;
  host.innerHTML = selectedIds.map(id => {
    const channel = org?.channels?.find(item => item.id === id);
    return `<details class="buffer-target-detail"><summary><span>${bufferHtml(channel?.name || 'Channel')}</span><span class="buffer-target-customize-hint">Customize copy and media</span></summary><label class="form-field"><span>Copy override <small>Leave blank to use shared copy</small></span><textarea data-target-text="${bufferHtml(id)}" maxlength="5000" placeholder="Use the main post copy"></textarea><span class="workflow-meta"><span data-target-character-count="${bufferHtml(id)}">0 / 5,000</span><span>Buffer validates channel limits</span></span></label><div class="form-grid"><label class="form-field"><span>Media for this channel</span><select class="field-control" data-target-media="${bufferHtml(id)}"><option value="inherit">Use shared media</option><option value="none">No media</option><option value="image">Different image</option><option value="video">Different video</option></select></label><label class="form-field"><span>Channel media URL</span><input class="field-control" data-target-url="${bufferHtml(id)}" type="url" placeholder="https://..." disabled></label></div></details>`;
  }).join('');
  host.querySelectorAll('[data-target-text]').forEach(input => { input.value = bufferCustomizations.get(input.dataset.targetText)?.text || ''; });
  host.querySelectorAll('[data-target-media]').forEach(input => { input.value = bufferCustomizations.get(input.dataset.targetMedia)?.media || 'inherit'; });
  host.querySelectorAll('[data-target-url]').forEach(input => { input.value = bufferCustomizations.get(input.dataset.targetUrl)?.url || ''; });
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

async function refreshLinkedContentPosts(contentId){
  const items=(storage()?.getWorkspace()?.content||[]).filter(item=>!contentId||item.id===contentId);
  const ids=[...new Set(items.flatMap(item=>item.bufferPostIds||[]))];
  let unresolved=0;
  for(let offset=0;offset<ids.length;offset+=10){const result=await callBuffer('contentPosts',{ids:ids.slice(offset,offset+10)});storage()?.reconcileBufferPosts?.(result.posts||[]);unresolved+=(result.unresolved||0);}
  if(unresolved)throw new Error(`${unresolved} linked posts could not be checked. Their previous status was kept.`);
}
async function showContentPosts(contentId){
  const item=(storage()?.getWorkspace()?.content||[]).find(item=>item.id===contentId);if(!item)return;
  try{await refreshLinkedContentPosts(contentId);}catch(error){ui()?.notify(error.message);}
  const latest=(storage()?.getWorkspace()?.content||[]).find(item=>item.id===contentId)||item;
  const states=Object.values(latest.bufferPostStates||{});
  const status=states.some(post=>post.status==='error')?'error':states.some(post=>post.status==='draft')?'draft':states.length&&states.every(post=>post.status==='sent')?'sent':'scheduled';
  document.getElementById('buffer-status-filter').value=status;
  document.getElementById('buffer-search').value='';
  await loadBufferPosts();
  const ids=new Set(item.bufferPostIds||[]);const linked=bufferPosts.filter(post=>ids.has(post.id));
  if(linked.length===1)openBufferPost(linked[0]);else if(linked.length)openBufferPostList(linked);else ui()?.notify('The planner is showing this content’s status. Load more posts if the linked post is older.');
}
function startContentPost(contentId){
  const item=(storage()?.getWorkspace()?.content||[]).find(item=>item.id===contentId);if(!item)return;
  renderBufferContentSources();const picker=document.getElementById('buffer-content-source');picker.value=contentId;picker.dispatchEvent(new Event('change',{bubbles:true}));
}
function renderContentPublishingFiles(item){
  let host=document.getElementById('buffer-content-files');
  if(!host){host=document.createElement('div');host.id='buffer-content-files';host.className='buffer-upload-box';document.getElementById('buffer-media-controls').insertAdjacentElement('beforebegin',host);}
  const files=item?.dropboxFiles||[];host.hidden=!files.length;
  host.innerHTML=files.length?`<strong>Files linked to this content</strong><p>Choose a file to copy from private Dropbox into public publishing storage. Only the file you choose is copied.</p>${files.map(file=>`<div class="hq-linked-media"><span>${bufferHtml(file.name)}</span><button class="button" type="button" data-publish-dropbox="${bufferHtml(file.path)}">Use for publishing</button></div>`).join('')}`:'';
  host.querySelectorAll('[data-publish-dropbox]').forEach(button=>button.onclick=async()=>{
    const path=button.dataset.publishDropbox;const name=path.split('/').pop();const extension=name.split('.').pop().toLowerCase();
    const types={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm'};
    if(!types[extension]){ui()?.notify('Choose an image or supported video file for publishing.');return;}
    button.disabled=true;
    try{
      if(!session?.access_token)throw new Error('Sign in before using a linked Dropbox file.');
      const config=readConfig();const response=await fetch(`${config.url}/functions/v1/dropbox?action=download-file`,{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`,apikey:config.anonKey,'Content-Type':'application/json'},body:JSON.stringify({path})});
      if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||'Could not read the Dropbox file.');}
      const blob=await response.blob();if(blob.size>50*1024*1024)throw new Error('Choose a file under 50 MB for publishing.');
      await uploadBufferPublishingFile(new File([blob],name,{type:types[extension]}));
    }catch(error){ui()?.notify(error.message);}finally{button.disabled=false;}
  });
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
    const upload = document.getElementById('buffer-media-file');
    if (upload) upload.disabled = result.mediaUploadsEnabled !== true;
    const uploadNote = document.getElementById('buffer-upload-status');
    if (uploadNote) uploadNote.textContent = result.mediaUploadsEnabled ? 'Publishing uploads are enabled.' : 'Device uploads need the site owner’s approval for public publishing links. Use a media link below in the meantime.';
    bufferOrganizations = Array.isArray(result.organizations) ? result.organizations : [];
    const selector = document.getElementById('buffer-organization');
    const previousOrganization = selector.value;
    selector.innerHTML = bufferOrganizations.length
      ? bufferOrganizations.map(organization => `<option value="${bufferHtml(organization.id)}">${bufferHtml(organization.name)}</option>`).join('')
      : '<option value="">No Buffer organizations found</option>';
    if (bufferOrganizations.some(org => org.id === previousOrganization)) selector.value = previousOrganization;
    renderBufferChannels();
    renderBufferPlannerSummary();
    renderBufferDraftLibrary();
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
  const generation = ++bufferLoadGeneration;
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
    const result = await callBuffer('posts', { organizationId: organization.id, channelId: channelId === 'all' ? '' : channelId, after: append ? bufferPostsCursor : '', status: document.getElementById('buffer-status-filter')?.value || 'scheduled' });
    if (generation !== bufferLoadGeneration) return;
    const pagePosts = Array.isArray(result.posts) ? result.posts : [];
    pagePosts.sort((a,b) => new Date(a.dueAt || 0) - new Date(b.dueAt || 0));
    bufferPosts = append ? [...bufferPosts, ...pagePosts] : pagePosts;
    if (!append) lastBufferRefresh = Date.now();
    bufferPostsCursor = result.endCursor || null;
    bufferPostsHasNext = Boolean(result.hasNextPage);
    const channels = organization.channels || [];
    document.getElementById('buffer-queue-count').textContent = `${bufferPosts.length}${bufferPostsHasNext ? '+' : ''} posts`;
    document.getElementById('buffer-queue').innerHTML = bufferPosts.length ? bufferPosts.map(post => {
      const channel = channels.find(item => item.id === post.channelId);
      const date = post.sentAt || post.dueAt ? new Date(post.sentAt || post.dueAt) : null;
      const thumbnail = post.assets?.[0]?.thumbnail || (String(post.assets?.[0]?.type).toLowerCase().includes('image') ? post.assets?.[0]?.source : '');
      const thumbMarkup = /^https:\/\//i.test(thumbnail || '') ? `<img class="buffer-queue-thumb" loading="lazy" src="${bufferHtml(thumbnail)}" alt="">` : '';
      return `<button type="button" class="data-entry-row buffer-post-row" data-buffer-post="${bufferHtml(post.id)}" aria-label="Open post for ${bufferHtml(channel?.name || 'Buffer channel')}">${thumbMarkup}<span class="buffer-post-row-copy"><strong>${bufferHtml(channel?.name || 'Buffer channel')}</strong><span>${bufferHtml(post.text || '')}</span>${post.error?.message ? `<span class="buffer-post-failure">${bufferHtml(post.error.message)}</span>` : ''}<span>${bufferHtml(post.status || 'Scheduled')}${date ? ` · ${bufferHtml(date.toLocaleString())}` : ''}</span></span><span class="chip">${bufferHtml(channel?.service || 'Buffer')}</span></button>`;
    }).join('') : '<div class="empty-state"><div><div class="empty-icon">✓</div><strong>No posts in this view</strong><span>Choose another status or compose a new post.</span></div></div>';
    ensureBufferQueueViews();
    document.getElementById('buffer-load-more').hidden = !bufferPostsHasNext;
    document.getElementById('buffer-load-more').disabled = false;
    document.getElementById('buffer-load-more').textContent = 'Load next 50';
    document.getElementById('buffer-queue').hidden = bufferQueueView !== 'list';
    document.getElementById('buffer-calendar').hidden = bufferQueueView !== 'calendar';
    storage()?.reconcileBufferPosts?.(bufferPosts);
    applyBufferSearch();
    renderBufferPlannerSummary();
    renderBufferCalendar();
  } catch (error) {
    if (generation !== bufferLoadGeneration) return;
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
  if (custom && (!localDateTime || !Number.isFinite(new Date(localDateTime).getTime()) || new Date(localDateTime).getTime() <= Date.now())) throw new Error('Choose a future date and time for the post.');
  const targets = selectedIds.map(channelId => {
    const override = document.querySelector(`[data-target-text="${CSS.escape(channelId)}"]`)?.value.trim() || '';
    const mediaMode = document.querySelector(`[data-target-media="${CSS.escape(channelId)}"]`)?.value || 'inherit';
    const targetMediaType = mediaMode === 'inherit' ? sharedAssetType : mediaMode === 'none' ? '' : mediaMode;
    const targetMediaUrl = mediaMode === 'inherit' ? sharedAssetUrl : document.querySelector(`[data-target-url="${CSS.escape(channelId)}"]`)?.value.trim() || '';
    return { channelId, text: override || sharedText, assetType: targetMediaType, assetUrl: targetMediaUrl, postType: document.getElementById('buffer-post-type').value, videoTitle: document.getElementById('buffer-video-title').value, categoryId: document.getElementById('buffer-video-category').value, madeForKids: document.getElementById('buffer-video-kids').checked, boardId: document.getElementById('buffer-board-id').value };
  });
  const issues = bufferReadiness();
  if (issues.length) throw new Error(issues.join(' '));
  const result = await callBuffer('schedule', {
    targets,
    organizationId: selectedBufferOrganization()?.id,
    mode: custom ? 'customScheduled' : document.getElementById('buffer-schedule-mode').value === 'draft' ? 'draft' : 'addToQueue',
    dueAt: custom ? new Date(localDateTime).toISOString() : undefined
  });
  const successes = (result.results || []).filter(entry => entry.post);
  const failures = (result.results || []).filter(entry => entry.error);
  storage()?.reportIssue?.('buffer-publish',failures.length?`${failures.length} social posts need attention.`:'','buffer-compose');
  if (contentId && successes.length) storage()?.markContentScheduled?.(contentId, successes.map(entry => entry.post));
  const channelNames = new Map(channels.map(channel => [channel.id, channel.name]));
  const summary = `${successes.length} of ${targets.length} channel${targets.length === 1 ? '' : 's'} ${document.getElementById('buffer-schedule-mode').value === 'draft' ? 'saved as Buffer drafts' : custom ? 'scheduled' : 'added to queue'}.`;
  document.getElementById('buffer-batch-result').innerHTML = `<strong>${bufferHtml(summary)}</strong>${failures.length ? `<ul>${failures.map(item => `<li>${bufferHtml(channelNames.get(item.channelId) || 'Channel')}: ${bufferHtml(item.error)}</li>`).join('')}</ul>` : ''}`;
  document.getElementById('buffer-batch-result').hidden = false;
  if (!successes.length) throw new Error(failures.map(item => item.error).join('; ') || 'Buffer did not schedule any posts.');
  if (failures.length) {
    const succeeded = new Set(successes.map(entry => entry.channelId || entry.post?.channelId));
    document.querySelectorAll('[data-buffer-target]').forEach(input => { if (succeeded.has(input.value)) input.checked = false; });
    renderBufferTargetCustomizations();
    updateBufferBatchLabel();
  }
  if (!failures.length) {
    bufferCustomizations.clear();
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

function rememberBufferCustomizations() {
  document.querySelectorAll('[data-target-text]').forEach(input => {
    const id = input.dataset.targetText;
    bufferCustomizations.set(id, { text: input.value, media: document.querySelector(`[data-target-media="${CSS.escape(id)}"]`)?.value || 'inherit', url: document.querySelector(`[data-target-url="${CSS.escape(id)}"]`)?.value || '' });
  });
}

function bufferReadiness() {
  const issues = [];
  if (bufferMediaUploading) issues.push('Wait for the media upload to finish.');
  const targets = [...document.querySelectorAll('[data-buffer-target]:checked')];
  if (!targets.length) issues.push('Choose at least one channel.');
  if (targets.length > 10) issues.push('Choose up to 10 channels.');
  const text = document.getElementById('buffer-post-text').value.trim();
  if (!text) issues.push('Write your shared post copy.');
  const custom = document.getElementById('buffer-schedule-mode').value === 'custom';
  const due = new Date(document.getElementById('buffer-due-at').value).getTime();
  if (custom && (!Number.isFinite(due) || due <= Date.now())) issues.push('Choose a future date and time.');
  const channels = selectedBufferOrganization()?.channels || [];
  targets.forEach(target => {
    const id = target.value;
    const channel = channels.find(item => item.id === id);
    const mode = document.querySelector(`[data-target-media="${CSS.escape(id)}"]`)?.value || 'inherit';
    const type = mode === 'inherit' ? document.getElementById('buffer-media-type').value : mode === 'none' ? '' : mode;
    const url = mode === 'inherit' ? document.getElementById('buffer-media-url').value.trim() : document.querySelector(`[data-target-url="${CSS.escape(id)}"]`)?.value.trim();
    if (channel?.isDisconnected || channel?.isLocked) issues.push(`${channel.name} needs attention in Buffer.`);
    if (['instagram','tiktok','pinterest'].includes(channel?.service) && !type) issues.push(`${channel.name} needs media.`);
    if (channel?.service === 'youtube' && (type !== 'video' || !document.getElementById('buffer-video-title')?.value.trim())) issues.push('YouTube needs a video and a title in Platform settings.');
    if (channel?.service === 'pinterest' && !document.getElementById('buffer-board-id')?.value.trim()) issues.push('Pinterest needs a board ID in Platform settings.');
    if (type) {
      try { const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(); }
      catch { issues.push(`${channel?.name || 'Channel'} needs a public HTTPS media URL.`); }
    }
  });
  return [...new Set(issues)];
}

function updateBufferReadiness() {
  const host = document.getElementById('buffer-readiness');
  if (!host) return;
  const issues = bufferReadiness();
  host.innerHTML = issues.length ? `<strong>Before scheduling</strong><ul>${issues.map(issue => `<li>${bufferHtml(issue)}</li>`).join('')}</ul>` : '<strong>Ready for Buffer</strong><p>Your selections are complete. Buffer will check each network’s requirements when you submit.</p>';
  host.dataset.ready = String(!issues.length);
}

function matchesBufferSearch(post) {
  const query = document.getElementById('buffer-search')?.value.trim().toLowerCase() || '';
  const channel = selectedBufferOrganization()?.channels?.find(item => item.id === post.channelId);
  return `${post.text || ''} ${post.status || ''} ${channel?.name || ''} ${channel?.service || ''}`.toLowerCase().includes(query);
}

function applyBufferSearch() {
  const rows = document.querySelectorAll('#buffer-queue [data-buffer-post]');
  let visible = 0;
  rows.forEach(row => { row.hidden = !matchesBufferSearch(bufferPosts.find(post => post.id === row.dataset.bufferPost) || {}); if (!row.hidden) visible++; });
  const note = document.getElementById('buffer-search-summary');
  if (note) note.textContent = `${visible} of ${bufferPosts.length} loaded posts shown${bufferPostsHasNext ? ' · Load more to search older posts' : ''}`;
}

let bufferLoadGeneration = 0;
let bufferMediaUploading = false;
function bufferLibrary() { return memoryBufferDrafts.length ? structuredClone(memoryBufferDrafts) : (storage()?.getSavedBufferDrafts?.() || []); }

function saveBufferLibraryDraft(draft) {
  const list = bufferLibrary();
  const id = crypto.randomUUID();
  list.unshift({...draft,id,title:(draft.values['buffer-post-text'] || 'Untitled draft').split('\n')[0].slice(0,90)});
  if (list.length > 50) throw new Error('Your draft library is full. Remove an old draft before saving another.');
  memoryBufferDrafts=structuredClone(list);
  storage()?.bufferDraftsChanged?.(list);
}
function renderBufferDraftLibrary() {
  const host = document.getElementById('buffer-draft-library'); if (!host) return;
  const list = bufferLibrary();
  host.innerHTML = `<div class="buffer-library-heading"><h3>Saved drafts <span class="chip">${list.length}</span></h3><span class="settings-hint">Shared workplace · Supabase drafts</span></div>${list.length ? list.map(draft=>`<article class="buffer-library-row"><div><strong>${bufferHtml(draft.title)}</strong><p>${bufferHtml(new Date(draft.savedAt).toLocaleString())} · ${(draft.targets || []).length} channels</p></div><button class="button" type="button" data-load-buffer-draft="${bufferHtml(draft.id)}">Continue</button><button class="mini-button" type="button" data-remove-buffer-draft="${bufferHtml(draft.id)}" aria-label="Remove draft ${bufferHtml(draft.title)}">×</button></article>`).join('') : '<p class="settings-hint">Save several posts here while you plan. Use “Save as Buffer draft” to keep a draft in your Buffer account across devices.</p>'}`;
  host.querySelectorAll('[data-load-buffer-draft]').forEach(button=>button.onclick=async()=>{
    const draft = list.find(item=>item.id===button.dataset.loadBufferDraft);
    if (!draft) return;
    if (document.getElementById('buffer-post-text').value.trim() && !await window.CreatorHQDialogs.confirm('Open this saved draft?','Replace the current composer with this saved draft?','Open draft')) return;
    try {
      currentBufferDraft=structuredClone(draft);
      document.getElementById('buffer-load-draft').click();
      document.querySelector('.nav-button[data-view="buffer-compose"]')?.click();
    } catch { ui()?.notify('Could not restore this draft.'); }
  });
  host.querySelectorAll('[data-remove-buffer-draft]').forEach(button=>button.onclick=async()=>{
    if (!await window.CreatorHQDialogs.confirm('Remove this saved draft?','This removes the draft from your draft library. It does not change posts in Buffer.','Remove draft')) return;
    try { const remaining=list.filter(item=>item.id!==button.dataset.removeBufferDraft);memoryBufferDrafts=structuredClone(remaining);storage()?.bufferDraftsChanged?.(remaining);renderBufferDraftLibrary(); }
    catch { ui()?.notify('Could not remove the draft.'); }
  });
}
function renderBufferPlannerSummary() {
  const host = document.getElementById('buffer-planner-summary'); if (!host) return;
  const channels = selectedBufferOrganization()?.channels || [];
  const status = document.getElementById('buffer-status-filter')?.value || 'scheduled';
  const upcoming = bufferPosts.filter(post=>post.dueAt && new Date(post.dueAt)>new Date()).sort((a,b)=>new Date(a.dueAt)-new Date(b.dueAt))[0];
  host.innerHTML = `<div class="buffer-planner-stats"><div><span>Connected channels</span><strong>${channels.length}</strong></div><div><span>${bufferHtml(status.replace('_',' '))} · loaded</span><strong>${bufferPosts.length}${bufferPostsHasNext ? '+' : ''}</strong></div><div><span>Next loaded post</span><strong class="buffer-small-stat">${upcoming ? bufferHtml(new Date(upcoming.dueAt).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})) : 'No upcoming time'}</strong></div></div><div class="buffer-channel-health">${channels.map(channel=>`<div><span class="buffer-health-dot ${channel.isDisconnected || channel.isLocked ? 'needs-attention' : ''}"></span><strong>${bufferHtml(channel.name)}</strong><span>${bufferHtml(channel.service)} · ${bufferHtml(channel.timezone || '')}</span><span class="chip">${channel.isDisconnected ? 'Reconnect in Buffer' : channel.isLocked ? 'Locked in Buffer' : channel.isQueuePaused ? 'Queue paused' : 'Ready'}</span></div>`).join('')}</div>`;
}
async function uploadBufferPublishingFile(file){
  const note=document.getElementById('buffer-upload-status');
  const input=document.getElementById('buffer-media-file');
  if(bufferMediaUploading){ui()?.notify('Wait for the current upload to finish.');return;}
  if(file.size>50*1024*1024){note.textContent='Choose a file under 50 MB.';return;}
  input.disabled=true;bufferMediaUploading=true;updateBufferReadiness();note.textContent=`Uploading ${file.name} for publishing…`;
  try{
    if(!session?.access_token||!client)throw new Error('Sign in before uploading publishing media.');
    const config=readConfig();
    const response=await fetch(`${config.url}/functions/v1/buffer?action=uploadMedia`,{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`,apikey:config.anonKey,'Content-Type':file.type},body:file});
    const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||`Upload failed (${response.status}).`);
    document.getElementById('buffer-media-type').value=result.type;document.getElementById('buffer-media-url').value=result.url;document.getElementById('buffer-media-url').disabled=false;
    renderBufferComposerPreview();note.textContent=`${file.name} attached. Its public publishing link is ready.`;storage()?.reportIssue?.('buffer-upload','','buffer-compose');
  }catch(error){note.textContent=error.message||'Media upload failed.';storage()?.reportIssue?.('buffer-upload','A publishing-media upload needs attention.','buffer-compose');}
  finally{input.disabled=false;bufferMediaUploading=false;updateBufferReadiness();}
}

function ensureBufferPlanner() {
  const schedule = document.getElementById('buffer-schedule-mode');
  schedule.insertAdjacentHTML('beforeend','<option value="draft">Save as Buffer draft — do not publish</option>');
  const media = document.getElementById('buffer-media-controls');
  media.insertAdjacentHTML('beforebegin',`<div class="buffer-upload-box"><strong>Start with a photo or clip</strong><p>Upload a file for publishing, or use a direct media link below. Uploaded media gets a public link that stays available for scheduled posts. Keep private files in Dropbox.</p><label class="button" for="buffer-media-file">Choose image or video<input hidden type="file" id="buffer-media-file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm"></label><span class="settings-hint">Up to 50 MB per file</span><p id="buffer-upload-status" role="status"></p></div>`);
  media.insertAdjacentHTML('afterend',`<details class="buffer-platform-options"><summary>Platform settings · post format and video details</summary><div class="form-grid"><label class="form-field"><span>Instagram / Facebook format</span><select class="field-control" id="buffer-post-type"><option value="post">Feed post</option><option value="reel">Reel</option><option value="story">Story</option></select></label><label class="form-field"><span>YouTube video title</span><input class="field-control" id="buffer-video-title" maxlength="100" placeholder="Title for YouTube posts"></label><label class="form-field"><span>YouTube category</span><select class="field-control" id="buffer-video-category"><option value="20">Gaming</option><option value="22">People & Blogs</option><option value="24">Entertainment</option><option value="27">Education</option><option value="28">Science & Technology</option></select></label><label class="form-field"><span>Pinterest board ID</span><input class="field-control" id="buffer-board-id" placeholder="Required for Pinterest"></label></div><label><input type="checkbox" id="buffer-video-kids"> This YouTube video is made for kids</label></details>`);
  const queue = document.getElementById('buffer-queue');
  queue.closest('.panel').insertAdjacentHTML('beforebegin','<div id="buffer-planner-summary"></div>');
  queue.insertAdjacentHTML('beforebegin',`<div class="buffer-status-toolbar"><label class="form-field"><span>Show posts</span><select class="field-control" id="buffer-status-filter"><option value="scheduled">Scheduled queue</option><option value="draft">Buffer drafts</option><option value="error">Failed posts</option><option value="sent">Published posts</option><option value="needs_approval">Awaiting approval</option></select></label><p class="settings-hint">Open a post to edit, change its timing, move it to drafts, or reuse its copy and media.</p></div>`);
  queue.closest('.panel').insertAdjacentHTML('afterend','<article class="panel buffer-library-panel"><div class="panel-body" id="buffer-draft-library"></div></article>');
  document.getElementById('buffer-status-filter').onchange = () => { document.querySelector('[data-buffer-view="list"]')?.click(); loadBufferPosts(); };
  document.getElementById('buffer-media-file').onchange=event=>{const file=event.target.files?.[0];event.target.value='';if(file)uploadBufferPublishingFile(file);};
  renderBufferPlannerSummary();
}

function ensureBufferConveniences() {
  const fields = document.getElementById('buffer-composer-fields');
  const preview = document.querySelector('.buffer-composer-preview');
  if (!fields || !preview) return;
  fields.insertAdjacentHTML('afterbegin', `<div class="buffer-draft-tools"><div class="button-row"><button type="button" class="button" id="buffer-save-draft">Save draft</button><button type="button" class="button" id="buffer-load-draft">Restore draft</button></div><p class="settings-hint" id="buffer-draft-note" role="status">Saved drafts join workspace backups and cloud sync when enabled. Nothing publishes automatically.</p><label class="form-field"><span>Quick start</span><select class="field-control" id="buffer-quick-start"><option value="">Choose a starting point…</option><option value="live">Stream announcement</option><option value="clip">Share a clip</option><option value="vod">New video / VOD</option><option value="community">Community question</option></select></label></div>`);
  preview.insertAdjacentHTML('beforeend', '<div id="buffer-readiness" class="buffer-readiness" aria-live="polite"></div>');

  const ids = ['buffer-post-type', 'buffer-video-title', 'buffer-video-category', 'buffer-board-id', 'buffer-post-text', 'buffer-media-type', 'buffer-media-url', 'buffer-schedule-mode', 'buffer-due-at', 'buffer-content-source'];
  document.getElementById('buffer-save-draft').onclick = async () => {
    rememberBufferCustomizations();
    const draft = { madeForKids: document.getElementById('buffer-video-kids').checked, organization: document.getElementById('buffer-organization').value, values: Object.fromEntries(ids.map(id => [id, document.getElementById(id).value])), targets: [...document.querySelectorAll('[data-buffer-target]:checked')].map(input => input.value), overrides: [...bufferCustomizations], savedAt: new Date().toISOString() };
    try { currentBufferDraft=structuredClone(draft); saveBufferLibraryDraft(draft); await uploadWorkspace(); renderBufferDraftLibrary(); document.getElementById('buffer-draft-note').textContent = `Draft saved in Supabase at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`; }
    catch { ui()?.notify('Could not save the draft to Supabase. Keep this tab open and retry.'); }
  };
  document.getElementById('buffer-load-draft').onclick = () => {
    try {
      const draft = currentBufferDraft || bufferLibrary()[0];
      if (!draft) return ui()?.notify('No saved draft for this account in this browser yet.');
      if (draft.organization && draft.organization !== document.getElementById('buffer-organization').value) return ui()?.notify('Choose the draft’s Buffer organization in Publishing planner first, then restore it.');
      document.getElementById('buffer-video-kids').checked = draft.madeForKids === true;
      ids.forEach(id => { if (typeof draft.values?.[id] === 'string') document.getElementById(id).value = draft.values[id]; });
      document.querySelectorAll('[data-buffer-target]').forEach(input => { input.checked = draft.targets?.includes(input.value); });
      document.querySelectorAll('[data-target-text]').forEach(input => input.value = '');
      // Restore after the renderer captures current fields, so current edits cannot overwrite the saved draft.
      document.getElementById('buffer-channel-customizations').innerHTML = '';
      bufferCustomizations.clear();
      (draft.overrides || []).forEach(([id, value]) => bufferCustomizations.set(id, value));
      renderBufferTargetCustomizations();
      document.getElementById('buffer-media-url').disabled = !document.getElementById('buffer-media-type').value;
      document.getElementById('buffer-due-field').hidden = document.getElementById('buffer-schedule-mode').value !== 'custom';
      document.getElementById('buffer-post-text').dispatchEvent(new Event('input', { bubbles: true }));
      updateBufferBatchLabel();
      document.getElementById('buffer-draft-note').textContent = 'Saved draft restored. Review your channels and publishing time before scheduling.';
    } catch { ui()?.notify('This draft could not be restored.'); }
  };
  const starters = { live: 'I’m going live!\n\nToday we’re [what you’re streaming]. Join me at [time + timezone]:\n[stream link]', clip: 'One of my favorite moments from the stream!\n\n[Describe the moment]\n\nWatch here: [clip link]', vod: 'Missed the stream? The replay is ready.\n\n[What viewers can expect]\n\nWatch: [video link]', community: 'Question for the community: [your question]\n\nTell me what you think below!' };
  document.getElementById('buffer-quick-start').onchange = event => {
    const input = document.getElementById('buffer-post-text');
    if (input.value.trim()) { ui()?.notify('Save your current draft and clear the copy before choosing a starting point.'); event.target.value = ''; return; }
    input.value = starters[event.target.value] || '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  document.querySelector('.buffer-draft-tools .button-row').insertAdjacentHTML('beforeend','<button class="button" type="button" id="buffer-browse-drafts">Browse saved drafts</button>');
  document.getElementById('buffer-browse-drafts').onclick = () => { document.querySelector('.nav-button[data-view="buffer-scheduled"]')?.click(); document.getElementById('buffer-draft-library').scrollIntoView({behavior:'smooth',block:'start'}); };
  fields.addEventListener('input', updateBufferReadiness);
  fields.addEventListener('change', () => { updateBufferBatchLabel(); });
  const queue = document.getElementById('buffer-queue');
  queue.insertAdjacentHTML('beforebegin', '<div class="buffer-queue-tools"><label class="form-field"><span>Search loaded posts</span><input class="field-control" id="buffer-search" type="search" placeholder="Search copy, channel, or status"></label><button class="button" type="button" id="buffer-refresh">Refresh Buffer</button><a class="button" href="https://publish.buffer.com/" target="_blank" rel="noopener noreferrer">Open Buffer ↗</a></div><p class="settings-hint" id="buffer-search-summary" role="status"></p>');
  document.getElementById('buffer-search').oninput = () => { applyBufferSearch(); renderBufferCalendar(); };
  document.getElementById('buffer-refresh').onclick = async event => { const button = event.currentTarget; button.disabled = true; try { await loadBufferWorkspace(); } finally { button.disabled = false; } };
  document.getElementById('buffer-due-at').insertAdjacentHTML('afterend', `<span class="settings-hint">Times use this device’s timezone: ${bufferHtml(Intl.DateTimeFormat().resolvedOptions().timeZone)}. Queue slots use your Buffer channel’s schedule.</span>`);
  document.getElementById('buffer-batch-result')?.setAttribute('role', 'status');
  updateBufferReadiness();
}

document.getElementById('buffer-organization').addEventListener('change', () => { bufferCustomizations.clear(); document.getElementById('buffer-channel-customizations').innerHTML = ''; renderBufferChannels(); loadBufferPosts(); });
document.getElementById('buffer-channel-filter').addEventListener('change', loadBufferPosts);
ensureBufferContentPicker();
ensureBufferMediaControls();
ensureBufferComposerLayout();
ensureBufferTargetPicker();
ensureBufferComposerSections();
ensureBufferPlanner();
ensureBufferConveniences();
renderBufferDraftLibrary();
document.getElementById('buffer-content-source').addEventListener('change', event => {
  const item = (storage()?.getWorkspace()?.content || []).find(content => content.id === event.target.value);
  renderContentPublishingFiles(item);
  if (!item) return;
  bufferCustomizations.clear();document.getElementById('buffer-channel-customizations').innerHTML='';
  const service=String(item.platform||'').toLowerCase().replace('x (twitter)','twitter');
  const matching=selectedBufferOrganization()?.channels?.filter(channel=>channel.service===service)||[];
  if(matching.length)document.querySelectorAll('[data-buffer-target]').forEach(input=>{input.checked=matching.some(channel=>channel.id===input.value);});
  renderBufferTargetCustomizations();
  document.getElementById('buffer-video-title').value=item.title||'';
  if(item.publishDate){const date=new Date(`${item.publishDate}T12:00:00`);if(date>new Date()){document.getElementById('buffer-schedule-mode').value='custom';document.getElementById('buffer-due-at').value=bufferLocalDateTime(date);document.getElementById('buffer-due-field').hidden=false;}}
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
    await authGate.signIn(email, password);
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

document.getElementById('cloud-sign-out').addEventListener('click',async()=>{try{await authGate.signOut();setAccountState();}catch(error){reportError(error);}});

document.getElementById('cloud-push').addEventListener('click', async () => {
  try { await uploadWorkspace({ confirmOverwrite: true }); }
  catch (error) { reportError(error); }
});

document.getElementById('cloud-pull').addEventListener('click', async () => {
  try { await pullWorkspace(); }
  catch (error) { reportError(error); }
});

document.getElementById('cloud-disable').addEventListener('click',async()=>{try{await uploadWorkspace();}catch(error){reportError(error);}});

try {
  const config = readConfig();
  // A new domain has fresh browser storage. Bootstrap the same public project connection.
  const publication = config.url && config.anonKey ? null : await getPublicProfileConfig();
  const projectUrl = config.url && config.anonKey ? config.url : publication?.supabaseUrl;
  const projectKey = config.url && config.anonKey ? config.anonKey : publication?.anonKey;
  if (projectUrl && projectKey) {
    document.getElementById('cloud-url').value = projectUrl;
    document.getElementById('cloud-anon-key').value = projectKey;
    await connectProject(projectUrl, projectKey);
    storage()?.refreshSocialLinks?.();
    if (config.syncEnabled && session?.user && mfaReady && preparedForUser===session.user.id) queueSync();
  }
} catch (error) {
  ui()?.setConnection(false, `Could not initialize Supabase: ${message(error)}`);
}