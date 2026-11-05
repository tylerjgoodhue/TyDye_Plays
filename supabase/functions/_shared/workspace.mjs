// Only use with a user already authenticated by auth.getUser(token).
export async function resolveWorkplace(user, token, url, key, permissions = []) {
 const response = await fetch(`${url.replace(/\/$/,'')}/rest/v1/rpc/creator_workspace_context`, {
  method:'POST',headers:{Authorization:`Bearer ${token}`,apikey:key,'Content-Type':'application/json'},body:'{}'
 });
 const context=await response.json().catch(()=>null);
 if(!response.ok || !context?.owner_id) { const error=new Error(context?.message || 'Your account is not a member of this workplace. Ask the owner to add it in Staff.');error.status=403;throw error; }
 requireWorkplacePermission(context,permissions);
 return context;
}
export function requireWorkplacePermission(context,permissions) {
 if(context.role==='owner' || !permissions.length || permissions.some(permission=>(context.permissions||[]).includes(permission)))return;
 const error=new Error('Your workplace role does not allow this action. Ask the owner to update your access.');error.status=403;throw error;
}
