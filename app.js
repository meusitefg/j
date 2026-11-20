'use strict';

const $ = (id) => document.getElementById(id);
const config = window.CENTRAL_CONFIG;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const dialog = $('dialog');
const sessionKey = 'minha-central:session:' + config?.url + ':' + config?.adminEmail;
const statuses = ['ON', 'OFF', 'RISCO'];
let encodedKey;
let session;
let vaultKey;
let db = { topics: [], accounts: [] };
let selected = '';
let busy = false;
let toastTimer;

function element(tag, className, label) {
  const node = document.createElement(tag);
  node.className = className;
  if (label !== undefined) node.textContent = label;
  return node;
}

function button(label, className, handler) {
  const node = element('button', className, label);
  node.type = 'button';
  node.onclick = handler;
  return node;
}

function notify(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4000);
}

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = { apikey: config.publishableKey, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(new URL(path, config.url), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw Object.assign(new Error('Falha na conexão com o banco.'), {
      status: response.status, code: details.code,
    });
  }
  if ((response.status !== 204 && method === 'GET') || path.startsWith('/auth/v1/token?')) {
    return response.json();
  }
}

async function query(path, options = {}) {
  if (Date.now() >= session.expires_at * 1000 - 30000) {
    session = await request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', body: { refresh_token: session.refresh_token },
    });
    saveSession();
  }
  return request('/rest/v1/' + path, { ...options, token: session.access_token });
}

async function deriveKey(password, userId) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'PBKDF2', salt: encoder.encode('minha-central-v1:' + userId),
    hash: 'SHA-256', iterations: 600000,
  }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function encrypt(email, password, id, status) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: encoder.encode(id),
  }, vaultKey, encoder.encode(JSON.stringify({ email, password, status })));
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(data)));
}

async function decrypt(row) {
  try {
    const bytes = Uint8Array.from(atob(row.payload), (character) => character.charCodeAt(0));
    const data = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(row.id),
    }, vaultKey, bytes.slice(12));
    return { ...row, ...JSON.parse(decoder.decode(data)) };
  } catch {
    return { ...row, locked: true };
  }
}

async function load() {
  const topics = await query('central_topics?select=id,name&order=created_at.asc,id.asc');
  const records = await query('central_accounts?select=id,topic_id,provider,payload&order=created_at.asc,id.asc');
  db = { topics, accounts: await Promise.all(records.map(decrypt)) };
}

function saveSession() {
  try {
    sessionStorage.setItem(sessionKey, JSON.stringify({ session, encodedKey }));
  } catch {
    // The dashboard also works in memory when browser storage is disabled.
  }
}

function showDashboard() {
  render();
  $('entry').hidden = true;
  $('dashboard').hidden = false;
}

async function restoreSession() {
  if (!config?.url || !config?.publishableKey || !globalThis.crypto?.subtle) return;
  const submit = $('signIn').querySelector('button');
  submit.disabled = busy = true;
  try {
    const stored = JSON.parse(sessionStorage.getItem(sessionKey));
    if (!stored?.session?.access_token || !stored.encodedKey) return;
    $('loginStatus').textContent = 'Restaurando sessão…';
    session = stored.session;
    encodedKey = stored.encodedKey;
    const bytes = Uint8Array.from(atob(encodedKey), (character) => character.charCodeAt(0));
    vaultKey = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    await load();
    showDashboard();
  } catch (error) {
    lock({ forget: !error.status ? error.name !== 'TypeError' && error.name !== 'TimeoutError' : error.status < 500 });
    $('loginStatus').textContent = 'Não foi possível restaurar a sessão. Entre novamente.';
  } finally {
    submit.disabled = busy = false;
  }
}

function lock({ forget = true } = {}) {
  if (forget) {
    try { sessionStorage.removeItem(sessionKey); } catch {}
  }
  encodedKey = undefined;
  session = undefined;
  vaultKey = undefined;
  db = { topics: [], accounts: [] };
  selected = '';
  dialog.close();
  $('fields').replaceChildren();
  $('search').value = '';
  $('nav').replaceChildren();
  $('cards').replaceChildren();
  $('toast').classList.remove('show');
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  $('dashboard').hidden = true;
  $('entry').hidden = false;
  $('loginStatus').textContent = '';
}

