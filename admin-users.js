'use strict';
const U = 'https://lpovhfipxoeqqnfnipia.supabase.co';
const K = 'sb_publishable_7WEioWEeqiSNE1nSFXD8lg_zosjgsC_';
const s = window.supabase.createClient(U, K), $ = id => document.getElementById(id);
const roles = { pending: 'Venter på godkjenning', dispatcher: 'Ordrebehandler – Cargo', admin: 'Administrator – Cargo', superuser: 'Superbruker – hele plattformen', disabled: 'Deaktivert – hele plattformen', viewer: 'Lesebruker (eldre rolle)' };
let me = null, users = [], busy = false, removeTarget = null;
const esc = value => String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

function message(text, error = false) {
  $('adminMessage').textContent = text;
  $('adminMessage').className = 'notice' + (error ? ' error' : '');
}

async function boot() {
  const { data, error } = await s.auth.getSession();
  for (const id of ['loginBox', 'adminBox', 'denied']) $(id).classList.add('hidden');
  if (error || !data.session) { me = null; $('loginBox').classList.remove('hidden'); return; }
  const result = await s.from('profiles').select('*').eq('id', data.session.user.id).single();
  me = result.data;
  if (result.error || !me || me.deleted_at || !['admin', 'superuser'].includes(me.role)) {
    me = null; $('users').replaceChildren(); $('deleteUserModal').classList.add('hidden'); $('denied').classList.remove('hidden'); return;
  }
  $('adminBox').classList.remove('hidden'); await load();
}

async function load() {
  const all = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await s.from('profiles').select('*').order('created_at', { ascending: true }).order('id').range(from, from + 499);
    if (error) { message(error.message, true); return; }
    all.push(...data);
    if (data.length < 500) break;
  }
  users = all;
  const fresh = users.find(user => user.id === me?.id);
  if (fresh) me = fresh;
  if (!me || me.deleted_at || !['admin', 'superuser'].includes(me.role)) { await boot(); return; }
  renderUsers();
}

function renderUsers() {
  const list = users.filter(user => !user.deleted_at);
  $('userCount').textContent = list.length + ' brukere';
  $('users').innerHTML = list.map(user => {
    const name = user.full_name || user.email || 'Ukjent';
    return '<div class="row" data-user="' + esc(user.id) + '"><div><b>' + esc(name) + '</b>' + (user.id === me.id ? ' <span class="muted">(deg)</span>' : '') + '<div class="muted">' + esc(user.email || '') + '</div></div><div><span class="badge ' + esc(user.role) + '">' + esc(roles[user.role] || user.role) + '</span></div><div class="actions"><label class="role-control">Rolle<select aria-label="Rolle for ' + esc(name) + '">' + Object.entries(roles).filter(([role]) => role !== 'viewer' || user.role === 'viewer').map(([role, label]) => '<option value="' + role + '"' + (user.role === role ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label><button type="button" class="btn navy save-role">Lagre rolle</button>' + (user.id !== me.id ? '<button type="button" class="btn red remove-user">Slett bruker</button>' : '') + '</div></div>';
  }).join('') || '<p class="muted">Ingen brukere.</p>';
  for (const row of $('users').querySelectorAll('[data-user]')) {
    row.querySelector('.save-role').onclick = () => changeRole(row.dataset.user, row.querySelector('select').value);
    const remove = row.querySelector('.remove-user');
    if (remove) remove.onclick = () => openRemoval(row.dataset.user);
  }
}

async function manage(id, action, nextRole = null) {
  if (busy) return false;
  busy = true;
  document.querySelectorAll('#adminBox button,#adminBox select,#deleteUserModal button').forEach(el => el.disabled = true);
  try {
    const { data, error } = await s.rpc('manage_platform_user', { target_user: id, action, next_role: nextRole });
    if (error) throw error;
    if (!data?.id) throw new Error('Endringen ble ikke bekreftet. Oppdater oversikten.');
    if (action === 'remove') { $('deleteUserModal').classList.add('hidden'); removeTarget = null; }
    message(action === 'remove' ? 'Brukeren er slettet fra oversikten og har mistet tilgangen til Cargo og Capacity. Historikken er beholdt.' : 'Rollen er oppdatert til ' + roles[nextRole] + '.');
    await load();
    return true;
  } catch (error) {
    message(error.message || 'Endringen kunne ikke lagres.', true);
    if (action === 'remove') $('deleteUserError').textContent = error.message;
    return false;
  } finally {
    busy = false; document.querySelectorAll('#adminBox button,#adminBox select,#deleteUserModal button').forEach(el => el.disabled = false);
  }
}

async function changeRole(id, role) {
  const user = users.find(item => item.id === id);
  if (!user || user.role === role) return;
  if (role === 'superuser' && !confirm('Gi ' + (user.full_name || user.email) + ' full tilgang til hele GNS-plattformen, inkludert brukeradministrasjon i Cargo og Capacity?')) return;
  if (role === 'disabled' && !confirm('Deaktivere tilgangen til Cargo og Capacity for ' + (user.full_name || user.email) + '?')) return;
  await manage(id, 'set_role', role);
}

function openRemoval(id) {
  removeTarget = users.find(user => user.id === id);
  if (!removeTarget || removeTarget.id === me.id) return;
  $('deleteUserName').textContent = removeTarget.full_name || removeTarget.email;
  $('deleteUserError').textContent = '';
  $('deleteUserModal').classList.remove('hidden'); $('cancelDeleteUser').focus();
}

$('cancelDeleteUser').onclick = () => { if (!busy) { $('deleteUserModal').classList.add('hidden'); removeTarget = null; } };
$('confirmDeleteUser').onclick = () => { if (removeTarget) return manage(removeTarget.id, 'remove'); };
$('deleteUserModal').addEventListener('keydown', event => {
  if (event.key === 'Escape') $('cancelDeleteUser').click();
  if (event.key === 'Tab') {
    event.preventDefault();
    (document.activeElement === $('cancelDeleteUser') ? $('confirmDeleteUser') : $('cancelDeleteUser')).focus();
  }
});
$('refresh').onclick = load;
$('login').onclick = async () => {
  const { error } = await s.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
  if (error) { $('msg').textContent = error.message; return; }
  await boot();
};
s.auth.onAuthStateChange(() => setTimeout(boot, 0));
boot();
