let csrf;
const base = '/orce/ui-api/v1/auth';

async function request(path, body) {
  const response = await fetch(base + path, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json', ...headers() },
    body: JSON.stringify(body || {})
  });
  const result = await response.json();
  if (!response.ok) {
    const error = Error(result.error?.code || 'AUTHENTICATION_REQUIRED');
    error.status = response.status;
    throw error;
  }
  return result.data;
}

export async function setup() {
  try { csrf = (await request('/csrf')).csrfToken; return true; }
  catch (error) { if (error.status === 401) return false; throw error; }
}
export async function login(username, password) {
  csrf = (await request('/login', { username, password })).csrfToken;
  location.assign('/orce/');
}
export function csrfToken() { return csrf; }
export function headers() { return csrf ? { 'X-CSRF-Token': csrf } : {}; }
export async function logout() {
  await request('/logout'); csrf = undefined; location.assign('/orce/');
}
export async function changePassword(currentPassword, newPassword) {
  await request('/password', { currentPassword, newPassword });
  csrf = undefined; location.assign('/orce/');
}