$('signIn').onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  const status = $('loginStatus');
  const submit = form.querySelector('button');
  if (!config?.url || !config?.publishableKey) {
    status.textContent = 'Conexão pendente. Configure o Supabase conforme o guia do projeto.';
    return;
  }
  if (!globalThis.crypto?.subtle) {
    status.textContent = 'Abra o site em HTTPS para acessar suas contas.';
    return;
  }
  const email = form.elements.email.value.trim().toLowerCase();
  const password = form.elements.password.value;
  form.elements.password.value = '';
  if (email !== config.adminEmail.toLowerCase()) {
    status.textContent = 'E-mail ou senha inválidos.';
    return;
  }
  submit.disabled = busy = true;
  status.textContent = 'Entrando…';
  try {
    session = await request('/auth/v1/token?grant_type=password', {
      method: 'POST', body: { email, password },
    });
    const key = await deriveKey(password, session.user.id);
    const raw = await crypto.subtle.exportKey('raw', key);
    encodedKey = btoa(String.fromCharCode(...new Uint8Array(raw)));
    vaultKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    await load();
    saveSession();
    showDashboard();
  } catch (error) {
    lock();
    status.textContent = error.status === 400 || error.status === 401
      ? 'E-mail ou senha inválidos.' : 'Falha ao carregar a central. Verifique a conexão.';
  } finally {
    submit.disabled = busy = false;
  }
};

$('signOut').onclick = () => {
  if (busy) return;
  const token = session.access_token;
  lock();
  request('/auth/v1/logout?scope=local', { method: 'POST', token }).catch(() => {});
};

function selectTopic(id) {
  selected = id;
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  render();
}

function render() {
  const topic = db.topics.find((item) => item.id === selected);
  if (!topic) selected = '';
  const nav = $('nav');
  nav.replaceChildren();
  const topicButton = (id, name) => {
    const control = button(name, selected === id ? 'active' : '', () => selectTopic(id));
    control.setAttribute('aria-pressed', String(selected === id));
    control.append(element('span', 'count', db.accounts.filter((account) => !id || account.topic_id === id).length));
    return control;
  };
  nav.append(topicButton('', 'Todas as contas'));
  for (const item of db.topics) {
    const row = element('div', 'topic-row');
    const remove = button('×', 'delete-topic', () => removeTopic(item));
    remove.setAttribute('aria-label', 'Excluir tópico ' + item.name);
    row.append(topicButton(item.id, item.name), remove);
    nav.append(row);
  }
  $('pageTitle').textContent = topic?.name || 'Todas as contas';
  $('statAccounts').textContent = db.accounts.length;
  $('statTopics').textContent = db.topics.length;
  const visible = db.accounts.filter((account) => !selected || account.topic_id === selected);
  $('statFiltered').textContent = visible.length;
  const search = $('search').value.trim().toLocaleLowerCase('pt-BR');
  const cards = $('cards');
  cards.replaceChildren();
  for (const account of visible) {
    const topicName = db.topics.find((item) => item.id === account.topic_id)?.name || 'Sem tópico';
    if (![account.email, account.provider, topicName].join(' ').toLocaleLowerCase('pt-BR').includes(search)) continue;
    const card = element('article', 'card');
    const actions = element('div', 'card-actions');
    if (!account.locked) {
      actions.append(
        button('Copiar login', 'btn dark', () => copyLogin(account)),
        button('Editar', 'btn', () => openAccount(account)),
      );
    }
    actions.append(button('Excluir', 'btn', () => removeAccount(account)));
    card.append(element('span', 'tag', topicName), element('h3', '', account.provider));
    const details = element('div', 'account-details');
    details.append(element('div', 'login', account.locked ? 'Senha de acesso incompatível com este registro.' : account.email));
    if (!account.locked) details.append(statusControl(account));
    card.append(details);
    if (!account.locked) card.append(passwordControl(account));
    card.append(actions);
    cards.append(card);
  }
  if (!cards.childElementCount) {
    cards.append(element('div', 'empty', search ? 'Nenhum resultado.' : 'Nenhum login cadastrado aqui.'));
  }
}

function statusControl(account) {
  const control = element('select', 'status-select');
  const current = statuses.includes(account.status) ? account.status : '';
  const placeholder = new Option('Status', '');
  placeholder.disabled = true;
  control.add(placeholder);
  for (const status of statuses) control.add(new Option(status, status));
  control.value = current;
  control.dataset.status = current;
  control.setAttribute('aria-label', 'Status de ' + account.email);
  control.onchange = () => {
    const status = control.value;
    if (busy || !statuses.includes(status)) {
      control.value = current;
      return;
    }
    change(async () => {
      const payload = await encrypt(account.email, account.password, account.id, status);
      await query('central_accounts?id=eq.' + account.id, { method: 'PATCH', body: { payload } });
      account.status = status;
    }, control).then(() => {
      control.value = account.status || '';
      control.dataset.status = control.value;
    });
  };
  return control;
}

