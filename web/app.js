/* knode-os web UI — vanilla JS, no build step */
'use strict';

const $ = (sel) => document.querySelector(sel);
const api = async (path, opts = {}) => {
  // X-Knode-CSRF: a page on another site cannot send it, so the server knows a write came from this one
  const headers = { 'content-type': 'application/json', 'x-knode-csrf': '1', ...workspaceRequestHeaders(), ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.reason === 'auth') sessionEnded(data.error);
    const error = new Error(data.error || res.statusText);
    // the machine-readable cause, when a route sends one: a screen can act on
    // it instead of parsing the prose
    if (data.reason) error.reason = data.reason;
    throw error;
  }
  return data;
};
const toast = (msg, ms = 2600) => {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Markdown someone else wrote, as HTML that carries formatting only: no raw HTML, no script links (web/markdown.js). */
const renderMd = (s, opts) => (window.knodeMarkdown ? window.knodeMarkdown.render(s, opts) : `<pre>${esc(s)}</pre>`);

/* --------------------------- auth & workspaces ------------------------- */

/**
 * Sign-in belongs to the server (src/auth): a browser holds an HttpOnly
 * session cookie, so nothing secret lives in this page. Storage keeps only
 * which workspaces you had open (`authState`); who you are and what you may
 * use (`serverAuth`) comes from the server on every load.
 */
const AUTH_KEY = 'knode-os.auth.v1';
let authState = null;
/** The server's view of the session: account, groups usable here, teams, gateways. */
let serverAuth = null;
/** Sign-in is off on this server (development): any username, no password. */
let authDisabled = false;
let pendingUser = null;
let pendingPersistence = 'local';
let statsTimer = null;
let sessionEndedShown = false;
/**
 * A deep link the page was opened with — `/?open=<path>&kind=&ws=#<fragment>`
 * (web/deeplink.js) — kept until the app is signed in and in that workspace.
 */
let pendingOpen = window.knodeDeepLink?.read(location.search, location.hash) ?? null;

const initials = (value) => {
  const parts = String(value || 'You').trim().split(/[\s@._-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0].slice(0, 2)).toUpperCase();
};

const nameFromUsername = (username) => String(username)
  .split(/[._-]+/)
  .filter(Boolean)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ') || 'Your account';

const normalizeUsername = (username) => String(username || '').trim().toLowerCase();

function readAuthState() {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      const parsed = JSON.parse(storage.getItem(AUTH_KEY) || 'null');
      if ((parsed?.user?.username || parsed?.user?.email) && Array.isArray(parsed.workspaces) && parsed.activeWorkspaceId) return parsed;
    } catch { /* storage may be unavailable or stale */ }
  }
  return null;
}

function saveAuthState() {
  if (!authState) return;
  const target = authState.persistence === 'session' ? sessionStorage : localStorage;
  const other = target === localStorage ? sessionStorage : localStorage;
  try {
    target.setItem(AUTH_KEY, JSON.stringify(authState));
    other.removeItem(AUTH_KEY);
  } catch { /* keep the current in-memory session */ }
}

function forgetAuthState() {
  try { localStorage.removeItem(AUTH_KEY); sessionStorage.removeItem(AUTH_KEY); } catch { /* no-op */ }
}

function showAuthStep(step) {
  document.querySelectorAll('.auth-step').forEach((el) => el.classList.remove('active'));
  $(`#auth-${step}`).classList.add('active');
}

function teamFromCode(rawCode) {
  let code = String(rawCode || '').trim();
  if (/^https?:\/\//i.test(code)) {
    try { code = new URL(code).pathname.split('/').filter(Boolean).pop() || ''; } catch { /* use raw input */ }
  }
  code = code.replace(/[^a-z0-9-]/gi, '').toUpperCase();
  if (code.replace(/-/g, '').length < 3) return null;
  const words = code.split('-').filter(Boolean);
  const name = words.map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(' ') || 'Shared Team';
  return { id: `team-${code.toLowerCase()}`, name, kind: 'team', code };
}

function personalWorkspace() {
  return { id: 'default', name: 'Default', kind: 'personal' };
}

function workspaceLabel(workspace) {
  return workspace?.name || 'Workspace';
}

/**
 * An evaluation build's line in the workspace menu and header (docs/design/35):
 * its state, the update batches it holds, what built it and its size — or why
 * the viewer does not open it.
 */
function evaluationLine(workspace) {
  const ev = workspace?.evaluation;
  if (!ev) return '';
  const mb = ev.bytes >= 1024 ** 3 ? `${(ev.bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(ev.bytes / 1024 ** 2))} MB`;
  const batches = ev.batchesApplied?.length ? `after batch ${ev.batchesApplied.at(-1)}` : 'no update batch';
  const built = ev.builtWith ? `knode-os ${ev.builtWith.version}${ev.builtWith.commit ? ` ${ev.builtWith.commit.slice(0, 7)}` : ''}` : '';
  const state = ev.state === 'updating' ? 'a batch is being applied' : ev.state;
  return [state, batches, built, mb, ev.openable ? '' : `not opened: ${ev.why}`].filter(Boolean).join(' · ');
}

/** The Teams the server says this account may open. */
function serverTeams() {
  return (serverAuth?.teams || []).map((team) => ({ id: team.id, name: team.name, kind: 'team', code: String(team.slug || '').toUpperCase() }));
}

/** Members keep only the Teams they were given; an administrator may keep any Team joined by code. */
function allowedTeams(teams) {
  const account = serverAuth?.account;
  const given = serverTeams();
  const open = authDisabled || !account || account.role === 'admin' || account.teams?.includes('*');
  const kept = open ? teams : teams.filter((team) => given.some((g) => g.id === team.id));
  return [...kept, ...given].filter((team, i, all) => all.findIndex((t) => t.id === team.id) === i);
}

function completeLogin(activeWorkspace, extraWorkspaces = []) {
  const user = pendingUser;
  if (!user) return;
  const personal = personalWorkspace();
  authState = {
    user,
    persistence: pendingPersistence,
    workspaces: [personal, ...allowedTeams(extraWorkspaces)],
    activeWorkspaceId: activeWorkspace.id,
  };
  saveAuthState();
  $('#login-password').value = '';
  pendingUser = null;
  enterApp();
}

function activeWorkspace() {
  return authState?.workspaces.find((workspace) => workspace.id === authState.activeWorkspaceId) || authState?.workspaces[0];
}

function workspaceRequestHeaders() {
  if (!authState?.user) return {};
  const workspace = activeWorkspace();
  const username = normalizeUsername(authState.user.username || authState.user.email);
  if (!username || !workspace) return {};
  // the server acts for the signed-in account; the user header only matters with sign-in off
  return {
    'x-knode-user': username,
    'x-knode-workspace-kind': workspace.kind,
    'x-knode-workspace-id': workspace.id,
    'x-knode-workspace-name': workspace.name,
  };
}

let workspaceSync = null;
let workspaceSyncedAt = 0;

/** What the workspace menu and header show, to tell whether a sync changed any of it. */
const workspaceView = () => JSON.stringify([
  authState?.activeWorkspaceId,
  (authState?.workspaces || []).map((workspace) => [workspace.id, workspace.name]),
  serverAuth?.account?.role,
  serverAuth?.account?.readOnly,
]);

/**
 * The workspaces this account may open: its own (/api/workspaces), the Teams
 * the server gives it, and any Team an administrator joined by code. With
 * `access`, first ask the server again what the account may open. Otherwise
 * that is read only when the page loads, and a Team shared or withdrawn later
 * would not show until a reload. Overlapping calls share one round trip, and
 * `notWithin` (ms) skips a sync made that recently. Resolves to the workspace
 * that was open when it had to give way (no longer open to this account),
 * else null.
 */
function syncUserWorkspaces({ access = false, notWithin = 0 } = {}) {
  if (workspaceSync) return workspaceSync;
  if (!authState?.user || Date.now() - workspaceSyncedAt < notWithin) return Promise.resolve(null);
  const asked = authState.user;
  workspaceSync = (async () => {
    const me = access && !authDisabled ? await api('/api/auth/me') : null;
    const owned = await api('/api/workspaces');
    // signed out, or in again, while the answers were on their way
    if (authState?.user !== asked) return null;
    if (me) serverAuth = { ...serverAuth, ...me };
    const before = workspaceView();
    const previous = activeWorkspace();
    const teams = allowedTeams(authState.workspaces.filter((workspace) => workspace.kind === 'team'));
    authState.workspaces = [...owned, ...teams];
    if (!authState.workspaces.some((workspace) => workspace.id === authState.activeWorkspaceId)) {
      authState.activeWorkspaceId = owned[0]?.id || teams[0]?.id;
    }
    saveAuthState();
    if (workspaceView() !== before) renderWorkspaceUI();
    return previous && previous.id !== activeWorkspace()?.id ? previous : null;
  })().finally(() => {
    workspaceSync = null;
    workspaceSyncedAt = Date.now();
  });
  return workspaceSync;
}

/**
 * Back on the page, or opening the workspace menu: take in Teams shared or
 * withdrawn since the list was read. Resolves to the workspace that had to give
 * way (and was replaced by a fresh one), else null.
 */
function refreshAccess(notWithin = 0) {
  if (!authState?.user || $('#app-shell').hidden) return Promise.resolve(null);
  return syncUserWorkspaces({ access: true, notWithin })
    .then((left) => {
      if (!left) return null;
      loadWorkspaceData();
      toast(`${workspaceLabel(left)} is no longer open to you — switched to ${workspaceLabel(activeWorkspace())}`, 5000);
      return left;
    })
    .catch(() => null /* the list stays as it was; the next refresh asks again */);
}

/**
 * Read the open workspace again without losing your place: the counts, the
 * notices, the open folders and the open file (unless it is being edited).
 * Unlike switching workspaces nothing is cleared, so an open file, a search
 * or a draft stays as it is.
 */
async function reloadWorkspace() {
  const workspace = activeWorkspace()?.id;
  loadStats();
  loadNotices();
  // Files is read only once a tree is on screen; until then it loads when it first opens
  if (!listings.size) return;
  try {
    await loadTree();
  } catch {
    return; // the folders stay as they were
  }
  if (activeWorkspace()?.id === workspace) await rereadOpenFile();
}

/** Read the open file again, keeping the reader's place; a file being edited is left as it is. */
async function rereadOpenFile() {
  const path = currentFile;
  if (!path || editing) return;
  try {
    const file = await api(fileUrl(path));
    // the reader may have moved on, or started editing, meanwhile
    if (currentFile !== path || editing) return;
    if (file.content !== $('#file-editor').value) {
      const view = $('#file-view');
      const top = view.scrollTop;
      renderFileContent(path, file.content, file.derived, file.truncated, file.bytes);
      view.scrollTop = top;
      loadFileCitations(path);
    }
    paintLanguages(path, file);
  } catch {
    // gone or unreachable: what is on screen stays; opening it again says why
  }
}

function renderWorkspaceUI() {
  if (!authState) return;
  const workspace = activeWorkspace();
  const user = authState.user;
  const userInitials = initials(user.name || user.username || user.email);
  const workspaceInitials = workspace.kind === 'personal' ? userInitials : initials(workspace.name);
  const personal = workspace.kind === 'personal';

  $('#workspace-avatar').textContent = workspaceInitials;
  $('#workspace-avatar').classList.toggle('team', !personal);
  $('#workspace-name').textContent = workspaceLabel(workspace);
  $('#workspace-kind').textContent = workspace.evaluation ? 'Evaluation build · read-only' : personal ? 'Private workspace' : 'Team workspace';
  $('#context-name').textContent = workspaceLabel(workspace);
  $('#context-description').textContent = workspace.evaluation
    ? `Built by run ${workspace.evaluation.runId}: ${evaluationLine(workspace)}`
    : personal
      ? 'Only you can access this knowledge.'
      : 'Knowledge in this view is shared with your Team.';
  $('#cfg-workspace-name').textContent = personal ? workspace.name : `${workspace.name} Team workspace`;
  $('#clear-workspace-name').textContent = workspaceLabel(workspace);
  $('#workspace-context').classList.toggle('team', !personal);
  $('#account-avatar').textContent = userInitials;
  $('#account-name').textContent = user.name;
  const role = serverAuth?.account?.role === 'admin' ? ' · administrator' : serverAuth?.account?.readOnly ? ' · read-only' : '';
  $('#account-email').textContent = user.username ? `@${user.username}${role}` : user.email;
  document.body.dataset.workspace = workspace.kind;
  document.body.dataset.role = serverAuth?.account?.role || 'member';

  const options = $('#workspace-options');
  options.innerHTML = '';
  for (const item of authState.workspaces) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `workspace-option${item.id === workspace.id ? ' active' : ''}`;
    button.setAttribute('role', 'menuitem');
    const detail = item.evaluation ? evaluationLine(item) : item.kind === 'personal' ? 'Private to you' : 'Shared Team knowledge';
    button.innerHTML = `<span>${esc(initials(item.name))}</span><span><b>${esc(workspaceLabel(item))}</b><small>${esc(detail)}</small></span>`;
    button.addEventListener('click', () => switchWorkspace(item.id));
    options.appendChild(button);
  }
}

function closeWorkspaceMenu() {
  $('#workspace-menu').hidden = true;
  $('#workspace-trigger').setAttribute('aria-expanded', 'false');
}

function switchWorkspace(id) {
  if (!authState || !authState.workspaces.some((workspace) => workspace.id === id)) return;
  // picking the workspace already open reads it again, keeping your place
  if (id === authState.activeWorkspaceId) {
    closeWorkspaceMenu();
    reloadWorkspace();
    toast(`Reloaded ${workspaceLabel(activeWorkspace())}`);
    return;
  }
  authState.activeWorkspaceId = id;
  saveAuthState();
  renderWorkspaceUI();
  closeWorkspaceMenu();
  loadWorkspaceData();
  toast(`Switched to ${workspaceLabel(activeWorkspace())}`);
}

function joinTeam(code, fromOnboarding = false) {
  const team = teamFromCode(code);
  if (!team) return { error: 'Enter a valid Team code or invite link.' };
  const account = serverAuth?.account;
  if (!authDisabled && account && account.role !== 'admin' && !account.teams?.includes('*') && !serverTeams().some((t) => t.id === team.id)) {
    return { error: `Your account has not been given ${team.name} — ask an administrator.` };
  }
  if (fromOnboarding) {
    completeLogin(team, [team]);
    return { team };
  }
  const existing = authState.workspaces.find((workspace) => workspace.id === team.id);
  if (!existing) authState.workspaces.push(team);
  authState.activeWorkspaceId = (existing || team).id;
  saveAuthState();
  renderWorkspaceUI();
  loadWorkspaceData();
  toast(`Joined ${team.name}`);
  return { team: existing || team };
}

function loadWorkspaceData() {
  currentFile = null;
  editing = false;
  // another workspace's files and entities: nothing to go back to, nothing to show
  fileTrail.length = 0;
  paintBack();
  closeEntityPanel();
  listings.clear();
  shownEntries.clear();
  selectedDir = null;
  expandedDirs.clear();
  expandedDirs.add('wiki');
  loadedConfig = null;
  resetGraph();
  $('#filetree').innerHTML = '';
  $('#file-path').textContent = '';
  $('#file-view').hidden = false;
  $('#file-view').innerHTML = '';
  clearFileCitations();
  $('#file-editor').hidden = true;
  $('#file-editor').value = '';
  $('#btn-edit').textContent = 'edit';
  $('#btn-edit').disabled = true;
  $('#btn-save').disabled = true;
  $('#btn-delete').disabled = true;
  searchState.result = null;
  searchState.seq++;
  $('#search-results').innerHTML = '';
  $('#search-summary').hidden = true;
  $('#search-main-head').hidden = true;
  $('#search-side').hidden = true;
  tasksSnapshot = null;
  $('#graph-side').innerHTML = '';
  resetEntities();
  $('#traces-table tbody').innerHTML = '';
  $('#suggestions').innerHTML = '';
  $('#cfg-status').innerHTML = '';
  loadStats();
  notices = [];
  showDismissedNotices = false;
  closeNotices();
  loadNotices();
  loadTree().then(openLanding).catch(() => {});

  // reload whatever the current host view shows — one list, so it cannot drift
  // out of sync with what navigate() loads on arrival
  playbook = null;
  TAB_LOAD[hostOf(currentTab)]?.();
  SUBTAB_LOAD[currentTab]?.();
}

function startAppData() {
  if (!statsTimer) statsTimer = setInterval(loadStats, 15000);
  if (!noticesTimer) noticesTimer = setInterval(loadNotices, NOTICE_REFRESH_MS);
  loadWorkspaceData();
}

function stopAppData() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  if (noticesTimer) clearInterval(noticesTimer);
  noticesTimer = null;
  stopChatPolling();
  stopTasksPolling();
}

function enterApp() {
  sessionEndedShown = false;
  $('#auth-view').hidden = true;
  $('#app-shell').hidden = false;
  // paints the header, the strip and the visible section from one source; a deep link's file shows in Files
  navigate(pendingOpen ? 'files' : restoreNav());
  renderWorkspaceUI();
  syncUserWorkspaces()
    .catch((error) => toast(`Could not sync workspaces: ${error.message}`, 5000))
    .finally(() => {
      useDeepLinkWorkspace();
      renderWorkspaceUI();
      startAppData();
    });
}

/* ------------------------------ deep links ------------------------------ */

/** The address keeps only the app: a reload opens where you are, not the link again. */
function clearDeepLink() {
  if (location.search || location.hash) history.replaceState(null, '', location.pathname);
}

/**
 * The workspace a deep link names becomes the open one before anything
 * loads; a Team the server lets this account open joins the menu. A link to
 * a workspace the account cannot open says so and opens nothing.
 */
function useDeepLinkWorkspace() {
  if (!pendingOpen?.ws || !authState) return;
  const named = window.knodeDeepLink.pick(pendingOpen, [...authState.workspaces, ...serverTeams()]);
  if (!named) {
    toast(`This link is for ${pendingOpen.kind === 'team' ? 'the Team' : 'the workspace'} “${pendingOpen.ws}”, which this account cannot open`, 6000);
    pendingOpen = null;
    clearDeepLink();
    return;
  }
  if (!authState.workspaces.some((workspace) => workspace.id === named.id)) authState.workspaces.push(named);
  authState.activeWorkspaceId = named.id;
  saveAuthState();
}

/** What a workspace opens at: a deep link's file — at its fragment — or folder, once; else the wiki's index. */
async function openLanding() {
  const link = pendingOpen;
  pendingOpen = null;
  if (!link) return openFile('wiki/index.md');
  clearDeepLink();
  if (!link.path) return openFile('wiki/index.md');
  let node;
  try {
    node = await api(`/api/tree?path=${encodeURIComponent(link.path)}&depth=1`);
  } catch (e) {
    toast(`${link.path} cannot be opened: ${e.message}`, 6000);
    return openFile('wiki/index.md');
  }
  if (node.kind === 'dir') {
    reveal(link.path);
    const parts = link.path.split('/');
    await Promise.all(['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))].map(ensureListing));
    renderTree();
    pickDir(link.path);
    document.querySelector(`#filetree .tree-dir > .tree-label[data-path="${CSS.escape(link.path)}"]`)?.scrollIntoView({ block: 'center' });
    return;
  }
  await showInTree(link.path);
  await openFile(link.path, null, link.fragment);
  document.querySelector(`#filetree .tree-file > .tree-label[data-path="${CSS.escape(link.path)}"]`)?.scrollIntoView({ block: 'center' });
}

function showAuthView() {
  stopAppData();
  closeWorkspaceMenu();
  $('#app-shell').hidden = true;
  $('#auth-view').hidden = false;
}

function showLogin(note = '') {
  showAuthView();
  showAuthStep('login');
  $('#login-form').reset();
  $('#login-remember').checked = true;
  $('#login-password').type = 'password';
  $('#btn-toggle-password').textContent = 'Show';
  $('#login-error').textContent = '';
  const message = note || (authDisabled ? 'Sign-in is off on this server (development): any username works, no password.' : '');
  $('#login-note').textContent = message;
  $('#login-note').hidden = !message;
  const last = readAuthState()?.user?.username;
  if (last) $('#login-username').value = last;
  setTimeout(() => (last ? $('#login-password') : $('#login-username')).focus(), 0);
}

/** A request came back 401: the session is over (expired, signed out elsewhere, password changed). */
function sessionEnded(message) {
  if (sessionEndedShown || authDisabled) return;
  sessionEndedShown = true;
  serverAuth = null;
  showLogin(message && !/^sign in first$/i.test(message) ? `${message.charAt(0).toUpperCase()}${message.slice(1)}.` : 'Your session ended — sign in again.');
}

function continueToWorkspaceChoice(user, persistence) {
  pendingUser = user;
  pendingPersistence = persistence;
  $('#personal-choice-avatar').textContent = initials(user.name || user.username);
  $('#onboarding-team-form').reset();
  $('#onboarding-team-error').textContent = '';
  showAuthStep('workspaces');
}

/** The server accepted us: back to the workspaces this browser had open for the same user, or choose. */
function signedIn(view, persistence) {
  serverAuth = view;
  const account = view.account;
  const user = { username: account.username, name: account.name || nameFromUsername(account.username) };
  const stored = readAuthState();
  if (stored && normalizeUsername(stored.user?.username) === account.username) {
    authState = { ...stored, user, persistence };
    authState.workspaces = [
      ...authState.workspaces.filter((workspace) => workspace.kind === 'personal'),
      ...allowedTeams(authState.workspaces.filter((workspace) => workspace.kind === 'team')),
    ];
    if (!authState.workspaces.some((workspace) => workspace.id === authState.activeWorkspaceId)) authState.activeWorkspaceId = personalWorkspace().id;
    saveAuthState();
    enterApp();
    return;
  }
  // someone else signed in on this browser: their workspaces are not ours
  forgetAuthState();
  if (pendingOpen?.ws) {
    // a deep link has made the choice: start from the personal workspace, and the link's takes over
    pendingUser = user;
    pendingPersistence = persistence;
    completeLogin(personalWorkspace());
    return;
  }
  continueToWorkspaceChoice(user, persistence);
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = normalizeUsername($('#login-username').value);
  const password = $('#login-password').value;
  const remember = $('#login-remember').checked;
  if (!username) {
    $('#login-error').textContent = 'Enter your username.';
    $('#login-username').focus();
    return;
  }
  if (authDisabled) {
    signedIn({ account: { username, name: nameFromUsername(username), role: 'admin', teams: ['*'] }, teams: [] }, remember ? 'local' : 'session');
    return;
  }
  if (!password) {
    $('#login-error').textContent = 'Enter your password.';
    $('#login-password').focus();
    return;
  }
  const button = $('#btn-login');
  button.disabled = true;
  try {
    const view = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password, remember }) });
    $('#login-error').textContent = '';
    $('#login-note').hidden = true;
    signedIn(view, remember ? 'local' : 'session');
  } catch (error) {
    $('#login-error').textContent = error.reason === 'setup' ? 'This server has no accounts yet.' : `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.`;
    $('#login-password').select();
  } finally {
    button.disabled = false;
  }
});

$('#btn-toggle-password').addEventListener('click', () => {
  const password = $('#login-password');
  const reveal = password.type === 'password';
  password.type = reveal ? 'text' : 'password';
  $('#btn-toggle-password').textContent = reveal ? 'Hide' : 'Show';
});

$('#setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = normalizeUsername($('#setup-username').value);
  const password = $('#setup-password').value;
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(username)) {
    $('#setup-error').textContent = 'Use up to 32 lower-case letters, digits, dots, dashes or underscores.';
    $('#setup-username').focus();
    return;
  }
  if (password.length < 8) {
    $('#setup-error').textContent = 'Passwords need at least 8 characters.';
    $('#setup-password').focus();
    return;
  }
  if (password !== $('#setup-confirm').value) {
    $('#setup-error').textContent = 'The passwords do not match.';
    $('#setup-confirm').focus();
    return;
  }
  try {
    const view = await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ username, password, name: nameFromUsername(username) }) });
    $('#setup-error').textContent = '';
    $('#setup-form').reset();
    signedIn(view, 'local');
  } catch (error) {
    $('#setup-error').textContent = error.message;
  }
});

$('#btn-nosetup-retry').addEventListener('click', () => bootAuth());

$('#btn-auth-back').addEventListener('click', () => showAuthStep('login'));
$('#btn-use-personal').addEventListener('click', () => pendingUser && completeLogin(personalWorkspace()));

$('#onboarding-team-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const result = joinTeam($('#onboarding-team-code').value, true);
  $('#onboarding-team-error').textContent = result.error || '';
});

$('#workspace-trigger').addEventListener('click', (event) => {
  event.stopPropagation();
  const menu = $('#workspace-menu');
  menu.hidden = !menu.hidden;
  $('#workspace-trigger').setAttribute('aria-expanded', String(!menu.hidden));
  // the list shows at once and takes in any Team shared since it was last read;
  // the open workspace is read again in place (a fresh one opened instead needs no second read)
  if (!menu.hidden) refreshAccess().then((left) => { if (!left) reloadWorkspace(); });
});

// coming back to the page: Teams shared or withdrawn meanwhile show without a reload
window.addEventListener('focus', () => refreshAccess(30_000));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshAccess(30_000);
});

$('#workspace-menu').addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('click', closeWorkspaceMenu);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeWorkspaceMenu();
    if ($('#join-team-dialog').open) $('#join-team-dialog').close();
    if ($('#create-workspace-dialog').open) $('#create-workspace-dialog').close();
    if ($('#clear-workspace-dialog').open) $('#clear-workspace-dialog').close();
    if ($('#user-dialog').open) $('#user-dialog').close();
  }
});

$('#btn-open-create-workspace').addEventListener('click', () => {
  closeWorkspaceMenu();
  $('#create-workspace-form').reset();
  $('#create-workspace-error').textContent = '';
  $('#create-workspace-dialog').showModal();
  setTimeout(() => $('#create-workspace-name').focus(), 0);
});

$('#btn-cancel-create-workspace').addEventListener('click', () => $('#create-workspace-dialog').close());
$('#create-workspace-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('#create-workspace-name').value.trim();
  if (!name) {
    $('#create-workspace-error').textContent = 'Enter a workspace name.';
    return;
  }
  try {
    const workspace = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
    authState.workspaces = [
      ...authState.workspaces.filter((item) => item.id !== workspace.id),
      workspace,
    ];
    authState.activeWorkspaceId = workspace.id;
    saveAuthState();
    $('#create-workspace-dialog').close();
    renderWorkspaceUI();
    loadWorkspaceData();
    toast(`Created ${workspace.name}`);
  } catch (error) {
    $('#create-workspace-error').textContent = error.message;
  }
});

$('#btn-open-join-team').addEventListener('click', () => {
  closeWorkspaceMenu();
  $('#join-team-form').reset();
  $('#join-team-error').textContent = '';
  $('#join-team-dialog').showModal();
  setTimeout(() => $('#join-team-code').focus(), 0);
});

$('#btn-cancel-join-team').addEventListener('click', () => $('#join-team-dialog').close());
$('#join-team-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const result = joinTeam($('#join-team-code').value);
  $('#join-team-error').textContent = result.error || '';
  if (!result.error) $('#join-team-dialog').close();
});

$('#btn-open-access').addEventListener('click', () => {
  closeWorkspaceMenu();
  navigate('access');
});

$('#btn-sign-out').addEventListener('click', async () => {
  closeWorkspaceMenu();
  if (!authDisabled) {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* signed out here either way */ }
  }
  forgetAuthState();
  authState = null;
  serverAuth = null;
  pendingUser = null;
  showLogin();
});

async function bootAuth() {
  let state;
  try {
    state = await api('/api/auth/state');
  } catch (error) {
    showLogin(`The server did not answer: ${error.message}`);
    return;
  }
  authDisabled = state.auth === false;
  if (authDisabled) {
    const stored = readAuthState();
    if (stored) {
      authState = stored;
      serverAuth = { account: { username: stored.user.username, name: stored.user.name, role: 'admin', teams: ['*'] }, teams: [] };
      enterApp();
    } else showLogin();
    return;
  }
  if (state.signedIn) {
    signedIn(state, readAuthState()?.persistence || 'local');
    return;
  }
  if (state.setupRequired) {
    showAuthView();
    showAuthStep(state.canSetup ? 'setup' : 'nosetup');
    if (state.canSetup) setTimeout(() => $('#setup-username').focus(), 0);
    return;
  }
  showLogin();
}

/* ----------------------------- navigation ------------------------------- */

/**
 * Two levels: a section in the header, its tabs in the strip below. The
 * grouping follows what you do with knowledge rather than what the service
 * implements (docs/design/20) — material comes in (Library), you look things
 * up in it (Explore: what matches, an answer, a set of pages), knowledge grows
 * out of it (Knowledge), and the work behind all of it runs (Tasks).
 */
const NAV = [
  { id: 'library', title: 'Library', tabs: [
    { id: 'files', title: 'Files', hint: 'Browse, edit and import knowledge' },
  ] },
  { id: 'explore', title: 'Explore', tabs: [
    { id: 'search', title: 'Search', hint: 'What a query matches: passages by channel, the entities it names, their relations and claims' },
    { id: 'ask', title: 'Ask', hint: 'An agent that answers from your workspace' },
    // a topic researched into several pages: refine it, collect sources, write and review the pages
    { id: 'studies', title: 'Research', hint: 'Research a topic into several wiki pages' },
  ] },
  { id: 'knowledge', title: 'Knowledge', tabs: [
    { id: 'graph', title: 'Graph', hint: 'Entities, relations, and claims' },
    { id: 'entities', title: 'Entities', hint: 'Every entity, filtered and sorted' },
    { id: 'wiki', title: 'Wiki', hint: 'Pages researched by agent CLIs' },
  ] },
  { id: 'tasks', title: 'Tasks', tabs: [
    { id: 'queue', title: 'Queue', hint: 'The pipeline, the calls out now and who holds them, workers, jobs and the schedule' },
    { id: 'dream', title: 'Dream', hint: 'The nightly review of agent traces, and its suggestions' },
  ] },
  // Settings in the order knowledge moves: processed as it comes in (Ingest),
  // researched into the wiki (Research, and the Sources a study may use), used
  // to answer (Ask). Ids keep their first names, so `pipeline` is titled
  // Ingest; Ask's settings are `chat`, the config block they edit, because
  // `ask` is the Ask view itself.
  { id: 'settings', title: 'Settings', tabs: [
    { id: 'providers', title: 'Providers & Agents', hint: 'Endpoints, credentials, and who does the work' },
    { id: 'pipeline', title: 'Ingest', hint: 'How documents get processed' },
    { id: 'research', title: 'Research', hint: 'How the wiki gets written' },
    { id: 'sources', title: 'Sources', hint: 'The web, your APIs, MCP servers and sites a study may use' },
    { id: 'chat', title: 'Ask', hint: 'How questions get answered' },
    { id: 'playbooks', title: 'Playbooks', hint: 'Prompts, templates and vocabularies knode-os works from' },
    { id: 'workspace', title: 'Workspace', hint: 'Clear this workspace' },
    { id: 'access', title: 'Access', hint: 'Your account; users and gateways of this server' },
  ] },
];

/**
 * Which `<section class="tab">` shows a tab. Settings' tabs share one host:
 * keying identity and loaders on the leaf instead would re-run
 * `loadConfigForm()` on every sub-tab click and throw away unsaved routes.
 */
const TAB_HOST = { providers: 'settings', pipeline: 'settings', research: 'settings', chat: 'settings', playbooks: 'settings', workspace: 'settings' };
const hostOf = (tab) => TAB_HOST[tab] ?? tab;

/**
 * Tabs that used to exist, so a stored navigation still lands somewhere.
 * `agents` was folded into `providers`: an agent runs on a provider from the
 * table above it, and the two were never separable but in the tab strip.
 * `traces` became the list at the foot of Dream, the job that reads them.
 */
const NAV_ALIAS = { agents: 'providers', traces: 'dream' };
const aliasOf = (tab) => NAV_ALIAS[tab] ?? tab;

/** The last arrival's load of Ask and of Research: what a question or a topic sent from the search box waits for. */
let chatLoaded = null;
let studiesLoaded = null;

/** What a host view loads when you arrive at it. */
const TAB_LOAD = {
  search: () => paintSearchArrival(),
  queue: () => startTasksPolling(),
  dream: () => loadDream(),
  wiki: () => loadResearch(),
  // kept, so a question or a topic sent from the search box waits for the list it lands in
  studies: () => (studiesLoaded = loadStudies()),
  sources: () => loadSources(),
  ask: () => (chatLoaded = loadChat()),
  settings: () => loadConfigForm(),
  access: () => loadAccess(),
  // the box may hold a name another view put there (exploreEntity): arrival runs it
  graph: () => { if (!graphState.loaded) loadGraph($('#graph-q').value.trim()); },
  entities: () => loadEntities(),
};

/** What a tab inside a shared host loads each time it is shown: Playbooks lists the files again. */
const SUBTAB_LOAD = {
  playbooks: () => loadPlaybooks(),
};

const NAV_KEY = 'knode-os.nav.v1';
const sectionOf = (tab) => NAV.find((s) => s.tabs.some((t) => t.id === tab));
let currentTab = 'files';
const lastTab = Object.fromEntries(NAV.map((s) => [s.id, s.tabs[0].id]));

function restoreNav() {
  try {
    const saved = JSON.parse(localStorage.getItem(NAV_KEY) ?? '{}');
    for (const [section, raw] of Object.entries(saved.lastTab ?? {})) {
      const tab = aliasOf(raw);
      if (sectionOf(tab)?.id === section) lastTab[section] = tab;
    }
    // these ids will move again; an unknown one just means the default
    const tab = aliasOf(saved.tab);
    return sectionOf(tab) ? tab : currentTab;
  } catch {
    return currentTab;
  }
}

function persistNav() {
  try {
    localStorage.setItem(NAV_KEY, JSON.stringify({ tab: currentTab, lastTab }));
  } catch {
    /* private window, blocked storage — navigation still works, it just forgets */
  }
}

function renderSubtabs(section) {
  const el = $('#subtabs');
  // one tab is not a choice: Ask renders no strip at all
  el.innerHTML = section.tabs.length < 2 ? '' : section.tabs
    .map((t) => `<button type="button" data-tab="${t.id}" title="${esc(t.hint)}"${t.id === currentTab ? ' class="active"' : ''}>${esc(t.title)}</button>`)
    .join('');
}

/**
 * Search's scope follows the folder picked in the file tree — the reason the
 * two live in the same section. `sources` is a path prefix the API already
 * takes, so this is a filter, not a second kind of search.
 */
function paintSearchScope() {
  const select = $('#search-scope');
  const dir = selectedDir;
  const previous = select.value;
  select.innerHTML = '<option value="">Whole base</option>'
    + ['raw/docs', 'raw/traces', 'wiki', ...(dir && !['raw/docs', 'raw/traces', 'wiki'].includes(dir) ? [dir] : [])]
      .map((d) => `<option value="${esc(d)}">${esc(d)}/</option>`).join('');
  select.value = [...select.options].some((o) => o.value === previous) ? previous : '';
}

/** The only way to change tabs. */
function navigate(tab) {
  const section = sectionOf(tab);
  if (!section) return;
  const previousTab = currentTab;
  const previousHost = hostOf(currentTab);
  const host = hostOf(tab);
  currentTab = tab;
  lastTab[section.id] = tab;
  persistNav();

  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.section === section.id);
  renderSubtabs(section);
  for (const el of document.querySelectorAll('.tab')) el.classList.toggle('active', el.id === `tab-${host}`);
  for (const el of document.querySelectorAll('.settings-section[data-subtab]')) el.hidden = el.dataset.subtab !== tab;

  // leaving Ask stops its polling — as its own statement, not as the `else` of
  // an unrelated `if`, which is how this used to silently fire everywhere
  if (previousHost === 'ask' && host !== 'ask') stopChatPolling();
  if (previousHost === 'queue' && host !== 'queue') stopTasksPolling();
  closeGlobalSearch();
  if (host !== previousHost) TAB_LOAD[host]?.();
  if (tab !== previousTab || host !== previousHost) SUBTAB_LOAD[tab]?.();
}

/** Picking a section returns to the tab it was left at, not to its first one. */
function navigateSection(id) {
  navigate(lastTab[id] ?? NAV.find((s) => s.id === id)?.tabs[0].id);
}

$('#tabs').addEventListener('click', (event) => {
  const button = event.target.closest?.('button[data-section]');
  if (button) navigateSection(button.dataset.section);
});
$('#subtabs').addEventListener('click', (event) => {
  const button = event.target.closest?.('button[data-tab]');
  if (button) navigate(button.dataset.tab);
});

/* ------------------------------- access -------------------------------- */

/**
 * Account & access: your password and sessions, and — for an administrator —
 * the users of this server and the local services it publishes under /gw.
 * Everything goes through /api/auth, and the server enforces all of it; this
 * page only draws what it is told.
 */

const API_GROUP_LABELS = {
  files: 'Files', search: 'Search', ask: 'Ask', knowledge: 'Knowledge', ingest: 'Ingest',
  traces: 'Traces', datasources: 'Datasources', settings: 'Settings', gateway: 'Gateways',
};
const MEMBER_REMOTE_DEFAULT = ['files', 'search', 'ask', 'knowledge', 'ingest', 'traces'];
let accessUsers = null;
let editingUser = null;

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const csvList = (value) => String(value || '').split(',').map((v) => v.trim()).filter(Boolean);

async function loadAccess() {
  const admin = document.querySelectorAll('.admin-only');
  if (authDisabled) {
    $('#access-summary').textContent = 'Sign-in is off on this server (development): there are no accounts here.';
    admin.forEach((el) => { el.hidden = true; });
    return;
  }
  try {
    const me = await api('/api/auth/me');
    serverAuth = { ...serverAuth, ...me };
    renderAccount(me);
    renderSessions(await api('/api/auth/sessions'));
    const isAdmin = me.account.role === 'admin' && me.groups?.settings;
    admin.forEach((el) => { el.hidden = !isAdmin; });
    if (isAdmin) await loadAdmin();
  } catch (error) {
    toast(`Could not load access: ${error.message}`, 5000);
  }
}

function renderAccount(me) {
  const a = me.account;
  $('#access-summary').textContent = `Signed in as ${a.name || a.username} (@${a.username}), ${me.local ? 'on this machine' : 'from another machine'}.`;
  $('#access-role').textContent = a.role === 'admin' ? 'administrator' : a.readOnly ? 'member, read-only — you may look, not change anything' : 'member';
  $('#access-groups').innerHTML = Object.entries(me.groups || {})
    .map(([group, ok]) => `<span class="access-chip${ok ? ' ok' : ''}" title="${esc(me.apiGroups?.[group] || '')}">${ok ? '✓' : '✕'} ${esc(API_GROUP_LABELS[group] || group)}</span>`)
    .join('');
  const gateways = me.gateways || [];
  $('#access-gateways-mine').innerHTML = gateways.length
    ? `<div class="cfg-card-title"><b>Gateways you may use</b></div>${gateways.map((g) => `<p class="hint"><a href="${esc(g.path)}" target="_blank" rel="noopener">${esc(g.path)}</a> ${esc(g.description)}</p>`).join('')}`
    : '';
}

function renderSessions(list) {
  $('#access-sessions').innerHTML = list.map((s) => `<div class="access-row">
      <span><b>${esc(s.label)}</b>${s.current ? ' <span class="section-badge">this one</span>' : ''}<small>${esc(s.kind)} · since ${esc(when(s.createdAt))} · last used ${esc(when(s.lastSeenAt))}${s.ip ? ` · ${esc(s.ip)}` : ''}</small></span>
      ${s.current ? '' : `<button type="button" class="ghost" data-end-session="${esc(s.id)}">End</button>`}
    </div>`).join('') || '<p class="hint">No sessions.</p>';
}

$('#access-sessions').addEventListener('click', async (event) => {
  const id = event.target.closest?.('[data-end-session]')?.dataset.endSession;
  if (!id) return;
  try {
    await api(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    loadAccess();
  } catch (error) {
    toast(error.message);
  }
});

$('#btn-signout-others').addEventListener('click', async () => {
  try {
    await api('/api/auth/signout-others', { method: 'POST', body: '{}' });
    toast('Signed out everywhere else');
    loadAccess();
  } catch (error) {
    toast(error.message);
  }
});

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const current = $('#password-current').value;
  const password = $('#password-new').value;
  if (password.length < 8) {
    $('#password-error').textContent = 'Passwords need at least 8 characters.';
    return;
  }
  if (password !== $('#password-confirm').value) {
    $('#password-error').textContent = 'The new passwords do not match.';
    return;
  }
  try {
    // the answer carries a new session cookie: this browser stays signed in, every other session ends
    await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ current, password }) });
    $('#password-form').reset();
    $('#password-error').textContent = '';
    toast('Password changed — your other sessions have ended');
    loadAccess();
  } catch (error) {
    $('#password-error').textContent = error.message;
  }
});

async function loadAdmin() {
  const [users, gateways] = await Promise.all([api('/api/auth/users'), api('/api/auth/gateways')]);
  accessUsers = users;
  renderUsers(users);
  renderGateways(gateways);
}

function renderUsers(data) {
  const me = serverAuth?.account?.username;
  $('#access-users').innerHTML = data.users.map((u) => `<tr${u.disabled ? ' class="disabled"' : ''}>
      <td><b>${esc(u.username)}</b>${u.name && u.name !== u.username ? `<small>${esc(u.name)}</small>` : ''}${u.disabled ? '<small class="bad">disabled</small>' : ''}</td>
      <td>${u.role === 'admin' ? 'administrator' : 'member'}${u.readOnly ? '<small>read-only</small>' : ''}</td>
      <td>${u.role === 'admin' ? 'all' : esc(u.teams.join(', ') || '—')}</td>
      <td>${u.remoteApis.includes('*') ? 'everything' : esc(u.remoteApis.map((g) => API_GROUP_LABELS[g] || g).join(', ') || 'nothing')}</td>
      <td>${u.role === 'admin' ? 'all' : esc(u.gateways.join(', ') || '—')}</td>
      <td>${u.sessions.count}${u.sessions.lastSeenAt ? `<small>${esc(when(u.sessions.lastSeenAt))}</small>` : ''}</td>
      <td class="row-actions"><button type="button" class="ghost" data-edit-user="${esc(u.username)}">Edit</button>${u.username === me || !u.sessions.count ? '' : `<button type="button" class="ghost" data-signout-user="${esc(u.username)}">Sign out</button>`}</td>
    </tr>`).join('');
}

function renderRemoteChecks(selected, groups) {
  const all = selected.includes('*');
  $('#user-remote-apis').innerHTML = `<label class="check-row"><input type="checkbox" id="user-remote-all"${all ? ' checked' : ''} /> Everything the role allows</label>`
    + Object.entries(groups).map(([group, description]) => `<label class="check-row" title="${esc(description)}"><input type="checkbox" data-group="${esc(group)}"${all || selected.includes(group) ? ' checked' : ''}${all ? ' disabled' : ''} /> ${esc(API_GROUP_LABELS[group] || group)}</label>`).join('');
}

$('#user-remote-apis').addEventListener('change', (event) => {
  if (event.target.id !== 'user-remote-all') return;
  for (const box of document.querySelectorAll('#user-remote-apis input[data-group]')) {
    box.disabled = event.target.checked;
    if (event.target.checked) box.checked = true;
  }
});

function openUserDialog(username) {
  const u = username ? accessUsers?.users.find((x) => x.username === username) : null;
  editingUser = u?.username || null;
  const self = Boolean(u && u.username === serverAuth?.account?.username);
  $('#user-dialog-title').textContent = u ? `Edit ${u.username}` : 'Add a user';
  $('#user-dialog-hint').textContent = self
    ? 'Your own password, role and sign-in are changed under Account, or by another administrator.'
    : 'They sign in with this username and password, here or from the other machines you allow.';
  $('#user-username').value = u?.username || '';
  $('#user-username').disabled = Boolean(u);
  $('#user-name').value = u?.name || '';
  $('#user-password').value = '';
  $('#user-password-label').textContent = u ? 'New password (empty keeps the current one)' : 'Password';
  $('#user-password').disabled = self;
  $('#user-role').value = u?.role || 'member';
  $('#user-role').disabled = self;
  $('#user-readonly').checked = Boolean(u?.readOnly);
  $('#user-readonly-row').hidden = $('#user-role').value === 'admin';
  $('#user-teams').value = (u?.teams || []).join(', ');
  $('#user-gateways').value = (u?.gateways || []).join(', ');
  $('#user-disabled').checked = Boolean(u?.disabled);
  $('#user-disabled-row').hidden = !u || self;
  renderRemoteChecks(u ? u.remoteApis : MEMBER_REMOTE_DEFAULT, accessUsers?.apiGroups || {});
  $('#btn-delete-user').hidden = !u || self;
  $('#user-error').textContent = '';
  $('#user-dialog').showModal();
  setTimeout(() => (u ? $('#user-name') : $('#user-username')).focus(), 0);
}

$('#btn-add-user').addEventListener('click', () => openUserDialog(null));
// an administrator is never read-only
$('#user-role').addEventListener('change', () => { $('#user-readonly-row').hidden = $('#user-role').value === 'admin'; });
$('#btn-cancel-user').addEventListener('click', () => $('#user-dialog').close());

$('#access-users').addEventListener('click', async (event) => {
  const edit = event.target.closest?.('[data-edit-user]')?.dataset.editUser;
  if (edit) {
    openUserDialog(edit);
    return;
  }
  const signout = event.target.closest?.('[data-signout-user]')?.dataset.signoutUser;
  if (!signout || !confirm(`End every session of ${signout}? They sign in again with their password.`)) return;
  try {
    const { ended } = await api(`/api/auth/users/${encodeURIComponent(signout)}/signout`, { method: 'POST', body: '{}' });
    toast(`${signout}: ${ended} session${ended === 1 ? '' : 's'} ended`);
    loadAdmin();
  } catch (error) {
    toast(error.message);
  }
});

$('#user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const all = $('#user-remote-all')?.checked;
  const remoteApis = all ? ['*'] : [...document.querySelectorAll('#user-remote-apis input[data-group]:checked')].map((box) => box.dataset.group);
  const body = {
    name: $('#user-name').value.trim(),
    role: $('#user-role').value,
    teams: csvList($('#user-teams').value),
    gateways: csvList($('#user-gateways').value),
    remoteApis,
    readOnly: $('#user-role').value === 'member' && $('#user-readonly').checked,
  };
  const password = $('#user-password').value;
  try {
    if (editingUser) {
      const self = editingUser === serverAuth?.account?.username;
      if (self) delete body.role;
      else body.disabled = $('#user-disabled').checked;
      if (password && !self) {
        if (password.length < 8) throw new Error('Passwords need at least 8 characters.');
        body.password = password;
      }
      await api(`/api/auth/users/${encodeURIComponent(editingUser)}`, { method: 'PATCH', body: JSON.stringify(body) });
      toast(`Saved ${editingUser}${body.password || body.disabled ? ' — their sessions ended' : ''}`);
    } else {
      if (password.length < 8) throw new Error('Passwords need at least 8 characters.');
      const created = await api('/api/auth/users', { method: 'POST', body: JSON.stringify({ ...body, username: normalizeUsername($('#user-username').value), password }) });
      toast(`Created ${created.username}`);
    }
    $('#user-dialog').close();
    loadAdmin();
  } catch (error) {
    $('#user-error').textContent = error.message;
  }
});

$('#btn-delete-user').addEventListener('click', async () => {
  if (!editingUser || !confirm(`Remove ${editingUser}? Their workspaces stay on disk under users/${editingUser}.`)) return;
  try {
    await api(`/api/auth/users/${encodeURIComponent(editingUser)}`, { method: 'DELETE' });
    $('#user-dialog').close();
    toast(`Removed ${editingUser}`);
    loadAdmin();
  } catch (error) {
    $('#user-error').textContent = error.message;
  }
});

function renderGateways(list) {
  $('#access-gateways').innerHTML = list.map((g) => `<tr>
      <td class="mono">${esc(g.id)}</td>
      <td class="mono">${esc(g.target)}${g.sandbox === false ? ' <small class="bad">unsandboxed</small>' : ''}</td>
      <td>${esc(g.description || '')}</td>
      <td class="row-actions"><a class="ghost" href="/gw/${encodeURIComponent(g.id)}/" target="_blank" rel="noopener">Open</a><button type="button" class="ghost" data-remove-gateway="${esc(g.id)}">Remove</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="hint">No gateways yet.</td></tr>';
}

$('#gateway-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    id: $('#gateway-id').value.trim().toLowerCase(),
    target: $('#gateway-target').value.trim(),
    description: $('#gateway-description').value.trim(),
    sandbox: $('#gateway-sandbox').checked,
  };
  try {
    await api('/api/auth/gateways', { method: 'POST', body: JSON.stringify(body) });
    $('#gateway-form').reset();
    $('#gateway-sandbox').checked = true;
    $('#gateway-error').textContent = '';
    toast(`Published /gw/${body.id}/`);
    loadAdmin();
  } catch (error) {
    $('#gateway-error').textContent = error.message;
  }
});

$('#access-gateways').addEventListener('click', async (event) => {
  const id = event.target.closest?.('[data-remove-gateway]')?.dataset.removeGateway;
  if (!id || !confirm(`Stop publishing /gw/${id}/?`)) return;
  try {
    await api(`/api/auth/gateways/${encodeURIComponent(id)}`, { method: 'DELETE' });
    loadAdmin();
  } catch (error) {
    toast(error.message);
  }
});

/* ------------------------------- stats --------------------------------- */

/** The last /api/stats: the Tasks header counts and the header's Tasks badge read it. */
let lastStats = null;

async function loadStats() {
  try {
    const s = await api('/api/stats');
    lastStats = s;
    const cell = (n, label) => `<div class="metric"><b>${Number(n ?? 0).toLocaleString()}</b><span>${label}</span></div>`;
    $('#tasks-stats').innerHTML = cell(s.documents, 'documents') + cell(s.chunks, 'chunks') + cell(s.entities, 'entities') + cell(s.relations, 'relations') + cell(s.traces, 'traces');
    paintTasksBadge(s);
  } catch { /* server still starting */ }
  loadProcessing();
  void loadContentLanguages();
}

/* ------------------------------- notices ------------------------------- */

/**
 * Notices: what this workspace needs a person to know (src/server/notices.ts)
 * — the lint report and the datasource failures the file tree no longer
 * shows, trace collection waiting for a yes, a purpose nobody wrote, a wiki
 * never initialized. The service sends data; the words, and the one action
 * each kind offers, are this page's. A dismissal holds until the notice
 * changes (its key), per workspace.
 */
const NOTICES_KEY = 'knode-os.notices.dismissed.v1';
const NOTICE_REFRESH_MS = 5 * 60 * 1000;
let notices = [];
let noticesTimer = null;
let showDismissedNotices = false;
const dismissedNotices = (() => {
  try {
    return JSON.parse(localStorage.getItem(NOTICES_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
})();

/** Lint finding kinds in words, singular and plural. */
const LINT_KINDS = {
  orphan: ['page nothing links to', 'pages nothing links to'],
  broken_link: ['broken link', 'broken links'],
  stale_research: ['research page due for a refresh', 'research pages due for a refresh'],
  unreviewed: ['unreviewed research page', 'unreviewed research pages'],
  expired: ['expired page', 'expired pages'],
  superseded_text: ['superseded statement', 'superseded statements'],
  open_dispute: ['page with open disputes', 'pages with open disputes'],
};

const noticeScope = () => {
  const workspace = activeWorkspace();
  return workspace ? `${workspace.kind}/${workspace.id}` : 'default';
};
const isDismissed = (notice) => dismissedNotices[noticeScope()]?.[notice.id] === notice.key;
/** Whether this account may use an API group; with sign-in off, everything is allowed. */
const mayUse = (group) => authDisabled || !serverAuth?.groups || serverAuth.groups[group] === true;
const count = (n, [one, many]) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function dismissNotice(notice) {
  const scope = noticeScope();
  dismissedNotices[scope] = { ...(dismissedNotices[scope] ?? {}), [notice.id]: notice.key };
  try {
    localStorage.setItem(NOTICES_KEY, JSON.stringify(dismissedNotices));
  } catch {
    /* blocked storage: dismissed until the page reloads */
  }
  paintNotices();
}

async function loadNotices() {
  try {
    notices = (await api('/api/notices')).notices ?? [];
  } catch {
    notices = []; // an older service, or an account without the search group: nothing to say
  }
  paintNotices();
}

/** A notice in words: a title, a body, and its action (`group` is the API group the action needs). */
function noticeText(notice) {
  switch (notice.id) {
    case 'lint': {
      const { summary, previous } = notice;
      const kinds = Object.entries(summary.counts).filter(([, n]) => n > 0).map(([kind, n]) => (LINT_KINDS[kind] ? count(n, LINT_KINDS[kind]) : `${n.toLocaleString()} ${kind}`));
      const change = previous ? summary.findings - previous.summary.findings : 0;
      const since = previous && change !== 0 ? ` (${change > 0 ? '+' : '−'}${Math.abs(change).toLocaleString()} since ${previous.date})` : '';
      return {
        title: `Wiki check: ${summary.findings.toLocaleString()} findings across ${summary.pages.toLocaleString()} pages${since}`,
        body: `${kinds.join(' · ')}. From the report of ${notice.date}.`,
        action: { label: 'Open report', group: 'files' },
      };
    }
    case 'traces-off':
      return {
        title: "Agent traces aren't collected here",
        body: `The nightly review learns from your Claude Code and Codex sessions, but this workspace has none. Collecting copies ${notice.sessions.toLocaleString()} sessions (${fmtBytes(notice.bytes)}) from this Mac into raw/traces and keeps adding new ones.`,
        action: { label: 'Collect traces', group: 'traces' },
      };
    case 'purpose':
      return {
        title: 'Say what this workspace is for',
        body: 'purpose.md is still the template. The wiki generator and the nightly review read it to decide what matters.',
        action: { label: 'Edit purpose.md', group: 'files' },
      };
    case 'initialize': {
      const missing = !notice.overview && !notice.guide ? 'No overview or agent guide yet.' : !notice.overview ? 'No overview yet.' : 'No agent guide yet.';
      return {
        title: "This workspace isn't initialized",
        body: `${missing} Initializing runs an agent that writes them, then queues topic pages.`,
        action: { label: 'Go to Initialize', group: 'knowledge' },
      };
    }
    case 'datasources':
      return {
        title: 'Datasources failed on the last sync',
        body: `${notice.errors.slice(0, 3).join(' · ')}${notice.errors.length > 3 ? ` · and ${notice.errors.length - 3} more` : ''}. Their dataset pages may be stale.`,
        action: { label: 'Retry', group: 'datasources' },
      };
    default:
      return null; // a kind this page does not know yet
  }
}

function paintNotices() {
  const button = $('#notices-toggle');
  const known = notices.map((notice) => ({ notice, text: noticeText(notice) })).filter((n) => n.text);
  const open = known.filter((n) => !isDismissed(n.notice));
  const dismissed = known.filter((n) => isDismissed(n.notice));
  button.hidden = known.length === 0;
  button.textContent = open.length ? `⚑ ${open.length} ${open.length === 1 ? 'notice' : 'notices'}` : '⚑ notices';
  button.classList.toggle('has-open', open.length > 0);
  button.classList.toggle('warn', open.some((n) => n.notice.level === 'warn'));
  if (known.length === 0) closeNotices();

  const shown = showDismissedNotices ? [...open, ...dismissed] : open;
  const item = ({ notice, text }) => {
    const gone = isDismissed(notice);
    return `<article class="notice ${esc(notice.level)}${gone ? ' dismissed' : ''}" data-notice="${esc(notice.id)}">
      <b>${esc(text.title)}</b>
      <p>${esc(text.body)}</p>
      <div class="notice-actions">
        <button type="button" data-run="${esc(notice.id)}"${mayUse(text.action.group) ? '' : ` disabled title="your account cannot use ${esc(API_GROUP_LABELS[text.action.group] ?? text.action.group)}"`}>${esc(text.action.label)}</button>
        ${gone ? '' : `<button type="button" class="quiet" data-dismiss="${esc(notice.id)}">Dismiss</button>`}
      </div>
    </article>`;
  };
  $('#notices-panel').innerHTML = (shown.length ? shown.map(item).join('') : '<p class="hint">Nothing needs you right now.</p>')
    + (dismissed.length ? `<button type="button" class="notices-more" data-toggle-dismissed>${showDismissedNotices ? 'Hide dismissed' : `Show ${dismissed.length} dismissed`}</button>` : '');
}

function closeNotices() {
  $('#notices-panel').hidden = true;
  $('#notices-toggle').setAttribute('aria-expanded', 'false');
}

async function runNotice(notice) {
  try {
    switch (notice.id) {
      case 'lint':
        closeNotices();
        navigate('files');
        await openFile(notice.report);
        break;
      case 'purpose':
        closeNotices();
        navigate('files');
        await openFile('purpose.md');
        if (currentFile === 'purpose.md' && !editing && !$('#btn-edit').disabled) $('#btn-edit').click();
        break;
      case 'initialize':
        closeNotices();
        navigate('wiki');
        break;
      case 'traces-off': {
        if (!confirm(`Copy ${notice.sessions.toLocaleString()} sessions (${fmtBytes(notice.bytes)}) from this Mac into this workspace? New sessions keep arriving after this.`)) return;
        const res = await api('/api/traces/sync', { method: 'POST' });
        toast(`collected ${res.copied} traces and ${res.skills} skill files`);
        loadStats();
        await loadNotices();
        break;
      }
      case 'datasources': {
        const res = await api('/api/datasources/sync', { method: 'POST' });
        toast(res.errors?.length ? `${res.errors.length} datasource errors remain` : 'datasources synced');
        await loadNotices();
        break;
      }
    }
  } catch (error) {
    toast(`could not ${noticeText(notice)?.action.label.toLowerCase() ?? 'do that'}: ${error.message}`);
  }
}

$('#notices-toggle').addEventListener('click', (event) => {
  event.stopPropagation();
  const panel = $('#notices-panel');
  panel.hidden = !panel.hidden;
  $('#notices-toggle').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) closeWorkspaceMenu();
});

$('#notices-panel').addEventListener('click', (event) => {
  event.stopPropagation();
  const target = event.target.closest?.('button');
  if (!target) return;
  if (target.hasAttribute('data-toggle-dismissed')) {
    showDismissedNotices = !showDismissedNotices;
    paintNotices();
    return;
  }
  const notice = notices.find((n) => n.id === (target.dataset.run ?? target.dataset.dismiss));
  if (!notice) return;
  if (target.dataset.dismiss) dismissNotice(notice);
  else runNotice(notice);
});

document.addEventListener('click', closeNotices);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeNotices();
});

/* ----------------------------- processing ------------------------------ */

/**
 * Extraction, reviews, summaries and translations start with the service in
 * every workspace, within the server's limits. An administrator may stop a
 * workspace's here (or in the app); it stays stopped until someone starts it
 * again or the service restarts.
 */
let processingStatus = null;

async function loadProcessing() {
  try {
    processingStatus = await api('/api/labeling/status');
  } catch {
    processingStatus = null;
  }
  paintProcessing();
}

/** Model calls out right now, every kind together, from the labeling status. */
function processingInFlight(status) {
  return ['scheduler', 'summaries', 'translations', 'judge'].reduce((n, key) => n + (status?.[key]?.leases?.length ?? 0), 0);
}

/**
 * The header pill says whether processing runs and how much is out; it opens
 * Tasks → Queue, where it is started and stopped (docs/design/20 D7).
 */
function paintProcessing() {
  const button = $('#processing-toggle');
  const state = processingStatus?.processing;
  button.hidden = !state;
  paintTasksBadge();
  if (!state) return;
  const queued = processingStatus.scheduler?.queued;
  const due = processingStatus.summaries?.due;
  const translations = processingStatus.translations?.enabled ? processingStatus.translations : null;
  const inFlight = processingInFlight(processingStatus);
  button.classList.toggle('running', state.running);
  button.textContent = state.running ? `● Processing${inFlight ? ` · ${inFlight} in flight` : ''}` : '○ Processing stopped';
  button.title = [
    state.running ? 'Extraction, reviews and summaries are running' : 'Extraction, reviews and summaries wait until someone starts them again, or the service restarts',
    queued === undefined ? '' : `${queued} documents waiting`,
    due ? `${due} summaries due` : '',
    translations?.due ? `${translations.due} translations into ${languageInEnglish(translations.primary)} due` : '',
    state.by && state.since ? `${state.running ? 'started' : 'stopped'} by ${state.by} at ${new Date(state.since).toLocaleTimeString()}` : '',
    'open Tasks to see the queue, start or stop',
  ].filter(Boolean).join(' · ');
}

$('#processing-toggle').addEventListener('click', () => navigate('queue'));

/** Start (after the estimate) or stop the processing — Tasks → Queue's switch. */
async function switchProcessing(on) {
  if (!on) {
    if (!confirm('Stop processing in this workspace? Calls in flight finish; nothing new starts here until someone starts it again or the service restarts.')) return;
    try {
      await api('/api/labeling/stop', { method: 'POST', body: '{}' });
      toast('Processing stopped — calls in flight finish');
    } catch (error) {
      toast(error.message, 5000);
    }
    loadProcessing();
    loadTasks();
    return;
  }
  // starting spends model calls: say how many, and what of each plan, first
  openEstimate({
    title: 'Start processing?',
    lede: 'Extraction of everything waiting, the duplicate reviews after it and the summary pages due — on this machine\'s slots, and on the remote workers taking work.',
    url: '/api/labeling/estimate',
    confirm: 'Start processing',
    run: async () => {
      await api('/api/labeling/start', { method: 'POST', body: '{}' });
      toast('Processing started: extraction, reviews and summaries');
      loadProcessing();
      loadTasks();
    },
  });
}

/* -------------------------------- tasks -------------------------------- */

/**
 * Tasks → Queue (docs/design/20): one read of everything the workspace has
 * under way — the pipeline by stage, the calls out now and who holds them,
 * this machine's backends and the remote workers, research and Ask jobs,
 * background syncs, and what runs on a clock. Polled while it is on screen.
 */
let tasksTimer = null;
let tasksSnapshot = null;
let tasksSeq = 0;
const TASKS_POLL_MS = 3000;

const STAGES = {
  index: { title: 'Index', icon: '⛁', about: 'convert, chunk and apply new and changed files' },
  embed: { title: 'Embed', icon: '◇', about: 'a vector for every chunk, for semantic search' },
  extract: { title: 'Extract', icon: '⌬', about: 'entities, relations and claims, by a model' },
  summarize: { title: 'Summarize', icon: '¶', about: 'one summary page per document' },
  translate: { title: 'Translate', icon: '文', about: 'into the primary content language' },
  review: { title: 'Review', icon: '⚖', about: 'judge calls: duplicate entities and claims' },
  evaluation: { title: 'Evaluation', icon: '◎', about: "evaluation runs' model calls and agent sessions, kept in serve's queue until a slot takes them and their run collects the result (the server's, shown in every workspace)" },
};
const UNIT_WORDS = { documents: ['document', 'documents'], chunks: ['chunk', 'chunks'], translations: ['translation', 'translations'], calls: ['call', 'calls'], pieces: ['piece', 'pieces'] };
const WORK_KIND_WORDS = { extract: 'Extract', summarize: 'Summarize', translate: 'Translate', judge: 'Review', embed: 'Embed', session: 'Research', 'eval-call': 'Eval call', 'eval-session': 'Eval agent' };
const JOB_KIND_WORDS = { study: 'Study', research: 'Page', init: 'Initialize', ask: 'Ask' };
const SCHEDULE_WORDS = {
  dream: ['Dream', 'reviews recent agent traces'],
  tier2: ['Tier-2 pass', 'merges, claim reviews, views and the wiki check'],
  traces: ['Agent traces', 'collects new Claude Code and Codex sessions'],
  datasources: ['Datasources', 'refreshes live schemas into the wiki'],
  feishu: ['Feishu documents', 'asks Feishu which linked documents and wiki pages were edited, and fetches those'],
  conversations: ['Agent conversations', 'adds new exchanges of followed Claude Code and Codex conversations once they go quiet'],
  codebases: ['Code repositories', 'fetches followed repositories again and indexes what changed'],
};
const ACTIVITY_ICONS = { sync: '⟳', ingest: '⛁', upload: '⤒', folder: '⇄', feishu: '⇅', conversations: '❝', feeds: '⇶', codebase: '⎇', traces: '⌁', datasources: '◫', dream: '☾', tier2: '⚙' };

/** "45 s", "3 min 10 s", "2 h 5 min". */
function spanText(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 && s < 600 ? ` ${s % 60} s` : ''}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h < 48 ? `${h} h${m ? ` ${m} min` : ''}` : `${Math.round(h / 24)} days`;
}
const agoText = (iso) => (iso ? `${spanText((Date.now() - Date.parse(iso)) / 1000)} ago` : 'never');
const untilText = (iso) => (iso ? `in ${spanText((Date.parse(iso) - Date.now()) / 1000)}` : '');

function startTasksPolling() {
  stopTasksPolling();
  loadTasks();
  tasksTimer = setInterval(() => { if (!document.hidden) loadTasks(); }, TASKS_POLL_MS);
}

function stopTasksPolling() {
  clearInterval(tasksTimer);
  tasksTimer = null;
}

async function loadTasks() {
  const seq = ++tasksSeq;
  try {
    const snapshot = await api('/api/tasks');
    if (seq !== tasksSeq) return;
    tasksSnapshot = snapshot;
    renderTasks(snapshot);
  } catch (e) {
    if (seq !== tasksSeq) return;
    $('#tasks-stages').innerHTML = `<p class="hint">The queue could not be read: ${esc(e.message)}</p>`;
  }
}

function renderTasks(t) {
  paintTasksProcessing(t);
  paintTasksStages(t);
  paintTasksInFlight(t);
  paintTasksWorkers(t);
  paintTasksJobs(t);
  paintTasksActivity(t);
  paintTasksSchedule(t);
  paintTasksErrors(t);
  wireTaskLinks($('#tab-queue'));
}

/** When a rest ends: the time today, with the day when it is not today (a plan's window may reset days out). */
function restingUntil(iso) {
  const at = new Date(iso);
  return at.toDateString() === new Date().toDateString()
    ? at.toLocaleTimeString()
    : at.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function paintTasksProcessing(t) {
  const el = $('#tasks-processing');
  if (!t.processing) {
    el.innerHTML = `<div class="tp-state"><span class="status-dot"></span><div><b>No processing here</b><p class="hint">${t.serving ? 'This workspace has no processing switch.' : 'Extraction and the other model stages run inside <span class="mono">knode-os serve</span>.'}</p></div></div>`;
    return;
  }
  const p = t.processing;
  const mayChange = authDisabled || serverAuth?.groups?.settings === true;
  const since = p.since ? new Date(p.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const line = p.running
    ? `Running${since ? ` since ${since}` : ''}${p.by ? `, started by ${esc(p.by)}` : ''}`
    : (since && p.by ? `Stopped at ${since} by ${esc(p.by)}, until someone starts it again or the service restarts` : 'Stopped');
  // the server's limits over this machine's slots (src/labeling/local.ts): calls at once, every workspace
  // together, and the plan quota background work leaves alone
  const max = p.calls?.max ?? 0;
  const here = p.calls?.workspace;
  const limits = [
    max > 0 ? `At most ${max} model call${max === 1 ? '' : 's'} at once on this machine, every workspace together (${p.calls.inFlight} now${here !== undefined ? `, ${here} of them here` : ''}).` : '',
    p.minQuotaPercent > 0 ? `Background work — processing, research, Dream and the tier-2 pass — stops while a Codex or Claude plan has less than ${p.minQuotaPercent}% left.` : '',
  ].filter(Boolean).join(' ');
  const holds = (p.quotaHolds ?? []).map((h) => `${esc(h.id)} rests${h.until ? ` until ${esc(restingUntil(h.until))}` : ''}: ${esc(h.reason)}`);
  el.innerHTML = `<div class="tp-state"><span class="status-dot${p.running ? ' live' : ''}"></span>
      <div><b>${p.running ? 'Processing' : 'Processing is stopped'}</b><p class="hint">${line}. ${p.running ? 'Extraction, reviews, summaries and translations take work as slots free up.' : 'Extraction, reviews, summaries and translations wait in this workspace until processing starts again.'}${limits ? ` ${limits}` : ''}</p>${holds.length ? `<p class="hint warn">${holds.join('<br>')}</p>` : ''}</div></div>
    <div class="tp-actions">
      ${mayChange ? '' : '<span class="hint">An administrator starts and stops processing.</span>'}
      <button type="button" id="btn-tasks-processing" class="${p.running ? 'danger-button' : 'primary'}"${mayChange ? '' : ' disabled'}>${p.running ? 'Stop processing' : 'Start processing…'}</button>
    </div>`;
  el.querySelector('#btn-tasks-processing')?.addEventListener('click', () => switchProcessing(!p.running));
}

function paintTasksStages(t) {
  const el = $('#tasks-stages');
  el.innerHTML = t.stages.map((st, i) => {
    const words = STAGES[st.id] ?? { title: st.id, icon: '•', about: '' };
    const unit = UNIT_WORDS[st.unit] ?? [st.unit, st.unit];
    const busy = st.inFlight > 0;
    const lines = [];
    if (!st.enabled) lines.push('<span class="hint">off for this workspace</span>');
    else {
      if (st.inFlight) lines.push(`<span><span class="status-dot live"></span>${st.inFlight.toLocaleString()} in flight</span>`);
      if (st.doneLastHour !== null || st.callsLastHour !== null) {
        const done = st.doneLastHour !== null ? `${st.doneLastHour.toLocaleString()} done` : '';
        const calls = st.callsLastHour ? `${st.callsLastHour.toLocaleString()} call${st.callsLastHour === 1 ? '' : 's'}` : '';
        lines.push(`<span class="hint">last hour: ${[done, calls].filter(Boolean).join(' · ') || 'nothing'}</span>`);
      }
      if (st.failed) lines.push(`<span class="bad">${st.failed.toLocaleString()} failed</span>`);
    }
    return `<div class="stage-card${st.enabled ? '' : ' off'}${busy ? ' busy' : ''}${st.waiting && st.note ? ' blocked' : ''}" title="${esc(words.about)}">
      <div class="stage-card-head"><span class="stage-icon">${words.icon}</span><b>${esc(words.title)}</b><span class="stage-step">${i + 1}</span></div>
      <div class="stage-big">${st.enabled ? st.waiting.toLocaleString() : '—'}<small>${st.enabled ? `${st.waiting === 1 ? unit[0] : unit[1]} waiting` : ''}</small></div>
      <div class="stage-lines">${lines.join('')}</div>
      ${st.note ? `<p class="stage-note">${esc(st.note)}</p>` : ''}
    </div>`;
  }).join('');
}

function paintTasksInFlight(t) {
  $('#tasks-inflight-count').textContent = t.inFlight.length ? String(t.inFlight.length) : '';
  const el = $('#tasks-inflight');
  if (!t.inFlight.length) {
    el.innerHTML = `<p class="hint">${t.processing?.running ? 'Nothing out right now — the slots are waiting for work.' : 'No model calls out.'}</p>`;
    return;
  }
  el.innerHTML = `<table class="tasks-table"><thead><tr><th>stage</th><th>document</th><th>part</th><th>worker</th><th class="num">running</th><th class="num">lease ends</th></tr></thead><tbody>
    ${t.inFlight.map((x) => `<tr>
      <td><span class="kind-pill k-${esc(x.kind)}">${esc(WORK_KIND_WORDS[x.kind] ?? x.kind)}</span></td>
      <td class="tasks-subject">${x.kind === 'judge' || x.kind === 'embed' || x.kind === 'session' || x.kind.startsWith('eval-') ? esc(x.subject) : `<a href="#" class="mono" data-open="${esc(x.subject)}">${esc(x.subject)}</a>`}</td>
      <td class="hint">${esc(x.detail ?? '')}</td>
      <td><span class="mono">${esc(x.backend)}</span>${x.remote ? ' <span class="tag remote">remote</span>' : ''}${x.class === 'eval' ? ' <span class="tag">evaluation</span>' : ''}<div class="hint mono tasks-worker-id">${esc(x.worker)}</div></td>
      <td class="num mono">${spanText(x.ageSeconds)}</td>
      <td class="num mono">${x.expiresInSeconds > 0 ? spanText(x.expiresInSeconds) : 'lapsed'}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function paintTasksWorkers(t) {
  const online = t.workers.filter((w) => w.online).length;
  $('#tasks-workers-count').textContent = t.workers.length ? `${online} of ${t.workers.length} online` : '';
  const el = $('#tasks-workers');
  if (!t.workers.length) {
    el.innerHTML = `<p class="hint">${!t.serving ? 'Workers run inside knode-os serve.'
      : t.processing && !t.processing.running ? "This machine's slots start with processing; remote workers appear here once they ask for work."
        : 'No model slots on this machine and no remote worker has asked for work. Slots come from the stage routes in Settings → Ingest; remote workers connect with a token (knode-os remote token create).'}</p>`;
    return;
  }
  el.innerHTML = t.workers.map((w) => {
    const paused = Boolean(w.pausedUntil);
    const state = paused ? 'paused' : w.online ? (w.busy ? 'busy' : 'idle') : 'offline';
    const load = w.slots !== null ? `${w.busy} of ${w.slots} slot${w.slots === 1 ? '' : 's'} busy` : `${w.busy} held`;
    return `<div class="worker-row">
      <span class="status-dot${w.online && !paused ? ' live' : ''}${paused ? ' warn' : ''}" title="${state}"></span>
      <div class="worker-main">
        <div><b class="mono">${esc(w.label)}</b> <span class="tag${w.remote ? ' remote' : ''}">${w.remote ? 'remote' : 'this machine'}</span>${w.pool ? ` <span class="tag" title="the pool this worker declared (knode-worker --pool)">pool ${esc(w.pool)}</span>` : ''}${w.kinds.length ? ` <span class="hint">${esc(w.kinds.map((k) => WORK_KIND_WORDS[k] ?? k).join(' · '))}</span>` : ''}</div>
        <div class="hint">${state} · ${load} · ${w.ok.toLocaleString()} ok${w.failed ? ` · <span class="bad">${w.failed.toLocaleString()} failed</span>` : ''}${w.remote ? ` · seen ${agoText(w.lastSeen)}` : ''}</div>
        ${w.remote ? `<div class="hint mono tasks-worker-id">${esc(w.id)}</div>` : ''}
        ${paused ? `<div class="hint warn">resting until ${esc(restingUntil(w.pausedUntil))}${w.pauseReason ? `: ${esc(w.pauseReason)}` : ''}</div>` : ''}
        ${w.lastError && !paused ? `<div class="hint bad">${esc(w.lastError)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function paintTasksJobs(t) {
  const live = t.jobs.filter((j) => ['queued', 'running', 'validating', 'waiting'].includes(j.status));
  $('#tasks-jobs-count').textContent = live.length ? `${live.length} under way` : '';
  const el = $('#tasks-jobs');
  if (!t.jobs.length) {
    el.innerHTML = '<p class="hint">No research, study or Ask turn is running, and none ended in the last day.</p>';
    return;
  }
  el.innerHTML = t.jobs.map((j) => {
    const when = j.finishedAt ? `ended ${agoText(j.finishedAt)}` : j.startedAt ? `started ${agoText(j.startedAt)}` : `queued ${agoText(j.createdAt)}`;
    const action = jobAction(j);
    return `<div class="job-row" data-job="${esc(j.id)}" data-kind="${esc(j.kind)}">
      <span class="kind-pill k-${esc(j.kind)}">${esc(JOB_KIND_WORDS[j.kind] ?? j.kind)}</span>
      <div class="job-main"><a href="#" class="job-title">${esc(j.title)}</a>
        <div class="hint">${j.pausedUntil ? pauseChip({ until: j.pausedUntil, reason: j.pauseReason ?? '' }) : statusChip(j.status)}${j.stage && j.kind !== 'ask' ? ` ${esc(j.stage)}` : ''} · ${when}${j.outputPath ? ` · <a href="#" class="mono" data-open="${esc(j.outputPath)}">${esc(baseName(j.outputPath))}</a>` : ''}</div>
        ${j.error ? `<div class="hint${j.pausedUntil ? '' : ' bad'}">${esc(j.error.slice(0, 220))}</div>` : ''}</div>
      ${action ? `<button type="button" class="row-action" data-job-action="${action.verb}">${action.label}</button>` : ''}
    </div>`;
  }).join('');
  el.querySelectorAll('[data-job-action]').forEach((b) => b.addEventListener('click', async () => {
    const row = b.closest('.job-row');
    const job = t.jobs.find((j) => j.id === row.dataset.job);
    if (!job) return;
    if (b.dataset.jobAction === 'cancel' && job.kind !== 'ask' && !confirm(`Cancel “${job.title}”? A running agent session is stopped.`)) return;
    b.disabled = true;
    try {
      await runJobAction(job, b.dataset.jobAction);
      toast(`${b.textContent.trim()}: ${job.title}`);
    } catch (e) {
      toast(e.message, 5000);
    }
    loadTasks();
  }));
  el.querySelectorAll('.job-row .job-title').forEach((a) => a.addEventListener('click', (ev) => {
    ev.preventDefault();
    const row = a.closest('.job-row');
    openJob(row.dataset.kind, row.dataset.job);
  }));
}

const LIVE_JOB = new Set(['queued', 'running', 'validating', 'waiting']);

/** What a job row offers: run now what waits out a pause, stop what runs, run again what failed — if this account may. */
function jobAction(job) {
  if (job.kind === 'ask') return job.status === 'running' && mayUse('ask') ? { verb: 'cancel', label: 'Stop' } : null;
  if (!mayUse('knowledge')) return null;
  if (job.pausedUntil) return { verb: 'resume', label: 'Resume now' };
  if (LIVE_JOB.has(job.status)) return { verb: 'cancel', label: 'Cancel' };
  if (job.status === 'failed' || job.status === 'cancelled') return { verb: 'retry', label: 'Retry' };
  return null;
}

async function runJobAction(job, verb) {
  if (job.kind === 'ask') return api(`/api/chat/conversations/${encodeURIComponent(job.id)}/cancel`, { method: 'POST' });
  const base = job.kind === 'study' ? '/api/research/studies' : '/api/research/jobs';
  return api(`${base}/${encodeURIComponent(job.id)}/${verb}`, { method: 'POST', body: '{}' });
}

/** Where a job lives: a study in Research, a page job in the wiki, an Ask turn in its conversation. */
async function openJob(kind, id) {
  if (kind === 'study') {
    navigate('studies');
    await studiesLoaded?.catch(() => {});
    openStudy(id);
  } else if (kind === 'ask') {
    navigate('ask');
    await chatLoaded?.catch(() => {});
    openConversation(id);
  } else {
    navigate('wiki');
  }
}

function paintTasksActivity(t) {
  const el = $('#tasks-activity');
  const running = t.activity.running;
  const recent = t.activity.recent.slice(0, 8);
  if (!running.length && !recent.length) {
    el.innerHTML = '<p class="hint">Nothing has run in the background since the service started.</p>';
    return;
  }
  el.innerHTML = `${running.map((a) => `<div class="activity-row running"><span class="activity-icon spin">${ACTIVITY_ICONS[a.kind] ?? '•'}</span><div><b>${esc(a.label)}</b><div class="hint">running for ${spanText((Date.now() - Date.parse(a.startedAt)) / 1000)}${a.progress ? ` · ${esc(a.progress)}` : ''}</div></div></div>`).join('')}
    ${recent.length ? `<details class="activity-recent"${running.length ? '' : ' open'}><summary class="hint">Recent · ${recent.length}</summary>
      ${recent.map((a) => `<div class="activity-row${a.ok ? '' : ' failed'}"><span class="activity-icon">${a.ok ? '✓' : '✕'}</span><div><span>${esc(a.label)}</span><div class="hint">${a.detail ? `${esc(a.detail)} · ` : ''}${agoText(a.finishedAt)} · took ${spanText((Date.parse(a.finishedAt) - Date.parse(a.startedAt)) / 1000)}</div></div></div>`).join('')}
    </details>` : ''}`;
}

function paintTasksSchedule(t) {
  const rows = t.scheduled.map((x) => {
    const [title, about] = SCHEDULE_WORDS[x.id] ?? [x.id, ''];
    let when = !x.enabled ? 'off' : x.at ? `daily at ${x.at}${x.next ? ` · ${untilText(x.next)}` : ''}` : x.everyMinutes ? `every ${x.everyMinutes} min` : '';
    if (x.last) when += ` · last ${agoText(x.last)}`;
    // the Feishu check also runs when asked: whoever may sync the files may ask
    const checkNow = x.id === 'feishu' && x.enabled && mayUse('files')
      ? `<button type="button" class="row-action" data-feishu-check ${x.running ? 'disabled' : ''} title="Ask Feishu now which linked documents were edited, and fetch those">Check now</button>`
      : x.id === 'conversations' && x.enabled && mayUse('files')
        ? `<button type="button" class="row-action" data-conversations-check ${x.running ? 'disabled' : ''} title="Add the new exchanges of every followed conversation now, without waiting for it to go quiet">Check now</button>`
        : x.id === 'codebases' && x.enabled && mayUse('files')
          ? `<button type="button" class="row-action" data-codebases-check ${x.running ? 'disabled' : ''} title="Fetch every followed repository again now, and index what changed">Check now</button>`
          : '';
    return `<div class="schedule-row${x.enabled ? '' : ' off'}"><span class="activity-icon${x.running ? ' spin' : ''}">${x.running ? '⟳' : '◷'}</span>
      <div><b>${esc(title)}</b> <span class="hint">${esc(about)}</span><div class="hint">${x.running ? 'running now · ' : ''}${esc(when)}</div></div>${checkNow}</div>`;
  });
  const folders = t.folders.map((f) => `<div class="schedule-row"><span class="status-dot${f.watching ? ' live' : ''}" title="${f.watching ? 'watching its source' : 'not watching'}"></span>
      <div><b class="mono">${esc(f.dest)}</b> <span class="hint">← ${esc(homeShort(f.source))}</span>
      <div class="hint">${f.lastSyncAt ? `synced ${agoText(f.lastSyncAt)}` : 'not synced since the service started'}${f.lastChange ? ` · last change ${f.lastChange.copied} copied, ${f.lastChange.removed} removed` : ''}</div>
      ${f.lastError ? `<div class="hint bad">${esc(f.lastError)}</div>` : ''}</div></div>`);
  // feeds: sources that keep producing items (docs/design/26); whoever may ingest may run one now
  const feeds = (t.feeds ?? []).map((f) => `<div class="schedule-row${f.enabled ? '' : ' off'}"><span class="activity-icon${f.running ? ' spin' : ''}">${f.running ? '⟳' : '⇶'}</span>
      <div><b>${esc(f.title)}</b> <span class="hint">${esc(f.connector)} → <span class="mono">${esc(f.dest)}</span></span>
      <div class="hint">${f.running ? 'running now · ' : ''}${f.enabled ? esc(f.schedule) : 'off'}${f.nextRunAt && f.enabled && !f.running ? ` · next ${untilText(f.nextRunAt)}` : ''}${f.lastRunAt ? ` · last ${agoText(f.lastRunAt)}` : ''} · ${f.items} item${f.items === 1 ? '' : 's'}</div>
      ${f.problem ? `<div class="hint bad">${esc(f.problem)}</div>` : f.lastError ? `<div class="hint bad">${esc(f.lastError)}</div>` : ''}</div>
      ${f.enabled && !f.problem && !f.pushOnly && mayUse('ingest') ? `<button type="button" class="row-action" data-feed-run="${esc(f.id)}" ${f.running ? 'disabled' : ''} title="Pull this feed now, decide what is new and write it">Run now</button>` : ''}</div>`);
  const dream = t.dream.pendingSuggestions ? `<p class="hint">Dream has <a href="#" data-goto="dream">${t.dream.pendingSuggestions} suggestion${t.dream.pendingSuggestions === 1 ? '' : 's'}</a> waiting for review.</p>` : '';
  $('#tasks-schedule').innerHTML = `${rows.join('')}${folders.length ? `<p class="tasks-sub">Linked folders</p>${folders.join('')}` : ''}${feeds.length ? `<p class="tasks-sub">Feeds</p>${feeds.join('')}` : ''}${dream}`;
  for (const b of $('#tasks-schedule').querySelectorAll('[data-feed-run]')) b.addEventListener('click', (ev) => runFeedNow(ev.currentTarget));
  $('#tasks-schedule').querySelector('[data-feishu-check]')?.addEventListener('click', (ev) => checkFeishuNow(ev.currentTarget));
  $('#tasks-schedule').querySelector('[data-conversations-check]')?.addEventListener('click', (ev) => checkConversationsNow(ev.currentTarget));
  $('#tasks-schedule').querySelector('[data-codebases-check]')?.addEventListener('click', (ev) => checkCodebasesNow(ev.currentTarget));
}

/** Tasks → Code repositories → Check now: every followed repository, fetched again in the background. */
async function checkCodebasesNow(button) {
  if (button) button.disabled = true;
  try {
    const res = await api('/api/codebases/update', { method: 'POST', body: JSON.stringify({ followed: true, wait: false }) });
    const n = res.repositories ?? 0;
    const what = `${n} followed ${n === 1 ? 'repository' : 'repositories'}`;
    toast(!res.started ? 'no repository is followed'
      : res.queued ? `fetching ${what} again once the fetch under way ends — it shows under Tasks → Background`
        : `fetching ${what} again — it shows under Tasks → Background`, 5000);
  } catch (e) {
    toast(`repository check failed: ${e.message}`, 6000);
  }
  loadTasks();
}

/** Tasks → Feeds → Run now: one feed, in the background; the activity list shows how it went. */
async function runFeedNow(button) {
  const id = button?.dataset.feedRun;
  if (!id) return;
  button.disabled = true;
  try {
    const res = await api(`/api/feeds/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify({}) });
    toast(res.started === false ? `${id} is running already` : `pulling ${id} — it shows under Tasks → Background`, 5000);
  } catch (e) {
    toast(`run failed: ${e.message}`, 6000);
  }
  loadTasks();
}

/** Tasks → Feishu documents → Check now: every linked document and tree, in the background. */
async function checkFeishuNow(button) {
  if (button) button.disabled = true;
  try {
    const res = await api('/api/feishu/sync', { method: 'POST', body: JSON.stringify({}) });
    toast(res.started ? 'asking Feishu which linked documents were edited — it shows under Tasks → Background' : res.links === 0 ? 'no Feishu documents are linked' : 'a check is under way already', 5000);
  } catch (e) {
    toast(`Feishu check failed: ${e.message}`, 6000);
  }
  loadTasks();
}

function paintTasksErrors(t) {
  const card = $('#tasks-errors-card');
  const failed = t.stages.find((s) => s.id === 'index')?.failed ?? 0;
  card.hidden = t.documentErrors.length === 0;
  $('#tasks-errors-count').textContent = failed ? String(failed) : '';
  $('#tasks-errors').innerHTML = t.documentErrors.map((d) => `<div class="error-row"><div class="error-row-main"><a href="#" class="mono" data-open="${esc(d.path)}">${esc(d.path)}</a><div class="hint bad">${esc(d.error ?? 'failed')}</div></div>
      ${mayUse('ingest') ? `<button type="button" class="row-action" data-reindex="${esc(d.path)}" title="Convert and index this file again">Index again</button>` : ''}</div>`).join('')
    + (failed > t.documentErrors.length ? `<p class="hint">and ${failed - t.documentErrors.length} more</p>` : '');
  $('#tasks-errors').querySelectorAll('[data-reindex]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const s = await api('/api/sync', { method: 'POST', body: JSON.stringify({ only: [b.dataset.reindex] }) });
      toast(s.errors ? `${b.dataset.reindex}: still failing` : `${b.dataset.reindex}: indexed`, 4000);
    } catch (e) {
      toast(e.message, 5000);
    }
    loadTasks();
  }));
}

/** Links inside the queue: files open in Library, `data-goto` changes tab. */
function wireTaskLinks(root) {
  root.querySelectorAll('a[data-open]').forEach((a) => a.addEventListener('click', (ev) => {
    ev.preventDefault();
    navigate('files');
    openFile(a.dataset.open);
  }));
  root.querySelectorAll('a[data-goto]').forEach((a) => a.addEventListener('click', (ev) => {
    ev.preventDefault();
    navigate(a.dataset.goto);
  }));
}

/** The Tasks button in the header: a dot while processing runs, the Dream suggestions waiting. */
function paintTasksBadge(stats = lastStats) {
  const badge = $('#tasks-badge');
  const pending = stats?.pending_suggestions ?? 0;
  const running = processingStatus?.processing?.running === true;
  badge.hidden = !pending && !running;
  badge.classList.toggle('live', running);
  badge.textContent = pending ? `☾${pending}` : '';
  badge.title = [running ? 'processing is running' : '', pending ? `${pending} Dream suggestion${pending === 1 ? '' : 's'} to review` : ''].filter(Boolean).join(' · ');
}

/* ------------------------------ estimates ------------------------------ */

/**
 * What a task will take, shown before it starts (docs/design/18): the work,
 * its time, tokens, transfer and cost, and each plan's share — Codex's windows
 * as Codex reports them, the others against what their plans include. The
 * person starts it from here, or not. An estimate that cannot be made (an
 * older server) does not stand in the way: the dialog says so and Start
 * still works.
 */
let estimateRun = null;

async function openEstimate({ title, lede, url, confirm, run }) {
  const dialog = $('#estimate-dialog');
  $('#estimate-title').textContent = title;
  $('#estimate-lede').textContent = lede;
  $('#btn-estimate-confirm').textContent = confirm;
  $('#btn-estimate-confirm').disabled = false;
  $('#estimate-body').innerHTML = '<div class="est-loading">Estimating — counting the work and reading the plans…</div>';
  estimateRun = run;
  dialog.showModal();
  try {
    const estimate = await api(url);
    if (dialog.open && estimateRun === run) {
      $('#estimate-body').innerHTML = renderEstimate(estimate);
      placeBars($('#estimate-body'));
    }
  } catch (error) {
    if (dialog.open && estimateRun === run) $('#estimate-body').innerHTML = `<div class="est-error">No estimate: ${esc(error.message)}. You can still start.</div>`;
  }
}

$('#btn-estimate-cancel').addEventListener('click', () => $('#estimate-dialog').close());
// Escape closes it too: nothing starts once it is gone
$('#estimate-dialog').addEventListener('close', () => { estimateRun = null; });

$('#estimate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const run = estimateRun;
  if (!run) return;
  const button = $('#btn-estimate-confirm');
  button.disabled = true;
  try {
    await run();
    $('#estimate-dialog').close();
  } catch (error) {
    toast(error.message, 5000);
  } finally {
    button.disabled = false;
  }
});

const estInt = (n) => Math.round(n).toLocaleString();

function estDuration(seconds) {
  if (!(seconds > 0)) return '0 s';
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = seconds / 3600;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)} days`;
}

function estBytes(bytes) {
  if (!(bytes > 0)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function estTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

const estUsd = (usd) => (usd >= 100 ? `$${estInt(usd)}` : usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`);
const estPercent = (p) => (p >= 10 ? `${Math.round(p)}%` : p >= 1 ? `${p.toFixed(1)}%` : `${p.toFixed(2)}%`);
/** "a – b" under a figure, unless both ends read the same. */
const estSpread = (r, f) => (f(r.low) === f(r.high) ? '' : `${f(r.low)} – ${f(r.high)}`);
const estWhen = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function renderEstimate(e) {
  const t = e.totals;
  const tile = (label, value, sub) => `<div class="est-tile"><span>${esc(label)}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const tiles = [
    tile('Time', t.seconds ? `≈ ${esc(estDuration(t.seconds.expected))}` : 'waits', t.seconds ? esc(estSpread(t.seconds, estDuration)) : 'no slot takes it yet'),
    tile('Model calls', esc(estInt(t.calls)), ''),
    tile('Tokens', `${esc(estTokens(t.tokens.input.expected))} in · ${esc(estTokens(t.tokens.output.expected))} out`, `${esc(estTokens(t.tokens.cached))} of the input from cache`),
    tile('Transfer', `↓ ${esc(estBytes(t.bytes.down.expected))}`, `↑ ${esc(estBytes(t.bytes.up.expected))}${t.bytes.remote.expected > 0 ? ` · remote workers ${esc(estBytes(t.bytes.remote.expected))}` : ''}`),
    tile('At API prices', t.costUsd ? `≈ ${esc(estUsd(t.costUsd.expected))}` : '—', t.costUsd ? `${esc(estSpread(t.costUsd, estUsd))}${t.unpriced.length ? ' · some models unpriced' : ''}` : 'no price known for the model'),
  ].join('');
  const work = e.work.map((w) => `<li><b>${esc(w.label)}</b><span>${esc(w.detail)}</span></li>`).join('');
  const services = e.services.map(renderServiceShare).join('');
  const notes = e.notes.length ? `<ul class="est-notes">${e.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  const rows = e.lines.map((l) => {
    const b = l.perCall.basis;
    const basis = `<span class="${b.tokens === 'measured' ? 'est-measured' : 'est-default'}">${b.tokens === 'measured' ? `measured over ${estInt(b.measuredCalls)} calls` : 'estimated'}</span> · <span class="${b.time === 'measured' ? 'est-measured' : 'est-default'}">${b.time === 'measured' ? 'timed' : 'default time'}</span>`;
    return `<tr><td>${esc(l.label)}</td><td class="mono">${esc(l.route)}${l.remote ? ' (remote)' : ''}</td><td class="num">${l.slots || '—'}</td><td class="num">${esc(estInt(l.calls))}</td>
      <td class="num">${esc(estTokens(l.perCall.input))} / ${esc(estTokens(l.perCall.output))}</td><td class="num">${esc(estDuration(l.perCall.seconds.expected))}</td><td>${basis}</td></tr>`;
  }).join('');
  return `<ul class="est-work">${work}</ul>
    <div class="est-tiles">${tiles}</div>
    ${services}
    ${notes}
    ${rows ? `<details class="est-details"><summary>How this was estimated</summary>
      <table class="est-table"><thead><tr><th>Work</th><th>Route</th><th class="num">Slots</th><th class="num">Calls</th><th class="num">In / out per call</th><th class="num">Each</th><th>From</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="est-basis">Ranges span what the figures rest on: a route's measured calls once it has run some, its service's defaults before. Each answered call is measured, so the next estimate is closer.</p>
    </details>` : ''}`;
}

/** A window bar's segments, sized from their data attributes. */
function placeBars(root) {
  root.querySelectorAll('.est-bar > span').forEach((segment) => {
    segment.style.left = `${Number(segment.dataset.left) || 0}%`;
    segment.style.width = `${Number(segment.dataset.width) || 0}%`;
  });
}

function renderServiceShare(s) {
  const head = `<div class="est-service-head"><b>${esc(s.label)}</b><span>${s.plan ? `${esc(s.plan)} plan · ` : ''}${esc(estInt(s.calls))} calls · ${esc(estTokens(s.tokens.input))} in / ${esc(estTokens(s.tokens.output))} out${s.costUsd ? ` · ≈ ${esc(estUsd(s.costUsd.expected))} at API prices` : ''}</span></div>`;
  const windows = s.windows.map((w) => {
    const used = w.usedPercent ?? 0;
    const task = w.taskPercent;
    const over = task && used + task.expected > 100;
    // widths go on through element.style once drawn (placeBars): the page's policy allows no style attribute
    const from = Math.min(100, used);
    const bar = `<div class="est-bar"><span class="used" data-left="0" data-width="${from}"></span>${task ? `<span class="task${over ? ' over' : ''}" data-left="${from}" data-width="${Math.max(0.6, Math.min(100 - from, task.expected))}"></span>` : ''}</div>`;
    const now = w.usedPercent !== null ? `<b>${esc(estPercent(w.usedPercent))} used</b>${w.resetsAt ? ` · resets ${esc(estWhen(w.resetsAt))}` : ''}` : '';
    const figure = task
      ? `This task: <b>≈ ${esc(estPercent(task.expected))}</b>${estSpread(task, estPercent) ? ` (${esc(estSpread(task, estPercent))})` : ''}${over ? ' <span class="over">— past the limit</span>' : ''}`
      : 'This task: not estimated';
    return `<div class="est-window"><div class="est-window-label"><span>${esc(w.name[0].toUpperCase() + w.name.slice(1))} window</span><span>${now}</span></div>${bar}<div class="est-window-figure">${figure}</div><div class="est-basis">${esc(w.basis)}</div></div>`;
  }).join('');
  const credits = s.credits ? `<div class="est-basis">Credits: ${s.credits.unlimited ? 'unlimited' : s.credits.balance !== null ? esc(estInt(s.credits.balance)) : s.credits.hasCredits ? 'yes' : 'none'}</div>` : '';
  const alert = s.limitReached ? `<p class="est-alert">${esc(s.label)} says a limit is reached: ${esc(s.limitReached.replace(/_/g, ' '))}.</p>` : '';
  const notes = s.notes.length ? `<ul class="est-notes">${s.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  return `<div class="est-service">${head}${windows}${credits}${alert}${notes}</div>`;
}

/* ------------------------------- menus --------------------------------- */

/** One floating menu at a time — the tree's right-click and the pane's own buttons share it. */
function showMenu(x, y, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'popup-menu';
  // a click inside must reach its own button, never the dismisser on document
  menu.addEventListener('mousedown', (ev) => ev.stopPropagation());
  for (const item of items) {
    if (item === '-') {
      menu.appendChild(document.createElement('hr'));
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    if (item.danger) button.classList.add('danger');
    if (item.disabled) button.disabled = true;
    else button.addEventListener('click', () => { closeMenu(); item.run(); });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - box.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - box.height - 6))}px`;
  // registered a tick later, so the click that opened the menu cannot close it
  setTimeout(() => {
    document.addEventListener('click', closeMenu);
    document.addEventListener('contextmenu', closeMenu);
    window.addEventListener('keydown', onMenuKey);
    window.addEventListener('resize', closeMenu);
  }, 0);
}

function closeMenu() {
  document.querySelector('.popup-menu')?.remove();
  document.removeEventListener('click', closeMenu);
  document.removeEventListener('contextmenu', closeMenu);
  window.removeEventListener('keydown', onMenuKey);
  window.removeEventListener('resize', closeMenu);
}

function onMenuKey(ev) {
  if (ev.key === 'Escape') closeMenu();
}

function showMenuUnder(anchor, items) {
  const box = anchor.getBoundingClientRect();
  showMenu(box.left, box.bottom + 4, items);
}

/* ------------------------------- files --------------------------------- */

let currentFile = null;
let editing = false;
/**
 * Where each followed link came from — a wikilink, a cited source, the entity
 * panel — so ‹ returns to the same file at the same place: checking a source
 * should not cost the reader their position in the page that cited it.
 */
const fileTrail = [];
/**
 * Each listed folder's own entries ('' is the workspace root). A workspace can
 * hold tens of thousands of files, so a folder is listed when it opens, one
 * level at a time, never the whole tree at once.
 */
const listings = new Map();
/** How many rows a long folder shows before "show more". */
const TREE_PAGE = 500;
/** Long folders shown past their first page: folder → rows shown. */
const shownEntries = new Map();
/** The folder clicked in the tree — where new items and uploads land. */
let selectedDir = null;
/** Folders left open, kept across reloads so something just created stays in view. */
const expandedDirs = new Set(['wiki']);
/** Linked folders in the tree: mirror path → the folder on this Mac it is mirrored from. Every listing carries them. */
const linkedDests = new Map();
/** The folder on this Mac a path is mirrored from, or null — everything under a linked mirror is. */
function mirroredSource(path) {
  for (const [dest, source] of linkedDests) if (path === dest || path.startsWith(`${dest}/`)) return source;
  return null;
}
/** Linked Feishu documents in the tree: mirror path → the document's link. A subset of linkedDests. */
const feishuDests = new Map();
/** Followed agent conversations in the tree: copy path → its transcript. A subset of linkedDests. */
const conversationDests = new Map();
/** Code repositories in the tree: mirror, card or docs path → the repository's name. A subset of linkedDests. */
const codebaseDests = new Map();
/** The last path typed into an import, offered again next time. */
let lastImportSource = '';
/** The last Feishu link typed into an import. */
let lastFeishuUrl = '';

/** How many files and bytes go into one upload request — a folder can hold thousands. */
const UPLOAD_BATCH_FILES = 40;
const UPLOAD_BATCH_BYTES = 24 * 1024 * 1024;

const isWritable = (path) => /^(wiki|raw\/docs)(\/|$)/.test(path);
const parentDir = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const baseName = (path) => path.split('/').pop();

/**
 * Whether the tree shows a folder: its parent's listing has it. The service
 * leaves system folders out (a lint report opened from a notice lives in one),
 * and a file made there would vanish from view.
 */
function shownInTree(dir) {
  const entries = listings.get(parentDir(dir));
  return !entries || entries.some((c) => c.path === dir);
}

/** Where a create or an upload goes: the picked folder, else the open file's folder when the tree shows it, else wiki. */
function targetDir() {
  if (selectedDir) return selectedDir;
  if (currentFile && parentDir(currentFile) && shownInTree(parentDir(currentFile))) return parentDir(currentFile);
  return 'wiki';
}

/** The same folder, kept to one an upload may actually land in. */
const uploadTarget = () => (isWritable(targetDir()) ? targetDir() : 'raw/docs');

/** A default name nothing in the folder uses yet, so two creates cannot collide. List the folder first. */
function freeName(dir, base, ext = '') {
  const taken = new Set((listings.get(dir) || []).map((c) => c.name));
  let name = base + ext;
  for (let i = 2; taken.has(name); i += 1) name = `${base}-${i}${ext}`;
  return name;
}

const fileCount = (node) => (node.kind === 'file' ? 1 : (node.children || []).reduce((n, c) => n + fileCount(c), 0));

/** How many files a folder holds at any depth, or null when it cannot be read — asked when a delete needs it. */
async function filesUnder(path) {
  try {
    return fileCount(await api(`/api/tree?path=${encodeURIComponent(path)}`));
  } catch {
    return null;
  }
}

/** One folder's entries from the service, or null when the folder is gone. */
async function fetchListing(dir) {
  try {
    const node = await api(`/api/tree?path=${encodeURIComponent(dir || '.')}&depth=1`);
    linkedDests.clear();
    feishuDests.clear();
    conversationDests.clear();
    codebaseDests.clear();
    for (const link of node.links || []) {
      linkedDests.set(link.path, link.source);
      if (link.kind === 'feishu') feishuDests.set(link.path, link.source);
      if (link.kind === 'conversation') conversationDests.set(link.path, link.source);
      if (link.kind === 'codebase') codebaseDests.set(link.path, link.name);
    }
    return node.children || [];
  } catch {
    return null;
  }
}

/** A folder's entries, listing it if nothing has yet; null when it is gone. */
async function ensureListing(dir) {
  if (!listings.has(dir)) {
    const entries = await fetchListing(dir);
    if (entries) listings.set(dir, entries);
  }
  return listings.get(dir) || null;
}

/** Whether a folder's rows are on screen: it and every folder above it are open. */
function isOnScreen(dir) {
  const parts = dir.split('/');
  return parts.every((_, i) => expandedDirs.has(parts.slice(0, i + 1).join('/')));
}

/** Reveal a path by opening it and every folder above it. */
function reveal(path) {
  const parts = path.split('/').filter(Boolean);
  for (let i = 1; i <= parts.length; i += 1) expandedDirs.add(parts.slice(0, i).join('/'));
}

/** Redraw the tree from the listings: the root's rows, and each open folder's inside it. */
function renderTree() {
  const el = $('#filetree');
  el.innerHTML = '';
  renderEntries('', el);
  paintDestination();
}

/**
 * A folder's rows, a page at a time, listing the folder first when nothing
 * has: opening a folder of thousands of files costs one request and a page of
 * rows, not the whole tree.
 */
function renderEntries(dir, container) {
  const entries = listings.get(dir);
  if (!entries) {
    container.innerHTML = '<div class="tree-note">loading…</div>';
    ensureListing(dir).then((list) => {
      container.innerHTML = list ? '' : '<div class="tree-note">could not list this folder</div>';
      if (list) renderEntries(dir, container);
    });
    return;
  }
  if (entries.length === 0) {
    container.innerHTML = '<div class="tree-note">empty</div>';
    return;
  }
  const shown = Math.min(entries.length, shownEntries.get(dir) || TREE_PAGE);
  for (const child of entries.slice(0, shown)) container.appendChild(treeRow(child));
  if (shown < entries.length) {
    const more = document.createElement('div');
    more.className = 'tree-more';
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = `… ${entries.length - shown} more — show ${Math.min(TREE_PAGE, entries.length - shown)}`;
    label.addEventListener('click', () => {
      shownEntries.set(dir, shown + TREE_PAGE);
      container.innerHTML = '';
      renderEntries(dir, container);
    });
    more.appendChild(label);
    container.appendChild(more);
  }
}

/** A path under a home directory, as `~/…`: a linked folder's origin is long, and the row is narrow. */
const homeShort = (p) => String(p).replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~');

function treeRow(child) {
  const div = document.createElement('div');
  div.className = child.kind === 'dir' ? 'tree-dir' : 'tree-file';
  const label = document.createElement('span');
  label.className = 'tree-label';
  label.dataset.path = child.path;
  div.appendChild(label);
  if (child.kind === 'dir') {
    const kids = document.createElement('div');
    kids.className = 'tree-children';
    div.appendChild(kids);
    // a folder's rows are made when it opens, not before
    if (expandedDirs.has(child.path)) renderEntries(child.path, kids);
    else div.classList.add('collapsed');
    if (child.path === selectedDir) label.classList.add('picked');
    const name = document.createElement('span');
    label.appendChild(name);
    // what the folder is for: the service's word for the folders it makes, the
    // origin for a linked one, nothing for a folder someone made
    const about = child.about || (child.linked ? `linked from ${homeShort(child.linked)}` : '');
    if (about) {
      const hint = document.createElement('span');
      hint.className = 'tree-about';
      hint.textContent = about;
      label.appendChild(hint);
    }
    const paint = () => {
      name.textContent = `${div.classList.contains('collapsed') ? '▸' : '▾'} ${child.name}${child.linked ? ' 🔗' : ''}`;
    };
    if (child.linked) label.title = `linked to ${child.linked} — mirrored from there and kept in sync; edit the originals, not these copies`;
    else if (child.about) label.title = child.about;
    paint();
    label.addEventListener('click', () => {
      // one click both picks the folder new items go into and opens it
      pickDir(child.path);
      div.classList.toggle('collapsed');
      if (div.classList.contains('collapsed')) expandedDirs.delete(child.path);
      else {
        expandedDirs.add(child.path);
        if (!kids.querySelector('.tree-dir, .tree-file')) {
          kids.innerHTML = '';
          renderEntries(child.path, kids);
        }
      }
      paint();
    });
  } else {
    label.textContent = `· ${child.name}${child.linked ? ' 🔗' : ''}`;
    if (child.linked) label.title = `follows the agent conversation in ${child.linked} — new exchanges are added as it goes on`;
    if (child.path === currentFile) label.classList.add('selected');
    label.addEventListener('click', () => openFile(child.path, label));
  }
  label.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    // the dismisser on document would otherwise close the menu we just opened
    ev.stopPropagation();
    showMenu(ev.clientX, ev.clientY, nodeMenu(child));
  });
  return div;
}

/** What a right-click on a row offers, for that row — never for what is selected elsewhere. */
function nodeMenu(node) {
  const dir = node.kind === 'dir';
  // a linked folder's mirror is written by the link alone: nothing is created,
  // renamed, moved or deleted inside it from here
  const mirrored = mirroredSource(node.path);
  const linkRoot = dir && linkedDests.has(node.path);
  const movable = isWritable(node.path) && node.path !== 'wiki' && node.path !== 'raw/docs' && !mirrored;
  const items = [];
  if (dir && isWritable(node.path) && !mirrored) {
    items.push({ label: 'New file here…', run: () => { pickDir(node.path); newFile(node.path); } });
    items.push({ label: 'New folder here…', run: () => { pickDir(node.path); newFolder(node.path); } });
    items.push('-');
    items.push({ label: 'Upload files here…', run: () => { pickDir(node.path); pickUpload('files', node.path); } });
    items.push({ label: 'Upload folder here…', run: () => { pickDir(node.path); pickUpload('folder', node.path); } });
    if (/^raw\/docs(\/|$)/.test(node.path) && mayImportFolders()) {
      items.push('-');
      items.push({ label: 'Import folder from this Mac here…', run: () => { pickDir(node.path); importLocalFolder('copy', node.path); } });
      items.push({ label: 'Link folder from this Mac here…', run: () => { pickDir(node.path); importLocalFolder('link', node.path); } });
    }
    items.push('-');
  }
  if (!dir && conversationDests.has(node.path)) {
    items.push({ label: 'Check for new exchanges now', run: () => syncAgentConversation(node.path) });
    items.push({ label: 'Render again from the transcript', run: () => syncAgentConversation(node.path, true) });
    items.push({ label: 'Unfollow (keep the copy)…', run: () => unfollowAgentConversation(node, false) });
    items.push({ label: 'Unfollow and remove the copy…', danger: true, run: () => unfollowAgentConversation(node, true) });
    items.push('-');
  }
  if (codebaseDests.has(node.path)) {
    // a repository's mirror, card or docs copy: the repository's actions, not a linked folder's
    const name = codebaseDests.get(node.path);
    const source = linkedDests.get(node.path);
    items.push({ label: 'Update from the repository now', run: () => updateCodebase(name) });
    if (/^https:\/\//.test(source ?? '')) items.push({ label: 'Open the repository page', run: () => window.open(source, '_blank', 'noopener') });
    items.push({ label: 'Code repository settings…', run: () => openCodebases({ edit: name }) });
    items.push({ label: 'Remove repository (keep the files)…', run: () => removeCodebaseNode(name, true) });
    items.push({ label: 'Remove repository and its files…', danger: true, run: () => removeCodebaseNode(name, false) });
    items.push('-');
  } else if (linkRoot && feishuDests.has(node.path)) {
    items.push({ label: 'Check Feishu for edits now', run: () => syncFeishuDoc(node.path) });
    items.push({ label: 'Fetch again from Feishu', run: () => syncFeishuDoc(node.path, true) });
    items.push({ label: 'Open in Feishu', run: () => window.open(feishuDests.get(node.path), '_blank', 'noopener') });
    items.push({ label: 'Unlink (keep the copies)…', run: () => unlinkFeishuNode(node, false) });
    items.push({ label: 'Unlink and remove the copies…', danger: true, run: () => unlinkFeishuNode(node, true) });
    items.push('-');
  } else if (linkRoot) {
    items.push({ label: 'Sync linked folder now', run: () => syncLinkedFolder(node.path) });
    items.push({ label: 'Unlink (keep the copies)…', run: () => unlinkFolderNode(node, false) });
    items.push({ label: 'Unlink and remove the copies…', danger: true, run: () => unlinkFolderNode(node, true) });
    items.push('-');
  }
  if (!dir) items.push({ label: 'Open', run: () => openFile(node.path) });
  items.push({ label: 'Copy path', run: () => copyPath(node.path) });
  if (movable) {
    items.push('-');
    items.push({ label: dir ? 'Rename folder…' : 'Rename…', run: () => renameNode(node) });
    items.push({ label: dir ? 'Move folder to…' : 'Move to…', run: () => moveNode(node) });
    items.push({ label: dir ? 'Delete folder…' : 'Delete…', danger: true, run: () => deleteNode(node) });
  }
  return items;
}

function pickDir(path) {
  selectedDir = path;
  paintSearchScope();
  document.querySelectorAll('#filetree .tree-label').forEach((el) => {
    el.classList.toggle('picked', el.parentElement.classList.contains('tree-dir') && el.dataset.path === path);
  });
  paintDestination();
}

function paintDestination() {
  const dir = targetDir();
  $('#tree-destination-path').textContent = `${dir}/`;
  $('#tree-destination-lock').hidden = isWritable(dir);
  $('#btn-clear-dir').hidden = !selectedDir;
}

/**
 * Re-read the folders on screen — the root and every open folder, one level
 * each — and redraw. A folder out of sight is listed again when it opens.
 */
async function loadTree() {
  const open = ['', ...[...expandedDirs].filter(isOnScreen)];
  const lists = await Promise.all(open.map(fetchListing));
  listings.clear();
  open.forEach((dir, i) => {
    if (lists[i]) listings.set(dir, lists[i]);
    else expandedDirs.delete(dir);
  });
  renderTree();
}

/** Bring a path's row on screen: open the folders above it, listing only what is not listed yet. */
async function showInTree(path) {
  const parent = parentDir(path);
  reveal(parent);
  const parts = parent.split('/').filter(Boolean);
  await Promise.all(['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))].map(ensureListing));
  // a file made since its folder was listed: list the folder again
  if (!(listings.get(parent) || []).some((c) => c.path === path)) {
    const fresh = await fetchListing(parent);
    if (fresh) listings.set(parent, fresh);
  }
  const index = (listings.get(parent) || []).findIndex((c) => c.path === path);
  if (index >= (shownEntries.get(parent) || TREE_PAGE)) shownEntries.set(parent, Math.ceil((index + 1) / TREE_PAGE) * TREE_PAGE);
  renderTree();
}

async function copyPath(path) {
  try {
    await navigator.clipboard.writeText(path);
    toast(`copied ${path}`);
  } catch {
    toast(path);
  }
}

async function newFile(dir) {
  const folder = isWritable(dir) ? dir : 'wiki';
  await ensureListing(folder);
  const suggested = `${folder}/${freeName(folder, 'new-note', '.md')}`;
  const path = prompt('New file path (under wiki/ or raw/docs/):', suggested);
  if (!path) return;
  if (!isWritable(path)) {
    toast('only wiki/ and raw/docs/ take new files');
    return;
  }
  try {
    const title = baseName(path).replace(/\.md$/, '').replace(/-/g, ' ');
    await api('/api/file', { method: 'PUT', body: JSON.stringify({ path, content: `# ${title}\n\n` }) });
    reveal(parentDir(path));
    await loadTree();
    openFile(path);
  } catch (e) {
    toast(`create failed: ${e.message}`);
  }
}

async function newFolder(dir) {
  const folder = isWritable(dir) ? dir : 'wiki';
  await ensureListing(folder);
  const suggested = `${folder}/${freeName(folder, 'new-folder')}`;
  const path = prompt('New folder path (under wiki/ or raw/docs/):', suggested);
  if (!path) return;
  if (!isWritable(path)) {
    toast('only wiki/ and raw/docs/ take new folders');
    return;
  }
  try {
    const created = await api('/api/mkdir', { method: 'POST', body: JSON.stringify({ path }) });
    reveal(created.path);
    await loadTree();
    pickDir(created.path);
    toast(`created ${created.path}/`);
  } catch (e) {
    toast(`create folder failed: ${e.message}`);
  }
}

async function renameNode(node) {
  const name = prompt(`Rename ${node.kind === 'dir' ? 'folder' : 'file'}:`, baseName(node.path));
  if (name === null) return;
  const clean = name.trim();
  if (!clean || clean === baseName(node.path)) return;
  if (clean.includes('/')) {
    toast('a name cannot contain "/" — use "move to…" instead');
    return;
  }
  const parent = parentDir(node.path);
  await moveSubtree(node.path, parent ? `${parent}/${clean}` : clean);
}

async function moveNode(node) {
  const answer = prompt(`Move ${baseName(node.path)} into which folder? (under wiki/ or raw/docs/)`, parentDir(node.path));
  if (answer === null) return;
  const dest = answer.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!isWritable(dest)) {
    toast('moves land under wiki/ or raw/docs/');
    return;
  }
  if (dest === parentDir(node.path)) {
    toast(`${baseName(node.path)} is already in ${dest}`);
    return;
  }
  // rename would fail halfway through a folder moved into itself
  if (node.kind === 'dir' && (dest === node.path || dest.startsWith(`${node.path}/`))) {
    toast('a folder cannot move inside itself');
    return;
  }
  await moveSubtree(node.path, `${dest}/${baseName(node.path)}`);
}

/**
 * The one path change behind rename and move.
 *
 * A path is the document's identity in the graph, so the knowledge only
 * catches up on the ingest that follows.
 */
async function moveSubtree(from, to) {
  try {
    await api('/api/mv', { method: 'POST', body: JSON.stringify({ from, to }) });
    const moved = (path) => (path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path);
    if (currentFile) {
      currentFile = moved(currentFile);
      $('#file-path').textContent = currentFile;
    }
    if (selectedDir) selectedDir = moved(selectedDir);
    for (const dir of [...expandedDirs]) {
      if (dir !== moved(dir)) {
        expandedDirs.delete(dir);
        expandedDirs.add(moved(dir));
      }
    }
    reveal(parentDir(to));
    await loadTree();
  } catch (e) {
    toast(`move failed: ${e.message}`);
    return;
  }
  // the files are already where they belong — a failed re-index must not read
  // as a failed move
  toast(`moved to ${to} — re-indexing…`, 60000);
  try {
    const stats = await api('/api/ingest', { method: 'POST' });
    await loadTree();
    loadStats();
    toast(`move complete — ${stats.indexed} docs · ${stats.chunks} chunks re-indexed`);
  } catch (e) {
    toast(`moved to ${to}, re-index failed: ${e.message}`);
  }
}

async function deleteNode(node) {
  // the folder's own listing is one level: what goes with it is counted now
  const files = node.kind === 'dir' ? await filesUnder(node.path) : 1;
  const inside = files === null ? 'everything' : `the ${files} file${files === 1 ? '' : 's'}`;
  const question = node.kind === 'dir'
    ? `Delete ${node.path}/ and ${inside} inside it?`
    : `Delete ${node.path}?`;
  if (!confirm(question)) return;
  try {
    await api(`/api/file?path=${encodeURIComponent(node.path)}`, { method: 'DELETE' });
    forget(node.path);
    await loadTree();
    loadStats();
    toast(node.kind === 'dir' ? `deleted ${node.path}/ — ${files === null ? 'and its files' : `${files} file${files === 1 ? '' : 's'}`}` : `deleted ${node.path}`);
  } catch (e) {
    toast(`delete failed: ${e.message}`);
  }
}

/** Drop every reference to a path that is no longer on disk. */
function forget(path) {
  const gone = (candidate) => candidate === path || candidate.startsWith(`${path}/`);
  if (currentFile && gone(currentFile)) clearOpenFile();
  if (selectedDir && gone(selectedDir)) selectedDir = null;
  for (const dir of [...expandedDirs]) if (gone(dir)) expandedDirs.delete(dir);
}

function clearOpenFile() {
  currentFile = null;
  editing = false;
  $('#file-path').textContent = '';
  showOriginalLink(null);
  paintContents(null);
  $('#file-view').innerHTML = '';
  $('#file-view').hidden = false;
  $('#file-editor').value = '';
  $('#file-editor').hidden = true;
  setFileNotice(null);
  clearFileCitations();
  $('#btn-edit').textContent = 'edit';
  $('#btn-edit').disabled = true;
  $('#btn-save').disabled = true;
  $('#btn-delete').disabled = true;
}

/** Files a browser shows as they are, or downloads (a book), from src/server/originals.ts: the file view shows what knode-os read out of them. */
const hasOriginal = (path) => /\.(pdf|html?|xhtml|png|jpe?g|gif|webp|avif|bmp|tiff?|heic|heif|svg|epub)$/i.test(path ?? '');

/** An EPUB: read whole, with its contents to jump through and its pictures read from inside it. */
const isBookPath = (path) => /\.epub$/i.test(path ?? '');

/** The file itself, to open in a tab: a link sends no headers, so it names the workspace in its query. */
function originalHref(path) {
  const q = new URLSearchParams({ path });
  const h = workspaceRequestHeaders();
  if (h['x-knode-workspace-kind']) {
    q.set('kind', h['x-knode-workspace-kind']);
    q.set('id', h['x-knode-workspace-id']);
    q.set('name', h['x-knode-workspace-name']);
  }
  // with sign-in on the session says who you are; off, the name does
  if (authDisabled && h['x-knode-user']) q.set('user', h['x-knode-user']);
  return `/api/file/original?${q}`;
}

/** A study as one HTML file to read, save or print (src/research/export.ts); named in the query like an original. */
function studyExportHref(id) {
  const q = new URLSearchParams();
  const h = workspaceRequestHeaders();
  if (h['x-knode-workspace-kind']) {
    q.set('kind', h['x-knode-workspace-kind']);
    q.set('id', h['x-knode-workspace-id']);
    q.set('name', h['x-knode-workspace-name']);
  }
  if (authDisabled && h['x-knode-user']) q.set('user', h['x-knode-user']);
  const query = q.toString();
  return `/api/research/studies/${encodeURIComponent(id)}/export${query ? `?${query}` : ''}`;
}

/** "original ↗" in the file toolbar, for a PDF, a picture or a web page; "original ↓" saves a book, which no browser shows. */
function showOriginalLink(path) {
  const link = $('#btn-original');
  link.hidden = !hasOriginal(path);
  const book = isBookPath(path);
  link.textContent = book ? 'original ↓' : 'original ↗';
  link.title = book
    ? 'The book itself, as an .epub file to open in a reader (Books, Calibre, an e-reader)'
    : 'The file itself in a new tab: the PDF, the picture, the web page as it was saved';
  if (link.hidden) link.removeAttribute('href');
  else link.href = originalHref(path);
}

/** Mirrors MAX_PREVIEW_BYTES in the service — the cap on an unqualified read. */
const PREVIEW_BYTE_CAP = 256 * 1024;
/** Mirrors MAX_FILE_BYTES: the largest read the service serves, so the largest editable file. */
const EDIT_BYTE_CAP = 4 * 1024 * 1024;

/** Decimal units, matching what the macOS app's ByteCountFormatter prints. */
const fmtBytes = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`);

/**
 * Why the open file cannot be edited — `{ text, canLoadFull }`, or null when it
 * can. A truncated preview must stay read-only: PUT /api/file overwrites the
 * whole file, so saving what the editor holds would silently drop everything
 * past the cap. `canLoadFull` says the whole file still fits in one read, so
 * the user can promote the preview to a real edit.
 */
function readOnlyNotice(derived, truncated, bytes, path = currentFile, transcript = null) {
  // The mirror of a linked folder follows its source: a save here would be
  // undone by the next sync (and the service refuses it).
  const mirrored = path ? mirroredSource(path) : null;
  if (mirrored && conversationDests.has(path)) {
    return {
      text: `Follows an agent conversation (${homeShort(mirrored)}) — rendered from its transcript and kept in sync, so it is read-only here. Right-click it in Files to check for new exchanges or unfollow it.`,
      canLoadFull: false,
    };
  }
  if (mirrored) {
    return {
      text: `Mirrored from ${mirrored} — kept in sync with the original there, so it is read-only here. Edit the original instead.`,
      canLoadFull: false,
    };
  }
  // Derived text is knode-os's rendering of a PDF or image. It is read-only
  // whatever its size: writing it back would replace the original's bytes, so
  // this is checked before the size rule and never offers a full load.
  if (derived && transcript) {
    // a reviewed transcript beside the original is its text (docs/design/19): the fix is an edit there
    return {
      text: `Read from its transcript, ${transcript.split('/').pop()} — edit that file to correct the reading. "original ↗" opens the file itself.`,
      canLoadFull: false,
    };
  }
  if (derived && isBookPath(path)) {
    return {
      text: 'Read out of the book — knode-os produced this text from the .epub, so it is read-only. "original ↓" saves the book itself; replace it by uploading a new copy.',
      canLoadFull: false,
    };
  }
  if (derived) {
    return {
      text: 'Derived Markdown — knode-os produced this from the original, so it is read-only. "original ↗" opens the file itself; replace it by uploading a new copy.',
      canLoadFull: false,
    };
  }
  if (truncated) {
    const total = Number.isFinite(bytes) ? ` of ${fmtBytes(bytes)}` : '';
    const head = `Preview only — showing the first ${fmtBytes(PREVIEW_BYTE_CAP)}${total}.`;
    if (Number.isFinite(bytes) && bytes <= EDIT_BYTE_CAP) {
      return { text: `${head} Load the full file to edit it.`, canLoadFull: true };
    }
    return { text: `${head} Files over ${fmtBytes(EDIT_BYTE_CAP)} cannot be edited here.`, canLoadFull: false };
  }
  return null;
}

function setFileNotice(notice) {
  $('#file-notice').hidden = !notice;
  $('#file-notice-text').textContent = notice?.text ?? '';
  $('#btn-load-full').hidden = !notice?.canLoadFull;
}

/**
 * Re-read the open file without the preview cap so it can be edited. The
 * editor only ever holds a complete file — that is what makes a save safe.
 */
async function loadFullFile() {
  if (!currentFile) return;
  const path = currentFile;
  try {
    const file = await api(fileUrl(path, { maxBytes: EDIT_BYTE_CAP }));
    if (currentFile !== path) return; // the user moved on while this was in flight
    renderFileContent(path, file.content, file.derived, file.truncated, file.bytes);
    paintLanguages(path, file);
    if (file.truncated) toast(`${path} is too large to edit here`);
  } catch (e) {
    toast(`load failed: ${e.message}`);
  }
}

const isMarkdownPath = (path) => /\.(md|markdown)$/i.test(path ?? '');

/** Whether a page's metadata panel opens unfolded: the reader's last choice, folded at first. */
const METADATA_OPEN_KEY = 'knode-os.markdown.metadataOpen';
const metadataOpen = () => {
  try {
    return localStorage.getItem(METADATA_OPEN_KEY) === '1';
  } catch {
    return false;
  }
};
$('#file-view').addEventListener('toggle', (event) => {
  if (!event.target.matches?.('details.md-meta')) return;
  try {
    localStorage.setItem(METADATA_OPEN_KEY, event.target.open ? '1' : '0');
  } catch {
    // a private window keeps no preferences; the panel still opens
  }
}, true); // toggle does not bubble

/** Paint text into the file view: Markdown with its notes and metadata and then the entities it names, anything else as it is. */
function paintFileView(path, content, derived = false) {
  const view = $('#file-view');
  if (!isMarkdownPath(path) && !derived) {
    view.innerHTML = `<pre>${esc(content)}</pre>`;
    paintContents(null);
    return;
  }
  view.innerHTML = renderMd(content, { metadataOpen: metadataOpen() });
  showPicturesBeside(view, path);
  paintContents(path);
  // ```chart blocks render as SVG in renderMd; hover and keyboard are added here (web/chart.js)
  window.knodeChart?.hydrate(view);
  hydrateMindMaps(view, path);
  markFileMentions(path, content);
}

/**
 * A picture a page names by a path beside it — `assets/x.png` in an imported
 * Feishu document — is shown from the workspace: the page's own address is
 * the app's, where that path means nothing.
 */
function showPicturesBeside(view, path) {
  // a book's pictures are inside it (src/ingest/converters/epub.ts): the .epub is their folder, each part of the path escaped on its own
  const book = isBookPath(path);
  const dir = book ? path : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  for (const img of view.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (!src || /^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('#')) continue;
    let rel;
    try {
      rel = book ? src.split('/').map(decodeURIComponent).join('/') : decodeURI(src);
    } catch {
      continue;
    }
    const parts = [];
    for (const seg of `${dir}/${rel}`.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    img.src = originalHref(parts.join('/'));
    img.loading = 'lazy';
  }
}

/** A picture the browser shows, and so one a mind map may have been read from. */
const isPicturePath = (path) => /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|heic|heif|svg)$/i.test(path ?? '');

/**
 * A mind map in the file view (web/mindmap.js): its controls, and — for a map
 * read off a picture, or the reviewed transcript beside one (`x.webp.md`) — a
 * button that shows the picture under the map, to check the reading against.
 */
function hydrateMindMaps(view, path) {
  const maps = view.querySelectorAll('.kmindmap');
  if (!maps.length) return;
  window.knodeMindmap?.hydrate(view);
  const picture = isPicturePath(path) ? path : /\.md$/i.test(path ?? '') && isPicturePath(path.slice(0, -3)) ? path.slice(0, -3) : null;
  if (!picture) return;
  for (const figure of maps) {
    const tools = figure.querySelector('.kmm-tools');
    if (!tools) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'kmm-btn';
    button.textContent = 'picture';
    button.title = `Show ${picture.split('/').pop()}, the picture this map was read from`;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      let frame = figure.querySelector('.kmm-picture');
      if (!frame) {
        frame = document.createElement('div');
        frame.className = 'kmm-picture';
        frame.hidden = true;
        const img = document.createElement('img');
        img.alt = `${picture.split('/').pop()}, the picture this map was read from`;
        img.loading = 'lazy';
        img.src = originalHref(picture);
        frame.append(img);
        figure.append(frame);
      }
      frame.hidden = !frame.hidden;
      button.setAttribute('aria-pressed', String(!frame.hidden));
      if (!frame.hidden) frame.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    tools.prepend(button);
  }
}

/** Paint the file pane and decide, from this read alone, whether editing is allowed. */
function renderFileContent(path, content, derived, truncated, bytes) {
  // derived text (a PDF / image's Markdown) is knode-os's, not the user's: readable, never editable here
  paintFileView(path, content, derived);
  $('#file-editor').value = content;
  // the transcript the text was read from, as its frontmatter names it (src/ingest/convert.ts)
  const transcript = derived ? /^transcript:[ \t]*"([^"\n]+)"/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(content ?? '')?.[1] ?? '')?.[1] ?? null : null;
  const notice = readOnlyNotice(derived, truncated, bytes, path, transcript);
  setFileNotice(notice);
  $('#btn-edit').textContent = 'edit';
  $('#btn-edit').disabled = Boolean(notice);
  $('#btn-save').disabled = true;
}

/**
 * `fragment`: where a link pointed inside the file — an export's entry anchor
 * or a heading. It may lie past the preview cap (a weekly digest's later
 * entries), so a file opened at one is read whole.
 */
async function openFile(path, labelEl, fragment = null) {
  try {
    // the reading language is known before the first file of a workspace opens
    if (contentLanguagesLoaded !== (activeWorkspace()?.id ?? null)) await loadContentLanguages();
    const file = await api(fileUrl(path, fragment ? { maxBytes: EDIT_BYTE_CAP } : {}));
    const { content, derived, truncated, bytes } = file;
    currentFile = path;
    editing = false;
    // the create target follows the last thing clicked: a file hands it back
    // to the file's own folder
    selectedDir = null;
    document.querySelectorAll('.tree-label.selected, .tree-label.picked').forEach((x) => x.classList.remove('selected', 'picked'));
    (labelEl || document.querySelector(`#filetree .tree-file > .tree-label[data-path="${CSS.escape(path)}"]`))?.classList.add('selected');
    paintDestination();
    $('#file-path').textContent = path;
    showOriginalLink(path);
    $('#file-view').hidden = false;
    $('#file-editor').hidden = true;
    renderFileContent(path, content, derived, truncated, bytes);
    paintLanguages(path, file);
    loadFileCitations(path);
    $('#btn-delete').disabled = Boolean(mirroredSource(path));
    if (fragment) scrollToFragment(fragment);
    else $('#file-view').scrollTop = 0;
  } catch (e) {
    toast(`open failed: ${e.message}`);
  }
}

/* --------------------------- content languages -------------------------- */

/**
 * Content languages (docs/design/17). A workspace with them on reads in a
 * primary language: documents in other languages are translated into it in
 * the background, and into a secondary one when a reader asks. Which version
 * this reader opens — the reading language — is theirs, kept in this browser
 * and defaulting to the workspace's primary; "original" reads every
 * document as it was written. It is not the interface language: this page's
 * own words stay as they are whatever a reader picks here.
 */
let contentLanguages = null; // GET /api/languages: the catalog and the workspace's settings; null on an older service
const READING_LANGUAGE_KEY = 'knode-os.reading-language';

/** The names the service would give, for an older one that has no catalog to send. */
const LANGUAGE_NAMES = {
  zh: '简体中文', 'zh-Hant': '繁體中文', en: 'English', ja: '日本語', ko: '한국어',
  fr: 'Français', de: 'Deutsch', es: 'Español', pt: 'Português', it: 'Italiano', ru: 'Русский',
};

/** A language as the switcher shows it: in itself. */
const languageName = (code) => contentLanguages?.languages?.find((l) => l.code === code)?.native ?? LANGUAGE_NAMES[code] ?? code;
/** A language as this page's sentences name it. */
const languageInEnglish = (code) => contentLanguages?.languages?.find((l) => l.code === code)?.english ?? code;

let contentLanguagesLoaded = null;

async function loadContentLanguages() {
  try {
    contentLanguages = await api('/api/languages');
  } catch {
    contentLanguages = null;
  }
  contentLanguagesLoaded = activeWorkspace()?.id ?? null;
}

/** 'original', or a language code; null while the workspace has content languages off. */
function readingLanguage() {
  if (!contentLanguages?.enabled) return null;
  let picked = null;
  try {
    picked = localStorage.getItem(READING_LANGUAGE_KEY);
  } catch {
    // a private window keeps no preferences: the primary language it is
  }
  if (picked === 'original') return picked;
  // a pick another workspace offers is not this one's: its primary then
  return picked && contentLanguages.offered?.includes(picked) ? picked : contentLanguages.primary;
}

function setReadingLanguage(value) {
  try {
    localStorage.setItem(READING_LANGUAGE_KEY, value);
  } catch {
    // kept for this page only
  }
}

/** The file API for `path`, asking for the reader's language. */
function fileUrl(path, { maxBytes } = {}) {
  const q = new URLSearchParams({ path });
  // a book is read, not previewed: its text whole (a few hundred KB to a couple of MB), never its first 256 KB
  if (!maxBytes && isBookPath(path)) maxBytes = EDIT_BYTE_CAP;
  if (maxBytes) q.set('maxBytes', String(maxBytes));
  const lang = readingLanguage();
  if (lang && lang !== 'original') q.set('lang', lang);
  return `/api/file?${q}`;
}

let languageRefresh = null;
/** The open file's language as the switcher last painted it: the one asked for and where its translation stands. */
let paintedLanguage = null;

/**
 * The switcher and what it says about the open file: the original and the
 * workspace's languages, the reader's pick marked, and — when the pick has no
 * translation yet — why, with the one action that helps. A translation is
 * read-only: an edit belongs to the original.
 */
function paintLanguages(path, file) {
  clearTimeout(languageRefresh);
  const box = $('#file-langs');
  const notice = $('#file-lang-notice');
  const langs = file.languages;
  if (!langs || !langs.source || langs.offered.length < 2) {
    box.hidden = true;
    box.innerHTML = '';
    notice.hidden = true;
    paintedLanguage = null;
    return;
  }
  const pick = readingLanguage();
  const wanted = pick === 'original' || !pick ? langs.source : pick;
  // a language the document is written in already — zh for a zh-Hant reader — reads as its original
  const asked = langs.offered.includes(wanted) ? wanted : langs.source;
  const others = langs.offered.filter((code) => code !== langs.source);
  const button = (value, code, label, title) =>
    `<button type="button" data-reading="${esc(value)}" class="${code === asked ? 'selected' : ''}" title="${esc(title)}">${esc(label)}</button>`;
  box.innerHTML = button('original', langs.source, `${languageName(langs.source)} · original`, 'Read every document in the language it was written in')
    + others.map((code) => button(code, code, languageName(code), `Read documents in ${languageInEnglish(code)} where a translation exists, and ask for this one's if it has none`)).join('');
  box.hidden = false;

  const state = langs.translations?.[asked];
  const translation = file.translation;
  paintedLanguage = { path, asked, status: state?.status ?? null };
  let text = '';
  let action = '';
  if (translation) {
    // reading a translation: never editable, the original is the file
    $('#btn-edit').disabled = true;
    const by = translation.model ? ` by ${translation.model}` : '';
    text = translation.done < translation.parts
      ? `Translated ${translation.done} of ${translation.parts} parts so far${by} — the rest still reads in ${languageInEnglish(langs.source)}. Read-only: edit the original.`
      : `Translated from ${languageInEnglish(langs.source)}${by}. Read-only: edit the original.`;
  } else if (asked !== langs.source && state) {
    const into = languageInEnglish(asked);
    if (state.status === 'requested') {
      text = `Queued for translation into ${into}${processingStatus?.processing && !processingStatus.processing.running ? ' — it runs once processing is started, or when a remote worker takes it' : ''}. Showing the original meanwhile.`;
    } else if (state.status === 'failed') {
      text = `The translation into ${into} failed${state.error ? `: ${state.error}` : ''}. Showing the original.`;
      action = 'try again';
    } else if (state.status === 'skipped') {
      text = `Nothing in this document to translate into ${into}.`;
    } else {
      // the primary language is the background's — for a raw/docs source, not a wiki page (an older service has no `background`)
      const background = asked === langs.primary && langs.background !== false;
      text = `Not translated into ${into} yet${background ? ' — documents in other languages are translated in the background, the newest first' : ''}. Showing the original.`;
      action = background ? 'translate next' : 'translate';
    }
  }
  notice.hidden = !text;
  $('#file-lang-notice-text').textContent = text;
  const go = $('#btn-translate');
  go.hidden = !action;
  go.textContent = action;
  go.dataset.lang = asked;
  // a translation under way is looked at again while the file stays open
  const pending = (translation && translation.done < translation.parts) || state?.status === 'requested' || state?.status === 'partial';
  if (pending) languageRefresh = setTimeout(() => refreshLanguages(path, translation?.done ?? -1), 20_000);
}

/** Repaint the open file when its translation moved on, keeping the reader's place. */
async function refreshLanguages(path, doneBefore) {
  if (currentFile !== path || editing) return;
  try {
    const file = await api(fileUrl(path));
    if (currentFile !== path || editing) return;
    const done = file.translation?.done ?? -1;
    if (done !== doneBefore) {
      const view = $('#file-view');
      const top = view.scrollTop;
      renderFileContent(path, file.content, file.derived, file.truncated, file.bytes);
      view.scrollTop = top;
    }
    paintLanguages(path, file);
  } catch {
    // the next open tries again
  }
}

/**
 * A pick is the reader's for every document from now on. A language the open
 * document has no translation into yet is asked for: picking it is wanting
 * this document in it, and without the request the pick would only show the
 * same original again.
 */
$('#file-langs').addEventListener('click', async (event) => {
  const value = event.target.closest?.('[data-reading]')?.dataset.reading;
  if (!value || !currentFile || editing) return;
  setReadingLanguage(value);
  const path = currentFile;
  await openFile(path);
  const painted = paintedLanguage;
  if (currentFile === path && !editing && painted?.path === path && painted.asked === value && painted.status === 'none') await requestTranslation(path, value);
});

/** Ask for the open document in `lang`: the Translate stage takes it next. */
async function requestTranslation(path, lang) {
  try {
    const r = await api('/api/file/translate', { method: 'POST', body: JSON.stringify({ path, lang }) });
    toast(r.status === 'done' ? 'Already translated' : r.processing ? `Queued: the ${languageInEnglish(lang)} translation is next` : `Queued — it is translated once processing is started, or when a remote worker takes it`, 5000);
    if (currentFile === path) void openFile(path);
  } catch (e) {
    toast(e.message, 5000);
  }
}

$('#btn-translate').addEventListener('click', () => {
  const path = currentFile;
  const lang = $('#btn-translate').dataset.lang;
  if (path && lang) void requestTranslation(path, lang);
});

/** Draw the eye to what a jump landed on. */
function flash(...els) {
  for (const el of els) {
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation on a second jump to the same place
    el.classList.add('flash');
  }
}

/** A citation's note in the list of notes. */
function scrollToNote(label) {
  const note = $('#file-view').querySelector(`[data-fn-def="${CSS.escape(label)}"]`);
  if (!note) return;
  note.scrollIntoView({ block: 'center', behavior: 'smooth' });
  flash(note);
}

/** Back from a note to the first place the text cites it. */
function scrollToCitation(label) {
  const ref = $('#file-view').querySelector(`[data-fn="${CSS.escape(label)}"]`);
  if (!ref) return;
  ref.scrollIntoView({ block: 'center', behavior: 'smooth' });
  flash(ref.closest('sup') ?? ref);
}

/**
 * Where a link's #fragment points: an export's entry anchor, which lights up
 * the whole entry (up to the next anchor or rule), else a heading with that text.
 */
/** The headings the Contents list names, in its order. */
let contentsHeadings = [];

/**
 * A book's chapters and sections in the toolbar (EPUB): its headings to the
 * third level, indented by depth. Picking one goes to it; the list then reads
 * "Contents" again, ready for the next jump.
 */
function paintContents(path) {
  const select = $('#file-contents');
  const headings = isBookPath(path) ? [...$('#file-view').querySelectorAll('h1, h2, h3')] : [];
  contentsHeadings = headings.length >= 2 ? headings : [];
  select.hidden = contentsHeadings.length === 0;
  if (select.hidden) {
    select.innerHTML = '';
    return;
  }
  const top = Math.min(...headings.map((h) => Number(h.tagName[1])));
  select.innerHTML = `<option value="" selected>Contents · ${headings.length}</option>` + headings.map((h, i) => {
    const text = h.textContent.trim().replace(/\s+/g, ' ');
    const label = text.length > 80 ? `${text.slice(0, 79)}…` : text;
    return `<option value="${i}">${' '.repeat(Number(h.tagName[1]) - top)}${esc(label)}</option>`;
  }).join('');
}

$('#file-contents').addEventListener('change', (event) => {
  const heading = contentsHeadings[Number(event.target.value)];
  event.target.value = '';
  if (!heading) return;
  heading.scrollIntoView({ block: 'start' });
  flash(heading);
});

function scrollToFragment(fragment) {
  const view = $('#file-view');
  const anchor = view.querySelector(`[data-anchor="${CSS.escape(fragment)}"]`);
  if (anchor) {
    const entry = [];
    for (let el = anchor.nextElementSibling; el && !el.matches('.md-anchor, hr'); el = el.nextElementSibling) entry.push(el);
    (entry[0] ?? anchor).scrollIntoView({ block: 'start' });
    flash(...entry);
    return;
  }
  const want = fragment.trim().toLowerCase();
  const slug = (s) => s.trim().toLowerCase().replace(/\s+/g, '-');
  const heading = [...view.querySelectorAll('h1, h2, h3, h4, h5, h6')].find((h) => h.textContent.trim().toLowerCase() === want || slug(h.textContent) === want);
  if (!heading) return;
  heading.scrollIntoView({ block: 'start' });
  flash(heading);
}

/* ------------------------- pages citing a raw file ------------------------ */

let citationRequest = 0;

/**
 * The wiki pages citing the open raw/docs file (src/graph/citations.ts), each
 * with how it cites it, above the text; nothing when none does. A slow answer
 * for a file the reader already left is dropped, as the mention marks are.
 */
async function loadFileCitations(path) {
  clearFileCitations();
  if (!path.startsWith('raw/docs/')) return;
  const request = citationRequest;
  try {
    const { citedBy } = await api(`/api/file/citations?path=${encodeURIComponent(path)}`);
    if (request !== citationRequest || currentFile !== path) return;
    paintFileCitations(citedBy ?? []);
  } catch {
    // the list is extra: the file reads the same without it
  }
}

function clearFileCitations() {
  citationRequest++;
  paintFileCitations([]);
}

function paintFileCitations(pages) {
  $('#file-citations').hidden = pages.length === 0;
  $('#file-citations-list').innerHTML = pages.map((page) => {
    const labels = [...new Set(page.links.map((l) => l.label.replace(/_/g, ' ')))].join(' · ');
    const via = [...new Set(page.links.map((l) => l.via))].join(', ');
    const badge = page.trust === 'quarantined'
      ? '<span class="trust quarantined" title="An agent wrote this page and nobody has promoted it yet">quarantined</span>'
      : '';
    return `<span class="citation"><a href="#" class="doc-link" data-path="${esc(page.path)}" title="${esc(`${page.path} — ${via}`)}">${esc(page.title || page.path)}</a> <span class="hint">${esc(labels)}</span>${badge}</span>`;
  }).join('');
}

$('#file-citations-list').addEventListener('click', (event) => {
  const link = event.target.closest('a.doc-link');
  if (!link) return;
  event.preventDefault();
  followTo(link.dataset.path);
});

/* -------------------------- entities in the text -------------------------- */

let mentionRequest = 0;

/** Ask which known entities the painted text names, then mark them — unless another paint came first. */
async function markFileMentions(path, content) {
  const request = ++mentionRequest;
  try {
    const { mentions } = await api('/api/entities/mentions', { method: 'POST', body: JSON.stringify({ text: content, path }) });
    if (request !== mentionRequest || currentFile !== path) return;
    markMentions($('#file-view'), mentions ?? []);
  } catch {
    // marking is extra: the file reads the same without it
  }
}

/**
 * Turn the entities' names into links that open the entity panel, in their
 * type's colour: the first mention of each per section, outside headings,
 * links, code, the metadata panel and the notes, so the text stays readable.
 */
function markMentions(view, mentions) {
  const matcher = window.knodeMarkdown?.mentionMatcher(mentions);
  if (!matcher || matcher.empty) return;
  // a chart's labels are SVG text: a mention link wrapped around one would make it vanish
  const SKIP = 'a, code, pre, sup, .md-meta, .footnotes, .kchart';
  const runs = [];
  let seen = new Set();
  const walker = document.createTreeWalker(view, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.parentElement.closest('h1, h2, h3, h4, h5, h6') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      if (/^H[1-3]$/.test(node.tagName)) return NodeFilter.FILTER_ACCEPT; // a new section
      return node.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) seen = new Set();
    else runs.push({ node, seen });
  }
  for (const { node, seen: section } of runs) {
    const pieces = matcher.split(node.data);
    if (!pieces.some((p) => p.mention && !section.has(p.mention.id))) continue;
    const frag = document.createDocumentFragment();
    for (const piece of pieces) {
      if (!piece.mention || section.has(piece.mention.id)) {
        frag.append(piece.text);
        continue;
      }
      section.add(piece.mention.id);
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'entity-mention';
      a.dataset.entity = piece.mention.id;
      a.title = `${piece.mention.type} · ${piece.mention.name}`;
      a.textContent = piece.text;
      a.style.setProperty('--entity', entityColor(piece.mention.type));
      frag.append(a);
    }
    node.replaceWith(frag);
  }
}

$('#file-view').addEventListener('click', async (event) => {
  const anchor = event.target.closest('a');
  if (!anchor || !currentFile) return;
  if (anchor.dataset.fn || anchor.dataset.fnBack || anchor.dataset.entity) {
    event.preventDefault();
    if (anchor.dataset.fn) scrollToNote(anchor.dataset.fn);
    else if (anchor.dataset.fnBack) scrollToCitation(anchor.dataset.fnBack);
    else openEntity(anchor.dataset.entity);
    return;
  }
  const wikiTarget = anchor.dataset.wikilink;
  const href = anchor.getAttribute('href') || '';
  const target = wikiTarget || href;
  if (!target || (!wikiTarget && /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target))) return;

  event.preventDefault();
  try {
    const resolved = await api(`/api/link/resolve?target=${encodeURIComponent(target)}&from=${encodeURIComponent(currentFile)}`);
    // a name with no note behind it that the graph knows opens the entity's panel
    if (resolved.entity) {
      openEntity(resolved.entity.id);
      return;
    }
    if (resolved.path === currentFile) {
      if (resolved.fragment) scrollToFragment(resolved.fragment);
      return;
    }
    await followTo(resolved.path, resolved.fragment);
  } catch (e) {
    toast(`link unavailable: ${e.message}`);
  }
});

function paintBack() {
  const last = fileTrail.at(-1);
  $('#btn-back').hidden = !last;
  $('#btn-back').title = last ? `Back to ${last.path}` : '';
}

async function followTo(path, fragment = null) {
  if (currentFile && currentFile !== path) {
    fileTrail.push({ path: currentFile, scrollTop: $('#file-view').scrollTop });
    if (fileTrail.length > 50) fileTrail.shift();
  }
  await showInTree(path);
  await openFile(path, null, fragment);
  paintBack();
}

$('#btn-back').addEventListener('click', async () => {
  const last = fileTrail.pop();
  paintBack();
  if (!last) return;
  await showInTree(last.path);
  await openFile(last.path);
  $('#file-view').scrollTop = last.scrollTop;
});

$('#btn-load-full').addEventListener('click', loadFullFile);

$('#btn-edit').addEventListener('click', () => {
  editing = !editing;
  $('#file-view').hidden = editing;
  $('#file-editor').hidden = !editing;
  $('#btn-edit').textContent = editing ? 'preview' : 'edit';
  $('#btn-save').disabled = !editing;
  if (!editing) paintFileView(currentFile, $('#file-editor').value);
});

$('#btn-save').addEventListener('click', async () => {
  try {
    await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: currentFile, content: $('#file-editor').value }) });
    toast(`saved ${currentFile}`);
    paintFileView(currentFile, $('#file-editor').value);
    // a written purpose.md, say, answers a notice
    loadNotices();
  } catch (e) {
    toast(`save failed: ${e.message}`);
  }
});

/* ------------------------------ entity panel ------------------------------ */

/**
 * The panel a marked name opens beside the file: the entity, its relations
 * folded per neighbour, who its documents mention alongside it, its claims
 * and the documents that mention it most. A neighbour opens in the same
 * panel, and ‹ walks back. Reading stays where it was: a wiki page, when the
 * entity has one, is a button away, not where the click lands.
 */
const entityPanel = { trail: [], request: 0 };

async function openEntity(id, { back = false } = {}) {
  const panel = $('#entity-panel');
  const request = ++entityPanel.request;
  panel.hidden = false;
  if (!back) {
    if (entityPanel.trail.at(-1) !== id) entityPanel.trail.push(id);
  }
  $('#entity-panel-back').hidden = entityPanel.trail.length < 2;
  $('#entity-panel-body').innerHTML = '<p class="hint">loading…</p>';
  try {
    const detail = await api(`/api/entities/detail?id=${encodeURIComponent(id)}`);
    if (request !== entityPanel.request) return;
    renderEntityPanel(detail);
  } catch (e) {
    if (request !== entityPanel.request) return;
    $('#entity-panel-body').innerHTML = `<p class="hint">${esc(e.message)}</p>`;
  }
}

function closeEntityPanel() {
  entityPanel.request++;
  entityPanel.trail = [];
  $('#entity-panel').hidden = true;
}

$('#entity-panel-close').addEventListener('click', closeEntityPanel);
$('#entity-panel-back').addEventListener('click', () => {
  if (entityPanel.trail.length < 2) return;
  entityPanel.trail.pop();
  openEntity(entityPanel.trail.at(-1), { back: true });
});

/** A relation as the panel reads it from the open entity's side: `→ supplies to`, `← invested in`, `↔ partner of`. */
function relationLabel(relation) {
  const way = KnodeGraph.UNDIRECTED.has(relation.type) ? '↔' : relation.direction === 'out' ? '→' : '←';
  return `${way} ${KnodeGraph.relationName({ type: relation.type })}`;
}

function renderEntityPanel(d) {
  const e = d.entity;
  const pill = (type) => `<span class="tpill" data-type="${esc(type)}">${esc(type)}</span>`;
  const family = (type) => KnodeGraph.family(type).color;
  const groups = d.relations.map((g) => `<div class="nb" data-entity="${esc(g.other.id)}">
      ${pill(g.other.type)}<span class="nb-name">${esc(g.other.name)}</span>
      <span class="nb-rels">${g.relations.map((r) => `<span class="nb-rel" title="${esc(r.description || r.type)}"><span class="rel-swatch" data-rel="${esc(r.type)}"></span>${esc(relationLabel(r))}</span>`).join('')}</span>
    </div>`).join('');
  const co = d.cooccurring.map((x) => `<button class="chip" data-entity="${esc(x.id)}" title="${x.documents} shared ${x.documents === 1 ? 'document' : 'documents'}"><span class="dot" data-type="${esc(x.type)}"></span>${esc(x.name)}</button>`).join('');
  const claims = d.claims.map((cl) => `<div class="hint">◈ ${esc(cl.statement.slice(0, 200))} <span class="mono">[${esc(cl.status)}]</span></div>`).join('');
  const docs = d.documents.map((doc) => `<a href="#" class="doc-link mono" data-path="${esc(doc.path)}" title="${esc(doc.path)}">${esc(doc.title || doc.path)}</a>`).join('');
  const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const numbers = [count(e.mentionCount, 'mention'), count(e.documentCount, 'document'), `degree ${e.degree}`].join(' · ');
  $('#entity-panel-body').innerHTML = `<div class="entity-card selected">
      ${pill(e.type)} <span class="ename">${esc(e.name)}</span>
      ${e.aliases.length ? `<div class="hint">also ${e.aliases.map(esc).join(' · ')}</div>` : ''}
      ${e.description ? `<div class="hint">${esc(e.description.slice(0, 400))}</div>` : ''}
      <div class="hint mono">${esc(numbers)}</div>
      <div class="actions">
        <button data-wiki${e.wikiPath ? ` title="${esc(e.wikiPath)}"` : ' disabled title="no wiki page yet"'}>open wiki page</button>
        <button data-graph>show in graph</button>
        <button data-search title="Explore → Search: the passages, relations and claims its name finds">search</button>
      </div>
    </div>
    <div class="entity-card"><b>${d.relations.length ? `relations · ${d.relations.length + d.moreRelations}` : 'no typed relations yet'}</b>${groups}
      ${d.moreRelations ? `<div class="hint">+${d.moreRelations} more in the graph</div>` : ''}</div>
    ${co ? `<div class="entity-card"><b>mentioned alongside</b><div class="chips">${co}</div></div>` : ''}
    ${claims ? `<div class="entity-card"><b>claims</b>${claims}</div>` : ''}
    ${docs ? `<div class="entity-card"><b>mentioned in</b>${docs}</div>` : ''}`;
  const body = $('#entity-panel-body');
  for (const p of body.querySelectorAll('.tpill')) p.style.color = entityColor(p.dataset.type);
  for (const dot of body.querySelectorAll('.dot[data-type]')) dot.style.background = entityColor(dot.dataset.type);
  for (const sw of body.querySelectorAll('.rel-swatch[data-rel]')) sw.style.background = family(sw.dataset.rel);
  for (const el of body.querySelectorAll('[data-entity]')) el.addEventListener('click', () => openEntity(el.dataset.entity));
  for (const a of body.querySelectorAll('.doc-link')) {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      followTo(a.dataset.path);
    });
  }
  const wiki = body.querySelector('[data-wiki]');
  if (e.wikiPath) wiki.addEventListener('click', () => followTo(e.wikiPath));
  body.querySelector('[data-search]').addEventListener('click', () => runSearch(e.name));
  body.querySelector('[data-graph]').addEventListener('click', () => {
    navigate('graph');
    loadGraph(e.name);
  });
}

$('#btn-delete').addEventListener('click', () => {
  if (currentFile) deleteNode({ path: currentFile, kind: 'file' });
});

// writing something new and bringing material in are two intents (docs/design/20 D10):
// ＋ makes a file or folder here, Import data brings files, folders and agent traces in
$('#btn-add').addEventListener('click', (ev) => {
  const dir = targetDir();
  showMenuUnder(ev.currentTarget, [
    { label: 'New file…', run: () => newFile(dir) },
    { label: 'New folder…', run: () => newFolder(dir) },
  ]);
});

$('#btn-import').addEventListener('click', (ev) => {
  const dir = targetDir();
  const folders = mayImportFolders();
  showMenuUnder(ev.currentTarget, [
    { label: `Files… → ${uploadTarget()}/`, run: () => pickUpload('files') },
    { label: `Folder… → ${uploadTarget()}/`, run: () => pickUpload('folder') },
    '-',
    { label: folders ? 'Folder from this Mac (copy once)…' : 'Folder from this Mac — administrators only', disabled: !folders, run: () => importLocalFolder('copy', dir) },
    { label: folders ? 'Link a folder from this Mac (keep in sync)…' : 'Link a folder — administrators only', disabled: !folders, run: () => importLocalFolder('link', dir) },
    '-',
    { label: folders ? 'Feishu documents or a wiki (import once)…' : 'Feishu documents — administrators only', disabled: !folders, run: () => importFeishuDoc('copy') },
    { label: folders ? 'Link Feishu documents or a wiki (keep in sync)…' : 'Link Feishu documents — administrators only', disabled: !folders, run: () => importFeishuDoc('link') },
    '-',
    { label: folders ? 'Code repository from GitHub or a git URL…' : 'Code repository — administrators only', disabled: !folders, run: () => openCodebases({ add: true }) },
    { label: 'Code repositories — update, edit or remove…', disabled: !mayUse('files'), run: () => openCodebases() },
    '-',
    { label: folders ? 'Agent conversations — pick Claude Code and Codex sessions…' : 'Agent conversations — administrators only', disabled: !folders, run: () => openAgentConversations() },
    { label: 'Agent traces — every Claude Code and Codex session, for Dream', disabled: !mayUse('traces'), run: () => collectTraces() },
  ]);
});

/* ------------------------ folders from this Mac -------------------------- */

/** Importing reads this Mac's own disk, so it is an administrator's call (the server puts it under `settings`). */
const mayImportFolders = () => authDisabled || serverAuth?.groups?.settings === true;

const fmtCount = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Import a folder that lives on this Mac, by its absolute path: copied once
 * (`copy`) or mirrored and kept in sync (`link`). The browser cannot hand over
 * a local path, so it is typed; the service reads the folder and says what it
 * would carry before anything is written.
 */
async function importLocalFolder(mode, dir) {
  const verb = mode === 'link' ? 'link' : 'import';
  const source = prompt(
    mode === 'link'
      ? 'Absolute path of the folder on this Mac to link.\nIts files are mirrored into raw/docs and kept in sync: every change there is indexed, and the copies are read-only here.'
      : 'Absolute path of the folder on this Mac to import.\nIts files are copied once into raw/docs with the folder structure kept.',
    lastImportSource || '/Users/',
  );
  if (source === null) return;
  const trimmed = source.trim();
  if (!trimmed) return;
  lastImportSource = trimmed;
  // the picked folder when it can take the mirror, else the root of raw/docs
  const base = isWritable(dir) && /^raw\/docs(\/|$)/.test(dir) && !mirroredSource(dir) ? dir : 'raw/docs';
  const name = trimmed.replace(/\/+$/, '').split('/').pop();
  toast('reading the folder…', 60000);
  let plan;
  try {
    plan = await api('/api/folders/preview', { method: 'POST', body: JSON.stringify({ source: trimmed, dest: `${base}/${name}` }) });
  } catch (e) {
    toast(`${verb} failed: ${e.message}`, 6000);
    return;
  }
  if (plan.linked) {
    toast(`${plan.linked.dest} is already linked to ${plan.linked.source}`, 6000);
    return;
  }
  const lines = [
    `${mode === 'link' ? 'Link' : 'Import'} ${plan.source}`,
    `→ ${plan.dest}`,
    '',
    `${fmtCount(plan.files, 'file')}, ${fmtBytes(plan.bytes)}${plan.sample.length ? ` — e.g. ${plan.sample.slice(0, 3).join(', ')}` : ''}.`,
  ];
  if (plan.tooLarge) lines.push(`${fmtCount(plan.tooLarge, 'file')} over ${fmtBytes(EDIT_BYTE_CAP)} will be copied but not indexed.`);
  if (plan.skippedByType) lines.push(`${fmtCount(plan.skippedByType, 'file')} of types knode-os cannot index stay behind.`);
  if (plan.exists) lines.push('', `${plan.dest} already exists: it becomes a mirror of this folder, and files only it has are removed.`);
  if (mode === 'link') lines.push('', 'The copies are kept in sync while knode-os runs. Edit the originals, not the copies.');
  lines.push('', 'Continue?');
  if (!confirm(lines.join('\n'))) return;
  toast(`${mode === 'link' ? 'linking' : 'importing'} ${fmtCount(plan.files, 'file')} — copying and indexing…`, 600000);
  try {
    const res = await api('/api/folders/import', { method: 'POST', body: JSON.stringify({ source: trimmed, dest: plan.dest, mode, replace: plan.exists }) });
    reveal(res.dest);
    await loadTree();
    loadStats();
    const indexed = res.sync ? ` · ${res.sync.indexed} indexed${res.sync.skipped ? `, ${res.sync.skipped} skipped` : ''}` : res.indexing ? ' · indexing in the background' : '';
    toast(`${mode === 'link' ? 'linked' : 'imported'} ${res.dest}: ${fmtCount(res.copied.length, 'file')} copied${indexed}`, 6000);
  } catch (e) {
    toast(`${verb} failed: ${e.message}`, 6000);
  }
}

async function syncLinkedFolder(dest) {
  toast(`syncing ${dest} from its source…`, 600000);
  try {
    const { results } = await api('/api/folders/sync', { method: 'POST', body: JSON.stringify({ dest }) });
    const r = results[0];
    await loadTree();
    loadStats();
    if (!r) toast('nothing to sync');
    else if (r.sourceMissing) toast(`${dest}: its source folder is not there — nothing changed`, 5000);
    else toast(`${dest}: ${r.copied} copied, ${r.removed} removed${r.sync ? ` · ${r.sync.indexed} indexed, ${r.sync.disposed} disposed` : ' · already up to date'}`, 5000);
  } catch (e) {
    toast(`sync failed: ${e.message}`, 5000);
  }
}

async function unlinkFolderNode(node, removeFiles) {
  const source = linkedDests.get(node.path);
  const files = removeFiles ? await filesUnder(node.path) : null;
  const question = removeFiles
    ? `Unlink ${node.path} from ${source} and delete the ${files === null ? 'copied files' : fmtCount(files, 'copied file')}?\n\nTheir knowledge is disposed (history stays in the ledger). The originals are not touched.`
    : `Unlink ${node.path} from ${source}?\n\nThe copies stay as ordinary documents and stop following the source.`;
  if (!confirm(question)) return;
  toast(removeFiles ? `unlinking and removing ${node.path}…` : `unlinking ${node.path}…`, 600000);
  try {
    await api(`/api/folders?dest=${encodeURIComponent(node.path)}&removeFiles=${removeFiles ? 1 : 0}`, { method: 'DELETE' });
    if (removeFiles && currentFile && (currentFile === node.path || currentFile.startsWith(`${node.path}/`))) {
      currentFile = null;
      $('#file-path').textContent = '';
      $('#file-view').innerHTML = '';
      setFileNotice(null);
      clearFileCitations();
      $('#btn-edit').disabled = true;
      $('#btn-delete').disabled = true;
    }
    await loadTree();
    loadStats();
    toast(removeFiles ? `unlinked and removed ${node.path}` : `unlinked ${node.path} — its files stay as ordinary documents`, 5000);
  } catch (e) {
    toast(`unlink failed: ${e.message}`, 5000);
  }
}

/* ---------------------------- Feishu documents --------------------------- */

/**
 * Feishu is read as this machine's signed-in Feishu user (lark-cli, see
 * src/ingest/feishu/client.ts). With nobody signed in, or a scope missing,
 * this runs the one-time authorization: a Feishu page to approve on, then a
 * wait until lark-cli holds the token. True once reading can start.
 */
async function ensureFeishuSignedIn() {
  let status;
  try {
    status = await api('/api/feishu/auth');
  } catch (e) {
    toast(`Feishu: ${e.message}`, 6000);
    return false;
  }
  if (!status.installed) {
    alert(`lark-cli, which knode-os reads Feishu through, is not installed where the service runs.\n\n${status.error || ''}\n\nInstall it (https://github.com/larksuite/cli), then try again.`);
    return false;
  }
  if (status.signedIn && !status.missingScopes.length) return true;
  const why = status.signedIn
    ? `Feishu is signed in as ${status.user?.name || 'someone'}, without leave to ${status.missingScopes.join(', ')}.`
    : 'No Feishu account is signed in on this machine yet.';
  if (!confirm(`${why}\n\nAuthorize once: a Feishu page opens where you let knode-os read documents — with their pictures and attachments — as your Feishu account. It stays authorized as long as knode-os keeps using it.\n\nContinue?`)) return false;
  let begun;
  try {
    begun = await api('/api/feishu/auth/login', { method: 'POST' });
  } catch (e) {
    toast(`Feishu sign-in failed: ${e.message}`, 6000);
    return false;
  }
  const link = begun.signIn.verificationUrl;
  // after an await a browser may refuse a new tab: then the link is handed over to open by hand
  if (!window.open(link, '_blank', 'noopener')) prompt('Open this link to approve knode-os in Feishu (on any device):', link);
  toast('approve knode-os on the Feishu page — waiting…', 600000);
  const deadline = Date.parse(begun.signIn.expiresAt) || Date.now() + 600000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    let now;
    try {
      now = await api('/api/feishu/auth');
    } catch {
      continue;
    }
    if (now.signIn.state === 'done' && now.signedIn) {
      toast(`signed in to Feishu as ${now.user?.name || 'you'}`, 4000);
      return true;
    }
    if (now.signIn.state === 'failed') {
      toast(`Feishu sign-in failed: ${now.signIn.error}`, 6000);
      return false;
    }
  }
  toast('the Feishu sign-in link expired before it was approved', 6000);
  return false;
}

/**
 * Bring Feishu documents in by their links: copied once (`copy`) or mirrored
 * and kept in sync (`link`). Several links go in one batch; a wiki page can
 * bring the pages under it, and a wiki space all of its pages, as folders
 * that keep the wiki's structure. The service looks each link up first —
 * which also proves the signed-in account may read it — and says what it
 * would bring; a batch or a tree then imports in the background, followed
 * here until it ends.
 */
async function importFeishuDoc(mode) {
  if (!(await ensureFeishuSignedIn())) return;
  feishuDialog.mode = mode;
  feishuDialog.plan = null;
  feishuDialog.job = null;
  $('#feishu-dialog-title').textContent = mode === 'link' ? 'Link Feishu documents' : 'Import Feishu documents';
  $('#feishu-dialog-hint').textContent = mode === 'link'
    ? 'Each is mirrored into raw/docs with its pictures and kept in sync: once a day knode-os asks Feishu which were edited and fetches those (Tasks → Check now asks at once). The copies here are read-only; edit them in Feishu.'
    : 'Each is copied once into raw/docs with its pictures and its PDF and text attachments; from then on the copies are ordinary documents.';
  $('#feishu-urls').value = lastFeishuUrl;
  $('#feishu-urls').disabled = false;
  $('#feishu-subpages').disabled = false;
  $('#feishu-plan').hidden = true;
  $('#feishu-plan').innerHTML = '';
  $('#feishu-error').textContent = '';
  paintFeishuButtons();
  $('#feishu-dialog').showModal();
  setTimeout(() => $('#feishu-urls').focus(), 0);
}

const feishuDialog = { mode: 'copy', plan: null, job: null, busy: false };

/** The links typed, one per line (or separated by spaces or commas), each once. */
const feishuLinksTyped = () => [...new Set($('#feishu-urls').value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];

/** The looked-up links that would import: readable, not linked already, and not the same document or wiki as a link above. */
function feishuReady(plan) {
  const seen = new Set();
  return plan.items.filter((i) => {
    if (!i.ok || i.preview.linked) return false;
    i.repeat = seen.has(i.preview.token);
    seen.add(i.preview.token);
    return !i.repeat;
  });
}

function paintFeishuButtons() {
  const { mode, plan, job, busy } = feishuDialog;
  const go = $('#btn-feishu-go');
  const ready = plan ? feishuReady(plan) : [];
  const finished = job && job.state !== 'running';
  $('#btn-feishu-lookup').hidden = Boolean(job);
  $('#btn-feishu-lookup').disabled = busy;
  $('#btn-feishu-cancel').textContent = job && !finished ? 'Close — it goes on' : finished ? 'Close' : 'Cancel';
  go.hidden = Boolean(job);
  go.disabled = busy || ready.length === 0;
  const verb = mode === 'link' ? 'Link' : 'Import';
  const pages = ready.reduce((n, i) => n + (i.preview.pages ? i.preview.pages.documents : 1), 0);
  go.textContent = ready.length === 0 ? verb : ready.length === 1 && !ready[0].preview.pages ? verb : `${verb} ${fmtCount(pages, 'document')}`;
}

function feishuItemHtml(cls, mark, title, lines) {
  return `<div class="feishu-item ${cls}"><span class="mark">${mark}</span><div><b>${esc(title)}</b>${lines.filter(Boolean).map((l) => `<div class="hint">${l}</div>`).join('')}</div></div>`;
}

function paintFeishuPlan() {
  const { plan } = feishuDialog;
  const el = $('#feishu-plan');
  el.hidden = !plan;
  if (!plan) return;
  el.innerHTML = plan.items.map((i) => {
    if (!i.ok) return feishuItemHtml('bad', '✕', i.input, [esc(i.error)]);
    const p = i.preview;
    const what = p.pages
      ? `a wiki ${p.wiki ? 'page' : 'space'} with ${fmtCount(p.pages.total, 'page')} — ${fmtCount(p.pages.documents, 'document')} come${p.pages.documents === 1 ? 's' : ''} as folders${p.pages.levels > 1 ? `, ${p.pages.levels} levels deep` : ' side by side'}${p.pages.keptInFeishu ? `; ${p.pages.keptInFeishu} of another kind (sheets, bases…) stay in Feishu` : ''}`
      : `last edited ${p.modifiedAt ? new Date(p.modifiedAt).toLocaleString() : 'at an unknown time'}`;
    if (p.linked) return feishuItemHtml('', '•', p.title, [`linked already at <span class="mono">${esc(p.linked.dest)}</span> — left out; right-click it there to check for edits`]);
    if (i.repeat) return feishuItemHtml('', '•', p.title, ['the same as a link above — left out']);
    return feishuItemHtml('ok', '✓', p.title, [
      esc(what),
      `→ <span class="mono">${esc(p.dest)}</span>`,
      p.existing ? (feishuDialog.mode === 'link' ? 'imported before: that copy becomes the linked mirror' : 'imported before: that copy is brought up to date') : '',
    ]);
  }).join('');
}

function paintFeishuJob() {
  const { job } = feishuDialog;
  const el = $('#feishu-plan');
  el.hidden = false;
  const head = job.state === 'running'
    ? `${feishuDialog.mode === 'link' ? 'Linking' : 'Importing'} — ${job.done} of ${job.inputs.length} done`
    : job.state === 'failed'
      ? `Stopped: ${job.error}`
      : `Done${job.indexing ? ' — indexing in the background' : ''}`;
  el.innerHTML = `<p class="hint">${esc(head)}</p>` + job.inputs.map((input, n) => {
    const item = job.items[n];
    if (item && !item.ok) return feishuItemHtml('bad', '✕', input, [esc(item.error)]);
    if (item) {
      const r = item.result;
      const what = r.pages ? `${fmtCount(r.pages.documents, 'document')} of ${fmtCount(r.pages.total, 'page')}, ${r.pages.fetched} fetched` : `revision ${r.revision}`;
      return feishuItemHtml('ok', '✓', r.title, [`${esc(what)} · ${fmtCount(r.images, 'picture')}, ${fmtCount(r.attachments, 'attachment')}${r.warnings.length ? ` · ${fmtCount(r.warnings.length, 'warning')} in the log` : ''}`, `→ <span class="mono">${esc(r.dest)}</span>`]);
    }
    return feishuItemHtml('', job.current === input ? '⟳' : '·', input, [job.current === input ? 'fetching it and its pictures…' : 'waiting']);
  }).join('');
}

async function lookUpFeishuLinks() {
  const urls = feishuLinksTyped();
  $('#feishu-error').textContent = '';
  if (!urls.length) {
    $('#feishu-error').textContent = 'Paste at least one Feishu link.';
    return;
  }
  lastFeishuUrl = urls.join('\n');
  const subpages = $('#feishu-subpages').checked;
  feishuDialog.busy = true;
  feishuDialog.plan = null;
  paintFeishuButtons();
  $('#feishu-plan').hidden = false;
  $('#feishu-plan').innerHTML = `<p class="hint">looking ${fmtCount(urls.length, 'link')} up in Feishu${subpages ? ', with the pages under wiki pages' : ''}…</p>`;
  try {
    const { items } = await api('/api/feishu/preview', { method: 'POST', body: JSON.stringify({ urls, subpages }) });
    feishuDialog.plan = { urls, subpages, items };
    feishuReady(feishuDialog.plan);
    paintFeishuPlan();
  } catch (e) {
    $('#feishu-plan').hidden = true;
    $('#feishu-error').textContent = e.message;
  } finally {
    feishuDialog.busy = false;
    paintFeishuButtons();
  }
}

async function runFeishuImport() {
  const { plan, mode } = feishuDialog;
  if (!plan || plan.urls.join('\n') !== feishuLinksTyped().join('\n') || plan.subpages !== $('#feishu-subpages').checked) return lookUpFeishuLinks();
  const urls = feishuReady(plan).map((i) => i.input);
  if (!urls.length) return;
  feishuDialog.busy = true;
  paintFeishuButtons();
  $('#feishu-error').textContent = '';
  try {
    const res = await api('/api/feishu/import', { method: 'POST', body: JSON.stringify({ urls, mode, subpages: plan.subpages }) });
    if (!res.job) {
      // one document: written already, indexed in the background
      $('#feishu-dialog').close();
      reveal(res.dest);
      await loadTree();
      loadStats();
      const verb = res.refreshed ? 'refreshed' : mode === 'link' ? 'linked' : 'imported';
      toast(`${verb} "${res.title}": ${fmtCount(res.images, 'picture')}, ${fmtCount(res.attachments, 'attachment')}${res.indexing ? ' · indexing in the background' : ''}${res.warnings.length ? ` · ${fmtCount(res.warnings.length, 'warning')} in the log` : ''}`, 8000);
      return;
    }
    $('#feishu-urls').disabled = true;
    $('#feishu-subpages').disabled = true;
    await followFeishuJob(res.job);
  } catch (e) {
    $('#feishu-error').textContent = e.message;
  } finally {
    feishuDialog.busy = false;
    if ($('#feishu-dialog').open) paintFeishuButtons();
  }
}

/** Follow a background import while the dialog is open; closing it leaves the import running (Tasks → Background). */
async function followFeishuJob(job) {
  feishuDialog.job = job;
  paintFeishuButtons();
  while (feishuDialog.job === job && job.state === 'running') {
    paintFeishuJob();
    await new Promise((r) => setTimeout(r, 1500));
    if (!$('#feishu-dialog').open || feishuDialog.job !== job) return;
    try {
      job = await api(`/api/feishu/import/${encodeURIComponent(job.id)}`);
      feishuDialog.job = job;
    } catch {
      // the next round asks again
    }
  }
  paintFeishuJob();
  paintFeishuButtons();
  await loadTree();
  loadStats();
  const ok = job.items.filter((i) => i.ok);
  if (ok.length === 1) reveal(ok[0].result.dest);
  const failed = job.items.length - ok.length;
  toast(`${feishuDialog.mode === 'link' ? 'linked' : 'imported'} ${fmtCount(ok.length, 'link')}${failed ? `, ${failed} failed` : ''}${job.indexing ? ' · indexing in the background' : ''}`, 8000);
}

$('#btn-feishu-cancel').addEventListener('click', () => {
  if (feishuDialog.job?.state === 'running') toast('the import goes on in the background — Tasks → Background shows it', 5000);
  feishuDialog.job = null;
  $('#feishu-dialog').close();
});
$('#btn-feishu-lookup').addEventListener('click', () => lookUpFeishuLinks());
$('#feishu-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  runFeishuImport();
});
// a changed list is looked up again before it imports
$('#feishu-urls').addEventListener('input', () => {
  if (!feishuDialog.plan) return;
  feishuDialog.plan = null;
  paintFeishuPlan();
  paintFeishuButtons();
});
$('#feishu-subpages').addEventListener('change', () => {
  feishuDialog.plan = null;
  paintFeishuPlan();
  paintFeishuButtons();
});

/* -------------------------- code repositories ---------------------------- */

/**
 * Library → Import data → Code repositories (docs/design/25): repositories
 * kept at one commit under raw/codebase/<name>/, each with a card and its
 * documentation in raw/docs/codebase/. Adding fetches from the network onto
 * the service's machine, so it is an administrator's call; whoever may sync
 * the files may update, edit and remove what is there. A fetch runs in the
 * background as a `codebase` activity, which the dialog follows while open.
 */
const codebaseState = { entries: [], running: false, activity: [], recent: [], editing: null, confirming: null, busy: false, timer: null, seq: 0, wasRunning: false };
const CODEBASE_POLL_MS = 2500;

/** Globs typed one per line (or comma-separated), as the routes take them. */
const globsTyped = (sel) => [...new Set($(sel).value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];

function openCodebases({ add = false, edit = null } = {}) {
  codebaseState.editing = null;
  codebaseState.confirming = null;
  // only a fetch watched from here ends with a toast and a redrawn tree
  codebaseState.wasRunning = false;
  $('#codebase-error').textContent = '';
  resetCodebaseForm();
  $('#codebase-dialog').showModal();
  loadCodebases().then(() => {
    if (edit) beginCodebaseEdit(edit);
  });
  if (add && mayImportFolders()) setTimeout(() => $('#codebase-repo').focus(), 0);
}

function resetCodebaseForm() {
  for (const id of ['#codebase-repo', '#codebase-name', '#codebase-ref', '#codebase-include', '#codebase-exclude']) $(id).value = '';
  $('#codebase-follow').checked = false;
  $('#codebase-docs').checked = true;
  paintCodebaseForm();
}

async function loadCodebases() {
  const seq = ++codebaseState.seq;
  try {
    const res = await api('/api/codebases');
    if (seq !== codebaseState.seq) return;
    const finished = codebaseState.wasRunning && !res.running;
    Object.assign(codebaseState, { entries: res.codebases, running: res.running, activity: res.activity ?? [], recent: res.recent ?? [], wasRunning: res.running });
    paintCodebases();
    if (finished) codebaseFetchEnded();
  } catch (e) {
    if (seq !== codebaseState.seq) return;
    $('#codebase-list').innerHTML = '';
    $('#codebase-error').textContent = e.message;
  }
  scheduleCodebasePoll();
}

/** Look again in a moment while something is fetching and the dialog is open. */
function scheduleCodebasePoll() {
  clearTimeout(codebaseState.timer);
  if (!codebaseState.running || !$('#codebase-dialog').open) return;
  codebaseState.timer = setTimeout(() => { if (!document.hidden) loadCodebases(); else scheduleCodebasePoll(); }, CODEBASE_POLL_MS);
}

/** A fetch the dialog watched has ended: the tree and the counts change with it, and a failure is said. */
async function codebaseFetchEnded() {
  const last = codebaseState.recent[0];
  if (last && !last.ok) $('#codebase-error').textContent = `${last.label}: ${last.detail ?? 'failed'}`;
  else if (last) toast(`${last.label} — ${last.detail ?? 'done'}`, 6000);
  await loadTree();
  loadStats();
}

function paintCodebases() {
  paintCodebaseActivity();
  const list = $('#codebase-list');
  const { entries } = codebaseState;
  if (!entries.length) {
    list.innerHTML = `<p class="hint">No repository is kept in this workspace yet.${mayImportFolders() ? ' Add one below.' : ''}</p>`;
    paintCodebaseForm();
    return;
  }
  const mayChange = mayUse('files');
  list.innerHTML = entries.map((e, n) => {
    const confirming = codebaseState.confirming === e.name;
    const where = e.web ? `<a href="${esc(e.web)}" target="_blank" rel="noopener">${esc(e.web.replace(/^https:\/\//, ''))} ↗</a>` : `<span class="mono">${esc(e.url)}</span>`;
    const commit = e.commit
      ? `<span class="mono" title="${esc(e.commit)}">${esc(e.commit.slice(0, 12))}</span>${e.committedAt ? ` of ${esc(new Date(e.committedAt).toLocaleDateString([], { dateStyle: 'medium' }))}` : ''}`
      : 'not fetched yet';
    const narrowed = [
      e.include?.length ? `only ${e.include.map((g) => `<span class="mono">${esc(g)}</span>`).join(', ')}` : '',
      e.exclude?.length ? `without ${e.exclude.map((g) => `<span class="mono">${esc(g)}</span>`).join(', ')}` : '',
      e.docs === false ? 'documentation not copied' : '',
    ].filter(Boolean).join(' · ');
    const actions = mayChange && !confirming
      ? `<div class="codebase-actions">
          <button type="button" class="row-action" data-update ${codebaseState.busy ? 'disabled' : ''} title="Fetch ${esc(e.ref || 'its default branch')} again and index what changed">Update now</button>
          <button type="button" class="row-action" data-edit ${codebaseState.busy ? 'disabled' : ''} title="Change the branch, the globs, following or the documentation copy">Edit</button>
          <button type="button" class="row-action danger" data-remove ${codebaseState.busy ? 'disabled' : ''}>Remove…</button>
        </div>`
      : '';
    const confirm = confirming
      ? `<div class="codebase-confirm">
          <b>Remove ${esc(e.name)}?</b>
          <label class="check-row"><input type="checkbox" data-keep /> Keep its files, card and documentation as plain workspace content</label>
          <div class="hint" data-keep-hint>Its ${fmtCount(e.files, 'file')} in <span class="mono">${esc(e.dir)}</span>, its card and documentation copy are deleted and their knowledge disposed (history stays in the ledger). The repository itself is not touched.</div>
          <div class="codebase-actions"><button type="button" class="row-action" data-cancel-remove>Cancel</button><button type="button" class="row-action danger" data-confirm-remove ${codebaseState.busy ? 'disabled' : ''}>Remove</button></div>
        </div>`
      : '';
    return `<div class="feishu-item codebase-item${codebaseState.editing === e.name ? ' editing' : ''}" data-n="${n}">
      <span class="mark" title="${e.follow ? 'followed: fetched again daily' : 'kept at its commit'}">${e.follow ? '⟳' : '⎇'}</span>
      <div>
        <b><a href="#" data-open-card title="Open its card, ${esc(e.card)}">${esc(e.name)}</a></b> <span class="hint">${where}</span>
        <div class="hint">${esc(e.ref || 'default branch')} · ${commit} · ${fmtCount(e.files, 'file')}, ${fmtBytes(e.bytes)}</div>
        <div class="hint">${e.follow ? 'followed — fetched again daily' : 'not followed'}${e.checkedAt ? ` · checked ${agoText(e.checkedAt)}` : ''}${narrowed ? ` · ${narrowed}` : ''}</div>
        ${confirm}
      </div>
      ${actions}
    </div>`;
  }).join('');
  list.querySelectorAll('.codebase-item').forEach((row) => {
    const e = entries[Number(row.dataset.n)];
    row.querySelector('[data-open-card]').addEventListener('click', (ev) => {
      ev.preventDefault();
      $('#codebase-dialog').close();
      reveal(parentDir(e.card));
      loadTree().then(() => openFile(e.card));
    });
    row.querySelector('[data-update]')?.addEventListener('click', () => updateCodebase(e.name));
    row.querySelector('[data-edit]')?.addEventListener('click', () => beginCodebaseEdit(e.name));
    row.querySelector('[data-remove]')?.addEventListener('click', () => {
      codebaseState.confirming = e.name;
      paintCodebases();
    });
    row.querySelector('[data-cancel-remove]')?.addEventListener('click', () => {
      codebaseState.confirming = null;
      paintCodebases();
    });
    const keep = row.querySelector('[data-keep]');
    keep?.addEventListener('change', () => {
      row.querySelector('[data-keep-hint]').innerHTML = keep.checked
        ? `It stops being a repository here: <span class="mono">${esc(e.dir)}</span>, its card and documentation stay as ordinary files and are no longer updated.`
        : `Its ${fmtCount(e.files, 'file')} in <span class="mono">${esc(e.dir)}</span>, its card and documentation copy are deleted and their knowledge disposed (history stays in the ledger). The repository itself is not touched.`;
    });
    row.querySelector('[data-confirm-remove]')?.addEventListener('click', () => removeCodebase(e.name, Boolean(keep?.checked)));
  });
  paintCodebaseForm();
}

/** What is fetching now, else how the last fetch ended (a background add that failed says so here). */
function paintCodebaseActivity() {
  const el = $('#codebase-activity');
  const { activity, recent, running } = codebaseState;
  if (activity.length) {
    el.hidden = false;
    el.innerHTML = activity.map((a) => `<div class="activity-row running"><span class="activity-icon spin">${ACTIVITY_ICONS.codebase}</span><div><b>${esc(a.label)}</b><div class="hint">running for ${spanText((Date.now() - Date.parse(a.startedAt)) / 1000)}${a.progress ? ` · ${esc(a.progress)}` : ''}</div></div></div>`).join('');
    return;
  }
  if (running) {
    el.hidden = false;
    el.innerHTML = `<div class="activity-row running"><span class="activity-icon spin">${ACTIVITY_ICONS.codebase}</span><div><b>Waiting for the fetch before it</b></div></div>`;
    return;
  }
  const last = recent[0];
  el.hidden = !last;
  if (last) el.innerHTML = `<div class="activity-row${last.ok ? '' : ' failed'}"><span class="activity-icon">${last.ok ? '✓' : '✕'}</span><div><span>${esc(last.label)}</span><div class="hint">${last.detail ? `${esc(last.detail)} · ` : ''}${agoText(last.finishedAt)}</div></div></div>`;
}

/** The form below the list: adding (administrators), or editing the entry picked. */
function paintCodebaseForm() {
  const editing = codebaseState.editing;
  const entry = editing ? codebaseState.entries.find((e) => e.name === editing) : null;
  const mayAdd = mayImportFolders();
  const shown = Boolean(entry) || mayAdd;
  $('#codebase-add').hidden = !shown;
  $('#codebase-admin-hint').hidden = shown || !mayUse('files');
  $('#codebase-add-title').textContent = entry ? `Edit ${entry.name}` : 'Add a repository';
  $('#codebase-repo').disabled = Boolean(entry);
  $('#codebase-name').disabled = Boolean(entry);
  $('#btn-codebase-cancel-edit').hidden = !entry;
  const go = $('#btn-codebase-go');
  go.hidden = !shown;
  go.textContent = entry ? 'Save' : codebaseState.busy ? 'Adding…' : 'Add repository';
  go.disabled = codebaseState.busy;
}

function beginCodebaseEdit(name) {
  const e = codebaseState.entries.find((x) => x.name === name);
  if (!e) return;
  codebaseState.editing = name;
  codebaseState.confirming = null;
  $('#codebase-error').textContent = '';
  $('#codebase-repo').value = e.web || e.url;
  $('#codebase-name').value = e.name;
  $('#codebase-ref').value = e.ref ?? '';
  $('#codebase-include').value = (e.include ?? []).join('\n');
  $('#codebase-exclude').value = (e.exclude ?? []).join('\n');
  $('#codebase-follow').checked = Boolean(e.follow);
  $('#codebase-docs').checked = e.docs !== false;
  paintCodebases();
  $('#codebase-add').scrollIntoView({ block: 'nearest' });
  $('#codebase-ref').focus();
}

function endCodebaseEdit() {
  codebaseState.editing = null;
  resetCodebaseForm();
  paintCodebases();
}

async function submitCodebaseForm() {
  if (codebaseState.busy) return;
  $('#codebase-error').textContent = '';
  if (codebaseState.editing) return saveCodebaseEdit(codebaseState.editing);
  const repository = $('#codebase-repo').value.trim();
  if (!repository) {
    $('#codebase-error').textContent = 'Name a repository: owner/repo, or an https or ssh git URL.';
    $('#codebase-repo').focus();
    return;
  }
  const body = {
    repository,
    ...($('#codebase-name').value.trim() ? { name: $('#codebase-name').value.trim() } : {}),
    ...($('#codebase-ref').value.trim() ? { ref: $('#codebase-ref').value.trim() } : {}),
    include: globsTyped('#codebase-include'),
    exclude: globsTyped('#codebase-exclude'),
    follow: $('#codebase-follow').checked,
    docs: $('#codebase-docs').checked,
  };
  codebaseState.busy = true;
  paintCodebaseForm();
  try {
    await api('/api/codebases/add', { method: 'POST', body: JSON.stringify(body) });
    resetCodebaseForm();
    toast(`fetching ${repository} — it shows here and under Tasks → Background until it is indexed`, 6000);
    codebaseState.wasRunning = true;
  } catch (e) {
    $('#codebase-error').textContent = e.message;
  } finally {
    codebaseState.busy = false;
    paintCodebaseForm();
  }
  await loadCodebases();
}

async function saveCodebaseEdit(name) {
  const before = codebaseState.entries.find((e) => e.name === name);
  if (!before) return endCodebaseEdit();
  const patch = {
    name,
    ref: $('#codebase-ref').value.trim(),
    include: globsTyped('#codebase-include'),
    exclude: globsTyped('#codebase-exclude'),
    follow: $('#codebase-follow').checked,
    docs: $('#codebase-docs').checked,
  };
  const same = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  // what is fetched changed: only an update applies it, so one follows the save
  const refetch = patch.ref !== (before.ref ?? '') || !same(patch.include, before.include) || !same(patch.exclude, before.exclude) || patch.docs !== (before.docs !== false);
  codebaseState.busy = true;
  paintCodebaseForm();
  try {
    await api('/api/codebases', { method: 'PATCH', body: JSON.stringify(patch) });
    codebaseState.editing = null;
    resetCodebaseForm();
    if (refetch) {
      await api('/api/codebases/update', { method: 'POST', body: JSON.stringify({ name, wait: false }) });
      codebaseState.wasRunning = true;
      toast(`saved ${name} — fetching it again to apply the change`, 5000);
    } else toast(`saved ${name}`, 3000);
  } catch (e) {
    $('#codebase-error').textContent = e.message;
  } finally {
    codebaseState.busy = false;
  }
  await loadCodebases();
}

/** Update now: fetch the tracked ref again in the background and index what changed. */
async function updateCodebase(name) {
  try {
    await api('/api/codebases/update', { method: 'POST', body: JSON.stringify({ name, wait: false }) });
    if ($('#codebase-dialog').open) codebaseState.wasRunning = true;
    toast(`fetching ${name} again — it shows under Tasks → Background`, 5000);
  } catch (e) {
    if ($('#codebase-dialog').open) $('#codebase-error').textContent = e.message;
    else toast(`update failed: ${e.message}`, 6000);
  }
  if ($('#codebase-dialog').open) await loadCodebases();
}

async function removeCodebase(name, keepFiles) {
  codebaseState.busy = true;
  paintCodebases();
  $('#codebase-error').textContent = '';
  toast(keepFiles ? `removing ${name}, keeping its files…` : `removing ${name} and its files…`, 600000);
  try {
    await api(`/api/codebases?name=${encodeURIComponent(name)}&keepFiles=${keepFiles ? 1 : 0}`, { method: 'DELETE' });
    codebaseState.confirming = null;
    if (codebaseState.editing === name) endCodebaseEdit();
    // the open file, the picked folder and open folders inside what was deleted
    if (!keepFiles) for (const [path, owner] of codebaseDests) if (owner === name) forget(path);
    toast(keepFiles ? `removed ${name} — its files stay as ordinary content` : `removed ${name} and its files`, 5000);
    await loadTree();
    loadStats();
  } catch (e) {
    toast(`remove failed: ${e.message}`, 6000);
    if ($('#codebase-dialog').open) $('#codebase-error').textContent = e.message;
  } finally {
    codebaseState.busy = false;
  }
  if ($('#codebase-dialog').open) await loadCodebases();
}

/** A repository's menu in Files → Remove: asked here, since the dialog is not open. */
async function removeCodebaseNode(name, keepFiles) {
  const question = keepFiles
    ? `Remove the repository ${name}, keeping its files?\n\nraw/codebase/${name}, its card and documentation stay as ordinary files and are no longer updated.`
    : `Remove the repository ${name} and its files?\n\nraw/codebase/${name}, its card and documentation copy are deleted and their knowledge disposed (history stays in the ledger). The repository itself is not touched.`;
  if (!confirm(question)) return;
  await removeCodebase(name, keepFiles);
}

$('#btn-codebase-close').addEventListener('click', () => $('#codebase-dialog').close());
$('#btn-codebase-cancel-edit').addEventListener('click', endCodebaseEdit);
$('#codebase-dialog').addEventListener('close', () => clearTimeout(codebaseState.timer));
$('#codebase-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  submitCodebaseForm();
});

/* ------------------------- agent conversations --------------------------- */

/**
 * Pick Claude Code and Codex conversations to keep as dialogue (docs/design/24):
 * search this machine's sessions, tick the ones wanted, import them once or
 * follow them. The catalog shows every session's prompts, so this is an
 * administrator's (the service puts it under `settings`); a followed copy is
 * then checked, synced and unfollowed from its menu in Files.
 */
const agentConv = { selected: new Map(), rows: [], busy: false, seq: 0, timer: null };
const AGENT_WORDS = { claude: 'Claude Code', codex: 'Codex' };

function openAgentConversations() {
  agentConv.selected.clear();
  $('#agentconv-error').textContent = '';
  $('#agentconv-follow').checked = true;
  paintAgentConvButtons();
  $('#agentconv-dialog').showModal();
  loadAgentConversations();
  setTimeout(() => $('#agentconv-q').focus(), 0);
}

async function loadAgentConversations() {
  const seq = ++agentConv.seq;
  const params = new URLSearchParams({ limit: '100' });
  const q = $('#agentconv-q').value.trim();
  if (q) params.set('q', q);
  if ($('#agentconv-agent').value) params.set('agent', $('#agentconv-agent').value);
  if ($('#agentconv-automated').checked) params.set('automated', '1');
  const list = $('#agentconv-list');
  if (!agentConv.rows.length) list.innerHTML = '<p class="hint">reading this machine\'s conversations…</p>';
  try {
    const res = await api(`/api/conversations/catalog?${params}`);
    if (seq !== agentConv.seq) return;
    agentConv.rows = res.conversations;
    paintAgentConversations(res);
  } catch (e) {
    if (seq !== agentConv.seq) return;
    list.innerHTML = '';
    $('#agentconv-error').textContent = e.message;
  }
}

const convKey = (c) => `${c.agent}:${c.id}`;

function paintAgentConversations(res) {
  const list = $('#agentconv-list');
  if (!res.conversations.length) {
    list.innerHTML = `<p class="hint">${$('#agentconv-q').value.trim() ? 'No conversation matches every word.' : 'No conversations found on this machine.'}${res.automatedHidden && !$('#agentconv-automated').checked ? ` ${fmtCount(res.automatedHidden, 'one-shot run')} by programs left out.` : ''}</p>`;
    return;
  }
  const more = res.total > res.conversations.length ? `<p class="hint">${res.total - res.conversations.length} more — narrow the search to see them.</p>` : '';
  list.innerHTML = res.conversations.map((c, n) => {
    const held = c.followed;
    const when = new Date(c.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const status = c.followed
      ? `followed at <span class="mono">${esc(c.copy)}</span>`
      : c.copy ? `imported before at <span class="mono">${esc(c.copy)}</span> — importing again brings it up to date` : '';
    return `<div class="feishu-item${held ? ' held' : ''}" data-n="${n}">
      <input type="checkbox" ${held ? 'disabled checked' : agentConv.selected.has(convKey(c)) ? 'checked' : ''} aria-label="${esc(c.title)}" />
      <div><b>${esc(c.title)}</b>
        <div class="hint">${esc(AGENT_WORDS[c.agent] || c.agent)} · ${esc(c.project || 'no project')} · ${fmtCount(c.exchanges, 'exchange')} · ${esc(when)}${c.automated ? ' · run by a program' : ''}</div>
        ${c.named ? `<div class="hint prompt">${esc(c.firstPrompt)}</div>` : ''}
        ${status ? `<div class="hint">${status}</div>` : ''}
        <pre hidden></pre>
      </div>
      <button type="button" class="row-action" data-preview>Preview</button>
    </div>`;
  }).join('') + more;
  list.querySelectorAll('.feishu-item').forEach((row) => {
    const c = res.conversations[Number(row.dataset.n)];
    const box = row.querySelector('input');
    const toggle = (on) => {
      if (c.followed) return;
      if (on) agentConv.selected.set(convKey(c), { agent: c.agent, id: c.id, title: c.title });
      else agentConv.selected.delete(convKey(c));
      box.checked = on;
      paintAgentConvButtons();
    };
    box.addEventListener('change', () => toggle(box.checked));
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('input, button, pre')) return;
      toggle(!box.checked);
    });
    row.querySelector('[data-preview]').addEventListener('click', (ev) => previewAgentConversation(c, row.querySelector('pre'), ev.currentTarget));
  });
}

/** The Markdown an import would write, shown in the row (the first part of it). */
async function previewAgentConversation(c, pre, button) {
  if (!pre.hidden) {
    pre.hidden = true;
    button.textContent = 'Preview';
    return;
  }
  button.disabled = true;
  try {
    const p = await api(`/api/conversations/preview?agent=${encodeURIComponent(c.agent)}&id=${encodeURIComponent(c.id)}`);
    const body = p.markdown.slice(p.markdown.indexOf('\n---\n') + 5).trim();
    pre.textContent = `→ ${p.dest} · ${(p.bytes / 1024).toFixed(1)} KB${p.redactions ? ` · ${fmtCount(p.redactions, 'secret')} redacted` : ''}\n\n${body.length > 6000 ? `${body.slice(0, 6000)}\n…` : body}`;
    pre.hidden = false;
    button.textContent = 'Hide';
  } catch (e) {
    toast(`preview failed: ${e.message}`, 5000);
  } finally {
    button.disabled = false;
  }
}

function paintAgentConvButtons() {
  const n = agentConv.selected.size;
  const go = $('#btn-agentconv-go');
  const verb = $('#agentconv-follow').checked ? 'Follow' : 'Import';
  go.textContent = n ? `${verb} ${fmtCount(n, 'conversation')}` : verb;
  go.disabled = agentConv.busy || n === 0;
}

async function runAgentConversationImport() {
  const sessions = [...agentConv.selected.values()].map(({ agent, id }) => ({ agent, id }));
  if (!sessions.length) return;
  const mode = $('#agentconv-follow').checked ? 'follow' : 'copy';
  agentConv.busy = true;
  paintAgentConvButtons();
  $('#agentconv-error').textContent = '';
  try {
    const res = await api('/api/conversations/import', { method: 'POST', body: JSON.stringify({ sessions, mode }) });
    const ok = res.items.filter((i) => i.ok);
    const failed = res.items.filter((i) => !i.ok);
    if (failed.length) {
      $('#agentconv-error').textContent = failed.map((i) => `${agentConv.selected.get(`${i.agent}:${i.id}`)?.title || i.id}: ${i.error}`).join(' · ');
      for (const i of ok) agentConv.selected.delete(`${i.agent}:${i.id}`);
      loadAgentConversations();
    } else $('#agentconv-dialog').close();
    // the folders above the first copy open with the tree drawn next
    if (ok.length) reveal(parentDir(ok[0].result.dest));
    await loadTree();
    loadStats();
    if (ok.length) {
      if (!$('#agentconv-dialog').open) openFile(ok[0].result.dest);
      toast(`${mode === 'follow' ? 'following' : 'imported'} ${fmtCount(ok.length, 'conversation')}${res.sync ? ` · ${res.sync.indexed} indexed` : ''}${mode === 'follow' ? ' — new exchanges are added as they come' : ''}`, 7000);
    }
  } catch (e) {
    $('#agentconv-error').textContent = e.message;
  } finally {
    agentConv.busy = false;
    if ($('#agentconv-dialog').open) paintAgentConvButtons();
  }
}

$('#btn-agentconv-cancel').addEventListener('click', () => $('#agentconv-dialog').close());
$('#agentconv-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  runAgentConversationImport();
});
$('#agentconv-q').addEventListener('input', () => {
  clearTimeout(agentConv.timer);
  agentConv.timer = setTimeout(loadAgentConversations, 250);
});
$('#agentconv-agent').addEventListener('change', loadAgentConversations);
$('#agentconv-automated').addEventListener('change', loadAgentConversations);
$('#agentconv-follow').addEventListener('change', paintAgentConvButtons);

/** A followed conversation's menu → check now: its new exchanges, without waiting for it to go quiet. */
async function syncAgentConversation(dest, force = false) {
  toast(`checking ${dest} for new exchanges…`, 600000);
  try {
    const { results } = await api('/api/conversations/sync', { method: 'POST', body: JSON.stringify({ dest, force }) });
    const r = results[0];
    if (currentFile === dest) openFile(dest);
    loadStats();
    if (!r) toast('nothing to check');
    else if (r.error) toast(`${dest}: ${r.error}`, 8000);
    else if (r.written) toast(`${dest}: updated — ${fmtCount(r.exchanges, 'exchange')}`, 5000);
    else toast(`${dest}: no new exchanges`, 4000);
  } catch (e) {
    toast(`check failed: ${e.message}`, 6000);
  }
}

async function unfollowAgentConversation(node, removeFiles) {
  const question = removeFiles
    ? `Stop following this conversation and delete its copy at ${node.path}?\n\nIts knowledge is disposed (history stays in the ledger). The transcript itself is not touched.`
    : `Stop following this conversation?\n\nThe copy at ${node.path} stays as an ordinary document and no longer gains new exchanges.`;
  if (!confirm(question)) return;
  try {
    await api(`/api/conversations?dest=${encodeURIComponent(node.path)}&removeFiles=${removeFiles ? 1 : 0}`, { method: 'DELETE' });
    if (removeFiles && currentFile === node.path) {
      currentFile = null;
      $('#file-path').textContent = '';
      $('#file-view').innerHTML = '';
      setFileNotice(null);
      clearFileCitations();
      $('#btn-edit').disabled = true;
      $('#btn-delete').disabled = true;
    }
    await loadTree();
    loadStats();
    toast(removeFiles ? `unfollowed and removed ${node.path}` : `unfollowed ${node.path} — the copy stays as an ordinary document`, 5000);
  } catch (e) {
    toast(`unfollow failed: ${e.message}`, 5000);
  }
}

/** Tasks → Agent conversations → Check now: every followed conversation, in the background. */
async function checkConversationsNow(button) {
  if (button) button.disabled = true;
  try {
    const res = await api('/api/conversations/sync', { method: 'POST', body: JSON.stringify({}) });
    toast(res.started ? 'checking followed conversations for new exchanges — it shows under Tasks → Background' : res.links === 0 ? 'no conversations are followed' : 'a check is under way already', 5000);
  } catch (e) {
    toast(`check failed: ${e.message}`, 6000);
  }
  loadTasks();
}

async function syncFeishuDoc(dest, force = false) {
  toast(force ? `fetching ${dest} from Feishu again…` : `asking Feishu whether ${dest} was edited…`, 600000);
  try {
    const { results } = await api('/api/feishu/sync', { method: 'POST', body: JSON.stringify({ dest, force }) });
    const r = results[0];
    await loadTree();
    loadStats();
    if (!r) toast('nothing to sync');
    else if (r.error) toast(`${dest}: ${r.error}`, 8000);
    else if (!r.fetched) toast(`${dest}: not edited since ${r.modifiedAt ? new Date(r.modifiedAt).toLocaleString() : 'the last fetch'}${r.pages ? ` (${fmtCount(r.pages.total, 'page')})` : ''}`, 5000);
    else if (r.pages) toast(`${dest}: ${r.pages.fetched} of ${fmtCount(r.pages.documents, 'document')} fetched${r.pages.moved ? `, ${r.pages.moved} moved` : ''}${r.pages.removed ? `, ${r.pages.removed} gone` : ''} — ${r.written} written, ${r.removed} removed${r.sync ? ` · ${r.sync.indexed} indexed` : ''}`, 6000);
    else toast(`${dest}: fetched — ${r.written} written, ${r.removed} removed${r.sync ? ` · ${r.sync.indexed} indexed` : ' · nothing changed'}`, 5000);
  } catch (e) {
    toast(`sync failed: ${e.message}`, 6000);
  }
}

async function unlinkFeishuNode(node, removeFiles) {
  const question = removeFiles
    ? `Stop following ${feishuDests.get(node.path)} and delete its copy at ${node.path}?\n\nIts knowledge is disposed (history stays in the ledger). The document in Feishu is not touched.`
    : `Stop following ${feishuDests.get(node.path)}?\n\nThe copy at ${node.path} stays as ordinary documents and no longer follows the original.`;
  if (!confirm(question)) return;
  try {
    await api(`/api/feishu?dest=${encodeURIComponent(node.path)}&removeFiles=${removeFiles ? 1 : 0}`, { method: 'DELETE' });
    if (removeFiles && currentFile && (currentFile === node.path || currentFile.startsWith(`${node.path}/`))) {
      currentFile = null;
      $('#file-path').textContent = '';
      $('#file-view').innerHTML = '';
      setFileNotice(null);
      clearFileCitations();
      $('#btn-edit').disabled = true;
      $('#btn-delete').disabled = true;
    }
    await loadTree();
    loadStats();
    toast(removeFiles ? `unlinked and removed ${node.path}` : `unlinked ${node.path} — its files stay as ordinary documents`, 5000);
  } catch (e) {
    toast(`unlink failed: ${e.message}`, 5000);
  }
}

$('#btn-clear-dir').addEventListener('click', () => {
  selectedDir = null;
  document.querySelectorAll('#filetree .tree-label.picked').forEach((x) => x.classList.remove('picked'));
  paintDestination();
});

$('#btn-refresh-tree').addEventListener('click', loadTree);

function pickUpload(kind, dir) {
  const input = kind === 'folder' ? $('#folder-upload') : $('#file-upload');
  input.dataset.dir = dir || uploadTarget();
  input.click();
}

for (const id of ['#file-upload', '#folder-upload']) {
  $(id).addEventListener('change', async (ev) => {
    const dir = ev.target.dataset.dir || uploadTarget();
    // a picked folder carries its whole subtree, dot-directories included
    const files = [...ev.target.files].filter((f) => !(f.webkitRelativePath || f.name).split('/').some((seg) => seg.startsWith('.')));
    ev.target.value = '';
    await uploadFiles(files, dir);
  });
}

/** Split an import into requests small enough for the service to hold in memory. */
function uploadBatches(files) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const file of files) {
    if (current.length && (current.length >= UPLOAD_BATCH_FILES || bytes + file.size > UPLOAD_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function uploadFiles(files, dir) {
  if (!files.length) {
    toast('nothing to upload — no readable files there');
    return;
  }
  try {
    let saved = 0;
    for (const batch of uploadBatches(files)) {
      const form = new FormData();
      form.set('dir', dir);
      // a folder upload sends each file's path inside it, so the subtree is recreated
      for (const file of batch) form.append('files', file, file.webkitRelativePath || file.name);
      const res = await fetch('/api/upload', { method: 'POST', headers: { 'x-knode-csrf': '1', ...workspaceRequestHeaders() }, body: form, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.reason === 'auth') sessionEnded(data.error);
      if (!res.ok) throw new Error(data.error || res.statusText);
      saved += data.saved.length;
      toast(`uploading ${saved}/${files.length} files into ${dir}…`, 60000);
    }
    toast(`uploaded ${saved} file${saved === 1 ? '' : 's'} into ${dir} — indexing…`, 60000);
    await api('/api/ingest', { method: 'POST' });
    reveal(dir);
    await loadTree();
    loadStats();
    toast('upload and index complete');
  } catch (e) {
    toast(`upload failed: ${e.message}`);
  }
}

$('#btn-ingest').addEventListener('click', async () => {
  toast('indexing…', 60000);
  try {
    const s = await api('/api/ingest', { method: 'POST' });
    toast(`indexed ${s.indexed} docs, ${s.unchanged} unchanged, ${s.chunks} chunks`);
    await loadTree();
    loadStats();
  } catch (e) {
    toast(`index failed: ${e.message}`);
  }
});

/* ------------------------------- search -------------------------------- */

/**
 * Explore → Search (docs/design/20): the retrieval the agents use, asked to
 * explain itself. Each passage carries its rank in every channel that found
 * it, each channel says what it found, and beside the passages stand the
 * entities the query names — with where it named them — their relations and
 * the claims about them. Either read may fail without blanking the page.
 */
const CHANNELS = [
  { id: 'vector', label: 'Semantic', hint: 'passages whose meaning is close to the query (vector similarity)' },
  { id: 'keyword', label: 'Keyword', hint: 'passages that contain its words (full text; CJK by substrings)' },
  { id: 'graph', label: 'Entity', hint: 'passages that mention an entity the query names' },
];
const channelLabel = (id) => CHANNELS.find((c) => c.id === id)?.label ?? id;
const searchState = { result: null, view: 'passages', channel: null, open: new Set(), seq: 0, intro: false };
const RECENT_SEARCH_KEY = 'knode-os.search.recent.v1';

/** This workspace's last searches, newest first — kept in this browser only. */
function recentSearches() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_SEARCH_KEY) ?? '{}')[noticeScope()] ?? [];
  } catch {
    return [];
  }
}

function rememberSearch(q) {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_SEARCH_KEY) ?? '{}');
    all[noticeScope()] = [q, ...(all[noticeScope()] ?? []).filter((x) => x !== q)].slice(0, 8);
    localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(all));
  } catch {
    /* blocked storage: nothing remembered */
  }
}

/** Arriving at Search: the scope follows the picked folder; an empty page shows what it does. */
function paintSearchArrival() {
  paintSearchScope();
  if (!searchState.result) paintSearchIntro();
  if (!$('#search-q').value) setTimeout(() => $('#search-q').focus(), 0);
}

/** Before the first search: the three channels in words, and the workspace's best-known entities to try. */
async function paintSearchIntro() {
  $('#search-summary').hidden = true;
  $('#search-main-head').hidden = true;
  $('#search-side').hidden = true;
  const el = $('#search-results');
  el.innerHTML = `<div class="search-intro">
    <p class="section-index">EXPLORE · SEARCH</p>
    <h3>See what a query matches — and why</h3>
    <p class="hint">Every search runs the retrieval Ask and the research agents use, and shows each channel's part in it:</p>
    <div class="intro-channels">${CHANNELS.map((c) => `<div class="intro-channel ch-${c.id}"><b>${c.label}</b><span>${esc(c.hint)}</span></div>`).join('')}</div>
    <p class="hint">Beside the passages: the entities the query names (and whether by name, alias or description), what they are related to, and the claims about them.</p>
    ${recentSearches().length ? `<div class="intro-try intro-recent"><span class="hint">Recent</span>${recentSearches().map((q) => `<button type="button" class="term-chip" data-recent="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''}
    <div class="intro-try" hidden><span class="hint">Try</span></div>
  </div>`;
  el.querySelectorAll('[data-recent]').forEach((b) => b.addEventListener('click', () => runSearch(b.dataset.recent)));
  if (searchState.intro) return;
  searchState.intro = true;
  try {
    const rows = (await api('/api/entities?limit=8&sort=mentions')).items ?? [];
    const tryEl = el.querySelector('.intro-try:not(.intro-recent)');
    if (!tryEl || !rows.length) return;
    for (const e of rows) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'term-chip';
      b.textContent = e.name;
      b.addEventListener('click', () => runSearch(e.name));
      tryEl.appendChild(b);
    }
    tryEl.hidden = false;
  } catch {
    /* nothing indexed yet, or no search group: the words above still stand */
  } finally {
    searchState.intro = false;
  }
}

/** Search for `q` from anywhere: the box, an entity chip, the global search. */
function runSearch(q) {
  $('#search-q').value = q;
  if (currentTab !== 'search') navigate('search');
  doSearch();
}

async function doSearch() {
  const q = $('#search-q').value.trim();
  if (!q) return;
  const mode = $('#search-mode').value;
  const scope = $('#search-scope').value;
  const seq = ++searchState.seq;
  const el = $('#search-results');
  el.innerHTML = '<p class="hint search-wait">searching — passages and the graph…</p>';
  try {
    const params = new URLSearchParams({ q, mode, k: '20' });
    if (scope) params.set('sources', scope);
    const result = await api(`/api/search/explore?${params}`);
    if (seq !== searchState.seq) return;
    searchState.result = result;
    rememberSearch(q);
    searchState.channel = null;
    searchState.open = new Set();
    paintSearch();
  } catch (e) {
    if (seq !== searchState.seq) return;
    el.innerHTML = `<p class="hint">search failed: ${esc(e.message)}</p>`;
  }
}

/** Terms worth marking: a CJK bigram inside a longer term would mark half the text. */
function markableTerms(terms) {
  const list = (terms ?? []).filter(Boolean);
  return list.filter((t) => !list.some((other) => other !== t && other.length > t.length && other.toLowerCase().includes(t.toLowerCase())));
}

/** `text`, escaped, with every term marked (case-insensitive). */
function markTerms(text, terms) {
  if (!terms.length) return esc(text);
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return String(text).split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

/** A passage as a person reads it: Markdown's marks off — heading hashes, emphasis, link brackets. */
function plainText(text) {
  return String(text)
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2');
}

/** Around the first term, not the first characters: the reason the passage is here. */
function snippetOf(text, terms, size = 300) {
  const flat = plainText(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= size) return flat;
  const low = flat.toLowerCase();
  const hits = terms.map((t) => low.indexOf(t.toLowerCase())).filter((i) => i >= 0);
  const first = hits.length ? Math.min(...hits) : 0;
  const start = Math.max(0, first - Math.round(size * 0.3));
  const end = Math.min(flat.length, start + size);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

const passageTitle = (p) => p.title || baseName(p.path).replace(/\.(md|markdown)$/i, '');

function rankBadges(p) {
  if (p.trace?.bridgeEntities?.length) {
    return `<span class="rank-badge ch-sag" title="reached ${p.trace.hop ?? 1} hop(s) from a direct match through these entities">via ${esc(p.trace.bridgeEntities.join(' → '))}</span>`;
  }
  return CHANNELS.filter((c) => p.ranks?.[c.id] !== undefined || p.signals?.[c.id] !== undefined)
    .map((c) => `<span class="rank-badge ch-${c.id}" title="${esc(c.hint)}">${c.label}${p.ranks?.[c.id] ? ` #${p.ranks[c.id]}` : ''}</span>`)
    .join('');
}

/** How the fused score came about, in words a person can check. */
function passageExplain(p) {
  const raw = {
    vector: (v) => `similarity ${v.toFixed(3)}`,
    keyword: (v) => (v >= 1 ? `${Math.round(v)} term${Math.round(v) === 1 ? '' : 's'} found` : `text rank ${v.toFixed(3)}`),
    graph: (v) => `${Math.round(v)} named entit${Math.round(v) === 1 ? 'y' : 'ies'} mentioned`,
  };
  const rows = CHANNELS.filter((c) => p.signals?.[c.id] !== undefined)
    .map((c) => `<li><span class="rank-badge ch-${c.id}">${c.label}${p.ranks?.[c.id] ? ` #${p.ranks[c.id]}` : ''}</span> ${esc(raw[c.id](Number(p.signals[c.id])))}</li>`);
  if (p.signals?.structural !== undefined) rows.push(`<li><span class="rank-badge ch-sag">multi-hop</span> structural score ${Number(p.signals.structural).toFixed(3)}</li>`);
  const missing = CHANNELS.filter((c) => p.signals?.[c.id] === undefined && searchState.result?.channels?.[c.id]).map((c) => c.label);
  return `<ul class="explain">${rows.join('')}</ul>
    <p class="hint">Fused score ${p.score.toFixed(4)} — each channel adds 1 / (60 + rank) (entity × 0.6), nudged by how often the document is read.${missing.length ? ` Not found by ${esc(missing.join(' or '))}.` : ''}</p>`;
}

function filteredPassages() {
  const r = searchState.result;
  if (!r) return [];
  const ch = searchState.channel;
  return ch ? r.passages.filter((p) => p.signals?.[ch] !== undefined) : r.passages;
}

function paintSearch() {
  const r = searchState.result;
  if (!r) return;
  const docs = new Set(r.passages.map((p) => p.path));
  const named = r.entities.filter((e) => e.match);
  const typed = r.relations.filter((x) => x.type !== 'co_occurs');
  const summary = $('#search-summary');
  summary.hidden = false;
  const errors = [
    r.errors?.passages ? `Passages failed: ${r.errors.passages}` : '',
    r.errors?.graph ? `The graph read failed: ${r.errors.graph}` : '',
  ].filter(Boolean);
  summary.innerHTML = `<div class="ss-line">
      <b>${r.passages.length}</b> passage${r.passages.length === 1 ? '' : 's'} in <b>${docs.size}</b> document${docs.size === 1 ? '' : 's'}
      · <b>${named.length}</b> entit${named.length === 1 ? 'y' : 'ies'} named · <b>${typed.length}</b> relation${typed.length === 1 ? '' : 's'}
      <span class="hint">· ${r.ms.total} ms · ${esc({ hybrid: 'hybrid', sag: 'multi-hop', vector: 'semantic only', keyword: 'keyword only' }[r.mode] ?? r.mode)}</span>
    </div>
    <div class="ss-channels">
      ${CHANNELS.filter((c) => r.channels?.[c.id]).map((c) => {
        const ch = r.channels[c.id];
        const title = ch.error ? `${c.label} could not answer: ${ch.error}` : `${c.hint} — ${ch.hits} chunks in ${ch.ms} ms; click to show only its passages`;
        return `<button type="button" class="channel-chip ch-${c.id}${ch.error ? ' failed' : ''}${searchState.channel === c.id ? ' active' : ''}" data-channel="${c.id}" title="${esc(title)}"${ch.error ? ' disabled' : ''}><span class="dot"></span>${c.label} <b>${ch.error ? 'failed' : ch.hits}</b></button>`;
      }).join('')}
      ${r.mode === 'sag' ? '<span class="hint">multi-hop: direct matches, then passages reached through the entities they mention</span>' : ''}
      <span class="ss-terms">${markableTerms(r.terms).map((t) => `<span class="term">${esc(t)}</span>`).join('')}</span>
    </div>
    ${errors.map((e) => `<p class="ss-error">${esc(e)}</p>`).join('')}`;
  summary.querySelectorAll('[data-channel]').forEach((b) => b.addEventListener('click', () => {
    searchState.channel = searchState.channel === b.dataset.channel ? null : b.dataset.channel;
    paintSearch();
  }));
  paintPassages();
  paintSearchSide();
}

function paintPassages() {
  const r = searchState.result;
  const list = filteredPassages();
  const terms = markableTerms(r.terms);
  const head = $('#search-main-head');
  head.hidden = r.passages.length === 0;
  $('#search-count').textContent = searchState.channel
    ? `${list.length} of ${r.passages.length} found by ${channelLabel(searchState.channel)}`
    : `${r.passages.length} ranked passages`;
  head.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === searchState.view));
  const el = $('#search-results');
  if (!list.length) {
    el.innerHTML = r.passages.length
      ? `<p class="hint">${esc(channelLabel(searchState.channel))} found none of these passages.</p>`
      : `<div class="search-empty"><b>No passage matched.</b><p class="hint">${r.entities.length ? 'The graph still knows the entities on the right.' : 'Try other words, another mode, the whole base — or index more documents.'}</p></div>`;
    return;
  }
  if (searchState.view === 'documents') {
    const groups = new Map();
    for (const p of list) {
      const g = groups.get(p.path) ?? { path: p.path, title: passageTitle(p), date: p.docDate, best: r.passages.indexOf(p) + 1, passages: [], channels: new Set() };
      g.passages.push(p);
      for (const c of CHANNELS) if (p.signals?.[c.id] !== undefined) g.channels.add(c.id);
      groups.set(p.path, g);
    }
    el.innerHTML = [...groups.values()].map((g) => `<article class="doc-group">
        <div class="passage-head">
          <span class="passage-rank" title="its best passage's place">${g.best}</span>
          <div class="passage-title"><b>${esc(g.title)}</b><span class="mono passage-path">${esc(g.path)}</span></div>
          ${g.date ? `<span class="passage-date">${esc(g.date)}</span>` : ''}
          <button type="button" class="passage-open" data-open="${esc(g.path)}">Open</button>
        </div>
        <div class="passage-foot">${CHANNELS.filter((c) => g.channels.has(c.id)).map((c) => `<span class="rank-badge ch-${c.id}">${c.label}</span>`).join('')}<span class="hint">${g.passages.length} passage${g.passages.length === 1 ? '' : 's'}</span></div>
        ${g.passages.map((p) => `<p class="doc-group-snippet">${markTerms(snippetOf(p.content, terms, 180), terms)}</p>`).join('')}
      </article>`).join('');
  } else {
    el.innerHTML = list.map((p) => {
      const i = r.passages.indexOf(p);
      const open = searchState.open.has(p.chunkId);
      return `<article class="passage${open ? ' open' : ''}" data-chunk="${esc(p.chunkId)}">
        <div class="passage-head">
          <span class="passage-rank">${i + 1}</span>
          <div class="passage-title"><b>${esc(passageTitle(p))}</b><span class="mono passage-path">${esc(p.path)}</span></div>
          ${p.docDate ? `<span class="passage-date" title="the source's date">${esc(p.docDate)}</span>` : ''}
          <button type="button" class="passage-open" data-open="${esc(p.path)}" title="Open the file">Open</button>
        </div>
        <div class="passage-text">${open ? markTerms(plainText(p.content).trim(), terms) : markTerms(snippetOf(p.content, terms), terms)}</div>
        <div class="passage-foot">${rankBadges(p)}<span class="spacer"></span><span class="hint passage-score" title="fused score">${p.score.toFixed(4)}</span></div>
        ${open ? passageExplain(p) : ''}
      </article>`;
    }).join('');
    el.querySelectorAll('.passage').forEach((card) => card.addEventListener('click', (ev) => {
      if (ev.target.closest('button, a') || getSelection()?.toString()) return;
      const id = card.dataset.chunk;
      if (searchState.open.has(id)) searchState.open.delete(id);
      else searchState.open.add(id);
      paintPassages();
    }));
  }
  el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
    navigate('files');
    openFile(b.dataset.open);
  }));
}

$('#search-main-head').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-view]');
  if (!b || !searchState.result) return;
  searchState.view = b.dataset.view;
  paintPassages();
});

/** The relation type in words: `competes_with` → competes with. */
const relationWords = (type) => String(type).replace(/_/g, ' ');

function entityWhy(e, terms) {
  if (!e.match) return '';
  if (e.match.field === 'name') return '<span class="ent-why">its name</span>';
  if (e.match.field === 'alias') return `<span class="ent-why">alias <q>${markTerms(e.match.text, terms)}</q></span>`;
  return `<span class="ent-why">its description: ${markTerms(snippetOf(e.match.text, [e.match.term], 90), terms)}</span>`;
}

function paintSearchSide() {
  const r = searchState.result;
  const side = $('#search-side');
  const terms = markableTerms(r.terms);
  const byId = new Map(r.entities.map((e) => [e.id, e]));
  const named = r.entities.filter((e) => e.match);
  const related = r.entities.filter((e) => !e.match);
  const typed = r.relations.filter((x) => x.type !== 'co_occurs');
  const together = r.relations.filter((x) => x.type === 'co_occurs');
  const entLink = (id) => {
    const e = byId.get(id);
    return e ? `<a href="#" class="ent-link" data-entity="${esc(e.id)}" data-type="${esc(e.type)}">${esc(e.name)}</a>` : `<span class="mono">${esc(id)}</span>`;
  };
  // claims about what the query names first, then about what is related to it
  const namedNames = new Set(named.map((e) => e.name));
  const claims = [...r.claims].sort((a, b) => Number(namedNames.has(b.subject)) - Number(namedNames.has(a.subject)));
  if (!r.entities.length && !r.claims.length) {
    side.hidden = false;
    side.innerHTML = `<section class="side-block"><h4>Entities</h4><p class="hint">${r.errors?.graph ? 'The graph read failed.' : 'The query names no entity the graph knows — no name, alias or description holds its terms.'}</p></section>`;
    return;
  }
  side.hidden = false;
  side.innerHTML = `
    <section class="side-block">
      <h4>Named in the query <span class="count">${named.length}</span></h4>
      ${named.length ? named.map((e) => `<div class="ent-card" data-type="${esc(e.type)}">
          <div class="ent-card-head"><span class="ent-dot"></span><a href="#" class="ent-name" data-entity="${esc(e.id)}" title="Open its panel: relations, claims, documents">${esc(e.name)}</a><span class="tpill">${esc(e.type)}</span></div>
          <div class="ent-card-why">matched by ${entityWhy(e, terms)}</div>
          ${e.description && e.match.field !== 'description' ? `<p class="ent-desc">${esc(plainText(e.description))}</p>` : ''}
          <div class="ent-card-foot"><span class="hint">${e.mentionCount.toLocaleString()} mention${e.mentionCount === 1 ? '' : 's'} · ${e.degree} relation${e.degree === 1 ? '' : 's'}</span>
            <span class="spacer"></span>
            <button type="button" data-graph="${esc(e.name)}" title="Open the graph around it">Graph</button>
            ${e.wikiPath ? `<button type="button" data-open="${esc(e.wikiPath)}" title="${esc(e.wikiPath)}">Wiki</button>` : ''}
            <button type="button" data-search="${esc(e.name)}" title="Search for its name">Search</button></div>
        </div>`).join('') : '<p class="hint">No entity holds these terms.</p>'}
    </section>
    ${related.length ? `<section class="side-block">
      <h4>One relation away <span class="count">${related.length}</span></h4>
      <div class="ent-chips">${related.map((e) => `<a href="#" class="ent-chip" data-entity="${esc(e.id)}" data-type="${esc(e.type)}" title="${esc(e.type)} · ${e.mentionCount} mentions"><span class="ent-dot"></span>${esc(e.name)}</a>`).join('')}</div>
    </section>` : ''}
    ${typed.length ? `<section class="side-block">
      <h4>Relations <span class="count">${typed.length}</span></h4>
      <ul class="rel-list">${typed.slice(0, 40).map((x) => `<li>${entLink(x.source)} <span class="rel-type">${esc(relationWords(x.type))}</span> ${entLink(x.target)}${x.validFrom || x.validTo ? ` <span class="hint">${esc(x.validFrom ?? '…')} – ${esc(x.validTo ?? '…')}</span>` : ''}</li>`).join('')}</ul>
      ${typed.length > 40 ? `<p class="hint">and ${typed.length - 40} more — open the graph to see them all</p>` : ''}
    </section>` : ''}
    ${together.length ? `<section class="side-block">
      <h4>Often mentioned together <span class="count">${together.length}</span></h4>
      <ul class="rel-list co">${together.slice(0, 20).map((x) => `<li>${entLink(x.source)} <span class="rel-type">·</span> ${entLink(x.target)}</li>`).join('')}</ul>
    </section>` : ''}
    ${claims.length ? `<section class="side-block">
      <h4>Claims <span class="count">${claims.length}</span></h4>
      ${claims.map((c) => `<div class="claim${c.status === 'disputed' ? ' disputed' : ''}">
          <div><span class="claim-subject">${esc(c.subject)}</span> ${esc(c.statement)}</div>
          <div class="claim-foot"><span class="claim-status ${esc(c.status)}">${esc(c.status)}</span>${c.kind && c.kind !== 'fact' ? `<span class="hint">${esc(c.kind)}</span>` : ''}${c.startDate ? `<span class="hint">${esc(c.startDate)}</span>` : ''}${c.evidenceCount > 1 ? `<span class="hint">${c.evidenceCount} sources</span>` : ''}
            ${c.path ? `<a href="#" class="mono claim-source" data-open="${esc(c.path)}" title="${esc(c.path)}">${esc(baseName(c.path))}</a>` : ''}</div>
        </div>`).join('')}
    </section>` : ''}`;
  // a type's colour, set the way the page policy allows (no inline style attributes)
  side.querySelectorAll('[data-type]').forEach((el) => {
    const dot = el.classList.contains('ent-card') || el.classList.contains('ent-chip') ? el.querySelector('.ent-dot') : null;
    if (dot) dot.style.background = entityColor(el.dataset.type);
    else el.style.color = entityColor(el.dataset.type);
  });
  side.querySelectorAll('[data-entity]').forEach((a) => a.addEventListener('click', (ev) => {
    ev.preventDefault();
    navigate('files');
    openEntity(a.dataset.entity);
  }));
  side.querySelectorAll('[data-graph]').forEach((b) => b.addEventListener('click', () => exploreEntity(b.dataset.graph)));
  side.querySelectorAll('[data-search]').forEach((b) => b.addEventListener('click', () => runSearch(b.dataset.search)));
  side.querySelectorAll('[data-open]').forEach((a) => a.addEventListener('click', (ev) => {
    ev.preventDefault();
    navigate('files');
    openFile(a.dataset.open);
  }));
}

$('#search-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  doSearch();
});
$('#search-mode').addEventListener('change', () => { if (searchState.result) doSearch(); });
$('#search-scope').addEventListener('change', () => { if (searchState.result) doSearch(); });

/* ---------------------------- global search ----------------------------- */

/**
 * The box in the header (docs/design/20 D4): while someone types it offers
 * entities and documents by name — substring reads, no model — and three
 * things to do with the text: Search it, Ask it, Research it. Return
 * searches, ⌘/Ctrl+Return asks, Alt+Return researches; ⌘K or / focuses it.
 */
const globalSearch = { items: [], active: 0, timer: null, seq: 0, suggestions: null, query: '' };

function globalSearchItems(q, suggestions) {
  const quoted = q.length > 48 ? `${q.slice(0, 48)}…` : q;
  const items = [
    { kind: 'search', label: `Search “${quoted}”`, hint: 'passages, entities and relations', key: '↵' },
    { kind: 'ask', label: `Ask “${quoted}”`, hint: 'an agent answers from this workspace', key: '⌘↵' },
    { kind: 'research', label: `Research “${quoted}”`, hint: 'plan a study — you review it before it runs', key: '⌥↵' },
  ];
  for (const e of suggestions?.entities ?? []) items.push({ kind: 'entity', group: 'Entities', entity: e });
  for (const d of suggestions?.documents ?? []) items.push({ kind: 'file', group: 'Files', doc: d });
  return items;
}

function paintGlobalSearch() {
  const menu = $('#global-search-menu');
  const input = $('#global-search');
  const q = input.value.trim();
  const show = Boolean(q) && document.activeElement === input;
  menu.hidden = !show;
  input.setAttribute('aria-expanded', String(show));
  if (!show) return;
  globalSearch.items = globalSearchItems(q, globalSearch.query === q ? globalSearch.suggestions : null);
  globalSearch.active = Math.min(globalSearch.active, globalSearch.items.length - 1);
  let group = null;
  menu.innerHTML = globalSearch.items.map((item, i) => {
    const heading = item.group && item.group !== group ? `<p class="gs-group">${esc(item.group)}</p>` : '';
    group = item.group ?? group;
    const active = i === globalSearch.active ? ' active' : '';
    if (item.kind === 'entity') {
      const e = item.entity;
      return `${heading}<div class="gs-item${active}" role="option" data-i="${i}"><span class="ent-dot" data-type="${esc(e.type)}"></span><span class="gs-label">${esc(e.name)}${e.alias ? ` <span class="hint">· ${esc(e.alias)}</span>` : ''}</span><span class="gs-hint">${esc(e.type)} · ${e.mentionCount.toLocaleString()}</span></div>`;
    }
    if (item.kind === 'file') {
      const d = item.doc;
      return `${heading}<div class="gs-item${active}" role="option" data-i="${i}"><span class="gs-icon">▤</span><span class="gs-label">${esc(d.title || baseName(d.path))}<span class="gs-path mono">${esc(d.path)}</span></span></div>`;
    }
    return `<div class="gs-item gs-action${active}" role="option" data-i="${i}"><span class="gs-icon">${item.kind === 'search' ? '⌕' : item.kind === 'ask' ? '✦' : '❒'}</span><span class="gs-label">${esc(item.label)} <span class="hint">${esc(item.hint)}</span></span><kbd>${item.key}</kbd></div>`;
  }).join('') + (globalSearch.query === q || !q ? '' : '<p class="gs-group hint">looking up names…</p>');
  menu.querySelectorAll('.ent-dot[data-type]').forEach((dot) => { dot.style.background = entityColor(dot.dataset.type); });
}

function fetchGlobalSuggestions() {
  clearTimeout(globalSearch.timer);
  const q = $('#global-search').value.trim();
  if (!q) return;
  globalSearch.timer = setTimeout(async () => {
    const seq = ++globalSearch.seq;
    try {
      const suggestions = await api(`/api/search/suggest?q=${encodeURIComponent(q)}&limit=5`);
      if (seq !== globalSearch.seq) return;
      globalSearch.suggestions = suggestions;
    } catch {
      if (seq !== globalSearch.seq) return;
      globalSearch.suggestions = { entities: [], documents: [] };
    }
    globalSearch.query = q;
    paintGlobalSearch();
  }, 140);
}

/** Close the suggestions: a pick, a click elsewhere, another view. */
function closeGlobalSearch() {
  $('#global-search-menu').hidden = true;
  $('#global-search').setAttribute('aria-expanded', 'false');
}

function runGlobalSearchItem(item, q) {
  const input = $('#global-search');
  input.blur();
  closeGlobalSearch();
  if (item.kind === 'search') runSearch(q);
  else if (item.kind === 'ask') askFromAnywhere(q);
  else if (item.kind === 'research') researchFromAnywhere(q);
  else if (item.kind === 'entity') runSearch(item.entity.name);
  else if (item.kind === 'file') {
    navigate('files');
    openFile(item.doc.path);
  }
  if (item.kind !== 'file') input.value = '';
}

$('#global-search').addEventListener('input', () => {
  globalSearch.active = 0;
  paintGlobalSearch();
  fetchGlobalSuggestions();
});
$('#global-search').addEventListener('focus', paintGlobalSearch);
$('#global-search').addEventListener('blur', () => setTimeout(paintGlobalSearch, 0));
document.addEventListener('mousedown', (ev) => { if (!ev.target.closest?.('.global-search')) closeGlobalSearch(); });
$('#global-search').addEventListener('keydown', (ev) => {
  const q = ev.target.value.trim();
  if (ev.key === 'Escape') {
    if (ev.target.value) ev.target.value = '';
    else ev.target.blur();
    paintGlobalSearch();
    return;
  }
  if (!q) return;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const n = globalSearch.items.length;
    globalSearch.active = (globalSearch.active + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
    paintGlobalSearch();
    return;
  }
  if (ev.key !== 'Enter' || ev.isComposing) return;
  ev.preventDefault();
  if (ev.metaKey || ev.ctrlKey) runGlobalSearchItem({ kind: 'ask' }, q);
  else if (ev.altKey) runGlobalSearchItem({ kind: 'research' }, q);
  else runGlobalSearchItem(globalSearch.items[globalSearch.active] ?? { kind: 'search' }, q);
});
// a pick happens on mousedown, before the box loses focus and the list goes
$('#global-search-menu').addEventListener('mousedown', (ev) => {
  const row = ev.target.closest('.gs-item');
  ev.preventDefault();
  if (!row) return;
  const item = globalSearch.items[Number(row.dataset.i)];
  if (item) runGlobalSearchItem(item, $('#global-search').value.trim());
});
document.addEventListener('keydown', (ev) => {
  if ($('#app-shell').hidden) return;
  const typing = ev.target.closest?.('input, textarea, select, [contenteditable="true"]');
  if ((ev.key === 'k' && (ev.metaKey || ev.ctrlKey)) || (ev.key === '/' && !typing && !ev.metaKey && !ev.ctrlKey && !ev.altKey)) {
    ev.preventDefault();
    $('#global-search').focus();
    $('#global-search').select();
  }
});

/** A question from the search box: a new Ask conversation, sent at once — or left in the composer when Ask cannot answer. */
async function askFromAnywhere(text) {
  navigate('ask');
  await chatLoaded?.catch(() => {});
  if (chatReadiness && chatReadiness.ready === false) {
    $('#chat-input').value = text;
    $('#chat-input').focus();
    toast('Ask has nothing to run on yet — the question waits in the composer', 5000);
    return;
  }
  stopChatPolling();
  chatActiveId = null;
  $('#chat-input').value = text;
  await sendChat();
}

/** A topic from the search box fills the new-study composer; refining spends a model call, so a person starts it. */
async function researchFromAnywhere(text) {
  navigate('studies');
  await studiesLoaded?.catch(() => {});
  showComposer();
  $('#study-topic').value = text;
  $('#study-topic').focus();
  toast('Check the options, then Refine the question', 4000);
}

/* ------------------------------- graph --------------------------------- */

/**
 * One colour per entity type, shared by the graph canvas and the entity table's type pills (set through
 * element.style, as the page policy allows) — the same set as the Mac app's (GraphPalette.swift). The
 * four common core types (organization, product, concept, person) stay apart under red-green colour
 * blindness, and so do the finance pack's common types (market, index, sector, theme, fund), from each
 * other and from those four; the rarer finance types are kept distinct in normal vision and may share a
 * colour-blind appearance only with rare or unrelated types, so their icons tell them apart there.
 */
const ENTITY_COLORS = {
  organization: '#ba7f02', product: '#e5657b', concept: '#9581ef', person: '#09a0a0', location: '#4b99d7', event: '#c158ae',
  technology: '#3db6cf', project: '#d76549', component: '#627ace', datasource: '#7d8ea1', dataset: '#8ca2ae', other: '#7c8088',
  // the finance ontology pack
  market: '#4170e9', index: '#d6b529', security: '#a6a266', fund: '#cba1fa', sector: '#148a53',
  theme: '#e29f81', indicator: '#c1ccd7', currency: '#56d0af', commodity: '#ca564b', policy: '#eda6c1',
};
const entityColor = (type) => ENTITY_COLORS[type] ?? ENTITY_COLORS.other;

const GRAPH_KEY = 'knode-os.graph.v1';

/** Display preferences for the graph (web/graph.js draws by them), kept across workspaces and reloads. */
function restoreGraphSettings() {
  const defaults = window.KnodeGraph?.DEFAULTS ?? {};
  let saved = {};
  try {
    const raw = JSON.parse(localStorage.getItem(GRAPH_KEY) ?? 'null');
    if (raw && raw.v === 1) saved = raw;
  } catch {
    /* storage may be off, or hold something older */
  }
  const settings = { ...defaults };
  for (const key of Object.keys(defaults)) if (key in saved) settings[key] = saved[key];
  return settings;
}

function saveGraphSettings() {
  try {
    localStorage.setItem(GRAPH_KEY, JSON.stringify({ v: 1, ...graphState.settings }));
  } catch {
    /* storage may be off */
  }
}

const graphState = { graph: null, res: null, mode: 'overview', query: '', loaded: false, settings: restoreGraphSettings() };

function resetGraph() {
  graphState.graph?.clear();
  graphState.res = null;
  graphState.query = '';
  graphState.loaded = false;
  $('#graph-caption').textContent = '';
  $('#graph-legend').innerHTML = '';
  $('#graph-side').innerHTML = '';
}

/** The canvas controller, built on first use; without d3 the stage says so instead of breaking. */
function ensureGraph() {
  if (graphState.graph) return graphState.graph;
  if (!window.KnodeGraph?.available) {
    const stage = $('#graph-stage');
    if (!stage.querySelector('.graph-empty')) {
      const p = document.createElement('p');
      p.className = 'hint graph-empty';
      p.textContent = 'the graph view needs the d3 package: run pnpm install where the service runs, then restart it';
      stage.appendChild(p);
    }
    return null;
  }
  const g = new KnodeGraph($('#graph-canvas'), { colors: ENTITY_COLORS, settings: graphState.settings });
  g.on('select', (n) => renderGraphSide(n));
  g.on('selectEdge', (b) => renderGraphSide(null, b));
  g.on('open', (n) => loadGraph(n.name));
  g.on('stats', (s) => paintGraphCaption(s));
  graphState.graph = g;
  paintGraphSettings();
  return g;
}

/** Empty query: the overview, the top entities by mentions. A name: the local graph around it. */
async function loadGraph(q) {
  const g = ensureGraph();
  if (!g) return;
  const s = graphState.settings;
  const params = new URLSearchParams({ limit: String(s.limit) });
  if (q) {
    params.set('q', q);
    params.set('depth', $('#graph-depth').value);
  } else if (!s.cooccur) {
    // the co-occurrence join is the slow part of an overview: skip it when it will not be drawn
    params.set('edges', 'typed');
  }
  try {
    const res = await api(`/api/graph?${params}`);
    graphState.res = res;
    graphState.mode = q ? 'search' : 'overview';
    graphState.query = q;
    graphState.loaded = true;
    $('#graph-q').value = q;
    g.load(res.nodes, res.edges, { mode: graphState.mode, communities: res.communities ?? [] });
    paintGraphLegend(res);
    renderGraphSide(null);
  } catch (e) {
    toast(`graph failed: ${e.message}`);
  }
}

function paintGraphCaption({ nodes, edges, clusters = 0 }) {
  const what = graphState.mode === 'search'
    ? `local graph · “${graphState.query}” · ${$('#graph-depth').value} hops · ranked by relevance`
    : `overview · top ${graphState.settings.limit} by mentions`;
  $('#graph-caption').textContent = `${what} · ${nodes} nodes · ${edges} edges${clusters ? ` · ${clusters} clusters` : ''}`;
  // the side panel lists the clusters while nothing is selected
  if (graphState.res && !graphState.graph?.selected && !graphState.graph?.selectedEdge) renderGraphSide(null);
}

/** A short line in a relation family's colour and pattern, built as SVG nodes (the page allows no inline style). */
function relationSample(family) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '8');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(ns, 'line');
  for (const [k, v] of Object.entries({ x1: 1, y1: 4, x2: 17, y2: 4, stroke: family.color, 'stroke-width': 2, 'stroke-linecap': family.dash.length ? 'round' : 'butt' })) line.setAttribute(k, String(v));
  if (family.dash.length) line.setAttribute('stroke-dasharray', family.dash.join(' '));
  svg.appendChild(line);
  return svg;
}

/**
 * Two rows of chips. Entity types in the result, with their counts; a click hides or shows that type.
 * Relation families, with their counts; a click hides or shows that family, and the co-occurrence chip
 * is the same switch as the settings checkbox.
 */
function paintGraphLegend(res) {
  const s = graphState.settings;
  const legend = $('#graph-legend');
  legend.textContent = '';

  const counts = new Map();
  for (const n of res.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  const hidden = new Set(s.hiddenTypes);
  const types = document.createElement('div');
  types.className = 'legend-row';
  for (const [type, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const chip = document.createElement('button');
    chip.className = `chip${hidden.has(type) ? ' off' : ''}`;
    chip.dataset.type = type;
    chip.title = 'hide or show this type';
    const dot = document.createElement('span');
    dot.className = 'dot ring';
    const color = entityColor(type);
    dot.style.borderColor = color;
    if (s.glow) dot.style.boxShadow = `0 0 6px 1px ${color}`;
    chip.append(dot, `${type} · ${n}`);
    types.appendChild(chip);
  }

  const families = new Map();
  for (const e of res.edges) {
    const id = KnodeGraph.family(e.type).id;
    families.set(id, (families.get(id) ?? 0) + 1);
  }
  const relations = document.createElement('div');
  relations.className = 'legend-row';
  for (const family of KnodeGraph.FAMILIES) {
    const n = families.get(family.id) ?? 0;
    // co-occurrence stays listed when switched off: an overview then does not even fetch it
    if (!n && family.id !== 'cooccur') continue;
    const off = family.id === 'cooccur' ? !s.cooccur : (s.hiddenRelations ?? []).includes(family.id);
    const chip = document.createElement('button');
    chip.className = `chip${off ? ' off' : ''}`;
    chip.dataset.family = family.id;
    chip.title = 'hide or show this relation family';
    chip.append(relationSample(family), n ? `${family.label} · ${n}` : family.label);
    relations.appendChild(chip);
  }
  legend.append(types, relations);
}

$('#graph-legend').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip');
  if (!chip) return;
  const family = chip.dataset.family;
  if (family === 'cooccur') {
    // the settings checkbox owns this switch, refetch included
    const box = $('#gs-cooccur');
    box.checked = !graphState.settings.cooccur;
    chip.classList.toggle('off', !box.checked);
    box.dispatchEvent(new Event('change'));
    return;
  }
  if (family) {
    const off = new Set(graphState.settings.hiddenRelations ?? []);
    if (off.has(family)) off.delete(family);
    else off.add(family);
    chip.classList.toggle('off', off.has(family));
    graphState.settings.hiddenRelations = [...off];
    graphState.graph?.setSettings({ hiddenRelations: graphState.settings.hiddenRelations });
    saveGraphSettings();
    return;
  }
  const hidden = new Set(graphState.settings.hiddenTypes);
  if (hidden.has(chip.dataset.type)) hidden.delete(chip.dataset.type);
  else hidden.add(chip.dataset.type);
  chip.classList.toggle('off', hidden.has(chip.dataset.type));
  graphState.settings.hiddenTypes = [...hidden];
  graphState.graph?.setSettings({ hiddenTypes: graphState.settings.hiddenTypes });
  saveGraphSettings();
});

/** The settings panel shows the current values; every control writes straight back. */
function paintGraphSettings() {
  const s = graphState.settings;
  for (const key of Object.keys(window.KnodeGraph?.DEFAULTS ?? {})) {
    const el = document.getElementById(`gs-${key}`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = Boolean(s[key]);
    else el.value = String(s[key]);
    const out = el.nextElementSibling;
    if (out && out.tagName === 'OUTPUT') out.textContent = String(s[key]);
  }
}

for (const key of Object.keys(window.KnodeGraph?.DEFAULTS ?? {})) {
  const el = document.getElementById(`gs-${key}`);
  if (!el) continue;
  const apply = () => {
    const value = el.type === 'checkbox' ? el.checked : Number(el.value);
    graphState.settings[key] = value;
    const out = el.nextElementSibling;
    if (out && out.tagName === 'OUTPUT') out.textContent = String(value);
    saveGraphSettings();
    // the node count, and co-occurrence in an overview, change what the server sends
    if (key === 'limit' || (key === 'cooccur' && graphState.mode === 'overview')) {
      if (graphState.loaded) loadGraph(graphState.query);
      return;
    }
    graphState.graph?.setSettings({ [key]: value });
    // the legend shows co-occurrence's switch, and glow on the type swatches
    if ((key === 'glow' || key === 'cooccur') && graphState.res) paintGraphLegend(graphState.res);
  };
  el.addEventListener(el.type === 'range' ? 'input' : 'change', apply);
}
$('#gs-query').addEventListener('input', () => graphState.graph?.setQuery($('#gs-query').value));
$('#gs-fit').addEventListener('click', () => graphState.graph?.fit());
$('#gs-reset').addEventListener('click', () => {
  const defaults = window.KnodeGraph?.DEFAULTS ?? {};
  const refetch = graphState.settings.limit !== defaults.limit || graphState.settings.cooccur !== defaults.cooccur;
  graphState.settings = { ...defaults };
  saveGraphSettings();
  paintGraphSettings();
  $('#gs-query').value = '';
  graphState.graph?.setQuery('');
  graphState.graph?.setSettings(graphState.settings);
  if (refetch && graphState.loaded) loadGraph(graphState.query);
  else if (graphState.res) paintGraphLegend(graphState.res);
});

/**
 * The panel beside the canvas: the selected node with its neighbours and
 * claims, the selected edge with each distinct relationship it holds, or,
 * with nothing selected, the top of the result.
 */
function renderGraphSide(node, edge = null) {
  const side = $('#graph-side');
  const res = graphState.res;
  const g = graphState.graph;
  if (!res || !g) {
    side.innerHTML = '';
    return;
  }
  if (!res.nodes.length) {
    side.innerHTML = '<p class="hint">graph is empty — index docs first (entities come from [[wikilinks]], frontmatter and extraction).</p>';
    return;
  }
  const claimsBySubject = new Map();
  for (const cl of res.claims ?? []) (claimsBySubject.get(cl.subject) ?? claimsBySubject.set(cl.subject, []).get(cl.subject)).push(cl);
  // the number means mentions in an overview and relevance to the query in a search: say which
  const numbers = (n) => {
    const parts = [`${n.mentionCount} mentions`, `degree ${typeof n.degree === 'number' ? n.degree : '?'}`];
    if (graphState.mode === 'search') parts.unshift(`relevance ${(n.score ?? 0).toFixed(2)}`);
    return parts.join(' · ');
  };
  const facts = (n, max) => (claimsBySubject.get(n.name) ?? []).slice(0, max)
    .map((cl) => `<div class="hint">◈ ${esc(cl.statement.slice(0, 120))} <span class="mono">[${esc(cl.kind && cl.kind !== 'fact' ? cl.kind : cl.status)}]</span></div>`)
    .join('');
  const pill = (type) => `<span class="tpill" data-type="${esc(type)}">${esc(type)}</span>`;
  const relationList = (relations) => {
    const names = relations.map((r) => esc(KnodeGraph.relationName(r)));
    return names.length > 2 ? `${names.slice(0, 2).join(' · ')} +${names.length - 2}` : names.join(' · ');
  };

  if (edge) {
    const n = edge.relations.length;
    const rows = edge.relations.map((r) => {
      // a directed relation reads source → target; an undirected one joins the two ends
      const way = r.directed ? `${esc(r.source.name)} → ${esc(r.target.name)}` : `${esc(edge.a.name)} ↔ ${esc(edge.b.name)}`;
      const when = r.validFrom || r.validTo ? `<div class="hint mono">valid ${esc(r.validFrom ?? '…')} – ${esc(r.validTo ?? '…')}</div>` : '';
      return `<div class="rel" data-family="${esc(r.fam.id)}">
          <div class="rel-head"><span class="rel-swatch"></span><b>${esc(KnodeGraph.relationName(r))}</b><span class="hint mono">weight ${r.weight.toFixed(1)}</span></div>
          <div class="hint mono">${way}</div>
          ${r.description ? `<div class="hint">${esc(r.description.slice(0, 280))}</div>` : ''}${when}
        </div>`;
    }).join('');
    side.innerHTML = `<div class="entity-card selected">
        <p class="eyebrow">relationship</p>
        <div class="edge-ends">
          <div class="nb" data-id="${esc(edge.a.id)}">${pill(edge.a.type)}<span>${esc(edge.a.name)}</span></div>
          <div class="nb" data-id="${esc(edge.b.id)}">${pill(edge.b.type)}<span>${esc(edge.b.name)}</span></div>
        </div>
        <div class="hint mono">${n === 1 ? '1 relationship' : `${n} distinct relationships`} between them</div>
      </div>
      <div class="entity-card">${rows}</div>`;
    for (const nb of side.querySelectorAll('.nb')) nb.addEventListener('click', () => { g.select(nb.dataset.id); g.focus(nb.dataset.id); });
    for (const p of side.querySelectorAll('.tpill')) p.style.color = entityColor(p.dataset.type);
    for (const row of side.querySelectorAll('.rel')) row.querySelector('.rel-swatch').style.background = KnodeGraph.FAMILIES.find((f) => f.id === row.dataset.family)?.color ?? '';
    return;
  }

  if (node) {
    const neighbours = g.neighbours(node.id);
    side.innerHTML = `<div class="entity-card selected">
        ${pill(node.type)} <span class="ename">${esc(node.name)}</span>
        <div class="hint">${esc((node.description || '').slice(0, 240))}</div>
        <div class="hint mono">${esc(numbers(node))}</div>
        ${facts(node, 5)}
        <div class="actions">
          <button data-local>local graph</button>
          <button data-wiki${node.wikiPath ? '' : ' disabled title="no wiki page yet"'}>open wiki page</button>
        </div>
      </div>
      <div class="entity-card"><b>${neighbours.length ? `${neighbours.length} neighbours in view` : 'no neighbours in view'}</b>
        ${neighbours.slice(0, 24).map((x) => `<div class="nb" data-id="${esc(x.node.id)}">${pill(x.node.type)}<span>${esc(x.node.name)}</span><span class="hint mono"><span class="rel-swatch" data-family="${esc(x.fam.id)}"></span>${relationList(x.relations)} ${x.weight.toFixed(1)}</span></div>`).join('')}
      </div>`;
    for (const sw of side.querySelectorAll('.rel-swatch')) sw.style.background = KnodeGraph.FAMILIES.find((f) => f.id === sw.dataset.family)?.color ?? '';
    side.querySelector('[data-local]').addEventListener('click', () => loadGraph(node.name));
    if (node.wikiPath) side.querySelector('[data-wiki]').addEventListener('click', () => { navigate('files'); openFile(node.wikiPath); });
    for (const nb of side.querySelectorAll('.nb')) {
      nb.addEventListener('click', () => { g.select(nb.dataset.id); g.focus(nb.dataset.id); });
      nb.addEventListener('mouseenter', () => g.setHover(nb.dataset.id));
      nb.addEventListener('mouseleave', () => g.setHover(null));
    }
  } else {
    // the islands on the canvas, largest first: a click brings one into view
    const clusters = g.clusters();
    const clusterRow = clusters.length
      ? `<p class="eyebrow">clusters</p><div class="legend-row graph-clusters">${clusters.map((c) =>
        `<button class="chip" data-cluster="${c.id}" title="show this cluster">${esc(c.label.length > 22 ? `${c.label.slice(0, 21)}…` : c.label)} · ${c.size}</button>`).join('')}</div>`
      : '';
    side.innerHTML = clusterRow + res.nodes.slice(0, 30).map((n) => `<div class="entity-card pick" data-id="${esc(n.id)}">
        ${pill(n.type)} <span class="ename">${esc(n.name)}</span>
        <div class="hint">${esc((n.description || '').slice(0, 140))}</div>
        <div class="hint mono">${esc(numbers(n))}</div>${facts(n, 3)}
      </div>`).join('');
    if (res.chunks?.length) {
      side.insertAdjacentHTML('beforeend', `<p class="hint">grounded in: ${[...new Set(res.chunks.map((c) => c.path))].slice(0, 5).map(pageLink).join(', ')}</p>`);
      wireOpenLinks(side);
    }
    for (const card of side.querySelectorAll('.entity-card.pick')) card.addEventListener('click', () => { g.select(card.dataset.id); g.focus(card.dataset.id); });
    for (const chip of side.querySelectorAll('[data-cluster]')) chip.addEventListener('click', () => g.fitCluster(Number(chip.dataset.cluster)));
  }
  for (const p of side.querySelectorAll('.tpill')) p.style.color = entityColor(p.dataset.type);
}

$('#btn-graph').addEventListener('click', () => loadGraph($('#graph-q').value.trim()));
$('#graph-q').addEventListener('keydown', (e) => e.key === 'Enter' && loadGraph($('#graph-q').value.trim()));
$('#btn-graph-insights').addEventListener('click', async () => {
  try {
    const ins = await api('/api/graph/insights');
    const side = $('#graph-side');
    side.innerHTML = `<div class="entity-card"><b>totals</b><div class="hint mono">${ins.totals.entities} entities · ${ins.totals.relations} relations · ${ins.totals.mentions} mentions</div></div>`;
    if (ins.hubs.length) {
      side.innerHTML += `<div class="entity-card"><b>hubs</b>${ins.hubs.map((h) => `<div class="hint">${esc(h.name)} — degree ${h.degree}</div>`).join('')}</div>`;
    }
    if (ins.isolated.length) {
      side.innerHTML += `<div class="entity-card"><b>isolated</b>${ins.isolated.map((h) => `<div class="hint">${esc(h.name)}</div>`).join('')}</div>`;
    }
    side.innerHTML += `<div class="entity-card"><b>types</b>${ins.typeCounts.map((t) => `<div class="hint">${esc(t.type)}: ${t.n}</div>`).join('')}</div>`;
  } catch (e) {
    toast(`insights failed: ${e.message}`);
  }
});

/* ------------------------------ entities ------------------------------- */

/**
 * Knowledge → Entities: one page of GET /api/entities at a time. The server
 * filters, sorts and counts; this keeps the query and paints what comes back.
 */
const entState = { q: '', type: '', merged: false, sort: 'mentions', order: 'desc', offset: 0, limit: 50, total: 0, seq: 0 };
/** The order a column reads best in when it is first chosen. */
const ENT_FIRST_ORDER = { name: 'asc', type: 'asc', mentions: 'desc', evidence: 'desc', updated: 'desc' };
let entTimer = null;

function resetEntities() {
  Object.assign(entState, { q: '', type: '', merged: false, offset: 0, total: 0 });
  entState.seq++;
  $('#ent-q').value = '';
  $('#ent-merged').checked = false;
  $('#ent-type').innerHTML = '<option value="">all types</option>';
  delete $('#ent-type').dataset.sig;
  $('#ent-count').textContent = '';
  $('#ent-page').textContent = '';
  $('#entities-table tbody').innerHTML = '';
}

async function loadEntities() {
  // boot runs a loader twice and a slow page may arrive after a fast one: the latest request wins
  const seq = ++entState.seq;
  const params = new URLSearchParams({ sort: entState.sort, order: entState.order, offset: String(entState.offset), limit: String(entState.limit) });
  if (entState.q) params.set('q', entState.q);
  if (entState.type) params.set('type', entState.type);
  if (entState.merged) params.set('merged', '1');
  try {
    const page = await api(`/api/entities?${params}`);
    if (seq === entState.seq) renderEntities(page);
  } catch (e) {
    if (seq === entState.seq) $('#entities-table tbody').innerHTML = `<tr><td colspan="11" class="hint">entities failed: ${esc(e.message)}</td></tr>`;
  }
}

function renderEntities(page) {
  entState.total = page.total;
  entState.offset = page.offset;
  entState.limit = page.limit;
  const tbody = $('#entities-table tbody');
  tbody.innerHTML = page.items.map((e) => {
    const aliases = e.aliases.slice(0, 3).join(', ') + (e.aliases.length > 3 ? ` +${e.aliases.length - 3}` : '');
    const sources = Object.entries(e.sources).sort((a, b) => b[1] - a[1]).map(([family, n]) => `<span class="spill">${esc(family)} ${n}</span>`).join(' ');
    return `<tr>
      <td><a href="#" class="ename" data-explore="${esc(e.name)}" title="explore in the graph">${esc(e.name)}</a>${e.canonicalId ? ' <span class="hint">merged</span>' : ''}</td>
      <td><span class="tpill" data-type="${esc(e.type)}">${esc(e.type)}</span></td>
      <td class="hint" title="${esc(e.aliases.join(', '))}">${esc(aliases)}</td>
      <td class="hint ent-desc" title="${esc(e.description)}">${esc(e.description.slice(0, 120))}</td>
      <td class="num mono">${e.mentions}</td>
      <td class="num mono">${e.documents}</td>
      <td class="num mono">${e.relations}</td>
      <td class="num mono">${e.evidence}</td>
      <td>${sources}</td>
      <td>${e.wikiPath ? pageLink(e.wikiPath) : '<span class="hint">—</span>'}</td>
      <td class="mono hint">${e.updatedAt ? new Date(e.updatedAt).toLocaleDateString() : '—'}</td>
    </tr>`;
  }).join('');
  if (!page.items.length) {
    const filtered = entState.q || entState.type;
    tbody.innerHTML = `<tr><td colspan="11" class="hint">${filtered ? 'no entities match' : 'no entities yet — index documents first (entities come from frontmatter, [[wikilinks]] and extraction)'}</td></tr>`;
  }
  for (const pill of tbody.querySelectorAll('.tpill')) pill.style.color = entityColor(pill.dataset.type);
  wireOpenLinks(tbody);

  // the type filter keeps its options, and the selection, while the types hold still
  const sel = $('#ent-type');
  const sig = page.typeCounts.map((t) => `${t.type}:${t.n}`).join('|');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = `<option value="">all types</option>${page.typeCounts.map((t) => `<option value="${esc(t.type)}">${esc(t.type)} (${t.n.toLocaleString()})</option>`).join('')}`;
    sel.value = entState.type;
    if (sel.value !== entState.type) entState.type = '';
  }

  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = Math.min(page.total, page.offset + page.items.length);
  $('#ent-count').textContent = `${page.total.toLocaleString()} ${page.total === 1 ? 'entity' : 'entities'}`;
  $('#ent-page').textContent = page.total ? `${from.toLocaleString()}–${to.toLocaleString()} of ${page.total.toLocaleString()}` : '';
  $('#ent-prev').disabled = page.offset <= 0;
  $('#ent-next').disabled = to >= page.total;
  $('#ent-size').value = String(page.limit);
  for (const th of document.querySelectorAll('#entities-table th[data-sort]')) {
    th.classList.toggle('sorted', th.dataset.sort === entState.sort);
    th.classList.toggle('asc', th.dataset.sort === entState.sort && entState.order === 'asc');
  }
}

/** Open the graph on an entity: the box holds the name, and arrival (or a view already loaded) runs it once. */
function exploreEntity(name) {
  $('#graph-q').value = name;
  if (graphState.loaded) loadGraph(name);
  navigate('graph');
}

$('#ent-q').addEventListener('input', () => {
  clearTimeout(entTimer);
  entTimer = setTimeout(() => {
    entState.q = $('#ent-q').value.trim();
    entState.offset = 0;
    loadEntities();
  }, 250);
});
$('#ent-type').addEventListener('change', () => {
  entState.type = $('#ent-type').value;
  entState.offset = 0;
  loadEntities();
});
$('#ent-merged').addEventListener('change', () => {
  entState.merged = $('#ent-merged').checked;
  entState.offset = 0;
  loadEntities();
});
$('#ent-size').addEventListener('change', () => {
  const limit = Number($('#ent-size').value) || 50;
  // the first row on screen stays on screen, on whichever page now holds it
  entState.offset = Math.floor(entState.offset / limit) * limit;
  entState.limit = limit;
  loadEntities();
});
$('#ent-prev').addEventListener('click', () => {
  entState.offset = Math.max(0, entState.offset - entState.limit);
  loadEntities();
});
$('#ent-next').addEventListener('click', () => {
  entState.offset += entState.limit;
  loadEntities();
});
$('#entities-table thead').addEventListener('click', (ev) => {
  const th = ev.target.closest('th[data-sort]');
  if (!th) return;
  const col = th.dataset.sort;
  entState.order = col === entState.sort ? (entState.order === 'asc' ? 'desc' : 'asc') : ENT_FIRST_ORDER[col];
  entState.sort = col;
  entState.offset = 0;
  loadEntities();
});
$('#entities-table tbody').addEventListener('click', (ev) => {
  const a = ev.target.closest('a[data-explore]');
  if (!a) return;
  ev.preventDefault();
  exploreEntity(a.dataset.explore);
});

/* ------------------------------- traces -------------------------------- */

async function loadTraces() {
  const tbody = $('#traces-table tbody');
  tbody.innerHTML = '';
  try {
    const traces = await api('/api/traces');
    $('#traces-count').textContent = traces.length ? `· ${traces.length} sessions · ${traces.filter((t) => t.analyzed_at).length} analyzed` : '· none yet';
    for (const t of traces) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(t.source)}</td><td class="mono">${esc(t.project ?? '-')}</td>
        <td class="mono">${esc((t.session_id ?? '').slice(0, 24))}</td>
        <td class="mono">${t.started_at ? new Date(t.started_at).toLocaleString() : '-'}</td>
        <td class="mono">${(t.bytes / 1024).toFixed(0)} KB</td>
        <td>${t.analyzed_at ? '✓' : ''}</td>`;
      // a trace is a file under raw/, so it opens where every other file does
      tr.title = `open ${t.path}`;
      tr.addEventListener('click', () => { navigate('files'); openFile(t.path); });
      tbody.appendChild(tr);
    }
    if (!traces.length) tbody.innerHTML = '<tr><td colspan="6" class="hint">no traces yet — run a Claude Code / Codex session, then sync.</td></tr>';
  } catch (e) {
    toast(`traces failed: ${e.message}`);
  }
}

/**
 * Copy new Claude Code and Codex sessions from this Mac into raw/traces —
 * from Dream, or Library's Import menu. It reads the service machine's home
 * folders, so it asks first.
 */
async function collectTraces() {
  if (!confirm('Copy your Claude Code and Codex sessions from this Mac into raw/traces?\n\nDream reads them overnight; new sessions keep arriving after this.')) return;
  toast('collecting agent traces…', 30000);
  try {
    const s = await api('/api/traces/sync', { method: 'POST' });
    toast(`collected ${s.copied} traces and ${s.skills} skill files`);
    if (currentTab === 'dream') loadTraces();
    else if (currentTab === 'files' && s.copied) {
      reveal('raw/traces');
      await loadTree();
    }
    loadStats();
    loadNotices();
  } catch (e) {
    toast(`could not collect traces: ${e.message}`, 5000);
  }
}

$('#btn-trace-sync').addEventListener('click', collectTraces);

/* -------------------------------- dream -------------------------------- */

/** Tasks → Dream: when it runs, its suggestions, and the traces it reads. */
function loadDream() {
  loadSuggestions();
  loadTraces();
  loadDreamSchedule();
}

async function loadDreamSchedule() {
  try {
    const t = await api('/api/tasks');
    const dream = t.scheduled.find((x) => x.id === 'dream');
    $('#dream-schedule').textContent = dream?.enabled
      ? `Runs every night at ${dream.at}${dream.next ? ` — next ${untilText(dream.next)}` : ''} — over the last ${t.dream.lookbackDays} days of your Claude Code and Codex sessions, and suggests skills, memory and knowledge to keep.`
      : 'Reads your recent Claude Code and Codex sessions and suggests skills, memory and knowledge to keep. No nightly run is scheduled (dream.schedule is not a time of day).';
  } catch {
    /* an older service or no ingest group: the default line stays */
  }
}

async function loadSuggestions() {
  const el = $('#suggestions');
  el.innerHTML = '';
  try {
    const [stats, suggestions] = await Promise.all([api('/api/stats'), api('/api/suggestions')]);
    if (stats.lastDream) {
      $('#dream-info').textContent = `Last run ${new Date(stats.lastDream.at).toLocaleString()} over ${stats.lastDream.sessions} sessions → ${stats.lastDream.report}`;
    }
    if (!suggestions.length) {
      el.innerHTML = '<p class="hint">No suggestions yet — collect agent traces, then Dream now (or wait for tonight).</p>';
      return;
    }
    for (const s of suggestions) {
      const div = document.createElement('div');
      div.className = `suggestion ${s.status}`;
      const evidence = (s.evidence ?? []).map((e) => `<div>${esc(e)}</div>`).join('');
      div.innerHTML = `<span class="skind ${esc(s.kind)}">${esc(s.kind)}</span> <span class="hint mono">${esc(s.status)} · ${new Date(s.created_at).toLocaleDateString()}</span>
        <div class="stitle">${esc(s.title)}</div>
        <div class="sbody markdown">${renderMd(s.body)}</div>
        ${evidence ? `<div class="evidence">${evidence}</div>` : ''}
        <div class="sactions">
          ${s.status === 'pending' ? `<button data-act="accepted">accept</button><button data-act="rejected">reject</button>` : ''}
          ${s.report_path ? `<button data-report="${esc(s.report_path)}">report</button>` : ''}
        </div>`;
      div.querySelectorAll('button[data-act]').forEach((b) =>
        b.addEventListener('click', async () => {
          await api(`/api/suggestions/${s.id}/status`, { method: 'POST', body: JSON.stringify({ status: b.dataset.act }) });
          loadSuggestions();
        }),
      );
      const rb = div.querySelector('button[data-report]');
      if (rb) rb.addEventListener('click', () => {
        navigate('files');
        openFile(rb.dataset.report);
      });
      el.appendChild(div);
    }
  } catch (e) {
    el.innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
  }
}

/* -------------------------------- wiki (research) ---------------------- */

const pageLink = (p) => `<a href="#" data-open="${esc(p)}" class="mono">${esc(p)}</a>`;

function wireOpenLinks(root) {
  root.querySelectorAll('a[data-open]').forEach((a) =>
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      navigate('files');
      openFile(a.dataset.open);
    }),
  );
}

async function loadResearch() {
  await Promise.all([loadInitCard(), loadResearchJobs(), loadResearchPages(), loadResearchRecommendations()]);
}

async function loadResearchJobs() {
  const el = $('#research-jobs');
  try {
    const jobs = await api('/api/research/jobs?limit=40');
    if (!jobs.length) {
      el.innerHTML = '<p class="hint">no research jobs yet — queue one above, or accept a recommendation.</p>';
      return;
    }
    el.innerHTML = '';
    for (const j of jobs) {
      const div = document.createElement('div');
      div.className = 'job';
      const what = `${esc(j.kind)} · ${esc(j.target ?? j.query ?? '')}`;
      const when = new Date(j.finishedAt ?? j.startedAt ?? j.createdAt).toLocaleString();
      const actions = [];
      // a study's pages are archived and removed with their study, on its page
      const own = !j.payload?.study;
      if (j.pause) actions.push(`<button data-act="resume">resume now</button>`);
      if (j.status === 'queued' || j.status === 'running') actions.push(`<button data-act="cancel">cancel</button>`);
      if (j.status === 'failed' || j.status === 'cancelled') actions.push(`<button data-act="retry">retry</button>`);
      if (own && ['done', 'failed', 'cancelled'].includes(j.status)) actions.push(`<button data-act="archive" title="take it off this list; its page stays">archive</button>`);
      if (own && (j.status === 'failed' || j.status === 'cancelled')) actions.push(`<button data-act="remove" title="remove the job and its session log">remove</button>`);
      actions.push(`<button data-log="${esc(j.id)}">log</button>`);
      div.innerHTML = `${j.pause ? pauseChip(j.pause) : `<span class="jstatus ${esc(j.status)}">${esc(j.status)}</span>`}
        <span>${what}${j.outputPath ? ` → ${pageLink(j.outputPath)}` : ''} <span class="hint mono">${when}${j.turns ? ` · ${j.turns} turns` : ''}${j.agent ? ` · ${esc(j.agent)}` : ''}</span></span>
        <span class="jactions">${actions.join('')}</span>
        ${j.error ? `<div class="jerr">${esc(j.error)}</div>` : ''}`;
      div.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', async () => {
        const act = b.dataset.act;
        if (act === 'remove' && !confirm('Remove this job and its session log? A page it wrote stays.')) return;
        try {
          await api(`/api/research/jobs/${j.id}${act === 'remove' ? '' : `/${act}`}`, { method: act === 'remove' ? 'DELETE' : 'POST' });
        } catch (e) {
          toast(`${act}: ${e.message}`, 5000);
        }
        loadResearchJobs();
      }));
      div.querySelector('button[data-log]')?.addEventListener('click', async () => {
        const full = await api(`/api/research/jobs/${j.id}?log=1`);
        const pre = document.createElement('pre');
        pre.className = 'mono';
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.maxHeight = '320px';
        pre.style.overflow = 'auto';
        pre.textContent = full.log ?? '(no transcript yet)';
        const old = div.querySelector('pre');
        if (old) old.remove(); else div.appendChild(pre);
      });
      wireOpenLinks(div);
      el.appendChild(div);
    }
  } catch (e) {
    el.innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
  }
}

async function loadResearchPages() {
  const el = $('#research-pages');
  try {
    const pages = await api('/api/research/pages');
    if (!pages.length) {
      el.innerHTML = '<p class="hint">no research pages yet.</p>';
      return;
    }
    el.innerHTML = '';
    for (const p of pages) {
      const div = document.createElement('div');
      div.className = 'rpage';
      const trust = p.trust ?? (p.exists ? 'unsynced' : 'missing');
      div.innerHTML = `<span>${pageLink(p.path)} <span class="hint">${esc(p.kind)} · ${esc(p.target ?? '')}${p.warnings?.length ? ` · ${p.warnings.length} warnings` : ''}</span></span>
        <span class="trust ${trust}">${trust}</span>
        <span class="ractions">
          ${p.trust === 'quarantined' ? `<button data-trust="trusted">promote</button>` : ''}
          ${p.trust === 'trusted' ? `<button data-trust="quarantined">demote</button>` : ''}
          <button data-refresh="${esc(p.path)}">refresh</button>
        </span>`;
      div.querySelector('button[data-trust]')?.addEventListener('click', async (ev) => {
        try {
          await api('/api/trust', { method: 'POST', body: JSON.stringify({ path: p.path, to: ev.target.dataset.trust }) });
          toast(`${p.path}: ${ev.target.dataset.trust}`);
          loadResearchPages();
        } catch (e) {
          toast(`trust change failed: ${e.message}`);
        }
      });
      div.querySelector('button[data-refresh]')?.addEventListener('click', async () => {
        await api('/api/research/jobs', { method: 'POST', body: JSON.stringify({ kind: 'refresh', target: p.path }) });
        toast('refresh queued');
        loadResearchJobs();
      });
      wireOpenLinks(div);
      el.appendChild(div);
    }
  } catch (e) {
    el.innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
  }
}

async function loadResearchRecommendations() {
  const el = $('#research-recommendations');
  try {
    const recs = await api('/api/research/recommendations');
    if (!recs.length) {
      el.innerHTML = '<p class="hint">nothing to recommend yet — recommendations come from hot entities, repeated questions and pages whose facts changed.</p>';
      return;
    }
    el.innerHTML = '';
    for (const r of recs) {
      const div = document.createElement('div');
      div.className = 'rec';
      div.innerHTML = `<div><b>${esc(r.kind)}</b> · ${esc(r.target)} <span class="hint mono">score ${Number(r.score).toFixed(2)}</span></div>
        <div class="recwhy">${(r.reasons ?? []).map(esc).join(' · ')}</div>
        <div class="recactions"><button data-queue>queue</button>${r.suggestionId ? `<button data-dismiss>dismiss</button>` : ''}</div>`;
      div.querySelector('button[data-queue]').addEventListener('click', async () => {
        if (r.suggestionId) await api(`/api/suggestions/${r.suggestionId}/status`, { method: 'POST', body: JSON.stringify({ status: 'accepted' }) });
        else await api('/api/research/jobs', { method: 'POST', body: JSON.stringify({ kind: r.kind, target: r.kind === 'question' ? undefined : r.target, query: r.kind === 'question' ? r.target : undefined }) });
        toast('research queued');
        loadResearch();
      });
      div.querySelector('button[data-dismiss]')?.addEventListener('click', async () => {
        await api(`/api/suggestions/${r.suggestionId}/status`, { method: 'POST', body: JSON.stringify({ status: 'rejected' }) });
        loadResearchRecommendations();
      });
      el.appendChild(div);
    }
  } catch (e) {
    el.innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
  }
}

$('#btn-research-queue').addEventListener('click', async () => {
  const kind = $('#research-kind').value;
  const text = $('#research-target').value.trim();
  if (!text) return toast('type an entity, concept, question or page path first');
  try {
    const body = kind === 'question' ? { kind, query: text } : { kind, target: text };
    const res = await api('/api/research/jobs', { method: 'POST', body: JSON.stringify(body) });
    toast(res.created ? `queued ${res.job.id}` : `already queued: ${res.job.id}`);
    $('#research-target').value = '';
    loadResearchJobs();
  } catch (e) {
    toast(`queue failed: ${e.message}`);
  }
});
$('#btn-research-refresh').addEventListener('click', loadResearch);

$('#btn-dream').addEventListener('click', async () => {
  const button = $('#btn-dream');
  button.disabled = true;
  toast('dreaming… this can take a minute', 90000);
  try {
    const res = await api('/api/dream', { method: 'POST' });
    toast(`dream complete: ${res.suggestions.length} suggestions (${res.sessions} sessions)`);
    if (currentTab === 'dream') loadDream();
    loadStats();
  } catch (e) {
    toast(`dream failed: ${e.message}`);
  } finally {
    button.disabled = false;
  }
});

/* --------------------- wiki · initialize the knowledge base ------------- */

const STEP_LABELS = { sync: 'Index the files', extract: 'Extract entities & claims', views: 'Regenerate stub pages', survey: 'Survey the base' };
let initJobTimer = null;
let initJobId = null;

function stopInitPolling() {
  clearTimeout(initJobTimer);
  initJobTimer = null;
}

const jobIsLive = (status) => status === 'queued' || status === 'running' || status === 'validating';

async function loadInitCard() {
  const summary = $('#init-summary');
  const button = $('#btn-init-kb');
  try {
    const { survey, guide, job } = await api('/api/research/init');
    const s = survey.stats;
    summary.textContent = `${s.documents} docs · ${survey.entities.total} entities · ${survey.relations.total} relations · ${s.claims} claims`
      + (survey.extraction.queued ? ` · ${survey.extraction.queued} awaiting extraction` : '');
    $('#init-guide').innerHTML = guide.exists
      ? `guide <a href="#" data-open="AGENTS.md" class="mono">AGENTS.md</a>${guide.stamp?.at ? ` · ${esc(guide.stamp.at.slice(0, 10))}` : ''}`
      : '<span class="muted">no guide yet</span>';
    wireOpenLinks($('#init-guide'));
    $('#init-title').textContent = guide.exists ? 'Re-initialize knowledge base' : 'Initialize knowledge base';
    button.textContent = guide.exists ? '⟳ re-initialize' : '⚙ initialize';
    button.disabled = Boolean(job && jobIsLive(job.status));
    if (job) renderInitJob(job);
    else $('#init-progress').hidden = true;
    if (job && jobIsLive(job.status)) watchInitJob(job.id);
    else stopInitPolling();
    if (s.documents === 0) summary.textContent += ' — add documents under raw/docs first';
  } catch (e) {
    summary.textContent = `unavailable: ${e.message}`;
  }
}

function renderInitJob(job) {
  $('#init-progress').hidden = false;
  const steps = job.steps ?? job.payload?.steps ?? [];
  $('#init-steps').innerHTML = steps.map((s) => `<li data-status="${esc(s.status)}"><b>${esc(STEP_LABELS[s.name] ?? s.name)}</b><span>${esc(s.detail ?? s.status)}</span></li>`).join('')
    || `<li data-status="running"><b>Starting…</b><span>${esc(job.status)}</span></li>`;
  const phases = job.phases?.length ? job.phases : job.payload?.phases ?? [];
  $('#init-phases').innerHTML = phases.length
    ? `<span class="hint">agent</span>${phases.map((p) => `<span class="jstatus ${p.error ? 'failed' : 'done'}" title="${esc(p.role ?? '')}${p.error ? ` · ${esc(p.error)}` : ''}">${esc(p.label)}${p.turns ? ` · ${p.turns}t` : ''}</span>`).join('')}`
    : '';
  const topics = job.payload?.topics ?? [];
  $('#init-topics').innerHTML = topics.length
    ? `<span class="hint">follow-up pages</span>${topics.map((t) => `<span class="chat-chip">${esc(t.kind)} · ${esc(t.target)}${t.queued ? '' : ' (not queued)'}</span>`).join('')}`
    : '';
  $('#init-error').textContent = job.error ?? '';
}

function watchInitJob(id) {
  stopInitPolling();
  initJobId = id;
  const tick = async () => {
    if (initJobId !== id || currentTab !== 'wiki') return;
    try {
      const job = await api(`/api/research/jobs/${id}`);
      renderInitJob(job);
      if (jobIsLive(job.status)) {
        initJobTimer = setTimeout(tick, 3000);
      } else {
        $('#btn-init-kb').disabled = false;
        toast(job.status === 'done' ? 'knowledge base initialized' : `initialization ${job.status}`);
        loadInitCard();
        loadResearchJobs();
        loadResearchPages();
      }
    } catch {
      initJobTimer = setTimeout(tick, 5000);
    }
  };
  initJobTimer = setTimeout(tick, 1500);
}

$('#btn-init-kb').addEventListener('click', async () => {
  const button = $('#btn-init-kb');
  button.disabled = true;
  try {
    const res = await api('/api/research/init', { method: 'POST' });
    toast(res.created ? 'initialization queued' : `already queued: ${res.job.id}`);
    $('#init-progress').hidden = false;
    renderInitJob(res.job);
    watchInitJob(res.job.id);
    loadResearchJobs();
  } catch (e) {
    button.disabled = false;
    toast(`could not start: ${e.message}`);
  }
});

/* ------------------------------ playbooks ------------------------------ */

/**
 * Settings → Playbooks: the files under playbooks/, which the file tree
 * leaves out, grouped the way knode-os reads them (src/fs/playbooks.ts). A
 * file is edited, reverted, or reset to the version knode-os ships; a group
 * another page owns points there instead. Saving is an administrator's call,
 * like every setting.
 */
const PLAYBOOK_GROUPS = {
  research: ['Research templates', 'What a research agent is told for each kind of page, and AGENTS.md, the protocol every research job shares.'],
  phases: ['Research phases', 'The prompt for each step of a research run: plan, collect, research, synthesize, review, revise.'],
  packs: ['Context packs', 'How knode gathers context for a question. The nightly review can revise them from what worked.'],
  intents: ['Intents', 'What an answer to each kind of question needs before it is worth giving.'],
  ontology: ['Ontology', 'The entity and relation types the knowledge graph uses.'],
  concepts: ['Concept stop list', 'Words never mined as concepts. frequent.yaml is learned from your documents and regenerated.'],
  capabilities: ['Capability notes', 'Notes on live datasources: metric definitions, joins, pitfalls.'],
  chat: ['Ask prompts', 'How Ask behaves (AGENTS.md, its protocol) and the prompt it sends each turn (turn.md).'],
  agents: ['Agents', 'Who does the work for Ask and Research.'],
  profiles: ['Research profiles', 'Effort, web access and the sub-agent roles of a research run.'],
  sources: ['Research sources', 'The web, APIs, MCP servers and sites a study may use.'],
};
/** The page that edits a group another page owns: its name and its tab. */
const PLAYBOOK_OWNERS = {
  providers: ['Settings → Providers & Agents', 'providers'],
  research: ['Settings → Research', 'research'],
  sources: ['Settings → Sources', 'sources'],
};

let playbookGroups = [];
/** The open file as last read or saved: what Revert returns to and what the textarea is compared with. */
let playbook = null;

const mayChangeSettings = () => authDisabled || serverAuth?.groups?.settings === true;
const playbookDirty = () => Boolean(playbook) && $('#pb-text').value !== playbook.text;
// `modified` is "not what knode-os ships now": an edit, or a copy seeded from an older version
const playbookTags = (file) => (file.readonly ? '<span class="tag">generated</span>' : file.modified ? '<span class="tag">differs</span>' : '');

async function loadPlaybooks() {
  try {
    playbookGroups = (await api('/api/playbooks')).groups ?? [];
  } catch (e) {
    $('#pb-groups').innerHTML = `<p class="cfg-callout">playbooks unavailable: ${esc(e.message)}</p>`;
    return;
  }
  $('#pb-badge').textContent = mayChangeSettings() ? 'Prompts & vocabularies' : 'Read-only';
  paintPlaybookGroups();
  // the open file stays open, unsaved edits and all; otherwise the first file there is
  if (playbook && playbookGroups.some((g) => g.files.some((f) => f.path === playbook.path))) return;
  const first = playbookGroups.find((g) => !g.managedIn && g.files.length)?.files[0];
  if (first) openPlaybook(first.path);
  else paintPlaybook(null);
}

function paintPlaybookGroups() {
  $('#pb-groups').innerHTML = playbookGroups.map((group) => {
    const [title, about] = PLAYBOOK_GROUPS[group.id] ?? [group.id, ''];
    const owner = group.managedIn ? PLAYBOOK_OWNERS[group.managedIn] : null;
    const body = group.managedIn
      ? `<button type="button" class="pb-owner" data-tab="${esc(owner?.[1] ?? '')}">Edited in ${esc(owner?.[0] ?? group.managedIn)} →</button>`
      : group.files.length
        ? group.files.map((f) => `<button type="button" class="pb-file${f.path === playbook?.path ? ' active' : ''}" data-path="${esc(f.path)}"><span>${esc(f.name)}</span>${playbookTags(f)}</button>`).join('')
        : '<p class="hint">Nothing here yet.</p>';
    return `<section class="pb-group"><h4>${esc(title)}</h4><p>${esc(about)}</p>${body}</section>`;
  }).join('');
}

async function openPlaybook(path) {
  if (playbookDirty() && playbook.path !== path && !confirm(`Discard your changes to ${playbook.name}?`)) return;
  try {
    paintPlaybook(await api(`/api/playbooks/file?path=${encodeURIComponent(path)}`));
  } catch (e) {
    toast(`could not open ${path}: ${e.message}`);
  }
}

function paintPlaybook(file) {
  playbook = file;
  const text = $('#pb-text');
  text.value = file?.text ?? '';
  const why = !file ? '' : file.readonly
    ? 'knode-os regenerates this file from your documents, so it is shown here, not edited.'
    : mayChangeSettings() ? '' : "Read-only: settings are an administrator's.";
  text.readOnly = !file || Boolean(why);
  $('#pb-path').textContent = file?.path ?? 'No playbook open';
  $('#pb-tags').innerHTML = file ? (file.builtin ? (file.modified ? '<span class="tag">differs from built-in</span>' : '<span class="tag">built-in</span>') : '') + (file.readonly ? '<span class="tag">generated</span>' : '') : '';
  $('#pb-note').hidden = !why;
  $('#pb-note').textContent = why;
  $('#pb-reset').hidden = !(file?.builtin && file.modified) || text.readOnly;
  $('#pb-status').textContent = '';
  paintPlaybookButtons();
  for (const b of document.querySelectorAll('#pb-groups .pb-file')) b.classList.toggle('active', b.dataset.path === file?.path);
}

function paintPlaybookButtons() {
  const dirty = playbookDirty();
  $('#pb-save').disabled = !dirty || $('#pb-text').readOnly;
  $('#pb-revert').disabled = !dirty;
}

/** Take the service's answer for a saved or reset file into the editor and the list. */
function playbookSaved(file, message) {
  for (const group of playbookGroups) {
    const i = group.files.findIndex((f) => f.path === file.path);
    if (i >= 0) group.files[i] = { ...group.files[i], ...file, text: undefined };
  }
  paintPlaybookGroups();
  paintPlaybook(file);
  $('#pb-status').textContent = message;
}

$('#pb-groups').addEventListener('click', (event) => {
  const file = event.target.closest?.('.pb-file');
  if (file) {
    openPlaybook(file.dataset.path);
    return;
  }
  const owner = event.target.closest?.('.pb-owner');
  if (owner?.dataset.tab) navigate(owner.dataset.tab);
});

$('#pb-text').addEventListener('input', paintPlaybookButtons);

$('#pb-save').addEventListener('click', async () => {
  if (!playbook) return;
  $('#pb-save').disabled = true;
  try {
    const file = await api('/api/playbooks/file', { method: 'PUT', body: JSON.stringify({ path: playbook.path, text: $('#pb-text').value }) });
    playbookSaved(file, 'saved — the next job that reads it uses it');
  } catch (e) {
    $('#pb-status').textContent = `not saved: ${e.message}`;
    paintPlaybookButtons();
  }
});

$('#pb-revert').addEventListener('click', () => paintPlaybook(playbook));

$('#pb-reset').addEventListener('click', async () => {
  if (!playbook || !confirm(`Put back the version of ${playbook.name} that knode-os ships? What the file holds now is lost.`)) return;
  try {
    playbookSaved(await api(`/api/playbooks/file?path=${encodeURIComponent(playbook.path)}`, { method: 'DELETE' }), 'reset to the built-in version');
  } catch (e) {
    $('#pb-status').textContent = `not reset: ${e.message}`;
  }
});

/* --------------------------------- chat -------------------------------- */

let chatConversations = [];
let chatActiveId = null;
let chatPollTimer = null;

function stopChatPolling() {
  clearTimeout(chatPollTimer);
  chatPollTimer = null;
}

/** Whether a question asked now would be answered, and if not, what to fix. */
let chatReadiness = null;

async function loadChat() {
  chatReadiness = await api('/api/chat/readiness').catch(() => null);
  paintChatReadiness();
  try {
    chatConversations = await api('/api/chat/conversations?limit=50');
  } catch (e) {
    $('#chat-list').innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
    return;
  }
  renderChatList();
  if (!chatActiveId || !chatConversations.some((c) => c.id === chatActiveId)) {
    if (chatConversations.length) await openConversation(chatConversations[0].id);
    else renderChatThread(null);
  } else {
    await openConversation(chatActiveId);
  }
}

function renderChatList() {
  const el = $('#chat-list');
  if (!chatConversations.length) {
    el.innerHTML = '<p class="hint">no conversations yet</p>';
    return;
  }
  el.innerHTML = '';
  for (const c of chatConversations) {
    const div = document.createElement('div');
    div.className = `chat-item${c.id === chatActiveId ? ' active' : ''}`;
    div.innerHTML = `<span class="chat-item-title">${esc(c.title || '(untitled)')}</span>
      <span class="hint">${esc(new Date(c.updatedAt).toLocaleString())}</span>
      <button data-del title="Delete this conversation">✕</button>`;
    div.addEventListener('click', (ev) => { if (!ev.target.hasAttribute('data-del')) openConversation(c.id); });
    div.querySelector('button[data-del]').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try {
        await api(`/api/chat/conversations/${c.id}`, { method: 'DELETE' });
        if (chatActiveId === c.id) chatActiveId = null;
        loadChat();
      } catch (e) {
        toast(`delete failed: ${e.message}`);
      }
    });
    el.appendChild(div);
  }
}

async function openConversation(id) {
  chatActiveId = id;
  renderChatList();
  try {
    const conversation = await api(`/api/chat/conversations/${id}`);
    renderChatThread(conversation);
    // the turn may have finished while another tab was open: the composer follows the server, not the last poll
    if (conversation.running) startChatPolling();
    else setChatBusy(false);
  } catch (e) {
    $('#chat-thread').innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
  }
}

function renderChatThread(conversation) {
  const el = $('#chat-thread');
  if (!conversation) {
    el.innerHTML = chatReadiness && chatReadiness.ready === false
      ? `<p class="hint"><b>Ask has nothing to run on.</b> ${esc(chatReadiness.hint ?? '')}
         <button type="button" class="hint-action" data-open-providers>open Providers &amp; Agents</button></p>`
      : '<p class="hint">Ask a question. An agent answers over your files, graph and wiki — it can follow leads across several turns, and writes what you teach it as a quarantined note you can adopt.</p>';
    el.querySelector('[data-open-providers]')?.addEventListener('click', () => navigate('providers'));
    return;
  }
  el.innerHTML = '';
  for (const m of conversation.messages ?? []) {
    const div = document.createElement('div');
    div.className = `chat-msg ${m.role}`;
    const body = m.content ? renderMd(m.content) : `<p class="hint">${esc(m.error ? `(${m.error})` : '(empty reply)')}</p>`;
    div.innerHTML = `<div class="markdown">${body}</div>`;
    window.knodeChart?.hydrate(div);
    if (m.role === 'assistant') {
      const chips = document.createElement('div');
      chips.className = 'chat-chips';
      for (const ev of m.events ?? []) {
        const chip = document.createElement('span');
        chip.className = `chat-chip${ev.ok === false ? ' bad' : ''}`;
        chip.textContent = ev.tool === 'wrote' ? `wrote ${ev.summary}` : `${ev.tool}${ev.summary ? `: ${ev.summary}` : ''}`;
        chips.appendChild(chip);
        if (ev.tool === 'wrote' && ev.path) {
          const open = document.createElement('button');
          open.textContent = 'open';
          open.addEventListener('click', () => {
            navigate('files');
            openFile(ev.path);
          });
          const promote = document.createElement('button');
          promote.textContent = 'adopt';
          promote.title = 'Promote this note from quarantined to trusted';
          promote.addEventListener('click', async () => {
            try {
              await api('/api/trust', { method: 'POST', body: JSON.stringify({ path: ev.path, to: 'trusted' }) });
              toast(`${ev.path}: trusted`);
            } catch (e) {
              toast(`adopt failed: ${e.message}`);
            }
          });
          chips.append(open, promote);
        }
      }
      if (m.error && m.content) chips.insertAdjacentHTML('beforeend', `<span class="chat-chip bad">${esc(m.error)}</span>`);
      if (chips.childElementCount) div.appendChild(chips);
    }
    el.appendChild(div);
  }
  el.scrollTop = el.scrollHeight;
}

function renderChatActivity(activity) {
  const el = $('#chat-activity');
  el.hidden = false;
  el.innerHTML = `<span class="chat-chip working">answering…</span>${(activity ?? []).map((ev) => `<span class="chat-chip${ev.ok === false ? ' bad' : ''}">${esc(ev.tool)}${ev.summary ? `: ${esc(ev.summary)}` : ''}</span>`).join('')}`;
}

function setChatBusy(busy) {
  // an unready composer stays disabled when the turn ends
  $('#btn-chat-send').disabled = busy || Boolean(chatReadiness && chatReadiness.ready === false);
  $('#btn-chat-cancel').hidden = !busy;
  $('#chat-activity').hidden = !busy;
}

function startChatPolling() {
  stopChatPolling();
  setChatBusy(true);
  renderChatActivity([]);
  const id = chatActiveId;
  const tick = async () => {
    if (chatActiveId !== id) return;
    try {
      const status = await api(`/api/chat/conversations/${id}/status`);
      if (status.status === 'running') {
        renderChatActivity(status.activity);
        chatPollTimer = setTimeout(tick, 1500);
        return;
      }
    } catch {
      /* transient */
    }
    setChatBusy(false);
    stopChatPolling();
    if (chatActiveId === id) {
      await openConversation(id);
      loadChat();
    }
  };
  chatPollTimer = setTimeout(tick, 900);
}

async function newConversation() {
  const conversation = await api('/api/chat/conversations', { method: 'POST', body: JSON.stringify({}) });
  chatConversations.unshift(conversation);
  chatActiveId = conversation.id;
  renderChatList();
  renderChatThread(conversation);
  return conversation;
}

async function askQuestion(text) {
  const thread = $('#chat-thread');
  const mine = document.createElement('div');
  mine.className = 'chat-msg user';
  mine.innerHTML = `<div class="markdown">${renderMd(text)}</div>`;
  window.knodeChart?.hydrate(mine);
  thread.appendChild(mine);
  thread.scrollTop = thread.scrollHeight;
  const res = await api(`/api/chat/conversations/${chatActiveId}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
  if (res.status === 'running') {
    startChatPolling();
  } else {
    $('#chat-activity').hidden = true;
    await openConversation(chatActiveId);
    chatConversations = await api('/api/chat/conversations?limit=50');
    renderChatList();
  }
}

async function sendChat() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    if (!chatActiveId) await newConversation();
  } catch (e) {
    input.value = text;
    toast(`could not start a conversation: ${e.message}`);
    return;
  }
  try {
    await askQuestion(text);
  } catch (e) {
    // a 503 is a configuration answer, not a failed send: show the screen that
    // says what to fix rather than a toast that scrolls away
    if (e.reason) {
      chatReadiness = { ready: false, reason: e.reason, hint: e.message };
      paintChatReadiness();
      renderChatThread(null);
      return;
    }
    toast(`send failed: ${e.message}`);
    // 409 means another client is already answering — resync and follow that turn instead
    await openConversation(chatActiveId);
  }
}

$('#btn-chat-new').addEventListener('click', async () => {
  try {
    await newConversation();
    $('#chat-input').focus();
  } catch (e) {
    toast(`could not start a conversation: ${e.message}`);
  }
});

/** A composer that cannot answer says so on the button rather than on send. */
function paintChatReadiness() {
  const blocked = Boolean(chatReadiness && chatReadiness.ready === false);
  $('#btn-chat-send').disabled = blocked;
  $('#btn-chat-send').title = blocked ? (chatReadiness.hint ?? '') : 'a reply runs an agent session, which can take minutes';
}

$('#chat-composer').addEventListener('submit', (ev) => { ev.preventDefault(); sendChat(); });
$('#chat-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    sendChat();
  }
});
$('#btn-chat-cancel').addEventListener('click', async () => {
  if (!chatActiveId) return;
  try {
    await api(`/api/chat/conversations/${chatActiveId}/cancel`, { method: 'POST' });
    toast('stopping…');
  } catch (e) {
    toast(`cancel failed: ${e.message}`);
  }
});

/* ------------------------------ settings ------------------------------- */

let loadedConfig = null;

const providerNames = {
  inherit: 'Default model',
  openai: 'OpenAI-compatible API',
  'codex-cli': 'Codex CLI',
  'claude-cli': 'Claude Code CLI',
  'cursor-cli': 'Cursor Agent CLI',
  'opencode-cli': 'OpenCode CLI',
};

const cliMeta = {
  'codex-cli': { command: 'codex exec', path: 'codex', note: 'Uses your existing Codex login in read-only one-shot mode.' },
  'claude-cli': { command: 'claude -p', path: 'claude', note: 'Uses your existing Claude Code login for one non-interactive turn.' },
  'cursor-cli': { command: 'cursor-agent -p', path: 'cursor-agent', note: 'Uses your existing Cursor Agent login in headless print mode.' },
  'opencode-cli': { command: 'opencode run', path: 'opencode', note: 'Runs OpenCode headlessly on one of your model connections — its endpoint, key and model.' },
};

/**
 * GET /api/config/providers: what `provider` may name on this service — the
 * built-ins plus whatever its loaded plugins registered, each with the config
 * fields it reads. The names above are the fallback for a service that does
 * not answer it.
 */
let providerCatalog = { llm: [], embedding: [], storage: [], converters: [] };
const LLM_FIELDS_DEFAULT = ['baseUrl', 'apiKey', 'protocol', 'model'];

function applyProviderCatalog(catalog) {
  providerCatalog = { llm: [], embedding: [], storage: [], converters: [], ...(catalog || {}) };
  for (const p of providerCatalog.llm) {
    providerNames[p.id] = p.label;
    if (p.note && !LLM_NOTES[p.id]) LLM_NOTES[p.id] = p.note;
  }
  for (const p of providerCatalog.embedding) {
    if (!EMBEDDING_PROVIDER_OPTIONS.some(([id]) => id === p.id)) EMBEDDING_PROVIDER_OPTIONS.push([p.id, p.label]);
    if (p.note && !EMB_NOTES[p.id]) EMB_NOTES[p.id] = p.note;
  }
}

/** The providers a connection row may pick: endpoints and other non-agent kinds (the coding-agent CLIs are agents, in the table below). */
function connectionProviderOptions(selected) {
  const listed = providerCatalog.llm.filter((p) => p.kind !== 'cli').map((p) => [p.id, p.label]);
  const pairs = listed.length ? listed : [['openai', providerNames.openai]];
  if (selected && !pairs.some(([id]) => id === selected)) pairs.push([selected, providerNames[selected] ?? selected]);
  return pairs;
}

/** Which fields a connection's provider reads; the OpenAI-compatible set when the service did not say. */
function llmProviderFields(provider) {
  return providerCatalog.llm.find((p) => p.id === provider)?.fields ?? LLM_FIELDS_DEFAULT;
}

/* ---------- the model picker, shared by every model field ---------- */

/**
 * Model lists the settings screen has already fetched, keyed by route. The
 * service caches by endpoint underneath, so this only saves the round trip —
 * but that is what makes reopening a dropdown instant.
 */
const modelLists = new Map();

function closeModelPicker() {
  document.querySelector('.model-picker')?.remove();
  document.removeEventListener('click', onModelPickerOutside, true);
  window.removeEventListener('keydown', onModelPickerKey);
  window.removeEventListener('resize', closeModelPicker);
}

function onModelPickerOutside(event) {
  const picker = document.querySelector('.model-picker');
  if (picker && !picker.contains(event.target) && !event.target.closest('.model-chevron')) closeModelPicker();
}

function onModelPickerKey(event) {
  if (event.key === 'Escape') closeModelPicker();
}

function renderModelPicker(picker, spec, input) {
  const state = modelLists.get(modelListKey(spec));
  const filter = picker.querySelector('.model-filter')?.value?.trim().toLowerCase() ?? '';
  const models = state?.result?.models ?? [];
  const shown = filter
    ? models.filter((m) => m.id.toLowerCase().includes(filter) || (m.label ?? '').toLowerCase().includes(filter))
    : models;
  const sourceLabel = { api: 'from the endpoint', cli: 'from the CLI' }[state?.result?.source] ?? 'suggestions';

  picker.innerHTML = `
    <div class="model-picker-head">
      <b>Models</b>
      ${state?.result ? `<span class="section-badge${state.result.source === 'builtin' ? ' accent2' : ''}">${esc(sourceLabel)}</span>` : ''}
      ${state?.loading ? '<span class="hint">asking…</span>' : ''}
      <button type="button" class="ghost model-refresh" title="Ask the provider again">⟳</button>
    </div>
    ${models.length ? `<input class="model-filter" placeholder="Filter ${models.length} models" value="${esc(filter)}" />` : ''}
    ${models.length ? `<div class="model-list">${shown
      .map((m) => `<button type="button" class="model-option${m.id === input.value ? ' selected' : ''}" data-model="${esc(m.id)}"><span class="mono">${esc(m.id)}</span>${m.label ? `<small>${esc(m.label)}</small>` : ''}</button>`)
      .join('') || '<p class="hint">Nothing matches.</p>'}</div>` : ''}
    ${!models.length && state?.loading ? '<p class="hint">Asking the provider…</p>' : ''}
    ${!models.length && state?.result && !state.result.error ? '<p class="hint">This provider lists no models — type the id you want.</p>' : ''}
    ${state?.error || state?.result?.error ? `<p class="jerr">${esc(state.error ?? state.result.error)}</p>` : ''}
    ${state?.result?.note ? `<p class="hint">${esc(state.result.note)}</p>` : ''}
    ${state?.result?.cached && state.result.cachedAt ? `<p class="hint">Cached — the service last asked at ${esc(new Date(state.result.cachedAt).toLocaleTimeString())}.</p>` : ''}
    <p class="model-picker-foot">Picking one fills the field — Save &amp; apply writes it to the workspace config.</p>`;
}

async function loadModelList(spec, picker, input, refresh = false) {
  const key = modelListKey(spec);
  const state = modelLists.get(key) ?? {};
  if (state.loading) return;
  if (state.result && !refresh) return;
  modelLists.set(key, { ...state, loading: true, error: null });
  renderModelPicker(picker, spec, input);
  try {
    const config = gatherConfig();
    // a provider override asks the default route as if that CLI — at that
    // path — were selected
    if (spec.provider) config.llm = { ...config.llm, provider: spec.provider, baseUrl: '', apiKey: '', model: '', cliPath: spec.cliPath || '' };
    const result = await api('/api/config/models', {
      method: 'POST',
      body: JSON.stringify({ route: spec.route, refresh, config }),
    });
    modelLists.set(key, { loading: false, result, error: result.error ?? null });
  } catch (e) {
    modelLists.set(key, { loading: false, result: state.result, error: e.message });
  }
  if (document.body.contains(picker)) renderModelPicker(picker, spec, input);
}

function openModelPicker(anchor, input, spec) {
  closeModelPicker();
  const picker = document.createElement('div');
  picker.className = 'model-picker';
  document.body.appendChild(picker);
  renderModelPicker(picker, spec, input);

  const box = anchor.getBoundingClientRect();
  const size = picker.getBoundingClientRect();
  picker.style.left = `${Math.max(6, Math.min(box.right - 430, window.innerWidth - 436))}px`;
  picker.style.top = `${Math.min(box.bottom + 4, window.innerHeight - size.height - 6)}px`;

  picker.addEventListener('click', (event) => {
    const option = event.target.closest('.model-option');
    if (option) {
      input.value = option.dataset.model;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      closeModelPicker();
      return;
    }
    if (event.target.closest('.model-refresh')) loadModelList(spec, picker, input, true);
  });
  picker.addEventListener('input', (event) => {
    if (event.target.classList.contains('model-filter')) renderModelPicker(picker, spec, input);
  });

  setTimeout(() => {
    document.addEventListener('click', onModelPickerOutside, true);
    window.addEventListener('keydown', onModelPickerKey);
    window.addEventListener('resize', closeModelPicker);
  }, 0);

  loadModelList(spec, picker, input);
}

/** A model input keeps its free text and gains a chevron that lists what the provider offers. */
/**
 * Which `/api/config/models` route lists what a spec offers, and the draft to
 * list it against.
 *
 * An agent lists through its runtime: a deepagents agent on the model it runs
 * on, a CLI agent as that CLI at its own path. A CLI is not an endpoint, so
 * ask the default route with it swapped into the draft instead — the same
 * thing the macOS client does.
 */
function executorModelRoute(spec) {
  const agent = agentDrafts.find((a) => a.name === spec);
  if (agent) {
    // OpenCode runs the models of its connection, so that endpoint lists them
    if (agent.executor === 'opencode-cli') {
      const connection = opencodeConnection(agent);
      return connection ? { route: `connection:${connection.id}` } : { route: 'llm', provider: agent.executor, cliPath: agent.cliPath || '' };
    }
    if (CLI_PROVIDERS.includes(agent.executor)) return { route: 'llm', provider: agent.executor, cliPath: agent.cliPath || '' };
    const endpoint = modelEndpoint(agent);
    return endpoint ? { route: `connection:${endpoint.id}` } : { route: 'llm' };
  }
  if (!spec || spec === 'default') return { route: 'llm' };
  if (connectionById(spec)) return { route: `connection:${spec}` };
  // a bare CLI borrows the path of a CLI agent running it, as it runs
  return { route: 'llm', provider: spec, cliPath: llmTargets().find((t) => t.provider === spec)?.cliPath || '' };
}

/** The cache key: two chevrons on one route but different CLIs or paths are two lists. */
const modelListKey = ({ route, provider, cliPath }) => `${route}|${provider ?? ''}|${cliPath ?? ''}`;

function modelChevron(spec) {
  const { route, provider, cliPath } = typeof spec === 'string' ? { route: spec } : spec;
  return `<button type="button" class="model-chevron" data-route="${esc(route)}"${provider ? ` data-provider="${esc(provider)}"` : ''}${cliPath ? ` data-cli-path="${esc(cliPath)}"` : ''} title="List the models this provider offers">⌄</button>`;
}

document.addEventListener('click', (event) => {
  const chevron = event.target.closest?.('.model-chevron');
  if (!chevron) return;
  const input = chevron.parentElement.querySelector('input');
  if (input) openModelPicker(chevron, input, { route: chevron.dataset.route, provider: chevron.dataset.provider, cliPath: chevron.dataset.cliPath });
});

/**
 * Every endpoint and credential, as one table. Embedding providers, the
 * default LLM and the extra LLM connections are three shapes of the same row,
 * so the drafts below are the edit buffer that the rows, the stage pickers and
 * the save payload all read from.
 */
let connectionDrafts = [];
let embeddingDrafts = [];
let embeddingUse = '';
let embeddingPoolDraft = { enabled: false, model: 'bge-m3', dimensions: 1024, batchSize: 16 };
// when vectors are made, and an embeddings endpoint of this machine's own for serve's embed slots (docs/design/12 §3.3, §4.3)
let embedLocalDraft = { embedding: 'inline', embedSlots: 8, baseUrl: '', model: '', apiKey: '', checked: null };
let embeddingUsage = [];
const defaultEmbeddingLimits = { requestsPerMinute: 60, tokensPerMinute: 100000, requestsPerDay: 5000, tokensPerDay: 1000000, concurrency: 2, resetTimezone: 'UTC' };
/** Which connection is the default — the mirror of `embeddingUse`. */
let llmUse = '';
/** Provider ids whose row is open, kept across a redraw. */
const expandedProviders = new Set();

function connectionById(id) {
  return connectionDrafts.find((c) => c.id === id);
}

/**
 * A CLI agent as a stage or the default sees it: a one-shot LLM — the mirror
 * of the service's `readAgentLlms`. The agent itself lives in `agentDrafts`.
 */
function agentTarget(agent) {
  return {
    id: agent.name,
    label: (agent.title || '').trim() || agent.name,
    provider: agent.executor,
    model: agent.model || opencodeConnection(agent)?.model || '',
    cliPath: agent.cliPath || '',
    effort: agent.effort || 'default',
    agent: true,
  };
}

/**
 * Everything the default can run on: the models, then the CLI agents, called
 * one-shot — the mirror of the service's `llmTargets`. A model wins an id
 * clash, since it is what the config itself names. A stage can run on more —
 * see `routeTargets`.
 */
function llmTargets() {
  const agents = agentDrafts.filter((a) => CLI_PROVIDERS.includes(a.executor) && !connectionById(a.name)).map(agentTarget);
  return [...connectionDrafts, ...agents];
}

function targetById(id) {
  return llmTargets().find((t) => t.id === id);
}

/**
 * What the default is — a model, or on a machine with none a CLI agent — or
 * null while the lists are loading. A dangling `llmUse` falls back the way the
 * service's `activeLlm` does.
 */
function defaultConnection() {
  const targets = llmTargets();
  return targets.find((c) => c.id === llmUse) ?? targets[0] ?? null;
}

/**
 * The connection an OpenCode agent runs on: the one it names, or the default
 * while that is a model — the mirror of the service's `modelConnectionFor`.
 * null for any other agent, or when there is no model to run on.
 */
function opencodeConnection(agent) {
  if (agent.executor !== 'opencode-cli') return null;
  // among the models only, never `defaultConnection()`: that lists the agents, this one included
  const named = connectionById(agent.connection && agent.connection !== 'default' ? agent.connection : llmUse);
  return named?.provider === 'openai' && named.baseUrl ? named : null;
}

/** The model a deepagents agent runs on: the one it pins, or the default while that is a model. */
function modelEndpoint(agent) {
  if (CLI_PROVIDERS.includes(agent.executor)) return null;
  if (agent.executor === 'default') {
    const def = defaultConnection();
    return def?.provider === 'openai' ? def : null;
  }
  return connectionById(agent.executor) ?? null;
}

/**
 * An agent as a stage sees it, run once through its own loop: a CLI agent as
 * itself, a deepagents agent as the endpoint it runs on with its own model or
 * else the endpoint's — the service runs the deepagents loop there. null for
 * one that runs on nothing.
 */
function agentRouteTarget(agent) {
  if (CLI_PROVIDERS.includes(agent.executor)) return { ...agentTarget(agent), runtime: providerNames[agent.executor] ?? agent.executor };
  const endpoint = modelEndpoint(agent);
  if (!endpoint) return null;
  return {
    ...endpoint,
    id: agent.name,
    label: (agent.title || '').trim() || agent.name,
    model: (agent.model || '').trim() || endpoint.model,
    agent: true,
    runtime: 'deepagents',
  };
}

/**
 * Everything a stage can name: the models, then the CLI agents and the
 * deepagents agents — the mirror of the service's `routeTargets`. Not
 * `llmTargets`, because the default cannot be a deepagents agent: it may
 * follow the default.
 */
function routeTargets() {
  const agents = agentDrafts.filter((a) => !connectionById(a.name)).map(agentRouteTarget).filter(Boolean);
  return [...connectionDrafts, ...agents];
}

function routeTargetById(id) {
  return routeTargets().find((t) => t.id === id);
}

/**
 * What a stage runs on: the target it names, else the default — where the
 * service runs a stage naming nothing known, and what a save writes down.
 * There is no "follow the default" entry to leave it on.
 */
function stageUse(use) {
  return routeTargetById(use) ? use : (defaultConnection()?.id ?? '');
}

/**
 * The model a route runs with when it names none of its own — the mirror of
 * the service's `resolveRoutedLlmConfig`, over everything a stage can name.
 *
 * Shown as a Model field's placeholder and never written: an empty `model`
 * means "follow this provider", so pinning the string would stop the route
 * tracking the provider's own model.
 */
function inheritedModelFor(use) {
  return (routeTargetById(use) ?? defaultConnection())?.model || '';
}

/**
 * The same for an agent spec, which may be an agent *name* — and a name can
 * legitimately be `default`, so this never shares a lookup with the route rule.
 * The mirror of the service's `resolveAgentSpec`: a CLI agent carries its own
 * model and inherits nothing; a deepagents agent takes its model endpoint's; a
 * bare CLI borrows the model of a CLI agent running it, the default's first.
 */
function inheritedAgentModelFor(spec) {
  const wanted = (spec || '').trim();
  const agent = agentDrafts.find((a) => a.name === wanted);
  if (agent) {
    if (agent.model || CLI_PROVIDERS.includes(agent.executor)) return agent.model || '';
    return modelEndpoint(agent)?.model || '';
  }
  if (wanted === 'default') return defaultConnection()?.model || '';
  const target = targetById(wanted);
  if (target) return target.model || '';
  if (!CLI_PROVIDERS.includes(wanted)) return '';
  const def = defaultConnection();
  return ((def?.provider === wanted ? def : llmTargets().find((t) => t.provider === wanted))?.model) || '';
}

const EMBEDDING_PROVIDER_OPTIONS = [
  ['local', 'Local hashing · offline'],
  ['openai', 'OpenAI-compatible API'],
  ['ark-multimodal', 'Volcengine Ark · multimodal'],
];

const EMB_NOTES = {
  local: 'The local hashing embedder is private, offline and ready immediately. Dimensions can be tuned before the first index.',
  openai: 'Changing the API model or dimensions re-embeds the corpus after saving. Use env:VAR_NAME to keep the key out of the config file.',
  'ark-multimodal': 'Ark posts to /embeddings/multimodal and returns one vector per request, so Base URL ends at /api/v3 and Model is the endpoint id (ep-…). Dimensions must match the model (doubao-embedding-vision: 2048, or 1024 with the dimensions parameter sent).',
};

const LLM_NOTES = {
  openai: 'Any OpenAI-compatible endpoint works. Auto prefers the Responses API and falls back to Chat Completions when the endpoint has no such route — reasoning models lose less that way. An empty model disables the general LLM features; the deterministic pipeline keeps running.',
};

const embeddingProviderLabel = (provider) =>
  EMBEDDING_PROVIDER_OPTIONS.find(([v]) => v === provider)?.[1] ?? provider;

const activeEmbedding = () =>
  embeddingDrafts.find((e) => e.id === embeddingUse) ?? embeddingDrafts[0] ?? null;

/**
 * Where a stage runs, as the two things a person reads separately: who runs
 * it, and which model. They used to share one ellipsised line, which turned
 * "super-relay · ark/seed-evolving" into "super-relay…ed-evolving".
 */
const summaryLine = (t) => (t.model ? `${t.provider} · ${t.model}` : t.provider);

function embeddingSummaryText() {
  if (embeddingPoolDraft.enabled) return { provider: 'Model pool', model: embeddingPoolDraft.model };
  const active = activeEmbedding();
  if (!active) return { provider: 'Loading…', model: '' };
  const name = active.label || active.id;
  if (active.provider === 'local') return { provider: name, model: `${active.dimensions || 384}d` };
  return { provider: name, model: active.model || 'API model not set' };
}

function routeSummary(prefix) {
  const use = $(`#cfg-${prefix}-use`).value;
  const model = $(`#cfg-${prefix}-model`).value.trim();
  // a stage names what it runs on; one naming nothing known runs on the default
  const target = routeTargetById(use) ?? defaultConnection();
  return {
    provider: target ? target.label?.trim() || providerNames[target.provider] || target.id : 'Not configured',
    // an inheriting model prints what it inherits, not a blank
    model: model || inheritedModelFor(use),
  };
}

/** Rebuild the Index picker from the configured embedding providers. */
function fillEmbeddingOptions() {
  const select = $('#cfg-embedding-use');
  select.innerHTML = embeddingDrafts
    .map((e) => `<option value="${esc(e.id)}">${esc(e.label || e.id)}</option>`)
    .join('');
  select.value = embeddingDrafts.some((e) => e.id === embeddingUse) ? embeddingUse : (embeddingDrafts[0]?.id ?? '');
  embeddingUse = select.value;
  select.disabled = embeddingPoolDraft.enabled;
  $('#cfg-embedding-route-note').textContent = embeddingPoolDraft.enabled
    ? `Automatic routing · ${embeddingPoolDraft.model} · ${poolEligibleKeys().length} compatible keys. Manage the pool in Providers & Agents.`
    : 'Enable a model pool in Providers & Agents to share compatible keys.';
}

const canonicalEmbeddingModel = (model) => ['bge-m3', 'baai/bge-m3', '@cf/baai/bge-m3'].includes((model || '').toLowerCase()) ? 'bge-m3' : model;
const poolEligibleKeys = () => embeddingDrafts.filter((e) => {
  const model = canonicalEmbeddingModel(embeddingPoolDraft.model);
  return e.enabled !== false && e.provider === 'openai' && [e.model, ...(e.catalog || [])].some((id) => canonicalEmbeddingModel(id) === model)
    && (model === 'bge-m3' ? embeddingPoolDraft.dimensions === 1024 : e.model === model && e.dimensions === embeddingPoolDraft.dimensions);
});

function renderEmbeddingPool() {
  const pool = embeddingPoolDraft;
  const models = [...new Set(embeddingDrafts.flatMap((e) => [e.model, ...(e.catalog || [])]).filter(Boolean).map(canonicalEmbeddingModel))].sort();
  $('#cfg-embedding-pool').innerHTML = `<div class="embedding-pool-head"><h4>Embedding model pool</h4>
    <label class="cfg-check"><input data-pool="enabled" type="checkbox"${pool.enabled ? ' checked' : ''} /> Automatic routing</label></div>
    <p class="cfg-callout">Choose one model. Compatible keys share the work. Lower priorities run first; equal priorities rotate. Unavailable keys cool down automatically.</p>
    <div class="cfg-grid cfg-grid-3">
      <label>Pool model<input data-pool="model" list="embedding-pool-models" value="${esc(pool.model)}" /><datalist id="embedding-pool-models">${models.map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist></label>
      <label>Dimensions<input data-pool="dimensions" type="number" min="1" value="${pool.dimensions}" /></label>
      <label>Texts per request<input data-pool="batchSize" type="number" min="1" max="128" value="${pool.batchSize}" /></label>
    </div>
    <div class="embedding-pool-head"><span id="cfg-pool-members" class="mono">${poolEligibleKeys().length} compatible keys · ${embeddingDrafts.length} configured</span>
    <div class="cfg-actions"><button data-pool-action="models">Refresh all models</button><button data-pool-action="test"${pool.enabled ? '' : ' disabled'}>Test pool</button><button data-pool-action="usage">Refresh usage</button></div></div>
    <p class="cfg-callout">Pool vectors are L2-normalized. Only matching models and dimensions participate. Changing the pool model re-embeds the workspace; changing keys or limits does not.</p>
    <div id="cfg-pool-status" role="status"></div>
    <details><summary>Usage today · shared across workspaces</summary><div class="embedding-usage">${embeddingDrafts.filter((e) => e.provider === 'openai').map((e) => {
      const u = embeddingUsage.find((u) => u.id === e.id) || {};
      const limit = { ...defaultEmbeddingLimits, ...e.limits };
      const source = embeddingTokenSource(u);
      return `<div><span>${esc(e.label)}</span><span>${u.requestsToday || 0} / ${limit.requestsPerDay} req</span><span title="${esc(source.title)}">${u.tokensToday || 0} / ${limit.tokensPerDay} tokens${source.tag ? ` · ${source.tag}` : ''}</span><span>${u.cooldownUntil > Date.now() ? 'Cooling down' : esc(limit.resetTimezone)}</span></div>`;
    }).join('')}</div><p class="cfg-callout">App usage persists across restarts. Tokens are the provider's own count when its response includes one (SiliconFlow, OpenRouter), otherwise an estimate for the model (Cloudflare reports none). Other apps are not included. Zero limits block requests.</p></details>`;
}

const embedEndpointKey = (d) => `${d.baseUrl.trim().replace(/\/+$/, '')}|${d.model.trim()}|${d.apiKey}`;

function renderEmbeddingLocal() {
  const d = embedLocalDraft;
  const check = d.checked;
  const checkLine = !check ? '' : check.ok
    ? `<span class="embed-check good">Passed: the lowest probe cosine against the pool's vectors is ${Number(check.minCosine).toFixed(4)} (needs ${check.threshold}) · ${check.ms} ms.${check.saved ? '' : ' Save &amp; apply to use it.'}</span>`
    : `<span class="embed-check bad">Refused: ${esc(check.reason || check.error || 'the check failed')}</span>`;
  $('#cfg-embedding-local').innerHTML = `<div class="embedding-pool-head"><h4>Embedding on this machine</h4>
      <span class="mono">${d.baseUrl ? esc(d.baseUrl) : 'no endpoint of its own'} · ${d.embedding}</span></div>
    <p class="cfg-callout">Run the pool's model on this machine and the embed slots use it instead of the pool's daily quota. Its vectors are taken only once they match the pool's, checked with 16 fixed texts, and spot-checked after; when they stop matching, the slots go back to the pool.</p>
    <details${d.baseUrl ? '' : ' open'}><summary>Set up a local embedding model, step by step</summary><ol>
      <li><strong>Run an OpenAI-compatible embeddings server on this machine</strong> that serves the pool's model (${esc(embeddingPoolDraft.model || 'bge-m3')}, ${embeddingPoolDraft.dimensions || 1024} dimensions), on 127.0.0.1 only. Any of these works:
        <p><b>Ollama</b> (lightest to set up): install it, then <code>ollama pull bge-m3</code>. URL <code>http://127.0.0.1:11434/v1</code>, model <code>bge-m3</code>.</p>
        <p><b>Text Embeddings Inference</b> (Hugging Face): <code>text-embeddings-router --model-id BAAI/bge-m3 --hostname 127.0.0.1 --port 12020</code>, or its Docker image with the port bound to 127.0.0.1. URL <code>http://127.0.0.1:12020/v1</code>, model <code>BAAI/bge-m3</code>.</p>
        <p><b>A small Python server</b>, what was tested here: BAAI/bge-m3 with transformers on the Apple GPU (MPS) in fp16, the CLS token's vector L2-normalized, 1024 dimensions, up to 8,192 tokens, behind <code>POST /v1/embeddings</code>. About 4 GB of memory and 17,500 tokens/s on an M5 Pro; its vectors matched the pool's at cosine 0.9999 or better.</p>
        <p>A different or smaller model (bge-small, nomic-embed…) makes vectors in another space and cannot share this pool: the check refuses it. To use one, make it the pool model instead, which re-embeds the workspace.</p></li>
      <li><strong>See that it answers</strong>, with 1024 numbers per text:<pre>curl -s http://127.0.0.1:12020/v1/embeddings -H 'content-type: application/json' \\
  -d '{"model":"BAAI/bge-m3","input":["你好","hello"]}'</pre></li>
      <li><strong>Enter its URL and model below and press Check endpoint.</strong> It embeds the probe texts there and compares each vector with the pool's; every one must reach cosine ${esc(String(loadedConfig?.server?.remote?.embedProbeCosine ?? 0.98))}.</li>
      <li><strong>Save &amp; apply.</strong> The workspace switches to deferred embedding: a sync writes chunks at once and the embed slots fill in their vectors on your endpoint. The save checks the endpoint once more.</li>
      <li>Other machines can lend theirs too, with the worker: <code>node knode-worker.mjs --backends embed:2 --embed-base-url http://127.0.0.1:12020/v1 --embed-model BAAI/bge-m3</code> and a token with the <code>embed</code> scope (<code>knode-os remote token create --scope embed</code>).</li>
    </ol></details>
    <div class="cfg-grid cfg-grid-3">
      <label>Endpoint URL<input data-embed-local="baseUrl" placeholder="http://127.0.0.1:12020/v1" value="${esc(d.baseUrl)}" spellcheck="false" /></label>
      <label>Model<input data-embed-local="model" placeholder="BAAI/bge-m3" value="${esc(d.model)}" spellcheck="false" /></label>
      <label>Key (optional)<input data-embed-local="apiKey" type="password" placeholder="none, or env:VAR" value="${esc(d.apiKey)}" autocomplete="off" /></label>
      <label>Vectors made<select data-embed-local="embedding">
        <option value="inline"${d.embedding === 'inline' ? ' selected' : ''}>while syncing (inline)</option>
        <option value="deferred"${d.embedding === 'deferred' ? ' selected' : ''}>by embed slots, after (deferred)</option></select></label>
      <label>Embed slots here<input data-embed-local="embedSlots" type="number" min="0" max="32" value="${d.embedSlots}" /></label>
    </div>
    <div class="embedding-pool-head"><span id="cfg-embed-local-status" role="status">${checkLine}</span>
      <div class="cfg-actions"><button data-embed-local-action="check"${d.baseUrl && d.model ? '' : ' disabled'}>Check endpoint</button><button data-embed-local-action="remove"${d.baseUrl ? '' : ' disabled'}>Remove</button></div></div>`;
}

// Which of today's tokens a provider counted. A day recorded before the split existed has none, so no tag.
function embeddingTokenSource(u) {
  const tokens = u.tokensToday || 0;
  if (!tokens || u.estimatedTokensToday == null) return { tag: '', title: '' };
  const estimated = Math.min(tokens, u.estimatedTokensToday);
  const tag = !estimated ? 'reported' : estimated === tokens ? 'estimated' : `${Math.round(100 * estimated / tokens)}% estimated`;
  return { tag, title: `${estimated} estimated · ${tokens - estimated} reported by the provider` };
}

async function refreshEmbeddingUsage() {
  const scope = activeWorkspace()?.id;
  const result = await api('/api/config/embedding-usage');
  if (activeWorkspace()?.id !== scope) return;
  embeddingUsage = result.entries || [];
  renderEmbeddingPool();
}

function embeddingKeyLimits(entry) {
  if (entry.provider !== 'openai') return '';
  const limits = { ...defaultEmbeddingLimits, ...entry.limits };
  const fields = [['requestsPerMinute', 'Requests / minute'], ['tokensPerMinute', 'Tokens / minute'], ['concurrency', 'Concurrent requests'], ['requestsPerDay', 'Requests / day'], ['tokensPerDay', 'Tokens / day']];
  return `<div class="embedding-key-limits"><div class="embedding-pool-head">
      <label class="cfg-check"><input data-field="enabled" type="checkbox"${entry.enabled !== false ? ' checked' : ''} /> Include in model pools</label>
      <button data-embedding-action="test">Test key</button></div>
    <div class="cfg-grid cfg-grid-3">${fields.map(([name, label]) => `<label>${label}<input data-limit="${name}" type="number" min="${name === 'concurrency' ? 1 : 0}" value="${limits[name]}" /></label>`).join('')}
      <label>Daily reset timezone<input data-limit="resetTimezone" value="${esc(limits.resetTimezone)}" /></label>
      <label>Priority · lower first<input data-field="priority" type="number" min="0" value="${entry.priority ?? 10}" /></label>
      <label>Shared account quota group<input data-field="quotaGroup" value="${esc(entry.quotaGroup || '')}" placeholder="Same account → same group" /></label>
      <label>OpenRouter upstream (optional)<input data-field="upstream" value="${esc(entry.upstream || '')}" placeholder="deepinfra/fp32" /></label>
    </div><p class="cfg-callout">${esc(entry.limitNote || 'Application limits. Use the same quota group for keys belonging to one provider account.')}</p>
    <div class="embedding-pool-head"><strong>Available embedding models · ${(entry.catalog || []).length}</strong><button data-embedding-action="models">Refresh models</button></div>
    <p class="embedding-catalog mono">${esc((entry.catalog || []).join(' · ') || 'Refresh to list the embedding models this key can access.')}</p></div>`;
}

/** The stages that name a model or an agent, by their fields' prefix (`#cfg-<prefix>-use`, `<prefix>Llm`). */
const ROUTE_PREFIXES = ['entity', 'document', 'summary', 'judge', 'translate'];

/**
 * Rebuild the per-route pickers: the models under LLM, then every agent a
 * stage can run under Agent, each by its name alone. A stage names one of
 * them — there is no "Default LLM" entry, which sat beside the default's own
 * row as a second copy of it. Keeps a selection that still exists, else lands
 * on the default.
 */
function fillRouteOptions() {
  const agents = routeTargets().filter((t) => t.agent);
  const option = (t) => `<option value="${esc(t.id)}">${esc(t.label || t.id)}</option>`;
  for (const prefix of ROUTE_PREFIXES) {
    const select = $(`#cfg-${prefix}-use`);
    const previous = select.value;
    select.innerHTML = `<optgroup label="LLM">${connectionDrafts.map(option).join('')}</optgroup>`
      + (agents.length ? `<optgroup label="Agent">${agents.map(option).join('')}</optgroup>` : '');
    select.value = stageUse(previous);
  }
  refreshResearchAgentOptions();
}

/**
 * The five stages, in the order a document meets them: Convert and Index on
 * sync, Extract and Summarize in the background pass, and Judge, which decides
 * things — duplicates after each pass, disputes and Dream at night, knode_ask
 * on demand (docs/design/09). The flow draws one node each, and the inspector
 * below shows the panel of whichever is selected — the long explanations used
 * to be stacked five deep and cost two screens.
 */
const PIPELINE_STAGES = [
  { key: 'document', step: 1, title: 'Convert', badge: 'vision', accent: 'accent2' },
  { key: 'index', step: 2, title: 'Index', badge: 'embedding', accent: 'accent' },
  { key: 'entity', step: 3, title: 'Extract', badge: 'volume', accent: 'accent2' },
  { key: 'summary', step: 4, title: 'Summarize', badge: 'prose', accent: 'accent2' },
  { key: 'judge', step: 5, title: 'Judge', badge: 'quality', accent: 'accent2' },
  // beside the background pass, while content languages are on (docs/design/17)
  { key: 'translate', step: 6, title: 'Translate', badge: 'languages', accent: 'accent2' },
];
let selectedStage = 'document';

function stageTarget(key) {
  if (key === 'index') return embeddingSummaryText();
  return routeSummary(key);
}

/** The rate a node reports: only the stages that have one show anything. */
function stageRate(key) {
  const int = (sel, fallback) => Number($(sel)?.value) || fallback;
  if (key === 'document') return `×${int('#cfg-ingest-convert', 2)}`;
  if (key === 'index') return `×${int('#cfg-ingest-concurrency', 4)} · ${int('#cfg-emb-batch', 32)}/req`;
  // Summarize runs in Extract's pass, at its rates
  if (key === 'entity' || key === 'summary') return `×${int('#cfg-extraction-concurrency', 1)} · ${int('#cfg-extraction-batch', 8)}/pass`;
  if (key === 'translate') {
    if (!$('#cfg-lang-enabled').checked) return 'off';
    const slots = Number($('#cfg-translate-concurrency').value);
    return `→ ${$('#cfg-lang-primary').value || '?'} · ×${Number.isFinite(slots) ? slots : 1}`;
  }
  return '';
}

function renderStageFlow() {
  $('#stage-flow').innerHTML = PIPELINE_STAGES
    .map((stage, index) => {
      const target = stageTarget(stage.key);
      const node = `<button type="button" class="stage-node${stage.key === selectedStage ? ' selected' : ''}" data-stage="${stage.key}">
        <span class="stage-node-head"><i class="stage-step ${stage.accent}">${stage.step}</i>${esc(stage.title)}</span>
        <span class="section-badge ${stage.accent === 'accent2' ? 'accent2' : ''}">${esc(stage.badge)}</span>
        <span class="stage-node-target mono" title="${esc(summaryLine(target))}">${esc(target.provider)}</span>
        <span class="stage-node-model mono" title="${esc(summaryLine(target))}">${esc(target.model || 'its own model')}</span>
        <span class="stage-node-rate mono">${esc(stageRate(stage.key))}</span>
      </button>`;
      return index ? `<span class="stage-arrow">→</span>${node}` : node;
    })
    .join('');
  for (const panel of document.querySelectorAll('.stage-panel')) {
    panel.hidden = panel.dataset.stage !== selectedStage;
  }
}

function updateConfigSummaries() {
  renderStageFlow();
  paintInheritedPlaceholders();
}

/**
 * The greyed text in every Model field that is inheriting. Repainted from
 * here rather than only on a provider-picker change, because editing a
 * connection's own model changes what every stage on it will run.
 */
function paintInheritedPlaceholders() {
  for (const prefix of ROUTE_PREFIXES) {
    const input = $(`#cfg-${prefix}-model`);
    if (input) input.placeholder = inheritedModelFor($(`#cfg-${prefix}-use`).value) || 'Optional · use its model';
  }
  const research = $('#cfg-research-model');
  if (research) research.placeholder = inheritedAgentModelFor($('#cfg-research-agent').value) || 'CLI default';
}

function routeProviderToggle(prefix) {
  const note = $(`#cfg-${prefix}-note`);
  const target = routeTargetById($(`#cfg-${prefix}-use`).value) ?? defaultConnection();
  if (!target) {
    note.innerHTML = 'Nothing to run on yet — add a model in section 01.';
  } else if (target.provider === 'openai') {
    // a model called directly, or a deepagents agent: the loop on that model
    const how = target.agent ? ' · runs the deepagents loop' : '';
    note.innerHTML = `<b>${esc(target.label || target.id)}</b>${how} · ${esc((target.baseUrl || '').trim() || 'no endpoint set')}`;
  } else {
    // a CLI agent, run with its own path
    const meta = cliMeta[target.provider];
    note.innerHTML = `<b>${esc(target.label || target.id)}</b> · ${esc(target.cliPath || (meta ? meta.command : target.provider))}`;
  }
  updateConfigSummaries();
}

function fillRoute(prefix, route = {}) {
  $(`#cfg-${prefix}-use`).value = stageUse(route.use || '');
  $(`#cfg-${prefix}-model`).value = route.model || '';
  routeProviderToggle(prefix);
}

const optionsFor = (pairs, selected) =>
  pairs.map(([v, l]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(l)}</option>`).join('');

/** The shared row chrome; `fields` is the form the chevron opens. */
function providerRow({ kind, accent, id, label, placeholder, providerLabel, summary, isDefault, removable, promotable, fields }) {
  const open = expandedProviders.has(id);
  return `<div class="provider-row${open ? ' open' : ''}" data-id="${esc(id)}" data-kind="${kind}">
    <div class="provider-line">
      <button type="button" class="provider-toggle" aria-expanded="${open}" title="${open ? 'Collapse' : 'Expand'}">${open ? '▾' : '▸'}</button>
      <span class="section-badge ${accent === 'accent2' ? 'accent2' : ''}">${esc(kind === 'embedding' ? 'embed' : 'llm')}</span>
      <input class="provider-name" data-field="label" value="${esc(label || '')}" placeholder="${esc(placeholder)}" />
      <span>${isDefault
        ? `<span class="section-badge ${accent === 'accent2' ? 'accent2' : ''}">default</span>`
        : promotable ? '<button type="button" class="hint-action provider-default" title="Every job that names no provider of its own moves here">make default</button>' : ''}</span>
      <span class="provider-kind">${esc(providerLabel)}</span>
      <span class="provider-model mono" title="${esc(summary || '')}">${esc(summary || 'no model set')}</span>
      <span class="provider-id mono">${esc(id)}</span>
      <button type="button" class="ghost provider-remove"${removable ? '' : ' disabled'} title="${removable ? 'Remove this provider' : 'This provider cannot be removed'}">✕</button>
    </div>
    ${open ? `<div class="provider-detail">${fields}</div>` : ''}
  </div>`;
}

function embeddingFields(entry) {
  const api = entry.provider !== 'local';
  return `<div class="cfg-grid cfg-grid-2">
      <label>Provider<select data-field="provider">${optionsFor(EMBEDDING_PROVIDER_OPTIONS, entry.provider)}</select></label>
      <label>Model<span class="model-field"><input data-field="model" value="${esc(entry.model || '')}" placeholder="${entry.provider === 'ark-multimodal' ? 'ep-…' : 'text-embedding-3-small'}"${api ? '' : ' disabled'} />${api ? modelChevron(`embedding:${entry.id}`) : ''}</span></label>
      <label class="cfg-span-2">Base URL<input data-field="baseUrl" value="${esc(entry.baseUrl || '')}" placeholder="https://api.openai.com/v1"${api ? '' : ' disabled'} /></label>
      <label>API key<input data-field="apiKey" type="password" value="${esc(entry.apiKey || '')}" placeholder="env:OPENAI_API_KEY"${api ? '' : ' disabled'} /></label>
      <label>Dimensions<input data-field="dimensions" type="number" min="1" step="1" value="${esc(entry.dimensions ?? '')}" /></label>
    </div>
    <label class="cfg-check"><input data-field="sendDimensions" type="checkbox"${entry.sendDimensions ? ' checked' : ''}${api ? '' : ' disabled'} /> Send the <span class="mono">dimensions</span> parameter with API requests</label>
    <p class="cfg-callout">${esc(EMB_NOTES[entry.provider] ?? EMB_NOTES.openai)}</p>${embeddingKeyLimits(entry)}`;
}

/**
 * An LLM row is a model endpoint: where it is, its key, its wire and which
 * model. The coding-agent CLIs that used to be picked here are agents now, in
 * the table below, with their path and effort.
 */
function llmFields(entry, route) {
  const provider = entry.provider || 'openai';
  // the form follows the provider: an endpoint shows its URL, key and wire; a
  // command its executable; a plugin provider whatever fields it declared
  const fields = llmProviderFields(provider);
  const has = (field) => fields.includes(field);
  const inputs = [];
  if (has('baseUrl')) inputs.push(`<label class="cfg-span-2">Base URL<input data-field="baseUrl" value="${esc(entry.baseUrl || '')}" placeholder="https://api.openai.com/v1" /></label>`);
  if (has('apiKey')) inputs.push(`<label>API key<input data-field="apiKey" value="${esc(entry.apiKey || '')}" placeholder="env:OPENAI_API_KEY" /></label>`);
  if (has('protocol')) inputs.push(`<label>Protocol<select data-field="protocol">${optionList(PROTOCOL_OPTIONS, entry.protocol || 'auto')}</select></label>`);
  if (has('cliPath')) inputs.push(`<label class="cfg-span-2">Executable<input data-field="cliPath" value="${esc(entry.cliPath || '')}" placeholder="/path/to/program" /></label>`);
  if (has('cliTimeoutMs')) inputs.push(`<label>Timeout (ms)<input data-field="cliTimeoutMs" type="number" min="1000" step="1000" value="${esc(entry.cliTimeoutMs ?? 300000)}" /></label>`);
  if (has('model')) inputs.push(`<label class="cfg-span-2">Model<span class="model-field"><input data-field="model" value="${esc(entry.model || '')}" placeholder="${provider === 'openai' ? 'gpt-4.1-mini' : 'model id'}" />${modelChevron(route)}</span></label>`);
  return `<div class="cfg-grid cfg-grid-2">
      <label>Provider<select data-field="provider">${optionsFor(connectionProviderOptions(provider), provider)}</select></label>
      ${inputs.join('\n      ')}
    </div>
    <p class="cfg-callout">${esc(LLM_NOTES[provider] ?? LLM_NOTES.openai)}</p>`;
}

function renderProviders() {
  renderEmbeddingPool();
  const rows = embeddingDrafts.map((e) =>
    providerRow({
      kind: 'embedding',
      accent: 'accent',
      id: e.id,
      label: e.label,
      placeholder: 'Name this provider',
      providerLabel: embeddingProviderLabel(e.provider),
      summary: e.provider === 'local' ? `hashing · ${e.dimensions || 384}d` : (e.model ? `${e.model} · ${e.dimensions || ''}d` : ''),
      isDefault: !embeddingPoolDraft.enabled && e.id === embeddingUse,
      // something has to embed, so the last one stays
      removable: embeddingDrafts.length > 1,
      fields: embeddingFields(e),
    }));

  // the default is an ordinary row that `llmUse` points at, so there is one
  // LLM row builder rather than one for the default and one for the rest
  for (const c of connectionDrafts) {
    rows.push(providerRow({
      kind: 'llm',
      accent: 'accent2',
      id: c.id,
      label: c.label,
      placeholder: 'Name this provider',
      providerLabel: providerNames[c.provider] ?? c.provider,
      summary: c.model,
      isDefault: c.id === (defaultConnection()?.id ?? ''),
      // something has to answer, so the last one stays
      removable: connectionDrafts.length > 1,
      promotable: true,
      fields: llmFields(c, `connection:${c.id}`),
    }));
  }

  $('#cfg-providers').innerHTML = rows.join('');
  fillEmbeddingOptions();
}

/** The draft one row edits, whichever of the three lists it came from. */
function providerDraft(id) {
  return embeddingDrafts.find((e) => e.id === id) ?? connectionById(id);
}

function addConnection() {
  let suffix = connectionDrafts.length + 1;
  while (connectionDrafts.some((c) => c.id === `connection-${suffix}`)) suffix += 1;
  const id = `connection-${suffix}`;
  connectionDrafts.push({
    id,
    label: `Connection ${suffix}`,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    protocol: 'auto',
    model: '',
    cliPath: '',
    effort: 'default',
  });
  expandedProviders.add(id);
  renderProviders();
  fillRouteOptions();
  updateConfigSummaries();
}

function addEmbeddingProvider() {
  let suffix = embeddingDrafts.length + 1;
  while (embeddingDrafts.some((e) => e.id === `embedding-${suffix}`)) suffix += 1;
  const id = `embedding-${suffix}`;
  embeddingDrafts.push({
    id,
    label: `Embedding ${suffix}`,
    provider: 'local',
    baseUrl: '',
    apiKey: '',
    model: '',
    dimensions: 384,
    sendDimensions: false,
  });
  expandedProviders.add(id);
  renderProviders();
  updateConfigSummaries();
}

/** Under the Extract stage: what the background passes still have to read (a long document counts its segments). */
async function showExtractionQueue() {
  const el = $('#cfg-extraction-queue');
  if (!el) return;
  try {
    const s = await api('/api/stats');
    el.textContent = s.extraction_queue ? `Queue: ${s.extraction_queue} documents, ${s.extraction_segments ?? s.extraction_queue} calls left.` : '';
  } catch {
    el.textContent = '';
  }
}

async function loadConfigForm({ preserveStatus = false } = {}) {
  // A workspace switch can happen while this request is in flight. Ignore a
  // response for the old workspace instead of painting its routes into the
  // newly selected workspace's form.
  const workspaceId = activeWorkspace()?.id;
  try {
    const cfg = await api('/api/config');
    if (activeWorkspace()?.id !== workspaceId) return;
    loadedConfig = cfg;
    // which providers this service knows — its plugins may add some
    try {
      applyProviderCatalog(await api('/api/config/providers'));
    } catch {
      // an older service: the built-in names above stay
    }
    if (activeWorkspace()?.id !== workspaceId) return;
    embeddingDrafts = (cfg.embeddingProviders ?? []).map((e) => ({ ...e }));
    embeddingUse = cfg.embeddingUse || embeddingDrafts[0]?.id || '';
    embeddingPoolDraft = { enabled: false, model: 'bge-m3', dimensions: 1024, batchSize: 16, ...cfg.embeddingPool };
    {
      const e = cfg.ingest?.embedEndpoint;
      embedLocalDraft = {
        embedding: cfg.ingest?.embedding === 'deferred' ? 'deferred' : 'inline', embedSlots: cfg.ingest?.embedSlots ?? 8,
        baseUrl: e?.baseUrl ?? '', model: e?.model ?? '', apiKey: e?.apiKey ?? '', checked: null,
      };
      // what is saved passed the check when it was saved
      if (e) embedLocalDraft.saved = embedEndpointKey(embedLocalDraft);
      renderEmbeddingLocal();
    }
    embeddingUsage = [];
    void refreshEmbeddingUsage().catch(() => {});
    connectionDrafts = (cfg.connections ?? []).map((c) => ({ ...c }));
    llmUse = cfg.llmUse || connectionDrafts[0]?.id || '';
    // agents before routes: a stage may run on an agent, and a route
    // filled before its agent exists would read — and then save — as the default
    await loadAgentsList();
    if (activeWorkspace()?.id !== workspaceId) return;
    renderProviders();
    fillRouteOptions();
    for (const prefix of ROUTE_PREFIXES) fillRoute(prefix, cfg.extraction?.[`${prefix}Llm`]);
    $('#cfg-extraction-batch').value = cfg.extraction?.batchSize ?? 8;
    $('#cfg-extraction-concurrency').value = cfg.extraction?.concurrency ?? 1;
    $('#cfg-extraction-claims').checked = cfg.extraction?.claims !== false;
    // the server's processing, the same in every workspace: calls at once, the quota floor (src/labeling/local.ts)
    $('#cfg-processing-max-calls').value = cfg.processing?.maxLocalCalls ?? 2;
    $('#cfg-processing-min-quota').value = cfg.processing?.minQuotaPercent ?? 20;
    await fillLanguagesForm(cfg);
    if (activeWorkspace()?.id !== workspaceId) return;
    $('#cfg-review-judge').value = cfg.review?.llmJudge ?? 'suggest';
    $('#cfg-review-claims').value = cfg.review?.claims ?? 'suggest';
    $('#cfg-review-claim-merge').value = cfg.review?.claimMerge ?? 'auto';
    $('#cfg-extraction-segment').textContent = (cfg.extraction?.segmentChars ?? 12000).toLocaleString('en-US');
    void showExtractionQueue();
    $('#cfg-ingest-concurrency').value = cfg.ingest?.concurrency ?? 4;
    $('#cfg-ingest-convert').value = cfg.ingest?.convertConcurrency ?? 2;
    $('#cfg-emb-batch').value = embeddingPoolDraft.enabled ? embeddingPoolDraft.batchSize : activeEmbedding()?.batchSize ?? 32;
    fillResearchForm(cfg.research ?? {});
    fillChatForm(cfg.chat ?? {});
    renderAgents();
    // With no agent configured, pre-fill what the service says can run here. It
    // is only a pre-fill: nothing is saved until the person presses Save, so
    // "not configured" never quietly becomes a setting nobody chose.
    if (!cfg.research?.agent) {
      try {
        const { suggested } = await api('/api/config/agents');
        if (suggested && activeWorkspace()?.id === workspaceId) $('#cfg-research-agent').value = suggested;
      } catch {
        /* the picker still works; it just starts empty */
      }
    }
    updateConfigSummaries();
    try {
      await loadResearchProfiles(cfg.research?.profile);
    } catch (e) {
      $('#cfg-roles').innerHTML = `<p class="cfg-callout">research profiles unavailable: ${esc(e.message)}</p>`;
    }
    if (!preserveStatus) $('#cfg-status').innerHTML = '';
  } catch (e) {
    if (activeWorkspace()?.id !== workspaceId) return;
    $('#cfg-status').innerHTML = `<div class="cfg-line bad">load failed: ${esc(e.message)}</div>`;
  }
}

/**
 * The Translate stage's languages: on or off, the primary language, the
 * secondary ones (any other the catalog has), and the size past which a
 * document waits for a reader to ask. The catalog comes from the service.
 */
async function fillLanguagesForm(cfg) {
  if (!contentLanguages) await loadContentLanguages();
  const catalog = contentLanguages?.languages ?? Object.entries(LANGUAGE_NAMES).map(([code, native]) => ({ code, native, english: code }));
  const langs = cfg.languages ?? { enabled: false, primary: '', secondary: [], maxChars: 200000 };
  $('#cfg-lang-enabled').checked = langs.enabled === true;
  $('#cfg-lang-primary').innerHTML = `<option value="">— choose —</option>${catalog.map((l) => `<option value="${esc(l.code)}">${esc(l.native)} · ${esc(l.english)}</option>`).join('')}`;
  $('#cfg-lang-primary').value = langs.primary || '';
  const secondary = new Set(langs.secondary ?? []);
  $('#cfg-lang-secondary').innerHTML = catalog
    .map((l) => `<label class="cfg-check cfg-inline-check"><input type="checkbox" value="${esc(l.code)}"${secondary.has(l.code) ? ' checked' : ''} /> ${esc(l.native)}</label>`)
    .join('');
  $('#cfg-lang-maxchars').value = langs.maxChars ?? 200000;
  $('#cfg-translate-concurrency').value = cfg.extraction?.translateConcurrency ?? cfg.extraction?.concurrency ?? 1;
  paintLanguageForm();
}

/** The primary language is no secondary one; the stage's line says what it is doing. */
function paintLanguageForm() {
  const primary = $('#cfg-lang-primary').value;
  for (const box of document.querySelectorAll('#cfg-lang-secondary input')) {
    box.disabled = box.value === primary;
    if (box.disabled) box.checked = false;
  }
  const t = processingStatus?.translations;
  $('#cfg-lang-status').textContent = !$('#cfg-lang-enabled').checked
    ? 'Off: nothing is translated, summaries keep each document\'s language and readers see no switcher.'
    : t?.enabled
      ? `${count(t.due, ['translation', 'translations'])} due at the last look · ${count(t.leases.length, ['segment', 'segments'])} out · ${count(t.lastHour.documents, ['document', 'documents'])} finished in the last hour.`
      : 'Translations start once this is saved and processing runs (or a remote worker takes them).';
}

function gatherLanguages() {
  return {
    enabled: $('#cfg-lang-enabled').checked,
    primary: $('#cfg-lang-primary').value,
    secondary: [...document.querySelectorAll('#cfg-lang-secondary input:checked')].map((box) => box.value),
    maxChars: Math.max(0, Math.floor(Number($('#cfg-lang-maxchars').value) || 0)),
  };
}

for (const id of ['#cfg-lang-enabled', '#cfg-lang-primary', '#cfg-translate-concurrency']) {
  $(id).addEventListener('change', () => {
    paintLanguageForm();
    updateConfigSummaries();
  });
}

function gatherRoute(prefix) {
  return {
    use: $(`#cfg-${prefix}-use`).value,
    model: $(`#cfg-${prefix}-model`).value.trim(),
    // the endpoint now lives on the connection; clear any pre-connections leftovers
    provider: 'inherit',
    baseUrl: '',
    apiKey: '',
    cliPath: '',
    cliTimeoutMs: loadedConfig?.extraction?.[`${prefix}Llm`]?.cliTimeoutMs || 300000,
  };
}

// '***' / 'env:…' are passed through verbatim; the server keeps the real secret.
function gatherConfig() {
  return {
    embeddingProviders: embeddingDrafts.map((e) => ({
      ...e,
      label: (e.label || '').trim() || e.id,
      // the request size is edited on the Index node, not in the provider row
      batchSize: !embeddingPoolDraft.enabled && e.id === embeddingUse ? Number($('#cfg-emb-batch').value) || e.batchSize : e.batchSize,
    })),
    embeddingUse,
    embeddingPool: { ...embeddingPoolDraft, ...(embeddingPoolDraft.enabled ? { batchSize: Number($('#cfg-emb-batch').value) || embeddingPoolDraft.batchSize } : {}) },
    ingest: {
      concurrency: Number($('#cfg-ingest-concurrency').value) || undefined,
      convertConcurrency: Number($('#cfg-ingest-convert').value) || undefined,
      embedding: embedLocalDraft.embedding,
      embedSlots: embedLocalDraft.embedSlots,
      // checked again by the server on save when it changed; null removes it
      embedEndpoint: embedLocalDraft.baseUrl.trim()
        ? { baseUrl: embedLocalDraft.baseUrl.trim(), model: embedLocalDraft.model.trim(), apiKey: embedLocalDraft.apiKey }
        : null,
    },
    connections: connectionDrafts.map((c) => ({ ...c, label: c.label.trim() || c.id })),
    llmUse,
    extraction: {
      entityLlm: gatherRoute('entity'),
      documentLlm: gatherRoute('document'),
      summaryLlm: gatherRoute('summary'),
      judgeLlm: gatherRoute('judge'),
      translateLlm: gatherRoute('translate'),
      batchSize: Number($('#cfg-extraction-batch').value),
      concurrency: Number($('#cfg-extraction-concurrency').value),
      translateConcurrency: Number($('#cfg-translate-concurrency').value),
      claims: $('#cfg-extraction-claims').checked,
    },
    languages: gatherLanguages(),
    processing: {
      maxLocalCalls: Number($('#cfg-processing-max-calls').value),
      minQuotaPercent: Number($('#cfg-processing-min-quota').value),
    },
    // what the Judge stage does with its verdicts
    review: {
      llmJudge: $('#cfg-review-judge').value,
      claims: $('#cfg-review-claims').value,
      claimMerge: $('#cfg-review-claim-merge').value,
    },
    research: gatherResearchConfig(),
    chat: gatherChatConfig(),
  };
}

/* ---------- 03 · agents: who runs a research job or a chat turn ---------- */

/**
 * Agents, one row each whichever runtime they have: the built-in deepagents
 * loop on one of the models above, or a coding-agent CLI that brings its own
 * loop, path and model. The CLIs used to sit among the models, which made
 * "cursor" the default *LLM* and let the deep agent quietly run Cursor.
 *
 * Each agent is its own file under `playbooks/agents/`, so unlike the rest of
 * this screen they are written the moment one is added or removed — Research
 * cannot point at a name that does not exist yet. Field edits still wait for
 * Save & apply, along with everything else.
 */
let agentDrafts = [];
const expandedAgents = new Set();

const AGENT_EFFORTS = [
  ['default', 'CLI default'], ['low', 'Low'], ['medium', 'Medium'],
  ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max'], ['ultra', 'Ultra (codex)'],
];
const AGENT_WEB = [['inherit', 'Follow review.external'], ['on', 'On (within review.external)'], ['off', 'Off']];
const AGENT_TYPES = { 'claude-cli': 'Claude Code', 'codex-cli': 'Codex', 'cursor-cli': 'Cursor', 'opencode-cli': 'OpenCode' };

const isCliAgent = (agent) => CLI_PROVIDERS.includes(agent.executor);

function agentById(name) {
  return agentDrafts.find((a) => a.name === name);
}

/** Where an agent runs, by the names the tables use. */
function agentRunsOn(agent) {
  if (agent.executor === 'opencode-cli') {
    const connection = opencodeConnection(agent);
    if (!connection) return { name: 'No model connection', help: 'OpenCode has no login of its own: pick the connection it runs on.' };
    const follows = !agent.connection || agent.connection === 'default';
    return { name: connection.label || connection.id, note: follows ? 'follows default' : '', help: `OpenCode on ${connection.baseUrl}` };
  }
  if (isCliAgent(agent)) {
    const command = cliMeta[agent.executor]?.path ?? agent.executor;
    return agent.cliPath ? { name: agent.cliPath, help: agent.cliPath } : { name: 'From PATH', help: `${command}, found on the service PATH` };
  }
  if (agent.executor === 'default') {
    const def = defaultConnection();
    const name = def ? def.label || def.id : 'Default LLM';
    return { name, note: 'follows default', help: `Follows the default LLM — ${name} for now. Make another model the default and this agent moves with it.` };
  }
  const connection = connectionById(agent.executor);
  return connection ? { name: connection.label || connection.id, help: connection.baseUrl || '' } : { name: agent.executor || 'Not configured', help: '' };
}

/** The model a row runs: its own, else what its model endpoint brings. */
function agentModelSummary(agent) {
  if (agent.model) return { text: agent.model, help: agent.model, pinned: true };
  const endpoint = modelEndpoint(agent);
  if (endpoint?.model) return { text: endpoint.model, help: `Inherited from ${endpoint.label || endpoint.id}` };
  const connection = opencodeConnection(agent);
  if (connection?.model) return { text: connection.model, help: `Inherited from ${connection.label || connection.id}` };
  return { text: isCliAgent(agent) ? 'CLI default' : 'its own default', help: '' };
}

/** Why an agent cannot run, in words that say what to change; '' when it can. */
function agentProblem(agent) {
  if (agent.executor === 'opencode-cli') {
    const connection = opencodeConnection(agent);
    if (!connection) return 'OpenCode runs on a model connection — pick one for it.';
    if (!connection.model && !agent.model) return `${connection.label || connection.id} has no model set.`;
    return '';
  }
  if (isCliAgent(agent)) return '';
  const endpoint = modelEndpoint(agent);
  if (agent.executor === 'default' && !endpoint) return 'deepagents runs on a model, and the default is a CLI agent — pick a model for it.';
  if (!endpoint) return 'Its executor cannot run here — pick another one.';
  if (!endpoint.model && !agent.model) return `${endpoint.label || endpoint.id} has no model set.`;
  return '';
}

function deepagentsFields(agent) {
  const def = defaultConnection();
  const options = [`<option value="default"${agent.executor === 'default' ? ' selected' : ''}>Follow the default LLM${def ? ` · ${esc(def.label || def.id)}` : ''}</option>`]
    .concat(connectionDrafts.map((c) => `<option value="${esc(c.id)}"${c.id === agent.executor ? ' selected' : ''}>${esc(c.label || c.id)}</option>`))
    .join('');
  return `<div class="cfg-grid cfg-grid-2">
      <label>Runs on<select data-field="executor">${options}</select></label>
      <label>Model<span class="model-field"><input data-field="model" value="${esc(agent.model || '')}" placeholder="${esc(modelEndpoint(agent)?.model || 'Its own default')}" />${modelChevron(executorModelRoute(agent.name))}</span></label>
    </div>`;
}

function cliFields(agent) {
  const cliOptions = CLI_PROVIDERS.map((p) => `<option value="${p}"${p === agent.executor ? ' selected' : ''}>${esc(providerNames[p])}</option>`).join('');
  const opencode = agent.executor === 'opencode-cli';
  const def = defaultConnection();
  const follows = !agent.connection || agent.connection === 'default';
  const connectionOptions = [`<option value="default"${follows ? ' selected' : ''}>Follow the default LLM${def ? ` · ${esc(def.label || def.id)}` : ''}</option>`]
    .concat(connectionDrafts.filter((c) => c.provider === 'openai').map((c) => `<option value="${esc(c.id)}"${c.id === agent.connection ? ' selected' : ''}>${esc(c.label || c.id)}</option>`))
    .join('');
  return `<div class="cfg-grid cfg-grid-2">
      <label>CLI<select data-field="executor">${cliOptions}</select></label>
      ${opencode ? `<label>Runs on<select data-field="connection">${connectionOptions}</select></label>` : ''}
      <label>Model<span class="model-field"><input data-field="model" value="${esc(agent.model || '')}" placeholder="${esc(opencode ? opencodeConnection(agent)?.model || 'The connection\'s model' : 'Use CLI default')}" />${modelChevron(executorModelRoute(agent.name))}</span></label>
      <label>Reasoning effort<select data-field="effort">${optionList(AGENT_EFFORTS, agent.effort || 'default')}</select></label>
      <label>Web access<select data-field="web">${optionList(AGENT_WEB, agent.tools?.web ?? 'inherit')}</select></label>
      <label class="cfg-span-2">CLI executable<input data-field="cliPath" value="${esc(agent.cliPath || '')}" placeholder="Default: ${esc(cliMeta[agent.executor]?.path ?? '')} from PATH" /></label>
    </div>`;
}

function renderAgents() {
  const host = $('#cfg-agents');
  if (!agentDrafts.length) {
    host.innerHTML = '<p class="cfg-callout">No agents yet — add one: deepagents on one of the models above, or a coding-agent CLI on this machine.</p>';
    return;
  }
  host.innerHTML = agentDrafts
    .map((agent) => {
      const cli = isCliAgent(agent);
      const open = expandedAgents.has(agent.name);
      const where = agentRunsOn(agent);
      const model = agentModelSummary(agent);
      const problem = agentProblem(agent);
      const uses = [
        cli && agent.name === llmUse ? '<span class="section-badge">default</span>' : '',
        $('#cfg-research-agent')?.value === agent.name ? '<span class="section-badge accent2">research</span>' : '',
        $('#cfg-chat-agent')?.value === agent.name ? '<span class="section-badge">ask</span>' : '',
      ].join('');
      return `<div class="provider-row${open ? ' open' : ''}" data-agent="${esc(agent.name)}">
        <div class="provider-line">
          <button type="button" class="provider-toggle agent-toggle" aria-expanded="${open}">${open ? '▾' : '▸'}</button>
          <span class="section-badge${cli ? '' : ' accent2'}">${esc(cli ? AGENT_TYPES[agent.executor] : 'deepagents')}</span>
          <input class="provider-name" data-field="title" value="${esc(agent.title || '')}" placeholder="Name this agent" />
          <span>${uses}</span>
          <span class="provider-kind" title="${esc(where.help)}">${esc(where.name)}${where.note ? ` <span class="soft">· ${esc(where.note)}</span>` : ''}</span>
          <span class="provider-model mono${model.pinned ? ' pinned' : ''}" title="${esc(model.help)}">${esc(model.text)}</span>
          <span class="provider-id mono">${problem ? `<span title="${esc(problem)}">⚠</span> ` : ''}${esc(agent.name)}</span>
          <button type="button" class="ghost agent-remove" title="${agent.builtin ? 'Reset this template to its built-in' : 'Remove this agent'}">${agent.builtin ? '⟲' : '✕'}</button>
        </div>
        ${open ? `<div class="provider-detail">${cli ? cliFields(agent) : deepagentsFields(agent)}</div>` : ''}
      </div>`;
    })
    .join('');
}

async function loadAgentsList() {
  try {
    const body = await api('/api/agents');
    agentDrafts = body.agents.map((a) => ({ ...a }));
  } catch {
    agentDrafts = [];
  }
  renderAgents();
  // a stage and the research pickers may name an agent
  fillRouteOptions();
}

/**
 * A new agent is written straight away: Research cannot name what has no file.
 * deepagents follows the default LLM while the default is a model; when it is
 * a CLI agent there is nothing to follow, so the first model is pinned.
 */
async function addAgent(runtime) {
  const cli = CLI_PROVIDERS.includes(runtime);
  const base = cli ? runtime.replace(/-cli$/, '') : 'agent';
  const taken = new Set([...agentDrafts.map((a) => a.name), ...connectionDrafts.map((c) => c.id)]);
  let suffix = 1;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  const name = `${base}-${suffix}`;
  const def = defaultConnection();
  const model = def?.provider === 'openai' ? 'default' : (connectionDrafts.find((c) => c.provider === 'openai')?.id ?? 'default');
  const executor = cli ? runtime : model;
  try {
    await api(`/api/agents/${name}`, {
      method: 'PUT',
      body: JSON.stringify({
        agent: {
          title: cli ? providerNames[runtime] : 'New deepagents agent',
          executor,
          // OpenCode brings no login: it starts on the model deepagents would
          ...(runtime === 'opencode-cli' ? { connection: model } : {}),
        },
      }),
    });
    expandedAgents.add(name);
    await loadAgentsList();
  } catch (e) {
    $('#cfg-status').innerHTML = `<div class="cfg-line bad">could not create the agent: ${esc(e.message)}</div>`;
  }
}

async function removeAgent(name) {
  try {
    const { reset } = await api(`/api/agents/${name}`, { method: 'DELETE' });
    expandedAgents.delete(name);
    // the service moves research, Ask, a pipeline route and the default off a
    // deleted agent, so read those back rather than keep a name that is gone
    const cfg = reset ? null : await api('/api/config');
    if (cfg) llmUse = cfg.llmUse || llmUse;
    await loadAgentsList();
    if (cfg) {
      $('#cfg-research-agent').value = cfg.research?.agent ?? '';
      $('#cfg-chat-agent').value = cfg.chat?.agent ?? '';
      for (const prefix of ROUTE_PREFIXES) {
        $(`#cfg-${prefix}-use`).value = stageUse(cfg.extraction?.[`${prefix}Llm`]?.use ?? '');
        routeProviderToggle(prefix);
      }
      renderProviders();
      refreshResearchAgentOptions();
      renderAgents();
    }
  } catch (e) {
    $('#cfg-status').innerHTML = `<div class="cfg-line bad">could not remove the agent: ${esc(e.message)}</div>`;
  }
}

/** Each agent is its own file, so Save & apply writes them beside the config. */
async function saveAgents() {
  for (const agent of agentDrafts) {
    await api(`/api/agents/${agent.name}`, {
      method: 'PUT',
      body: JSON.stringify({
        agent: {
          title: (agent.title || '').trim() || agent.name,
          executor: agent.executor,
          cliPath: agent.cliPath ?? '',
          connection: agent.connection ?? '',
          model: agent.model ?? '',
          effort: agent.effort ?? 'default',
          // set in the macOS app's effort chip; kept, not edited, here
          speed: agent.speed ?? 'default',
          tools: { web: agent.tools?.web ?? 'inherit' },
        },
      }),
    });
  }
}

for (const id of ['#cfg-research-agent', '#cfg-chat-agent']) {
  $(id).addEventListener('change', () => {
    renderAgents();
    paintInheritedPlaceholders();
  });
}

$('#cfg-add-agent').addEventListener('click', (event) => {
  showMenuUnder(event.currentTarget, [
    { label: 'deepagents · on the default LLM', run: () => addAgent('deepagents') },
    ...CLI_PROVIDERS.map((p) => ({ label: providerNames[p], run: () => addAgent(p) })),
  ]);
});

$('#cfg-agents').addEventListener('input', (event) => {
  const row = event.target.closest?.('.provider-row');
  const field = event.target.dataset?.field;
  const agent = row && agentById(row.dataset.agent);
  if (!agent || !field || event.target.tagName === 'SELECT') return;
  agent[field] = event.target.value;
  // the model list is the CLI's at this path, not at the one it was drawn with
  if (field === 'cliPath') row.querySelector('.model-chevron')?.setAttribute('data-cli-path', agent.cliPath);
  // a CLI agent's name and model are what a stage or the default shows
  if (field === 'title') fillRouteOptions();
  if (field === 'model' || field === 'title') {
    const cell = row.querySelector('.provider-model');
    const summary = agentModelSummary(agent);
    cell.textContent = summary.text;
    cell.title = summary.help;
    cell.classList.toggle('pinned', Boolean(summary.pinned));
    updateConfigSummaries();
  }
});

$('#cfg-agents').addEventListener('change', (event) => {
  const row = event.target.closest?.('.provider-row');
  const field = event.target.dataset?.field;
  const agent = row && agentById(row.dataset.agent);
  if (!agent || !field) return;
  if (field === 'web') {
    agent.tools = { ...agent.tools, web: event.target.value };
    return;
  }
  if (field !== 'executor' && field !== 'effort' && field !== 'connection') return;
  agent[field] = event.target.value;
  if (field === 'executor' || field === 'connection') {
    renderAgents();
    fillRouteOptions();
    updateConfigSummaries();
  }
});

$('#cfg-agents').addEventListener('click', (event) => {
  const row = event.target.closest?.('.provider-row');
  if (!row) return;
  const name = row.dataset.agent;
  if (event.target.classList.contains('agent-toggle')) {
    if (expandedAgents.has(name)) expandedAgents.delete(name); else expandedAgents.add(name);
    renderAgents();
    return;
  }
  if (event.target.classList.contains('agent-remove')) removeAgent(name);
});

/* ---------- Settings · research: pipeline, initialization, profile; and Ask's chat block ---------- */
const CLI_PROVIDERS = ['claude-cli', 'codex-cli', 'cursor-cli', 'opencode-cli'];
const PROTOCOL_OPTIONS = [
  ['auto', 'Auto (Responses, else Chat)'], ['responses', 'Responses only'], ['chat', 'Chat Completions only'],
];
const EFFORT_OPTIONS = [
  ['default', 'CLI default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max (claude & codex; cursor, opencode → high)'], ['ultra', 'Ultra (codex; claude → max)'],
];
const ROLE_PHASES = [
  ['plan', 'Plan · outline the page'], ['research', 'Research · one section'], ['synthesize', 'Synthesize · write the page'], ['review', 'Review · critique'], ['revise', 'Revise · fix issues'],
];
const ROLE_WEB = [['inherit', 'Profile setting'], ['on', 'On (within review.external)'], ['off', 'Off']];
let researchProfiles = [];
let profileDraft = null;
let profileDirty = false;

function optionList(pairs, selected) {
  return pairs.map(([v, l]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(l)}</option>`).join('');
}

// `fallbackLabel` is the meaning of the empty value: "follow the one above" for
// chat and roles. The research agent has no such fallback any more — it gets
// null, and an empty value is shown as the unconfigured state it is.
//
// The choices are the agents in section 01, each saying which runtime it is. A
// config written before agents may name a bare CLI, the default or a model
// straight; those keep resolving, so the one in use stays listed — only that one.
function agentOptions(selected, fallbackLabel) {
  const opts = fallbackLabel
    ? [`<option value="">${esc(fallbackLabel)}</option>`]
    : [`<option value=""${selected ? ' disabled' : ' selected'}>Not configured — pick an agent</option>`];
  // in the order the agents table lists them: there is no kind to sort by
  for (const a of agentDrafts) {
    const runtime = isCliAgent(a) ? providerNames[a.executor] : 'deepagents';
    opts.push(`<option value="${esc(a.name)}"${a.name === selected ? ' selected' : ''}>${esc(a.title || a.name)} · ${esc(runtime)}</option>`);
  }
  if (selected && !agentById(selected)) {
    let legacy = selected;
    if (selected === 'default') {
      const def = defaultConnection();
      legacy = `Default LLM${def ? ` · ${def.label || def.id}` : ''}`;
    } else if (CLI_PROVIDERS.includes(selected)) {
      legacy = `${providerNames[selected]} · from PATH`;
    } else if (connectionById(selected)) {
      legacy = `${connectionById(selected).label || selected} · deepagents`;
    }
    opts.push(`<option value="${esc(selected)}" selected>${esc(legacy)}</option>`);
  }
  return opts.join('');
}

/** Only the CLIs ship a web tool; deepagents on a model searches the base only. */
function agentWebCapable(spec) {
  const agent = agentById(spec);
  if (agent) return isCliAgent(agent);
  if (CLI_PROVIDERS.includes(spec)) return true;
  const provider = spec === 'default' ? defaultConnection()?.provider : targetById(spec)?.provider;
  return CLI_PROVIDERS.includes(provider);
}

function refreshResearchAgentOptions() {
  const select = $('#cfg-research-agent');
  if (!select) return;
  const current = select.value;
  select.innerHTML = agentOptions(current, null);
  select.value = current;
  if (select.value !== current) select.value = '';
  const chatSelect = $('#cfg-chat-agent');
  if (chatSelect) {
    const chatCurrent = chatSelect.value;
    chatSelect.innerHTML = agentOptions(chatCurrent, 'The research agent, else the default provider');
    chatSelect.value = chatCurrent;
    if (chatSelect.value !== chatCurrent) chatSelect.value = '';
  }
  for (const roleSelect of document.querySelectorAll('#cfg-roles select[data-field="agent"]')) {
    const value = roleSelect.value;
    roleSelect.innerHTML = agentOptions(value, 'The research agent above');
    roleSelect.value = value;
  }
  updateResearchNote();
}

function fillResearchForm(research) {
  $('#cfg-research-agent').innerHTML = agentOptions(research.agent || '', null);
  $('#cfg-research-agent').value = research.agent || '';
  $('#cfg-research-model').value = research.model || '';
  paintInheritedPlaceholders();
  $('#cfg-research-pipeline').value = research.pipeline || 'team';
  $('#cfg-research-concurrency').value = research.concurrency ?? 1;
  $('#cfg-research-maxturns').value = research.maxTurns ?? 40;
  $('#cfg-research-timeout').value = Math.max(1, Math.round((research.timeoutMs ?? 1200000) / 60000));
  $('#cfg-research-researchers').value = research.researchers ?? 3;
  $('#cfg-research-rounds').value = research.reviewRounds ?? 1;
  $('#cfg-research-auto').checked = !!research.auto?.enabled;
  $('#cfg-research-daily').value = research.auto?.dailyJobs ?? 3;
  $('#cfg-init-maxms').value = Math.max(1, Math.round((research.init?.extractionMaxMs ?? 900000) / 60000));
  $('#cfg-init-followups').value = research.init?.followUps ?? 6;
  if (!$('#cfg-profile-effort').options.length) $('#cfg-profile-effort').innerHTML = optionList(EFFORT_OPTIONS, 'default');
}

async function loadResearchProfiles(preferred) {
  const r = await api('/api/research/profiles');
  researchProfiles = r.profiles ?? [];
  const select = $('#cfg-research-profile');
  select.innerHTML = researchProfiles.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}${p.title && p.title !== p.name ? ` · ${esc(p.title)}` : ''}</option>`).join('');
  const want = preferred && researchProfiles.some((p) => p.name === preferred) ? preferred : r.active;
  select.value = want;
  await loadProfileDetail(select.value || r.active);
}

async function loadProfileDetail(name) {
  profileDraft = await api(`/api/research/profiles/${encodeURIComponent(name)}`);
  profileDirty = false;
  renderProfileForm();
}

function renderProfileForm() {
  const p = profileDraft;
  if (!p) return;
  $('#cfg-profile-name').textContent = p.name;
  $('#cfg-profile-title').value = p.title || '';
  $('#cfg-profile-desc').value = p.description || '';
  $('#cfg-profile-pipeline').value = p.pipeline || '';
  $('#cfg-profile-effort').innerHTML = optionList(EFFORT_OPTIONS, p.reasoning.effort);
  $('#cfg-profile-web').value = p.search.web;
  $('#cfg-profile-freshness').value = p.search.freshness;
  $('#cfg-profile-rounds').value = p.search.maxRounds;
  $('#cfg-profile-minsources').value = p.verification.minSourcesPerClaim;
  $('#cfg-profile-conflicts').value = p.verification.resolveConflicts;
  $('#cfg-profile-maxsections').value = p.stop.maxSections;
  $('#cfg-profile-primary').checked = !!p.verification.preferPrimarySources;
  $('#cfg-profile-marginal').checked = !!p.stop.marginalGain;
  $('#cfg-profile-citations').checked = !!p.output.citations;
  $('#cfg-profile-uncertainty').checked = !!p.output.uncertainty;
  $('#cfg-profile-evidence').checked = !!p.output.evidenceTable;
  $('#cfg-profile-delete').textContent = p.builtin ? 'Reset to built-in' : 'Delete';
  renderRoles();
  updateResearchNote();
}

function renderRoles() {
  const host = $('#cfg-roles');
  const roles = profileDraft?.roles ?? [];
  if (!roles.length) {
    host.innerHTML = '<p class="cfg-callout">No roles. The team pipeline needs at least a synthesize role; single-session mode ignores roles.</p>';
    return;
  }
  host.innerHTML = roles.map((r, index) => `<fieldset class="cfg-card cfg-role${r.enabled ? '' : ' cfg-role-off'}" data-index="${index}">
      <div class="cfg-connection-head">
        <label class="cfg-check cfg-role-enabled"><input type="checkbox" data-field="enabled"${r.enabled ? ' checked' : ''} /> On</label>
        <input class="cfg-conn-label" data-field="title" value="${esc(r.title || '')}" placeholder="Role title" />
        <span class="mono">${esc(r.id)} · ${esc(r.phase)}${r.native ? ' · native' : ''}</span>
        <button type="button" class="ghost cfg-role-remove" title="Remove this role">Remove</button>
      </div>
      <div class="cfg-grid cfg-grid-3">
        <label>Phase<select data-field="phase">${optionList(ROLE_PHASES, r.phase)}</select></label>
        <label>Runs on<select data-field="agent">${agentOptions(r.agent || '', 'The research agent above')}</select></label>
        <label>Model<input data-field="model" value="${esc(r.model || '')}" placeholder="${esc(inheritedAgentModelFor(r.agent || $('#cfg-research-agent').value) || "Agent's model")}" /></label>
        <label>Effort<select data-field="effort">${optionList([['default', 'Profile default'], ...EFFORT_OPTIONS.slice(1)], r.effort)}</select></label>
        <label>Web tools<select data-field="web">${optionList(ROLE_WEB, r.tools.web)}</select></label>
        <label>Turns per session<input data-field="maxTurns" type="number" min="0" step="1" value="${r.maxTurns || ''}" placeholder="Default" /></label>
        ${r.phase === 'research' ? `<label>Parallel sessions<input data-field="parallel" type="number" min="0" max="16" step="1" value="${r.parallel || ''}" placeholder="Researchers default" /></label>` : ''}
        ${r.phase === 'review' || r.phase === 'revise' ? `<label>Rounds<input data-field="rounds" type="number" min="0" max="6" step="1" value="${r.rounds || ''}" placeholder="Review rounds default" /></label>` : ''}
        <label class="cfg-span-2">Description<input data-field="description" value="${esc(r.description || '')}" placeholder="One line the orchestrator reads when picking this sub-agent" /></label>
      </div>
      <div class="cfg-checks">
        <label class="cfg-check"><input type="checkbox" data-field="write"${r.tools.write ? ' checked' : ''} /> Writes pages (knode_write / knode_commit)</label>
        <label class="cfg-check"><input type="checkbox" data-field="files"${r.tools.files ? ' checked' : ''} /> Reads files (Read / Grep / Glob)</label>
        <label class="cfg-check"><input type="checkbox" data-field="native"${r.native ? ' checked' : ''} /> Native sub-agent (pipeline: native)</label>
      </div>
      <div class="cfg-prompt">
        <div class="cfg-prompt-head"><span>Prompt</span><span class="mono">${esc(r.promptPath || '')}${r.promptIsDefault ? ' · built-in' : ''}</span><button type="button" class="ghost cfg-role-reset">Reset to built-in</button></div>
        <textarea data-field="promptText" rows="9" spellcheck="false">${esc(r.promptText || '')}</textarea>
      </div>
    </fieldset>`).join('');
}

function updateResearchNote() {
  const note = $('#cfg-research-note');
  if (!note) return;
  const p = profileDraft;
  const agentValue = $('#cfg-research-agent').value;
  // the selected option already reads the way the picker shows it
  const agentLabel = agentValue ? ($('#cfg-research-agent').selectedOptions[0]?.textContent || agentValue) : 'not configured';
  const pipeline = (p && p.pipeline) || $('#cfg-research-pipeline').value;
  const fanout = Number($('#cfg-research-researchers').value) || 1;
  const roles = p
    ? p.roles.filter((r) => r.enabled).map((r) => {
      const n = r.phase === 'research' ? (r.parallel || fanout) : 0;
      return `${r.id}${n > 1 ? ` ×${n}` : ''}${r.agent ? ` @${r.agent}` : ''}`;
    })
    : [];
  const parts = [`Agent: ${agentLabel}`, `pipeline: ${pipeline}${p && p.pipeline ? ' (pinned by profile)' : ''}`];
  const web = agentValue && !agentWebCapable(agentValue) ? 'none (built-in agent)' : p ? `${p.search.web} / ${p.search.freshness}` : null;
  if (p) parts.push(`effort: ${p.reasoning.effort}`);
  if (web) parts.push(`web: ${web}`);
  if (p) parts.push(`sources per fact: ${p.verification.minSourcesPerClaim}`);
  if (pipeline !== 'single') parts.push(`roles: ${roles.join(', ') || 'none'}`);
  const caveat = agentValue && !agentWebCapable(agentValue)
    ? ' The built-in agent has no web tool — it verifies against the knowledge base only.'
    : ' Web tools never exceed what review.external allows.';
  note.textContent = `${parts.join(' · ')}.${caveat}`;
}

function gatherResearchConfig() {
  return {
    agent: $('#cfg-research-agent').value,
    model: $('#cfg-research-model').value.trim(),
    profile: $('#cfg-research-profile').value,
    pipeline: $('#cfg-research-pipeline').value,
    concurrency: Number($('#cfg-research-concurrency').value) || 1,
    maxTurns: Number($('#cfg-research-maxturns').value) || 40,
    timeoutMs: (Number($('#cfg-research-timeout').value) || 20) * 60000,
    researchers: Number($('#cfg-research-researchers').value) || 3,
    reviewRounds: Math.max(0, Number($('#cfg-research-rounds').value) || 0),
    auto: { enabled: $('#cfg-research-auto').checked, dailyJobs: Number($('#cfg-research-daily').value) || 3 },
    init: {
      followUps: Math.max(0, Number($('#cfg-init-followups').value) || 0),
      // edited with the Extract stage under Ingest: it is how long the catch-up extraction may run
      extractionMaxMs: (Number($('#cfg-init-maxms').value) || 15) * 60000,
    },
  };
}

// The Ask tab. Model, effort and web access belong to the agent definition, and
// the turn cap, timeout and tools are the same for every agent; what is left
// here is a property of the conversation.
function fillChatForm(chat) {
  $('#cfg-chat-agent').innerHTML = agentOptions(chat.agent || '', 'The research agent, else the default provider', 'general');
  $('#cfg-chat-agent').value = chat.agent || '';
  $('#cfg-chat-history').value = chat.historyTurns ?? 12;
  $('#cfg-chat-keep').value = chat.keep ?? 200;
}

function gatherChatConfig() {
  return {
    agent: $('#cfg-chat-agent').value,
    historyTurns: Math.max(0, Number($('#cfg-chat-history').value) || 0),
    keep: Number($('#cfg-chat-keep').value) || 200,
  };
}

function gatherProfile(name) {
  const p = profileDraft;
  const roles = p.roles.map(({ promptText, promptPath, promptIsDefault, promptDefault, ...role }) => role);
  return {
    profile: {
      name: name || p.name,
      title: $('#cfg-profile-title').value.trim(),
      description: $('#cfg-profile-desc').value.trim(),
      pipeline: $('#cfg-profile-pipeline').value,
      // speed is set in the macOS app's effort chip; kept, not edited, here
      reasoning: { effort: $('#cfg-profile-effort').value, speed: p.reasoning?.speed ?? 'default' },
      search: { web: $('#cfg-profile-web').value, freshness: $('#cfg-profile-freshness').value, maxRounds: Number($('#cfg-profile-rounds').value) || 3 },
      verification: {
        minSourcesPerClaim: Number($('#cfg-profile-minsources').value) || 1,
        preferPrimarySources: $('#cfg-profile-primary').checked,
        resolveConflicts: $('#cfg-profile-conflicts').value,
      },
      stop: { maxSections: Number($('#cfg-profile-maxsections').value) || 8, marginalGain: $('#cfg-profile-marginal').checked },
      output: { citations: $('#cfg-profile-citations').checked, uncertainty: $('#cfg-profile-uncertainty').checked, evidenceTable: $('#cfg-profile-evidence').checked },
      roles,
    },
    prompts: Object.fromEntries(p.roles.map((r) => [r.id, r.promptText ?? ''])),
  };
}

async function saveResearchProfile() {
  if (!profileDraft) return null;
  const saved = await api(`/api/research/profiles/${encodeURIComponent(profileDraft.name)}`, { method: 'PUT', body: JSON.stringify(gatherProfile()) });
  profileDraft = saved;
  profileDirty = false;
  renderProfileForm();
  return saved;
}

function newRoleId(base) {
  const ids = new Set((profileDraft?.roles ?? []).map((r) => r.id));
  let id = base;
  let n = 2;
  while (ids.has(id)) id = `${base}-${n++}`;
  return id;
}

$('#cfg-research-profile').addEventListener('change', async (event) => {
  if (profileDirty && !window.confirm('Discard unsaved changes to the current profile?')) {
    event.target.value = profileDraft?.name ?? event.target.value;
    return;
  }
  try {
    await loadProfileDetail(event.target.value);
  } catch (e) {
    toast(`profile load failed: ${e.message}`);
  }
});
$('#cfg-research-agent').addEventListener('change', updateResearchNote);
$('#cfg-research-pipeline').addEventListener('change', updateResearchNote);
$('#cfg-research-researchers').addEventListener('input', updateResearchNote);

$('#cfg-profile-card').addEventListener('input', () => { profileDirty = true; });
$('#cfg-profile-card').addEventListener('change', (event) => {
  profileDirty = true;
  if (profileDraft && ['cfg-profile-effort', 'cfg-profile-web', 'cfg-profile-freshness', 'cfg-profile-pipeline', 'cfg-profile-minsources'].includes(event.target.id)) {
    const g = gatherProfile().profile;
    Object.assign(profileDraft, { pipeline: g.pipeline, reasoning: g.reasoning, search: g.search, verification: g.verification });
    updateResearchNote();
  }
});

$('#cfg-role-add').addEventListener('click', () => {
  if (!profileDraft) return;
  const phase = 'research';
  const id = newRoleId('role');
  const promptDefault = profileDraft.phaseDefaults?.[phase] ?? '';
  profileDraft.roles.push({
    id, title: 'New role', phase, enabled: true, agent: '', model: '', effort: 'default',
    tools: { write: false, files: true, web: 'inherit' }, parallel: 0, rounds: 0, maxTurns: 0, prompt: '', native: false, description: '',
    promptPath: `playbooks/research/roles/${id}.md`, promptText: promptDefault, promptIsDefault: true, promptDefault,
  });
  profileDirty = true;
  renderRoles();
  updateResearchNote();
});

// Typing edits the role draft in place; phase / native / enabled changes redraw the card.
$('#cfg-roles').addEventListener('input', (event) => {
  const field = event.target.dataset?.field;
  const card = event.target.closest('.cfg-role');
  if (!field || !card || !profileDraft) return;
  const role = profileDraft.roles[Number(card.dataset.index)];
  profileDirty = true;
  if (field === 'write' || field === 'files') role.tools[field] = event.target.checked;
  else if (field === 'web') role.tools.web = event.target.value;
  else if (field === 'enabled' || field === 'native') role[field] = event.target.checked;
  else if (['parallel', 'rounds', 'maxTurns'].includes(field)) role[field] = Math.max(0, Number(event.target.value) || 0);
  else if (field === 'promptText') {
    role.promptText = event.target.value;
    role.promptIsDefault = role.promptText.trim() === (role.promptDefault || '').trim();
  } else role[field] = event.target.value;
  if (field === 'title' || field === 'agent') updateResearchNote();
});
$('#cfg-roles').addEventListener('change', (event) => {
  const field = event.target.dataset?.field;
  const card = event.target.closest('.cfg-role');
  if (!field || !card || !profileDraft) return;
  const role = profileDraft.roles[Number(card.dataset.index)];
  if (field === 'phase') {
    const wasDefault = role.promptIsDefault || !role.promptText?.trim();
    role.phase = event.target.value;
    role.promptDefault = profileDraft.phaseDefaults?.[role.phase] ?? '';
    if (wasDefault) {
      role.promptText = role.promptDefault;
      role.promptIsDefault = true;
    }
    if (role.phase === 'synthesize' || role.phase === 'revise') role.tools.write = true;
  }
  if (['phase', 'native', 'enabled'].includes(field)) {
    renderRoles();
    updateResearchNote();
  }
});
$('#cfg-roles').addEventListener('click', (event) => {
  const card = event.target.closest('.cfg-role');
  if (!card || !profileDraft) return;
  const index = Number(card.dataset.index);
  if (event.target.classList.contains('cfg-role-remove')) {
    profileDraft.roles.splice(index, 1);
    profileDirty = true;
    renderRoles();
    updateResearchNote();
  } else if (event.target.classList.contains('cfg-role-reset')) {
    const role = profileDraft.roles[index];
    role.promptText = role.promptDefault || profileDraft.phaseDefaults?.[role.phase] || '';
    role.promptIsDefault = true;
    profileDirty = true;
    renderRoles();
  }
});

$('#cfg-profile-duplicate').addEventListener('click', async () => {
  if (!profileDraft) return;
  const name = window.prompt('Name for the new profile (letters, digits, - and _):', `${profileDraft.name}-copy`);
  if (!name) return;
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name)) {
    toast('invalid profile name');
    return;
  }
  try {
    await api(`/api/research/profiles/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(gatherProfile(name)) });
    await loadResearchProfiles(name);
    toast(`profile ${name} created — it is selected above; Save & apply makes it active`);
  } catch (e) {
    toast(`duplicate failed: ${e.message}`);
  }
});

$('#cfg-profile-delete').addEventListener('click', async () => {
  if (!profileDraft) return;
  const verb = profileDraft.builtin ? 'Reset' : 'Delete';
  if (!window.confirm(`${verb} profile "${profileDraft.name}"?${profileDraft.builtin ? ' Its file goes back to the built-in defaults.' : ''}`)) return;
  try {
    await api(`/api/research/profiles/${encodeURIComponent(profileDraft.name)}`, { method: 'DELETE' });
    await loadResearchProfiles(profileDraft.builtin ? profileDraft.name : undefined);
    toast(`profile ${verb.toLowerCase()}${verb === 'Reset' ? '' : 'd'}`);
  } catch (e) {
    toast(`${verb.toLowerCase()} failed: ${e.message}`);
  }
});

function renderCfgResult(r) {
  // same order and names as the pipeline section
  const items = [
    ['1 · Convert', r.documentLlm],
    ['2 · Index', r.embedding],
    ['3 · Extract', r.entityLlm],
    ['4 · Summarize', r.summaryLlm],
    ['5 · Judge', r.judgeLlm],
    ['6 · Translate', r.translateLlm],
  ];
  $('#cfg-status').innerHTML = items.map(([label, result]) => {
    if (!result) return '';
    if (result.ok === false) return `<div class="cfg-line bad"><b>${label}</b> · ${esc(result.error)}</div>`;
    if (!result.enabled && !label.startsWith('2 ·')) return `<div class="cfg-line warn"><b>${label}</b> · ${esc(result.note)}</div>`;
    if (label.startsWith('2 ·')) return `<div class="cfg-line good"><b>${label}</b> · ${esc(result.model)} · ${result.dimensions}d · ${result.ms}ms</div>`;
    const inherited = result.inherited ? 'inherited · ' : '';
    const sample = result.sample ? ` · replied “${esc(String(result.sample).trim())}”` : '';
    return `<div class="cfg-line good"><b>${label}</b> · ${inherited}${esc(result.model)} · ${result.ms ?? 0}ms${sample}</div>`;
  }).join('');
}

for (const prefix of ROUTE_PREFIXES) {
  $(`#cfg-${prefix}-use`).addEventListener('change', () => routeProviderToggle(prefix));
  $(`#cfg-${prefix}-model`).addEventListener('input', updateConfigSummaries);
}

$('#stage-flow').addEventListener('click', (event) => {
  const node = event.target.closest?.('.stage-node');
  if (!node) return;
  selectedStage = node.dataset.stage;
  renderStageFlow();
});

$('#cfg-embedding-use').addEventListener('change', (event) => {
  embeddingUse = event.target.value;
  $('#cfg-emb-batch').value = activeEmbedding()?.batchSize ?? 32;
  renderProviders();
  updateConfigSummaries();
});

for (const id of ['#cfg-ingest-convert', '#cfg-ingest-concurrency', '#cfg-emb-batch', '#cfg-extraction-concurrency', '#cfg-extraction-batch']) {
  $(id).addEventListener('input', renderStageFlow);
}
$('#cfg-emb-batch').addEventListener('input', (event) => {
  if (embeddingPoolDraft.enabled) {
    embeddingPoolDraft.batchSize = Number(event.target.value);
    $('#cfg-embedding-pool [data-pool="batchSize"]').value = event.target.value;
  }
});

$('#cfg-add-provider').addEventListener('click', (event) => {
  showMenuUnder(event.currentTarget, [
    { label: 'LLM · OpenAI-compatible API', run: addConnection },
    { label: 'Embedding', run: addEmbeddingProvider },
  ]);
});

/** The row a DOM event happened in, and the draft object behind it. */
function rowDraft(target) {
  const row = target.closest?.('.provider-row');
  if (!row) return null;
  const draft = providerDraft(row.dataset.id);
  return draft ? { row, draft } : null;
}

// Typing edits the draft in place; only a provider change, a removal or the
// chevron redraws, so an input never loses focus mid-edit.
$('#cfg-providers').addEventListener('input', (event) => {
  const field = event.target.dataset?.field;
  const found = rowDraft(event.target);
  if (!found) return;
  const limit = event.target.dataset?.limit;
  if (limit) {
    found.draft.limits = { ...defaultEmbeddingLimits, ...found.draft.limits, [limit]: limit === 'resetTimezone' ? event.target.value : Number(event.target.value) };
    return;
  }
  if (!field) return;
  found.draft[field] = event.target.type === 'checkbox' ? event.target.checked : ['dimensions', 'priority'].includes(field) ? Number(event.target.value) : event.target.value;
  if (field === 'label') fillRouteOptions();
  // the row's own summary column used to refresh on a label edit and never on
  // a model one, so a typed model stayed invisible until the next redraw
  if (field === 'label' || field === 'model') {
    const cell = found.row.querySelector('.provider-model');
    cell.textContent = found.draft.model || 'no model set';
    cell.title = found.draft.model || '';
  }
  updateConfigSummaries();
});

$('#cfg-providers').addEventListener('change', (event) => {
  const found = rowDraft(event.target);
  if (!found) return;
  const field = event.target.dataset?.field;
  if (field === 'enabled') { found.draft.enabled = event.target.checked; renderEmbeddingPool(); return; }
  if (field === 'sendDimensions') {
    found.draft.sendDimensions = event.target.checked;
    return;
  }
  if (field !== 'provider') return;
  found.draft.provider = event.target.value;
  // the list came from the provider that is no longer selected
  modelLists.delete(modelListKey(found.row.dataset.kind === 'embedding'
    ? { route: `embedding:${found.row.dataset.id}` }
    : { route: `connection:${found.row.dataset.id}` }));
  // an endpoint that no longer applies would otherwise be saved and tested
  if (found.row.dataset.kind === 'embedding' && found.draft.provider === 'local') {
    found.draft.baseUrl = '';
    found.draft.apiKey = '';
    found.draft.model = '';
  } else if (found.row.dataset.kind === 'llm') {
    const fields = llmProviderFields(found.draft.provider);
    if (!fields.includes('baseUrl')) found.draft.baseUrl = '';
    if (!fields.includes('apiKey')) found.draft.apiKey = '';
  }
  renderProviders();
  fillRouteOptions();
  updateConfigSummaries();
});

$('#cfg-providers').addEventListener('click', async (event) => {
  const row = event.target.closest?.('.provider-row');
  if (!row) return;
  const id = row.dataset.id;
  if (event.target.dataset.embeddingAction) {
    const draft = embeddingDrafts.find((e) => e.id === id);
    const scope = activeWorkspace()?.id;
    if (!draft) return;
    event.target.disabled = true;
    try {
      if (event.target.dataset.embeddingAction === 'models') {
        const result = await api('/api/config/models', { method: 'POST', body: JSON.stringify({ route: `embedding:${id}`, config: gatherConfig(), refresh: true }) });
        if (!result.ok) throw new Error(result.error || result.note || 'Catalog unavailable');
        if (activeWorkspace()?.id !== scope) return;
        draft.catalog = result.models.map((m) => m.id); renderProviders();
        toast('Catalog updated. Save & apply to keep it.');
      } else {
        const result = await api('/api/config/embedding-test', { method: 'POST', body: JSON.stringify({ id, config: gatherConfig() }) });
        toast(`Key test passed · ${result.dimensions} dimensions`); await refreshEmbeddingUsage();
      }
    } catch (e) { toast(e.message); }
    finally { event.target.disabled = false; }
    return;
  }

  if (event.target.classList.contains('provider-toggle')) {
    if (expandedProviders.has(id)) expandedProviders.delete(id); else expandedProviders.add(id);
    renderProviders();
    return;
  }

  if (event.target.classList.contains('provider-default')) {
    llmUse = id;
    renderProviders();
    updateConfigSummaries();
    return;
  }

  if (!event.target.classList.contains('provider-remove') || event.target.disabled) return;
  expandedProviders.delete(id);
  if (row.dataset.kind === 'embedding') {
    embeddingDrafts = embeddingDrafts.filter((e) => e.id !== id);
    // removing the active provider moves Index to the first one left, which
    // re-embeds on save — say so rather than let the corpus change quietly
    if (embeddingUse === id && embeddingDrafts[0]) {
      embeddingUse = embeddingDrafts[0].id;
      $('#cfg-status').innerHTML = `<div class="cfg-line">Index now runs on ${esc(embeddingDrafts[0].label || embeddingUse)} — saving re-embeds the corpus.</div>`;
    }
    renderProviders();
    updateConfigSummaries();
    return;
  }

  connectionDrafts = connectionDrafts.filter((c) => c.id !== id);
  // removing the default moves it to the first row left — say so, because
  // every job that names no provider of its own moves with it
  if (llmUse === id && connectionDrafts[0]) {
    llmUse = connectionDrafts[0].id;
    $('#cfg-status').innerHTML = `<div class="cfg-line">The default provider is now ${esc(connectionDrafts[0].label || llmUse)} — every job that names no provider of its own follows it.</div>`;
  }
  renderProviders();
  // a stage on the removed connection lands on the default, by name
  fillRouteOptions();
  updateConfigSummaries();
  for (const prefix of ROUTE_PREFIXES) routeProviderToggle(prefix);
});

$('#cfg-embedding-pool').addEventListener('input', (event) => {
  const field = event.target.dataset.pool;
  if (!field) return;
  embeddingPoolDraft[field] = field === 'enabled' ? event.target.checked : field === 'model' ? event.target.value : Number(event.target.value);
  if (field === 'model' && canonicalEmbeddingModel(embeddingPoolDraft.model) === 'bge-m3') embeddingPoolDraft.dimensions = 1024;
  if (field === 'batchSize') $('#cfg-emb-batch').value = embeddingPoolDraft.batchSize;
  if (field === 'enabled') $('#cfg-emb-batch').value = embeddingPoolDraft.enabled ? embeddingPoolDraft.batchSize : activeEmbedding()?.batchSize ?? 32;
  fillEmbeddingOptions(); updateConfigSummaries();
  $('#cfg-pool-members').textContent = `${poolEligibleKeys().length} compatible keys · ${embeddingDrafts.length} configured`;
  $('#cfg-embedding-pool [data-pool-action="test"]').disabled = !embeddingPoolDraft.enabled;
});

$('#cfg-embedding-pool').addEventListener('click', async (event) => {
  const action = event.target.dataset.poolAction;
  if (!action) return;
  const scope = activeWorkspace()?.id;
  const draft = gatherConfig();
  const rows = [...embeddingDrafts];
  event.target.disabled = true;
  const status = (text) => { if (activeWorkspace()?.id === scope) $('#cfg-pool-status').textContent = text; };
  try {
    if (action === 'models') {
      let count = 0; const failures = [];
      for (const row of rows.filter((e) => e.provider === 'openai')) {
        if (activeWorkspace()?.id !== scope) return;
        status(`Loading models: ${row.label}`);
        try {
          const result = await api('/api/config/models', { method: 'POST', body: JSON.stringify({ route: `embedding:${row.id}`, config: draft, refresh: true }) });
          if (!result.ok) throw new Error();
          row.catalog = result.models.map((m) => m.id); count++;
        } catch { failures.push(row.label); }
      }
      if (activeWorkspace()?.id !== scope) return;
      renderProviders(); status(`Refreshed ${count} keys. Save & apply to keep the catalog.${failures.length ? ' Unavailable: ' + failures.join(', ') : ''}`);
    } else if (action === 'test') {
      status('Testing the model pool…');
      const result = await api('/api/config/embedding-test', { method: 'POST', body: JSON.stringify({ config: draft }) });
      await refreshEmbeddingUsage(); status(`Pool test passed · ${result.dimensions} dimensions · ${result.ms} ms`);
    } else { await refreshEmbeddingUsage(); }
  } catch (error) { status(error.message); }
  finally { event.target.disabled = false; }
});

$('#cfg-embedding-local').addEventListener('input', (event) => {
  const field = event.target.dataset.embedLocal;
  if (!field) return;
  embedLocalDraft[field] = field === 'embedSlots' ? Math.max(0, Math.min(32, Number(event.target.value) || 0)) : event.target.value;
  if (['baseUrl', 'model', 'apiKey'].includes(field)) {
    embedLocalDraft.checked = null;
    $('#cfg-embed-local-status').innerHTML = embedLocalDraft.saved && embedLocalDraft.saved !== embedEndpointKey(embedLocalDraft) ? 'Changed: check it before saving.' : '';
    $('#cfg-embedding-local [data-embed-local-action="check"]').disabled = !(embedLocalDraft.baseUrl.trim() && embedLocalDraft.model.trim());
  }
});

$('#cfg-embedding-local').addEventListener('click', async (event) => {
  const action = event.target.dataset.embedLocalAction;
  if (!action) return;
  if (action === 'remove') {
    Object.assign(embedLocalDraft, { baseUrl: '', model: '', apiKey: '', checked: null });
    renderEmbeddingLocal();
    $('#cfg-embed-local-status').textContent = 'Removed. Save & apply to embed on the pool only.';
    return;
  }
  const scope = activeWorkspace()?.id;
  event.target.disabled = true;
  $('#cfg-embed-local-status').textContent = 'Embedding the 16 probe texts on the endpoint and comparing them with the pool…';
  try {
    const d = embedLocalDraft;
    const result = await api('/api/config/embedding-endpoint/check', {
      method: 'POST', body: JSON.stringify({ baseUrl: d.baseUrl.trim(), model: d.model.trim(), apiKey: d.apiKey }),
    });
    if (activeWorkspace()?.id !== scope) return;
    d.checked = { ...result, saved: d.saved === embedEndpointKey(d) && result.ok };
    // an endpoint is used by the embed slots, which run in deferred mode
    if (result.ok && d.embedding !== 'deferred') d.embedding = 'deferred';
    if (result.ok && d.embedSlots < 1) d.embedSlots = 2;
    renderEmbeddingLocal();
  } catch (error) {
    $('#cfg-embed-local-status').textContent = error.message;
    event.target.disabled = false;
  }
});

function setConfigBusy(busy) {
  $('#btn-cfg-test').disabled = busy;
  $('#btn-cfg-save').disabled = busy;
}

$('#btn-cfg-test').addEventListener('click', async () => {
  setConfigBusy(true);
  $('#cfg-status').innerHTML = '<div class="cfg-line">Testing each configured stage…</div>';
  try {
    renderCfgResult(await api('/api/config/test', { method: 'POST', body: JSON.stringify(gatherConfig()) }));
  } catch (e) {
    $('#cfg-status').innerHTML = `<div class="cfg-line bad">test failed: ${esc(e.message)}</div>`;
  } finally {
    setConfigBusy(false);
  }
});

$('#btn-cfg-save').addEventListener('click', async () => {
  const workspace = activeWorkspace();
  const workspaceId = workspace?.id;
  const selectedWorkspaceLabel = workspaceLabel(workspace);
  setConfigBusy(true);
  $('#cfg-status').innerHTML = '<div class="cfg-line">Saving routes… re-embedding if retrieval changed.</div>';
  try {
    // the agents have to be on disk before the config may name one
    let agentLine = '';
    try {
      await saveAgents();
    } catch (e) {
      agentLine = `<div class="cfg-line bad">agents not saved: ${esc(e.message)}</div>`;
    }
    const r = await api('/api/config', { method: 'PUT', body: JSON.stringify(gatherConfig()) });
    let profileLine = '';
    try {
      const saved = await saveResearchProfile();
      if (saved) profileLine = `<div class="cfg-line good">research profile <b>${esc(saved.name)}</b> saved · ${esc(saved.path)}</div>`;
    } catch (e) {
      profileLine = `<div class="cfg-line bad">research profile not saved: ${esc(e.message)}</div>`;
    }
    if (activeWorkspace()?.id !== workspaceId) {
      toast(`configuration saved for ${selectedWorkspaceLabel}`);
      return;
    }
    let html = `<div class="cfg-line good"><b>Configuration saved for ${esc(selectedWorkspaceLabel)}</b> · routes applied</div>`;
    if (r.reembedded && r.reindex) html += `<div class="cfg-line">re-embedded: ${r.reindex.indexed} docs · ${r.reindex.chunks} chunks</div>`;
    else if (r.reconverted && r.reindex) html += `<div class="cfg-line">document conversion refreshed: ${r.reindex.indexed} docs · ${r.reindex.errors} errors</div>`;
    // settings are server-wide (all but a workspace's sources): the save went to every workspace
    if (r.shared) html += `<div class="cfg-line">settings applied to every workspace on this server${r.shared.written ? ` · ${r.shared.written} other workspace${r.shared.written === 1 ? '' : 's'} updated` : ''}${r.shared.failed ? ` · <span class="bad">${r.shared.failed} could not take them (see the service log)</span>` : ''}</div>`;
    html += agentLine + profileLine;
    $('#cfg-status').innerHTML = html;
    toast(`configuration saved for ${selectedWorkspaceLabel}`);
    await loadConfigForm({ preserveStatus: true });
    loadStats();
  } catch (e) {
    $('#cfg-status').innerHTML = `<div class="cfg-line bad">save failed: ${esc(e.message)}</div>`;
  } finally {
    setConfigBusy(false);
  }
});

$('#btn-clear-workspace').addEventListener('click', () => {
  const workspace = activeWorkspace();
  $('#clear-dialog-workspace-name').textContent = workspaceLabel(workspace);
  $('#clear-workspace-error').textContent = '';
  $('#clear-workspace-confirm').value = '';
  $('#btn-confirm-clear-workspace').disabled = true;
  $('#clear-workspace-dialog').showModal();
  setTimeout(() => $('#clear-workspace-confirm').focus(), 0);
});

$('#clear-workspace-confirm').addEventListener('input', () => {
  $('#btn-confirm-clear-workspace').disabled = $('#clear-workspace-confirm').value.trim().toUpperCase() !== 'CLEAR';
});

$('#btn-cancel-clear-workspace').addEventListener('click', () => $('#clear-workspace-dialog').close());
$('#clear-workspace-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const workspace = activeWorkspace();
  if (!workspace || $('#clear-workspace-confirm').value.trim().toUpperCase() !== 'CLEAR') return;
  const button = $('#btn-confirm-clear-workspace');
  button.disabled = true;
  button.textContent = 'Clearing…';
  try {
    await api('/api/workspace', { method: 'DELETE' });
    $('#clear-workspace-dialog').close();
    loadWorkspaceData();
    toast(`${workspaceLabel(workspace)} was completely cleared`);
  } catch (error) {
    $('#clear-workspace-error').textContent = error.message;
  } finally {
    button.textContent = 'Clear workspace';
    button.disabled = $('#clear-workspace-confirm').value.trim().toUpperCase() !== 'CLEAR';
  }
});

/* --------------------------- research · studies ------------------------- */

/**
 * Studies (docs/design/15): a topic, refined into a brief the person edits,
 * then run — seed sources are captured, collectors gather material into
 * raw/docs/research/<study>/, one page per planned part is written, and a
 * report links them. The list on the left is every study of the workspace;
 * the right side is the composer, a draft's brief, or a study that ran.
 */

const STUDY_STEP_LABELS = { seed: 'Capture seed sources', collect: 'Collect material', index: 'Index what was collected', pages: 'Write the pages', report: 'Write the report' };
const STUDY_LIVE = new Set(['queued', 'running', 'validating', 'waiting']);
const study = { id: null, view: null, timer: null, options: null, busy: false, archived: false };

const lines = (v) => String(v || '').split('\n').map((x) => x.trim()).filter(Boolean);
const statusChip = (s) => `<span class="jstatus ${esc(s)}">${esc(s)}</span>`;

const PAUSE_WORDS = { quota: 'usage limit', transient: 'agent busy', setup: 'agent not set up' };

/** When a pause ends: the time today, else the day and time. */
function pauseEnd(iso) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** "paused until 01:32 · usage limit": a job that waits out a spent limit (docs/design/22), the agent's words on hover. */
function pauseChip(pause) {
  if (!pause) return '';
  const why = PAUSE_WORDS[pause.kind] ?? '';
  return `<span class="jstatus paused" title="${esc(pause.reason || '')}">paused until ${esc(pauseEnd(pause.until))}${why ? ` · ${esc(why)}` : ''}</span>`;
}

async function loadStudies() {
  await loadStudyOptions().catch((e) => toast(`research options: ${e.message}`));
  await loadStudyList();
  if (study.id) await openStudy(study.id, { quiet: true });
  else showComposer();
}

/** What the composer offers: the agents that can run here, the profiles, the sources and the web switch. */
async function loadStudyOptions() {
  const [agents, profiles, sources, config] = await Promise.all([
    api('/api/config/agents'), api('/api/research/profiles'), api('/api/research/sources'), api('/api/config'),
  ]);
  study.options = { agents: agents.agents ?? [], profiles: profiles.profiles ?? [], activeProfile: profiles.active, sources, config };
  const configured = config.research?.agent || '';
  $('#study-agent').innerHTML = [
    `<option value="">${configured ? `Research agent · ${esc(configured)}` : 'Research agent · not configured'}</option>`,
    ...study.options.agents.map((a) => `<option value="${esc(a.id)}"${a.available ? '' : ' disabled'}>${esc(a.label)}${a.available ? '' : ` — ${esc(a.reason || 'unavailable')}`}</option>`),
  ].join('');
  $('#study-profile').innerHTML = study.options.profiles.map((p) => `<option value="${esc(p.name)}"${p.name === study.options.activeProfile ? ' selected' : ''}>${esc(p.name)}${p.title && p.title !== p.name ? ` · ${esc(p.title)}` : ''}</option>`).join('');
  $('#study-dr-connection').innerHTML = (sources.connections ?? []).map((c) => `<option value="${esc(c.id)}">${esc(c.label || c.id)}${c.model ? ` · ${esc(c.model)}` : ''}</option>`).join('')
    || '<option value="">no API connection — add one under Settings → Providers & Agents</option>';
  const gate = sources.web?.gate;
  $('#study-web').disabled = gate === 'off';
  if (gate === 'off') $('#study-web').checked = false;
  $('#study-web-note').textContent = gate === 'off'
    ? '· off for this workspace (Settings → Research → Web access)'
    : `· Claude Code and Codex search with their own tools${sources.web?.search?.enabled ? `; others through ${sources.web.search.provider}` : ''}; what they cite is captured into raw/docs/research`;
  $('#study-source-list').innerHTML = (sources.sources ?? []).length
    ? sources.sources.map((s) => `<label class="cfg-check"><input type="checkbox" data-source="${esc(s.id)}"${s.enabled ? ' checked' : ''}${s.problem ? ' disabled' : ''} /> ${esc(s.title)} <span class="hint">· ${esc(s.kind)}${s.problem ? ` · ${esc(s.problem)}` : s.description ? ` · ${esc(s.description.slice(0, 90))}` : ''}</span></label>`).join('')
    : '<p class="hint">No sources of your own yet — add MCP servers, APIs or trusted sites under Settings → Sources.</p>';
}

async function loadStudyList() {
  const el = $('#study-items');
  const toggle = $('#btn-study-archived');
  toggle.setAttribute('aria-pressed', String(study.archived));
  toggle.textContent = study.archived ? '← Studies' : 'Archived';
  try {
    const rows = await api(`/api/research/studies?limit=80${study.archived ? '&archived=1' : ''}`);
    if (!rows.length) {
      el.innerHTML = study.archived
        ? '<p class="hint">Nothing archived. Archive a finished study from its page to take it off the list.</p>'
        : '<p class="hint">No studies yet. Describe a topic on the right to start one.</p>';
      return;
    }
    el.innerHTML = rows.map((r) => `<button type="button" class="study-item${r.id === study.id ? ' active' : ''}" data-study="${esc(r.id)}">
        <span class="study-item-title">${esc(r.title || r.topic)}</span>
        <span class="study-item-meta">${r.pause ? pauseChip(r.pause) : statusChip(r.status)} <span class="hint">${esc(r.stage)} · ${esc(new Date(r.createdAt).toLocaleDateString())}${r.pages ? ` · ${r.pages} pages` : ''}</span></span>
      </button>`).join('');
    el.querySelectorAll('[data-study]').forEach((b) => b.addEventListener('click', () => openStudy(b.dataset.study)));
  } catch (e) {
    el.innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
  }
}

function stopStudyPolling() {
  clearTimeout(study.timer);
  study.timer = null;
}

function showComposer() {
  stopStudyPolling();
  study.id = null;
  study.view = null;
  $('#study-compose').hidden = false;
  $('#study-detail').hidden = true;
  document.querySelectorAll('.study-item.active').forEach((b) => b.classList.remove('active'));
}

$('#btn-study-new').addEventListener('click', () => {
  showComposer();
  $('#study-topic').focus();
});
$('#btn-study-archived').addEventListener('click', () => {
  study.archived = !study.archived;
  loadStudyList();
});
$('#study-mode').addEventListener('change', () => {
  const deep = $('#study-mode').value === 'deep-research';
  document.querySelectorAll('#study-compose [data-deep]').forEach((el) => { el.hidden = !deep; });
});

function composeRunner() {
  const deep = $('#study-mode').value === 'deep-research';
  return {
    agent: $('#study-agent').value, model: $('#study-model').value.trim(), profile: $('#study-profile').value,
    mode: deep ? 'deep-research' : 'agent',
    deepResearch: deep ? { connection: $('#study-dr-connection').value, model: $('#study-dr-model').value.trim() || 'o3-deep-research' } : null,
  };
}

$('#btn-study-refine').addEventListener('click', async () => {
  const topic = $('#study-topic').value.trim();
  if (topic.length < 8) return toast('describe what you want to research first');
  const button = $('#btn-study-refine');
  button.disabled = true;
  $('#study-compose-note').textContent = 'refining — the model reads the topic and what the knowledge base holds (up to a minute or two on a CLI)…';
  try {
    const sources = { web: $('#study-web').checked, ids: [...document.querySelectorAll('#study-source-list input[data-source]:checked')].map((i) => i.dataset.source) };
    const view = await api('/api/research/studies', { method: 'POST', body: JSON.stringify({ topic, runner: composeRunner(), sources }) });
    $('#study-topic').value = '';
    $('#study-compose-note').textContent = '';
    study.id = view.job.id;
    await loadStudyList();
    await openStudy(view.job.id);
  } catch (e) {
    $('#study-compose-note').textContent = `could not start: ${e.message}`;
  } finally {
    button.disabled = false;
  }
});

async function openStudy(id, opts = {}) {
  stopStudyPolling();
  study.id = id;
  document.querySelectorAll('.study-item').forEach((b) => b.classList.toggle('active', b.dataset.study === id));
  try {
    const view = await api(`/api/research/studies/${encodeURIComponent(id)}`);
    study.view = view;
    $('#study-compose').hidden = true;
    $('#study-detail').hidden = false;
    if (view.job.status === 'draft' && view.refining) renderRefining(view);
    else if (view.job.status === 'draft') renderDraft(view);
    else renderStudy(view);
    if (STUDY_LIVE.has(view.job.status) || view.refining) {
      study.timer = setTimeout(() => {
        if (currentTab === 'studies' && study.id === id && !study.busy) openStudy(id, { quiet: true }).then(() => loadStudyList());
      }, view.refining ? 2500 : 4000);
    }
  } catch (e) {
    if (!opts.quiet) toast(`study: ${e.message}`);
  }
}

/* ---- a draft: the brief, editable ---- */

/** The refiner is at work (a CLI one-shot can take a minute or two): the request, and what it is doing. */
function renderRefining(view) {
  const p = view.payload;
  const runner = p.runner.agent || 'the research agent';
  $('#study-detail').innerHTML = `<div class="study-card">
    <p class="section-index">DRAFT · ${esc(view.job.id)}</p>
    <h3 class="study-title">Refining the question…</h3>
    <p class="hint">The refiner reads your request, what this knowledge base already holds about it and the sources you picked, and plans the questions, the pages and the sources to start from${p.refinements.length ? ' — with your answers and edits' : ''}. It runs on the default model, else on ${esc(runner)}, once; nothing is searched or fetched yet. Since ${esc(new Date(view.refining).toLocaleTimeString())}.</p>
    <div class="study-progress"><span></span></div>
    <details class="study-topic" open><summary>Your request</summary><p>${esc(p.topic)}</p></details>
  </div>`;
}

function renderDraft(view) {
  const b = view.payload.brief;
  const last = view.payload.refinements[view.payload.refinements.length - 1];
  const el = $('#study-detail');
  const questionOf = (id) => b.questions.find((q) => q.id === id);
  el.innerHTML = `<div class="study-card">
    <div class="study-head">
      <div><p class="section-index">DRAFT · ${esc(view.job.id)}</p>
        <input class="study-title-input" data-f="title" value="${esc(b.title)}" />
        <p class="hint">${last ? `refined by ${esc(last.refiner)} in ${Math.round((last.ms || 0) / 1000)} s${last.error ? ` — <span class="jerr-inline">${esc(last.error)}</span>` : ''}` : 'not refined yet'} · folder <span class="mono">raw/docs/research/${esc(b.slug)}/</span> · pages under <span class="mono">wiki/research/${esc(b.slug)}/</span></p>
      </div>
      <div class="study-head-actions"><button type="button" data-act="delete" class="ghost">Delete draft</button></div>
    </div>
    <details class="study-topic"><summary>Your request</summary><p>${esc(view.payload.topic)}</p></details>
    <div class="cfg-grid study-form">
      <label>Objective<textarea data-f="objective" rows="3">${esc(b.objective)}</textarea></label>
      ${b.restatement ? `<p class="study-restatement"><b>As the refiner reads it:</b> ${esc(b.restatement)}</p>` : ''}
      <div class="cfg-grid cfg-grid-3">
        <label>In scope (one per line)<textarea data-f="include" rows="3">${esc(b.scope.include.join('\n'))}</textarea></label>
        <label>Out of scope<textarea data-f="exclude" rows="3">${esc(b.scope.exclude.join('\n'))}</textarea></label>
        <div class="cfg-grid"><label>Time frame<input data-f="timeframe" value="${esc(b.scope.timeframe)}" /></label>
          <label>Write in<select data-f="language">${[['en', 'English'], ['zh', '中文']].map(([v, l]) => `<option value="${v}"${b.language.startsWith(v) ? ' selected' : ''}>${l}</option>`).join('')}</select></label></div>
      </div>
    </div>
    ${b.clarifications.length ? `<div class="study-block"><h4>Questions for you</h4>${b.clarifications.map((c, i) => `<div class="study-clar" data-clar="${i}">
        <p>${esc(c.question)}</p>
        <div class="study-chips">${c.options.map((o) => `<button type="button" class="chat-chip" data-pick="${esc(o)}">${esc(o)}</button>`).join('')}</div>
        <input data-answer placeholder="your answer" value="${esc(c.answer || '')}" />
      </div>`).join('')}</div>` : ''}
    <div class="study-block"><h4>Pages <span class="hint">· one job each, plus a report that links them</span></h4>
      <div id="study-pages">${b.pages.map((p) => pageEditor(p, p.questions.map(questionOf).filter(Boolean))).join('')}</div>
      <button type="button" data-act="add-page">＋ Page</button>
    </div>
    <div class="study-block"><h4>Start from these sources <span class="hint">· captured before the agents start; one per line, “URL — why”</span></h4>
      <textarea data-f="seeds" rows="3">${esc(b.seedUrls.map((u) => `${u.url}${u.why ? ` — ${u.why}` : ''}`).join('\n'))}</textarea>
    </div>
    <div class="study-block study-refine">
      <h4>Refine again</h4>
      <textarea data-f="feedback" rows="2" placeholder="What should change? — e.g. “focus on 2025–2026”, “add Chinese competitors”, “one page on compute costs”"></textarea>
      <div class="study-actions">
        <button type="button" data-act="refine">↻ Refine with my answers and edits</button>
        <button type="button" data-act="save">Save edits</button>
        <button type="button" data-act="start" class="primary">▶ Start research</button>
        <span class="hint" data-note>${view.startProblem ? `cannot start yet: ${esc(view.startProblem)}` : `${b.pages.length} pages · ${b.questions.length} questions · ${view.payload.runner.mode === 'deep-research' ? `deep research on ${esc(view.payload.runner.deepResearch?.model || '?')}` : `runs on ${esc(view.payload.runner.agent || 'the research agent')}`} · web ${view.payload.sources.web ? 'on' : 'off'}`}</span>
      </div>
    </div>
  </div>`;
  el.querySelectorAll('[data-pick]').forEach((b2) => b2.addEventListener('click', () => {
    b2.closest('.study-clar').querySelector('[data-answer]').value = b2.dataset.pick;
  }));
  el.querySelector('[data-act="add-page"]').addEventListener('click', () => {
    $('#study-pages').insertAdjacentHTML('beforeend', pageEditor({ id: '', title: '', purpose: '', sections: [], charts: [] }, [{ id: '', text: '' }]));
    wirePageEditors();
  });
  wirePageEditors();
  const note = el.querySelector('[data-note]');
  const run = async (what, fn) => {
    study.busy = true;
    el.querySelectorAll('[data-act]').forEach((b2) => { b2.disabled = true; });
    note.textContent = what;
    try {
      await fn();
    } catch (e) {
      note.textContent = e.message;
      toast(e.message, 5000);
    } finally {
      study.busy = false;
      el.querySelectorAll('[data-act]').forEach((b2) => { b2.disabled = false; });
    }
  };
  el.querySelector('[data-act="refine"]').addEventListener('click', () => run('refining…', async () => {
    await api(`/api/research/studies/${view.job.id}/refine`, { method: 'POST', body: JSON.stringify({ brief: gatherBrief(view), answers: gatherAnswers(), feedback: el.querySelector('[data-f="feedback"]').value.trim() }) });
    study.busy = false;
    await openStudy(view.job.id);
  }));
  el.querySelector('[data-act="save"]').addEventListener('click', () => run('saving…', async () => {
    renderDraft(await api(`/api/research/studies/${view.job.id}`, { method: 'PUT', body: JSON.stringify({ brief: gatherBrief(view) }) }));
    toast('brief saved');
    loadStudyList();
  }));
  const hint = note.textContent;
  el.querySelector('[data-act="start"]').addEventListener('click', () => run('saving…', async () => {
    // saved first, so the estimate reads the brief as it stands now
    await api(`/api/research/studies/${view.job.id}`, { method: 'PUT', body: JSON.stringify({ brief: gatherBrief(view) }) });
    note.textContent = hint;
    openEstimate({
      title: 'Start research?',
      lede: `${b.pages.length} page${b.pages.length === 1 ? '' : 's'} and a report: a collector gathers each page's sources, an agent writes each page, then the report — measured against the studies run here before.`,
      url: `/api/research/studies/${view.job.id}/estimate`,
      confirm: '▶ Start research',
      run: async () => {
        await api(`/api/research/studies/${view.job.id}/start`, { method: 'POST' });
        toast('research started');
        await loadStudyList();
        await openStudy(view.job.id);
      },
    });
  }));
  el.querySelector('[data-act="delete"]').addEventListener('click', () => run('deleting…', async () => {
    if (!confirm('Delete this draft?')) return;
    await api(`/api/research/studies/${view.job.id}`, { method: 'DELETE' });
    showComposer();
    loadStudyList();
  }));
}

function pageEditor(p, questions) {
  return `<div class="study-page" data-page="${esc(p.id)}" data-slug="${esc(p.slug || '')}">
    <div class="study-page-head"><input data-pf="title" value="${esc(p.title)}" placeholder="Page title" /><button type="button" class="ghost" data-remove-page title="remove this page">✕</button></div>
    <textarea data-pf="purpose" rows="2" placeholder="What this page answers">${esc(p.purpose || '')}</textarea>
    <div class="cfg-grid cfg-grid-2">
      <label>Questions<div class="study-questions">${questions.map((q) => questionRow(q)).join('')}</div><button type="button" class="ghost" data-add-q>＋ question</button></label>
      <label>Sections (one per line)<textarea data-pf="sections" rows="5">${esc((p.sections || []).map((s) => s.replace(/^##\s*/, '')).join('\n'))}</textarea>
        <span class="hint">Charts it should carry</span><textarea data-pf="charts" rows="2">${esc((p.charts || []).join('\n'))}</textarea></label>
    </div>
  </div>`;
}

function questionRow(q) {
  return `<div class="study-q" data-q="${esc(q.id || '')}"><textarea rows="2" data-qtext>${esc(q.text || '')}</textarea><button type="button" class="ghost" data-remove-q title="remove">✕</button></div>`;
}

function wirePageEditors() {
  document.querySelectorAll('#study-pages .study-page').forEach((page) => {
    if (page.dataset.wired) return;
    page.dataset.wired = '1';
    page.querySelector('[data-remove-page]').addEventListener('click', () => page.remove());
    page.querySelector('[data-add-q]').addEventListener('click', (ev) => {
      ev.preventDefault();
      page.querySelector('.study-questions').insertAdjacentHTML('beforeend', questionRow({}));
      wireQuestionRows(page);
    });
    wireQuestionRows(page);
  });
}

function wireQuestionRows(page) {
  page.querySelectorAll('[data-remove-q]').forEach((b) => {
    if (b.dataset.wired) return;
    b.dataset.wired = '1';
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      b.closest('.study-q').remove();
    });
  });
}

function gatherAnswers() {
  const out = {};
  const b = study.view?.payload.brief;
  document.querySelectorAll('#study-detail [data-clar]').forEach((el) => {
    const c = b?.clarifications[Number(el.dataset.clar)];
    const a = el.querySelector('[data-answer]').value.trim();
    if (c && a) out[c.question] = a;
  });
  return out;
}

/** The brief as the person left it on screen; the server normalizes it again. */
function gatherBrief(view) {
  const b = view.payload.brief;
  const root = $('#study-detail');
  const f = (name) => root.querySelector(`[data-f="${name}"]`)?.value ?? '';
  const answers = gatherAnswers();
  const pages = [];
  const questions = [];
  root.querySelectorAll('#study-pages .study-page').forEach((el, i) => {
    const title = el.querySelector('[data-pf="title"]').value.trim();
    if (!title) return;
    const id = `p${pages.length + 1}`;
    const prior = b.pages.find((p) => p.id === el.dataset.page);
    const qids = [];
    el.querySelectorAll('.study-q').forEach((row) => {
      const text = row.querySelector('[data-qtext]').value.trim();
      if (!text) return;
      const old = b.questions.find((q) => q.id === row.dataset.q);
      const qid = `q${questions.length + 1}`;
      questions.push({ id: qid, text, why: old?.why ?? '', page: id, queries: old?.queries ?? [] });
      qids.push(qid);
    });
    pages.push({
      id, title, slug: el.dataset.slug || '', purpose: el.querySelector('[data-pf="purpose"]').value.trim(),
      sections: lines(el.querySelector('[data-pf="sections"]').value).map((s) => `## ${s.replace(/^#+\s*/, '')}`),
      questions: qids, charts: lines(el.querySelector('[data-pf="charts"]').value), entities: prior?.entities ?? [],
    });
    void i;
  });
  return {
    ...b,
    title: f('title').trim() || b.title,
    objective: f('objective').trim(),
    language: f('language') || b.language,
    scope: { ...b.scope, include: lines(f('include')), exclude: lines(f('exclude')), timeframe: f('timeframe').trim() },
    clarifications: b.clarifications.map((c) => ({ ...c, ...(answers[c.question] ? { answer: answers[c.question] } : {}) })),
    pages,
    questions,
    seedUrls: lines(f('seeds')).map((l) => {
      const [url, ...why] = l.split(/\s+[—–-]\s+/);
      return { url: url.trim(), why: why.join(' — ').trim() };
    }).filter((u) => /^https?:\/\//i.test(u.url)),
  };
}

/* ---- a study that runs or ran ---- */

/** What a Promote changed, as the person reads it: "Pages and report: 7 now trusted · 1 not indexed yet". */
function promotionSummary(what, r) {
  const parts = [
    r.changed.length ? `${r.changed.length} now ${r.to}` : '',
    r.unchanged.length ? `${r.unchanged.length} already ${r.to}` : '',
    r.notIndexed.length ? `${r.notIndexed.length} not indexed yet — try again in a moment` : '',
    r.failed.length ? `${r.failed.length} failed: ${r.failed[0].error}` : '',
  ].filter(Boolean);
  return `${what === 'pages' ? 'Pages and report' : 'Sources'}: ${parts.join(' · ') || 'nothing to promote'}`;
}

/** How a study's source files (captures, notes, register) stand: "61 files quarantined", "2 files not indexed yet" or "all trusted". */
function sourcesTier(t) {
  if (t.quarantined) return `${t.quarantined} files quarantined (captures, notes, register)`;
  return t.unindexed ? `${t.unindexed} files not indexed yet` : 'all trusted';
}

function renderStudy(view) {
  const { job, payload: p } = view;
  const live = STUDY_LIVE.has(job.status);
  const el = $('#study-detail');
  const runner = p.runner.mode === 'deep-research'
    ? `deep research · ${esc(p.runner.deepResearch?.model || '?')}, pages by ${esc(job.agent || p.runner.agent || 'the research agent')}`
    : `${esc(job.agent || p.runner.agent || 'the research agent')}${job.model ? ` · ${esc(job.model)}` : ''}`;
  const trustChip = (t) => (t ? `<span class="trust ${esc(t)}">${esc(t)}</span>` : '');
  const none = { trusted: 0, quarantined: 0, unindexed: 0 };
  const tiers = { pages: view.tiers?.pages ?? none, sources: view.tiers?.sources ?? none };
  el.innerHTML = `<div class="study-card">
    <div class="study-head">
      <div><p class="section-index">STUDY · ${esc(job.id)}</p><h3 class="study-title">${esc(p.brief.title)}</h3>
        <p class="hint">${statusChip(job.status)} ${esc(p.stage)} · ${runner} · web ${p.sources.web ? 'on' : 'off'}${job.startedAt ? ` · started ${esc(new Date(job.startedAt).toLocaleString())}` : ''}${job.finishedAt ? ` · finished ${esc(new Date(job.finishedAt).toLocaleString())}` : ''}${view.archivedAt ? ` · archived ${esc(new Date(view.archivedAt).toLocaleDateString())}` : ''}</p>
        ${view.pause ? `<p class="hint">${pauseChip(view.pause)} — it goes on by itself then, from where it stopped. <span class="mono">${esc(view.pause.reason)}</span></p>` : job.error ? `<p class="jerr">${esc(job.error)}</p>` : ''}
      </div>
      <div class="study-head-actions">
        ${view.pause ? '<button type="button" data-act="resume" title="the limit is lifted: run it now instead of when the pause ends">Resume now</button>' : ''}
        ${live ? '<button type="button" data-act="cancel">Cancel</button>' : ''}
        ${job.status === 'failed' || job.status === 'cancelled' ? '<button type="button" data-act="retry">Retry</button>' : ''}
        ${!live && !view.archivedAt ? '<button type="button" data-act="archive" title="take it off the list; its report, pages and sources stay where they are">Archive</button>' : ''}
        ${view.archivedAt ? '<button type="button" data-act="unarchive">Unarchive</button>' : ''}
        ${job.status === 'failed' || job.status === 'cancelled' ? '<button type="button" data-act="remove" title="remove the study\'s jobs and session logs; what it wrote into the knowledge base stays">Remove</button>' : ''}
        ${tiers.pages.quarantined ? `<button type="button" data-act="promote-pages" title="mark the pages and the report trusted: their facts become the knowledge base's position">Promote pages (${tiers.pages.quarantined})</button>` : ''}
        ${tiers.sources.quarantined ? `<button type="button" data-act="promote-sources" title="mark the captured sources, the notes and the register trusted">Promote sources (${tiers.sources.quarantined})</button>` : ''}
        ${view.reportExists || view.pages.some((pg) => pg.status === 'done') ? `<a class="study-link" href="${esc(studyExportHref(job.id))}" target="_blank" rel="noopener" title="the report and its pages as one HTML file, its charts as figures: read it, save it, or print it to PDF">Export ↗</a>` : ''}
      </div>
    </div>
    <ol class="init-steps study-steps">${p.steps.map((s) => `<li data-status="${esc(s.status)}"><b>${esc(STUDY_STEP_LABELS[s.name] || s.name)}</b><span>${esc(s.detail || s.status)}</span></li>`).join('')}</ol>
    <div class="study-block"><h4>Report</h4>
      ${view.reportExists ? `<div class="rpage"><span><a href="#" data-open="${esc(view.reportPath)}">${esc(p.brief.report.title)}</a> <span class="hint mono">${esc(view.reportPath)}</span></span>${trustChip(view.reportTrust)}<span></span></div>` : `<p class="hint">${esc(view.reportPath)} — written once the pages are done.</p>`}
    </div>
    <div class="study-block"><h4>Pages</h4>
      ${view.pages.map((pg) => `<div class="rpage"><span>${pg.status === 'done' ? `<a href="#" data-open="${esc(pg.path)}">${esc(pg.title)}</a>` : esc(pg.title)} <span class="hint mono">${esc(pg.path.split('/').pop())}${pg.warnings.length ? ` · ${pg.warnings.length} warnings` : ''}</span>${pg.error ? `<span class="jerr">${esc(pg.error.slice(0, 300))}</span>` : ''}</span>${trustChip(pg.trust)}${pg.pause ? pauseChip(pg.pause) : statusChip(pg.status)}</div>`).join('')}
    </div>
    <div class="study-block"><h4>Sources <span class="hint">· ${view.captures.length} captured into the knowledge base${view.captures.length ? ` · ${sourcesTier(tiers.sources)}` : ''} · register ${pageLink(view.registerPath)}</span></h4>
      ${view.captures.length ? `<table class="study-table"><thead><tr><th>Title</th><th>Site</th><th>Published</th><th>Type</th><th>File</th></tr></thead><tbody>${view.captures.map((c) => `<tr>
        <td>${/^https?:\/\//i.test(c.url || '') ? `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.title || c.url)}</a>` : esc(c.title || c.url || '')}${c.why ? `<div class="hint">${esc(c.why)}</div>` : ''}</td>
        <td>${esc(c.site)}</td><td class="mono">${esc(c.published || '—')}</td><td>${esc(c.kind)}</td><td>${pageLink(c.path)}${hasOriginal(c.path) ? ` <a href="${esc(originalHref(c.path))}" target="_blank" rel="noopener" class="hint" title="the file itself, as it was captured">original ↗</a>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">nothing captured yet.</p>'}
      ${view.notes.length ? `<p class="hint">Collector notes: ${view.notes.map((n) => pageLink(n)).join(' · ')}</p>` : ''}
    </div>
    <details class="study-block"><summary>The brief</summary>
      <p>${esc(p.brief.objective)}</p>
      ${p.brief.pages.map((pg) => `<p><b>${esc(pg.title)}</b></p><ul>${pg.questions.map((qid) => p.brief.questions.find((q) => q.id === qid)).filter(Boolean).map((q) => `<li>${esc(q.text)}</li>`).join('')}</ul>`).join('')}
      <p class="hint">Request: ${esc(p.topic)}</p>
    </details>
    <details class="study-block" data-logs><summary>Session logs</summary><div class="study-actions" data-log-buttons><span class="hint">loading…</span></div><pre class="mono study-log" hidden></pre></details>
  </div>`;
  wireOpenLinks(el);
  const act = async (what, fn) => {
    try {
      await fn();
    } catch (e) {
      toast(`${what}: ${e.message}`, 5000);
    }
  };
  el.querySelector('[data-act="cancel"]')?.addEventListener('click', () => act('cancel', async () => {
    if (!confirm('Cancel this study and the pages it has not written yet?')) return;
    await api(`/api/research/studies/${job.id}/cancel`, { method: 'POST' });
    openStudy(job.id);
    loadStudyList();
  }));
  el.querySelector('[data-act="retry"]')?.addEventListener('click', () => act('retry', async () => {
    await api(`/api/research/studies/${job.id}/retry`, { method: 'POST' });
    openStudy(job.id);
    loadStudyList();
  }));
  for (const verb of ['resume', 'archive', 'unarchive']) {
    el.querySelector(`[data-act="${verb}"]`)?.addEventListener('click', () => act(verb, async () => {
      await api(`/api/research/studies/${job.id}/${verb}`, { method: 'POST' });
      if (verb === 'archive') toast('Archived — the Archived list keeps it');
      openStudy(job.id);
      loadStudyList();
    }));
  }
  el.querySelector('[data-act="remove"]')?.addEventListener('click', () => act('remove', async () => {
    if (!confirm('Remove this study? Its jobs and session logs go; the pages, notes and sources it already wrote stay in the knowledge base.')) return;
    const r = await api(`/api/research/studies/${job.id}`, { method: 'DELETE' });
    toast(r.kept?.length ? `Removed — kept in the knowledge base: ${r.kept.length} file(s) and folders` : 'Removed', 4000);
    showComposer();
    loadStudyList();
  }));
  for (const [sel, what] of [['[data-act="promote-pages"]', 'pages'], ['[data-act="promote-sources"]', 'sources']]) {
    el.querySelector(sel)?.addEventListener('click', () => act('promote', async () => {
      const r = await api(`/api/research/studies/${job.id}/promote`, { method: 'POST', body: JSON.stringify({ what }) });
      toast(promotionSummary(what, r), r.failed.length || r.notIndexed.length ? 6000 : 3000);
      openStudy(job.id);
    }));
  }
  el.querySelector('[data-logs]').addEventListener('toggle', async (ev) => {
    if (!ev.target.open) return;
    const box = el.querySelector('[data-log-buttons]');
    try {
      const { labels } = await api(`/api/research/studies/${job.id}/log?label=agent`);
      const all = [...labels, 'agent'];
      box.innerHTML = all.map((l) => `<button type="button" data-log="${esc(l)}">${esc(l === 'agent' ? 'report' : l)}</button>`).join('');
      box.querySelectorAll('[data-log]').forEach((b) => b.addEventListener('click', async () => {
        const r = await api(`/api/research/studies/${job.id}/log?label=${encodeURIComponent(b.dataset.log)}`);
        const pre = el.querySelector('.study-log');
        pre.hidden = false;
        pre.textContent = r.log ?? '(no transcript yet)';
      }));
    } catch (e) {
      box.textContent = e.message;
    }
  });
}

/* --------------------------- research · sources ------------------------- */

/** The web settings and the research sources (playbooks/research/sources). Saving either is an administrator's call. */
let sourceDrafts = null;

async function loadSources() {
  try {
    const [data, config] = await Promise.all([api('/api/research/sources'), api('/api/config')]);
    sourceDrafts = data;
    const web = config.research?.web ?? {};
    $('#web-search-provider').value = web.search?.provider ?? '';
    $('#web-search-base').value = web.search?.baseUrl ?? '';
    $('#web-search-key').value = web.search?.apiKey ?? '';
    $('#web-user-agent').value = web.userAgent ?? '';
    $('#web-proxy').value = web.proxy ?? '';
    $('#web-private').checked = Boolean(web.allowPrivateHosts);
    const gate = data.web.gate;
    $('#web-gate-note').textContent = `${gate === 'off' ? 'Web access is off for this workspace' : gate === 'research' ? 'Every research job may use the web' : 'Studies may use the web when you tick it; other jobs only verify'} (Settings → Research → Web access). Claude Code and Codex search with their own tools; the search API below is for the built-in agent and Cursor, through knode_web_search. Proxy: ${data.web.proxy}.`;
    renderSourceList();
  } catch (e) {
    $('#source-items').innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
  }
}

function renderSourceList() {
  const el = $('#source-items');
  const list = sourceDrafts?.sources ?? [];
  if (!list.length) {
    el.innerHTML = '<p class="hint">No sources yet. An MCP server (a filings database, a market-data vendor), a JSON API with its endpoints, a list of trusted sites, or one of the live datasources.</p>';
    return;
  }
  el.innerHTML = list.map((s) => `<div class="rpage"><span><b>${esc(s.title)}</b> <span class="mono hint">${esc(s.id)}</span> <span class="hint">· ${esc(s.kind)}${s.description ? ` · ${esc(s.description)}` : ''}</span>${s.problem ? `<span class="jerr">${esc(s.problem)}</span>` : ''}</span>
      <span class="trust ${s.enabled ? 'trusted' : ''}">${s.enabled ? 'on by default' : 'off by default'}</span>
      <span class="ractions"><button type="button" data-edit="${esc(s.id)}">edit</button><button type="button" data-del="${esc(s.id)}">delete</button></span></div>`).join('');
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editSource(list.find((s) => s.id === b.dataset.edit))));
  el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Delete source ${b.dataset.del}?`)) return;
    try {
      await api(`/api/research/sources/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
      loadSources();
    } catch (e) {
      toast(e.message, 5000);
    }
  }));
}

const kv = (obj, sep) => Object.entries(obj || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');
const parseKv = (text, sep) => Object.fromEntries(lines(text).map((l) => {
  const at = l.indexOf(sep);
  return at > 0 ? [l.slice(0, at).trim(), l.slice(at + sep.length).trim()] : [l, ''];
}));

function editSource(s) {
  const src = s ?? { id: '', title: '', kind: 'site', description: '', enabled: true, url: '', headers: {}, command: '', args: [], env: {}, tools: [], endpoints: [], domains: [], urls: [], datasource: '' };
  const el = $('#source-editor');
  el.hidden = false;
  el.innerHTML = `<div class="study-source-editor">
    <div class="cfg-grid cfg-grid-3 study-form">
      <label>Id<input data-s="id" value="${esc(src.id)}" ${s ? 'disabled' : ''} placeholder="sec-edgar" /></label>
      <label>Title<input data-s="title" value="${esc(src.title)}" /></label>
      <label>Kind<select data-s="kind">${['site', 'api', 'mcp', 'datasource'].map((k) => `<option value="${k}"${k === src.kind ? ' selected' : ''}>${{ site: 'Trusted sites', api: 'JSON API', mcp: 'MCP server', datasource: 'Live datasource' }[k]}</option>`).join('')}</select></label>
    </div>
    <label class="study-wide">What it holds and when to use it (the agent reads this)<textarea data-s="description" rows="2">${esc(src.description)}</textarea></label>
    <label class="cfg-check study-check"><input data-s="enabled" type="checkbox"${src.enabled ? ' checked' : ''} /> Selected for new studies</label>
    <div data-kind="site" class="cfg-grid cfg-grid-2 study-form">
      <label>Domains (one per line)<textarea data-s="domains" rows="3">${esc(src.domains.join('\n'))}</textarea></label>
      <label>Seed URLs, captured at the start (one per line)<textarea data-s="urls" rows="3">${esc(src.urls.join('\n'))}</textarea></label>
    </div>
    <div data-kind="api" class="cfg-grid study-form">
      <label>Base URL<input data-s="api-url" value="${esc(src.kind === 'api' ? src.url : '')}" placeholder="https://data.example.com/v1" /></label>
      <label>Headers (Name: value, one per line; values may be env:VAR)<textarea data-s="api-headers" rows="2">${esc(src.kind === 'api' ? kv(src.headers, ': ') : '')}</textarea></label>
      <label>Endpoints (JSON: [{"name","path","description","params":[{"name","in":"query|path","required"}],"resultPath"}])<textarea data-s="endpoints" rows="6" class="mono">${esc(JSON.stringify(src.endpoints, null, 2))}</textarea></label>
    </div>
    <div data-kind="mcp" class="cfg-grid study-form">
      <label>URL (Streamable HTTP) — or leave empty and give a command<input data-s="mcp-url" value="${esc(src.kind === 'mcp' ? src.url : '')}" placeholder="https://mcp.example.com/mcp" /></label>
      <label>Headers (Name: value)<textarea data-s="mcp-headers" rows="2">${esc(src.kind === 'mcp' ? kv(src.headers, ': ') : '')}</textarea></label>
      <div class="cfg-grid cfg-grid-2"><label>Command (a local process)<input data-s="command" value="${esc(src.command)}" placeholder="npx" /></label>
        <label>Arguments (one per line)<textarea data-s="args" rows="2">${esc(src.args.join('\n'))}</textarea></label></div>
      <label>Environment (NAME=value, one per line)<textarea data-s="env" rows="2">${esc(kv(src.env, '='))}</textarea></label>
      <label>Only these tools (one per line; empty = all)<textarea data-s="tools" rows="2">${esc(src.tools.join('\n'))}</textarea></label>
    </div>
    <div data-kind="datasource" class="study-form">
      <label>Datasource<select data-s="datasource">${(sourceDrafts?.datasources ?? []).map((d) => `<option value="${esc(d.id)}"${d.id === src.datasource ? ' selected' : ''}>${esc(d.id)} · ${esc(d.kind)}</option>`).join('') || '<option value="">no datasources in knode.config.json</option>'}</select></label>
    </div>
    <div class="study-actions"><button type="button" class="primary" data-save>Save source</button><button type="button" class="ghost" data-close>Close</button><span class="hint" data-note></span></div>
  </div>`;
  const kindOf = () => el.querySelector('[data-s="kind"]').value;
  const showKind = () => el.querySelectorAll('[data-kind]').forEach((d) => { d.hidden = d.dataset.kind !== kindOf(); });
  el.querySelector('[data-s="kind"]').addEventListener('change', showKind);
  showKind();
  el.querySelector('[data-close]').addEventListener('click', () => { el.hidden = true; });
  el.querySelector('[data-save]').addEventListener('click', async () => {
    const v = (k) => el.querySelector(`[data-s="${k}"]`).value;
    const kind = kindOf();
    const id = (s?.id ?? v('id')).trim();
    if (!id) return toast('give the source an id');
    const body = { title: v('title').trim() || id, kind, description: v('description').trim(), enabled: el.querySelector('[data-s="enabled"]').checked };
    try {
      if (kind === 'site') Object.assign(body, { domains: lines(v('domains')), urls: lines(v('urls')) });
      if (kind === 'api') Object.assign(body, { url: v('api-url').trim(), headers: parseKv(v('api-headers'), ':'), endpoints: JSON.parse(v('endpoints') || '[]') });
      if (kind === 'mcp') Object.assign(body, { url: v('mcp-url').trim(), headers: parseKv(v('mcp-headers'), ':'), command: v('command').trim(), args: lines(v('args')), env: parseKv(v('env'), '='), tools: lines(v('tools')) });
      if (kind === 'datasource') Object.assign(body, { datasource: v('datasource') });
      await api(`/api/research/sources/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
      toast(`source ${id} saved`);
      el.hidden = true;
      loadSources();
    } catch (e) {
      el.querySelector('[data-note]').textContent = e.message;
    }
  });
}

$('#btn-source-new').addEventListener('click', () => editSource(null));
$('#btn-web-save').addEventListener('click', async () => {
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify({ research: { web: {
      search: { provider: $('#web-search-provider').value, baseUrl: $('#web-search-base').value.trim(), apiKey: $('#web-search-key').value.trim() },
      userAgent: $('#web-user-agent').value.trim(), proxy: $('#web-proxy').value.trim(), allowPrivateHosts: $('#web-private').checked,
    } } }) });
    toast('web settings saved');
    loadSources();
  } catch (e) {
    toast(`could not save: ${e.message}`, 5000);
  }
});

/* -------------------------------- boot ---------------------------------- */

bootAuth();