function passwordControl(account) {
  const row = element('div', 'password-row');
  const value = element('span', 'password-value');
  value.hidden = true;
  const toggle = button('Mostrar senha', 'btn password-toggle', () => {
    const show = value.hidden;
    value.textContent = show ? account.password : '';
    value.hidden = !show;
    toggle.textContent = show ? 'Ocultar senha' : 'Mostrar senha';
    toggle.setAttribute('aria-expanded', String(show));
  });
  value.id = 'password-' + account.id;
  toggle.setAttribute('aria-controls', value.id);
  toggle.setAttribute('aria-expanded', 'false');
  row.append(toggle, value);
  return row;
}

async function copyLogin(account) {
  try {
    await navigator.clipboard.writeText(account.email + '\n' + account.password);
    notify('E-mail e senha copiados.');
  } catch {
    notify('O navegador bloqueou a cópia.');
  }
}

function openForm(title, submit) {
  if (busy) return false;
  $('fields').replaceChildren();
  $('modalTitle').textContent = title;
  $('form').onsubmit = (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    change(async () => {
      await submit(data);
      dialog.close();
    }, $('save'));
  };
  return true;
}

function field(name, label, { type = 'text', value = '', options, maxLength, required = true } = {}) {
  const wrapper = element('label', 'field', label);
  const control = document.createElement(options ? 'select' : 'input');
  if (options) {
    for (const [key, title] of options) control.add(new Option(title, key));
  } else {
    control.type = type;
    control.autocomplete = type === 'password' ? 'new-password' : 'off';
    if (maxLength) control.maxLength = maxLength;
  }
  control.name = name;
  control.value = value;
  control.required = required;
  wrapper.append(control);
  $('fields').append(wrapper);
}

function openTopic() {
  if (!openForm('Novo tópico', async (data) => {
    const name = data.get('name').trim();
    if (!name) throw new Error('Digite o nome do tópico.');
    await query('central_topics', { method: 'POST', body: { name } });
  })) return;
  field('name', 'Nome do tópico', { maxLength: 70 });
  dialog.showModal();
}

function openAccount(account) {
  if (!openForm(account ? 'Editar login' : 'Adicionar login', async (data) => {
    const id = account?.id || crypto.randomUUID();
    const body = {
      provider: data.get('provider'), topic_id: data.get('topic') || null,
      payload: await encrypt(data.get('email').trim(), data.get('password'), id, account?.status),
    };
    if (account) {
      await query('central_accounts?id=eq.' + id, { method: 'PATCH', body });
    } else {
      await query('central_accounts', { method: 'POST', body: { ...body, id } });
    }
  })) return;
  field('provider', 'Tipo de conta', { value: account?.provider || 'Gmail', options: [['Gmail', 'Gmail'], ['Outlook', 'Outlook']] });
  field('email', 'E-mail da conta', { type: 'email', value: account?.email, maxLength: 254 });
  field('password', 'Senha da conta', { type: 'password', value: account?.password, maxLength: 512 });
  field('topic', 'Tópico', {
    value: account ? account.topic_id || '' : selected, required: false,
    options: [['', 'Sem tópico'], ...db.topics.map((item) => [item.id, item.name])],
  });
  dialog.showModal();
}

async function change(write, submit) {
  if (busy) return;
  busy = true;
  if (submit) submit.disabled = true;
  let written = false;
  try {
    await write();
    written = true;
    await load();
    render();
    notify('Alteração salva.');
  } catch (error) {
    if (error.status === 401 || error.code === 'refresh_token_not_found') {
      lock();
      $('loginStatus').textContent = 'Sua sessão expirou. Entre novamente.';
    } else if (written) {
      notify('Alteração salva. Entre novamente para atualizar a lista.');
    } else {
      notify(error.code === '23505' ? 'Já existe um tópico com esse nome.' :
        error.message === 'Digite o nome do tópico.' ? error.message : 'Não foi possível salvar. Confira a conexão e as permissões.');
    }
  } finally {
    if (submit) submit.disabled = false;
    busy = false;
  }
}

function removeTopic(item) {
  if (!busy && confirm('Excluir o tópico “' + item.name + '”? Os logins ficarão em “Sem tópico”.')) {
    change(() => query('central_topics?id=eq.' + item.id, { method: 'DELETE' }));
  }
}

function removeAccount(account) {
  if (!busy && confirm('Excluir este login?')) {
    change(() => query('central_accounts?id=eq.' + account.id, { method: 'DELETE' }));
  }
}

$('newTopic').onclick = openTopic;
$('newAccount').onclick = () => openAccount();
$('cancel').onclick = () => { if (!busy) dialog.close(); };
dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
dialog.addEventListener('close', () => $('fields').replaceChildren());
$('search').oninput = render;
$('menuBtn').setAttribute('aria-controls', 'sidebar');
$('menuBtn').setAttribute('aria-expanded', 'false');
$('menuBtn').onclick = () => {
  $('menuBtn').setAttribute('aria-expanded', String($('sidebar').classList.toggle('mobile-open')));
};

restoreSession();
