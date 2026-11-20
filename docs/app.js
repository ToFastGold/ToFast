/* Alex Звонки — приложение. Данные живут в Google Таблице, сервер — Apps Script. */
(function () {
  'use strict';

  const LS = {
    get(k, d) { try { const v = localStorage.getItem('alex_' + k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('alex_' + k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem('alex_' + k); } catch (e) { /* ignore */ } },
  };

  const MAPS_CITIES = ['Victoria', 'Saanich', 'Langford', 'Nanaimo', 'Vancouver', 'Burnaby', 'Surrey', 'Richmond', 'Coquitlam', 'North Vancouver', 'Kelowna', 'Kamloops'];
  const MAPS_QUERIES = ['barber', 'hair salon', 'nail salon', 'lash studio', 'auto repair', 'mobile car detailing', 'cleaning service',
    'landscaping', 'handyman', 'painter', 'moving company', 'bakery', 'food truck', 'restaurant', 'cafe', 'tattoo shop', 'massage', 'dog grooming'];

  const state = {
    tab: LS.get('tab', 'clients'),
    data: null,
    clientFilter: 'all',
    foundFilter: 'новый',
    openCall: null,
    transcripts: {},
    audio: {},
    usage: null,
    firstMessage: null,
    showAddClient: false,
  };

  const $view = document.getElementById('view');
  const $banner = document.getElementById('banner');

  function scriptUrl() { return LS.get('url', '') || (window.ALEX_CONFIG && window.ALEX_CONFIG.scriptUrl) || ''; }
  function pin() { return LS.get('pin', ''); }

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function fmtPhone(p) {
    const m = String(p || '').match(/^\+1(\d{3})(\d{3})(\d{4})$/);
    return m ? '+1 ' + m[1] + ' ' + m[2] + ' ' + m[3] : (p || '');
  }
  function isTrue(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
  let toastTimer;
  function toast(msg, err) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast' + (err ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), err ? 6000 : 3000);
  }

  async function api(action, payload) {
    const url = scriptUrl();
    if (!url) throw new Error('Не задан адрес сервера');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action: action, pin: pin() }, payload || {})),
    });
    const json = await res.json();
    if (!json.ok) {
      if (json.error === 'Неверный PIN') { LS.del('pin'); }
      throw new Error(json.error || 'Ошибка сервера');
    }
    return json;
  }

  async function load(quiet) {
    try {
      const d = await api('load');
      state.data = d;
      updateBanner();
      render();
      if (!quiet) toast('Обновлено');
    } catch (e) {
      if (!pin()) return renderLogin();
      toast(e.message, true);
    }
  }

  function updateBanner() {
    const s = state.data && state.data.settings;
    if (!s) return $banner.classList.add('hidden');
    const msgs = [];
    if (!s.api_key_set) msgs.push('Добавь ключ ElevenLabs в Настройках, иначе звонки не пойдут.');
    if (s.paused === '1') msgs.push('Звонки на паузе.');
    $banner.innerHTML = msgs.map(esc).join('<br>');
    $banner.classList.toggle('hidden', msgs.length === 0);
  }

  /* ---------- login / first run ---------- */
  function renderLogin() {
    document.getElementById('tabs').classList.add('hidden');
    $view.innerHTML = `
      <div class="card">
        <h3>Вход</h3>
        <p class="sub">Один раз на этом телефоне.</p>
        <label class="f">Адрес сервера (из Apps Script)</label>
        <input id="l-url" placeholder="https://script.google.com/macros/s/.../exec" value="${esc(scriptUrl())}">
        <label class="f">PIN</label>
        <input id="l-pin" type="password" inputmode="numeric" autocomplete="current-password">
        <p class="small" id="l-hint"></p>
        <div class="row"><button class="btn primary block" id="l-go">Войти</button></div>
      </div>`;
    const go = async () => {
      const url = document.getElementById('l-url').value.trim();
      const p = document.getElementById('l-pin').value.trim();
      if (!url) return toast('Вставь адрес сервера', true);
      LS.set('url', url);
      try {
        const st = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'status' }) }).then((r) => r.json());
        if (!st.ok) throw new Error(st.error || 'Сервер не ответил');
        if (!st.pinSet) throw new Error('PIN ещё не создан. Запусти функцию setup в Apps Script (шаг 1 инструкции).');
        if (!p) return toast('Введи PIN из журнала Apps Script', true);
        LS.set('pin', p);
        document.getElementById('tabs').classList.remove('hidden');
        await load(true);
      } catch (e) {
        toast('Не получилось: ' + e.message, true);
      }
    };
    document.getElementById('l-go').onclick = go;
    fetch(scriptUrl() || 'about:blank', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'status' }) })
      .then((r) => r.json()).then((st) => {
        if (st && st.ok && !st.pinSet) document.getElementById('l-hint').textContent = 'PIN ещё не создан: запусти функцию setup в Apps Script.';
      }).catch(() => {});
  }

  /* ---------- render ---------- */
  function render() {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    if (!state.data) { $view.innerHTML = '<div class="empty">Загрузка…</div>'; return; }
    ({ found: renderFound, clients: renderClients, calls: renderCalls, settings: renderSettings })[state.tab]();
  }

  /* ---------- Клиенты ---------- */
  const CLIENT_STATUS = {
    'новый': '', 'звоним': 'warn', 'поговорили': 'ok', 'не ответил': 'warn', 'автоответчик': 'warn', 'не звонить': 'bad',
  };

  function callBlockReason(c) {
    const s = state.data.settings;
    if (c.status === 'не звонить') return 'Просил не звонить';
    if (!isTrue(c.consent)) return 'Нет согласия';
    if (s.paused === '1') return 'Пауза';
    if (!s.api_key_set) return 'Нет ключа ElevenLabs';
    return '';
  }

  function renderClients() {
    const list = state.data.clients.slice().reverse();
    const filters = ['all', 'новый', 'поговорили', 'не ответил', 'автоответчик', 'не звонить'];
    const shown = list.filter((c) => state.clientFilter === 'all' || c.status === state.clientFilter);
    $view.innerHTML = `
      <div class="between"><div class="sub">Всего: ${list.length}</div>
        <button class="btn" id="add-toggle">${state.showAddClient ? 'Закрыть' : '+ Добавить'}</button></div>
      ${state.showAddClient ? addClientForm() : ''}
      <div class="chips" style="margin-top:10px">${filters.map((f) => `<button data-f="${esc(f)}" class="${state.clientFilter === f ? 'on' : ''}">${f === 'all' ? 'Все' : esc(f)}</button>`).join('')}</div>
      ${shown.length ? shown.map(clientCard).join('') : '<div class="empty">Пока пусто. Клиенты появятся, когда оставят заявку на странице или ты добавишь их сам.</div>'}`;
    document.getElementById('add-toggle').onclick = () => { state.showAddClient = !state.showAddClient; render(); };
    $view.querySelectorAll('.chips button').forEach((b) => b.onclick = () => { state.clientFilter = b.dataset.f; render(); });
    if (state.showAddClient) bindAddClient();
    $view.querySelectorAll('[data-call]').forEach((b) => b.onclick = () => doCall(b.dataset.call, b));
    $view.querySelectorAll('[data-dnc]').forEach((b) => b.onclick = async () => {
      if (!confirm('Больше никогда не звонить этому клиенту?')) return;
      await act('updateClient', { id: b.dataset.dnc, patch: { status: 'не звонить' } }, 'Отмечено: не звонить');
    });
    $view.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!confirm('Удалить клиента? Это нельзя отменить.')) return;
      await act('deleteClient', { id: b.dataset.del }, 'Удалено');
    });
  }

  function clientCard(c) {
    const reason = callBlockReason(c);
    const cls = CLIENT_STATUS[c.status] || '';
    return `<div class="card">
      <div class="between"><h3>${esc(c.business || c.name || fmtPhone(c.phone))}</h3><span class="badge ${cls}">${esc(c.status || 'новый')}</span></div>
      <div class="sub">${esc([c.name && c.business ? c.name : '', fmtPhone(c.phone), c.city].filter(Boolean).join(' · '))}</div>
      ${c.email ? `<div class="sub">${esc(c.email)}</div>` : ''}
      ${c.note ? `<div class="sub" style="margin-top:4px">${esc(c.note)}</div>` : ''}
      <div class="small" style="margin-top:6px">${isTrue(c.consent) ? 'Согласие есть' : 'Согласия нет'} · ${esc(c.source || '')}${Number(c.attempts) ? ' · звонков: ' + esc(c.attempts) : ''}${c.last_call_at ? ' · последний ' + fmtDate(c.last_call_at) : ''}</div>
      <div class="row">
        <button class="btn primary" data-call="${esc(c.id)}" ${reason ? 'disabled' : ''}>${reason ? esc(reason) : 'Позвонить'}</button>
        ${c.status !== 'не звонить' ? `<button class="btn" data-dnc="${esc(c.id)}">Не звонить</button>` : ''}
        <button class="btn danger" data-del="${esc(c.id)}">Удалить</button>
      </div>
    </div>`;
  }

  function addClientForm() {
    return `<div class="card" style="margin-top:10px">
      <label class="f">Имя</label><input id="c-name">
      <label class="f">Бизнес</label><input id="c-business">
      <label class="f">Телефон</label><input id="c-phone" inputmode="tel" placeholder="604 555 0123">
      <label class="f">Email</label><input id="c-email" inputmode="email">
      <label class="f">Город</label><input id="c-city">
      <label class="f">Заметка</label><input id="c-note">
      <label class="f">Как клиент согласился на звонок от Alex?</label>
      <select id="c-consent">
        <option value="">— выбери —</option>
        <option>Ответил на письмо и попросил позвонить</option>
        <option>Сам позвонил и попросил перезвонить</option>
        <option>Написал в соцсетях и попросил позвонить</option>
        <option>Согласился лично</option>
      </select>
      <label class="f">Подробности (когда, где)</label><input id="c-consent-details" placeholder="например: ответил на письмо 20 ноября">
      <p class="small">Без согласия Alex звонить не будет: в Канаде это запрещено.</p>
      <button class="btn primary block" id="c-save">Сохранить</button>
    </div>`;
  }

  function bindAddClient() {
    document.getElementById('c-save').onclick = async () => {
      const v = (id) => document.getElementById(id).value.trim();
      if (!v('c-phone')) return toast('Нужен телефон', true);
      if (!v('c-consent')) return toast('Выбери, как клиент согласился', true);
      await act('addClient', {
        client: {
          name: v('c-name'), business: v('c-business'), phone: v('c-phone'), email: v('c-email'), city: v('c-city'), note: v('c-note'),
          consent_text: v('c-consent') + (v('c-consent-details') ? ': ' + v('c-consent-details') : ''),
        },
      }, 'Клиент добавлен');
      state.showAddClient = false;
      render();
    };
  }

  async function doCall(id, btn) {
    const c = state.data.clients.find((x) => x.id === id);
    if (!confirm('Alex позвонит: ' + (c.business || c.name || c.phone) + ' (' + fmtPhone(c.phone) + '). Звонить?')) return;
    btn.disabled = true;
    btn.textContent = 'Звоню…';
    try {
      await api('call', { id: id });
      toast('Alex звонит. Итог появится во вкладке «Звонки».');
      await load(true);
    } catch (e) {
      toast(e.message, true);
      render();
    }
  }

  async function act(action, payload, okMsg) {
    try {
      await api(action, payload);
      if (okMsg) toast(okMsg);
      await load(true);
    } catch (e) {
      toast(e.message, true);
    }
  }

  /* ---------- Найденные ---------- */
  function fillTemplate(tpl, f) {
    const s = state.data.settings;
    return String(tpl || '')
      .replace(/\{business\}/g, f.business || 'there')
      .replace(/\{city\}/g, f.city || '')
      .replace(/\{link\}/g, s.request_page_url || '')
      .replace(/\{sender_name\}/g, s.sender_name || '')
      .replace(/\{brand\}/g, s.brand || '')
      .replace(/\{sender_contact\}/g, s.sender_contact || '');
  }

  function renderFound() {
    const list = state.data.found;
    const filters = ['новый', 'написали', 'оставил заявку', 'не писать', 'all'];
    const counts = {};
    list.forEach((f) => { counts[f.status] = (counts[f.status] || 0) + 1; });
    const shown = list.filter((f) => state.foundFilter === 'all' || f.status === state.foundFilter);
    $view.innerHTML = `
      <div class="between"><div class="sub">Найдено: ${list.length}</div>
        <button class="btn" id="import-leads">Загрузить новых</button></div>
      <div class="card">
        <label class="f" style="margin-top:0">Искать в Google Maps бизнесы без сайта</label>
        <input id="m-q" list="m-qs" placeholder="кого искать, например barber" value="${esc(state.mapsQuery || '')}">
        <datalist id="m-qs">${MAPS_QUERIES.map((q) => `<option value="${esc(q)}">`).join('')}</datalist>
        <select id="m-city">${MAPS_CITIES.map((c) => `<option ${c === (state.mapsCity || 'Victoria') ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <div class="row"><button class="btn primary" id="m-go" ${state.data.settings.places_key_set ? '' : 'disabled'}>Искать</button></div>
        ${state.data.settings.places_key_set ? '<div class="small">Один поиск это до 60 бизнесов. В список попадут только те, у кого нет своего сайта.</div>' : '<div class="small">Сначала добавь ключ Google Maps в Настройках.</div>'}
      </div>
      <p class="small">Сначала пишем сообщение. Кто оставит номер на странице, попадёт в «Клиенты», и тогда Alex сможет позвонить.</p>
      <div class="chips">${filters.map((f) => `<button data-f="${esc(f)}" class="${state.foundFilter === f ? 'on' : ''}">${f === 'all' ? 'Все' : esc(f)}${f !== 'all' && counts[f] ? ' ' + counts[f] : ''}</button>`).join('')}</div>
      ${shown.length ? shown.map(foundCard).join('') : '<div class="empty">Здесь пусто.</div>'}`;
    $view.querySelectorAll('.chips button').forEach((b) => b.onclick = () => { state.foundFilter = b.dataset.f; render(); });
    document.getElementById('import-leads').onclick = importLeads;
    document.getElementById('m-go').onclick = searchMaps;
    $view.querySelectorAll('[data-igfind]').forEach((b) => b.onclick = () => {
      const f = state.data.found.find((x) => x.id === b.dataset.igfind);
      window.open('https://www.google.com/search?q=' + encodeURIComponent(f.business + ' ' + f.city + ' instagram'), '_blank');
    });
    $view.querySelectorAll('[data-igset]').forEach((b) => b.onclick = () => {
      const h = prompt('Instagram этого бизнеса (например @barbershop или ссылка):');
      if (h === null) return;
      const handle = igHandle(h);
      if (!handle) return toast('Не понял, какой это Instagram. Вставь @имя или ссылку на профиль.', true);
      act('updateFound', { id: b.dataset.igset, patch: { instagram: handle } }, 'Instagram добавлен');
    });
    $view.querySelectorAll('[data-mail]').forEach((b) => b.onclick = (ev) => writeTo(b.dataset.mail, ev));
    $view.querySelectorAll('[data-skip]').forEach((b) => b.onclick = () => act('updateFound', { id: b.dataset.skip, patch: { status: 'не писать' } }, 'Отмечено'));
    $view.querySelectorAll('[data-fdel]').forEach((b) => b.onclick = async () => {
      if (!confirm('Удалить из списка?')) return;
      await act('deleteFound', { id: b.dataset.fdel }, 'Удалено');
    });
  }

  function foundCard(f) {
    const ig = igHandle(f.instagram);
    const canWrite = f.email || ig;
    return `<div class="card">
      <div class="between"><h3>${esc(f.business)}</h3><span class="badge">${esc(f.status)}</span></div>
      <div class="sub">${esc([f.category, f.city].filter(Boolean).join(' · '))}</div>
      <div class="sub">${esc([fmtPhone(f.phone), f.email, f.instagram].filter(Boolean).join(' · '))}</div>
      <div class="small" style="margin-top:4px">${f.website ? 'Сайт: ' + esc(f.website) : 'Сайта нет'}${f.maps_url ? ` · <a href="${esc(f.maps_url)}" target="_blank" rel="noopener">карта</a>` : ''}</div>
      ${f.note ? `<div class="small">${esc(f.note)}</div>` : ''}
      <div class="row">
        ${f.status !== 'не писать' && !f.email && ig ? `<a class="btn primary" data-mail="${esc(f.id)}" href="${esc(igUrl(f.instagram))}" target="_blank" rel="noopener">Написать в Instagram</a>` : ''}
        ${f.status !== 'не писать' && (f.email || !ig) ? `<button class="btn primary" data-mail="${esc(f.id)}" ${canWrite ? '' : 'disabled'}>${canWrite ? 'Написать' : 'Нет контакта'}</button>` : ''}
        ${ig ? `<a class="btn" href="${esc(igUrl(f.instagram))}" target="_blank" rel="noopener">Открыть Instagram</a>` : ''}
        ${!canWrite && f.status !== 'не писать' ? `<button class="btn" data-igfind="${esc(f.id)}">Найти Instagram</button><button class="btn" data-igset="${esc(f.id)}">Вписать</button>` : ''}
        ${f.status === 'новый' ? `<button class="btn" data-skip="${esc(f.id)}">Не писать</button>` : ''}
        <button class="btn danger" data-fdel="${esc(f.id)}">Удалить</button>
      </div>
    </div>`;
  }

  function igHandle(v) {
    return String(v || '').trim().replace(/^@/, '').replace(/^(https?:\/\/)?(www\.)?instagram\.com\//i, '').split(/[/?#\s]/)[0];
  }
  function igUrl(v) { return 'https://www.instagram.com/' + encodeURIComponent(igHandle(v)) + '/'; }

  async function writeTo(id, ev) {
    const f = state.data.found.find((x) => x.id === id);
    const s = state.data.settings;
    if (!s.sender_contact) {
      if (ev) ev.preventDefault();
      toast('Сначала заполни «Контакт для писем» в Настройках: закон Канады требует указать в письме адрес или телефон отправителя.', true);
      state.tab = 'settings'; render();
      return;
    }
    const subject = fillTemplate(s.email_subject, f);
    const body = fillTemplate(s.email_body, f);
    if (f.email) {
      window.location.href = 'mailto:' + encodeURIComponent(f.email) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    } else {
      const dm = body.replace(/reply to this email/gi, 'reply to this message').replace(/email you again/gi, 'message you again');
      // Start the copy and open Instagram in the same click, so the browser does not block the new tab.
      let copied;
      try { copied = navigator.clipboard.writeText(dm); } catch (e) { copied = Promise.reject(e); }
      // The Instagram page itself is opened by the link the user tapped (an <a>, so the phone never blocks it).
      copied.then(
        () => toast('Текст скопирован. Вставь его в сообщение в Instagram.'),
        () => toast('Не удалось скопировать текст. Скопируй его из Настроек → текст письма.', true),
      );
    }
    // Ask only once the user is back in the app (after sending in Instagram or the mail app).
    const ask = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', ask);
      if (confirm('Сообщение отправлено? Отметить «написали».')) act('updateFound', { id: id, patch: { status: 'написали' } }, 'Отмечено');
    };
    setTimeout(() => { if (document.hidden) document.addEventListener('visibilitychange', ask); else ask(); }, 1500);
  }

  async function searchMaps() {
    const q = document.getElementById('m-q').value.trim();
    const city = document.getElementById('m-city').value;
    if (!q) return toast('Напиши, кого искать', true);
    state.mapsQuery = q; state.mapsCity = city;
    const btn = document.getElementById('m-go');
    btn.disabled = true; btn.textContent = 'Ищу…';
    try {
      const r = await api('searchMaps', { query: q, city: city });
      toast(`Нашёл ${r.total}, без сайта ${r.without_site}, новых добавлено ${r.added}`);
      await load(true);
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false; btn.textContent = 'Искать';
    }
  }

  async function importLeads() {
    try {
      const res = await fetch('leads/leads.json?ts=' + Date.now());
      if (!res.ok) throw new Error('Файл со списком не найден');
      const items = await res.json();
      const r = await api('addFound', { items: items });
      toast(r.added ? 'Добавлено новых: ' + r.added : 'Новых нет, все уже в списке');
      await load(true);
    } catch (e) {
      toast(e.message, true);
    }
  }

  /* ---------- Звонки ---------- */
  function renderCalls() {
    const list = state.data.calls;
    $view.innerHTML = list.length ? list.map(callCard).join('') : '<div class="empty">Звонков пока не было.</div>';
    $view.querySelectorAll('[data-open]').forEach((el) => el.onclick = () => {
      state.openCall = state.openCall === el.dataset.open ? null : el.dataset.open;
      render();
    });
    $view.querySelectorAll('[data-tr]').forEach((b) => b.onclick = () => loadTranscript(b.dataset.tr));
    $view.querySelectorAll('[data-au]').forEach((b) => b.onclick = () => loadAudio(b.dataset.au, b));
  }

  function callStatusClass(s) {
    return ({ 'поговорили': 'ok', 'звоним': 'warn', 'автоответчик': 'warn', 'не ответил': 'warn', 'занято': 'warn', 'просил не звонить': 'bad', 'ошибка звонка': 'bad' })[s] || '';
  }

  function callCard(c) {
    const open = state.openCall === c.conversation_id;
    const secs = Math.round(Number(c.duration_s) || 0);
    const mins = secs ? Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0') : '';
    const fields = [
      ['Нужен сайт', isTrue(c.wants_website) ? 'да' : ''], ['Какой сайт', c.site_type], ['Бюджет', c.budget], ['Сроки', c.timeline],
      ['Email', c.email], ['Когда удобно', c.best_time], ['Интерес', c.interest],
    ].filter((x) => x[1]);
    const tr = state.transcripts[c.conversation_id];
    const au = state.audio[c.conversation_id];
    const real = c.conversation_id && !String(c.conversation_id).startsWith('pending-');
    return `<div class="card">
      <div class="between" data-open="${esc(c.conversation_id)}" style="cursor:pointer">
        <div><h3>${esc(c.business || c.name || fmtPhone(c.phone) || 'Неизвестный номер')}</h3>
          <div class="sub">${fmtDate(c.started_at)} · ${esc(c.direction || '')}${mins ? ' · ' + mins : ''}</div></div>
        <span class="badge ${callStatusClass(c.status)}">${esc(c.status || '')}</span>
      </div>
      ${c.summary_ru ? `<p style="margin:8px 0 0">${esc(c.summary_ru)}</p>` : ''}
      ${open ? `
        ${fields.length ? `<dl class="kv">${fields.map((x) => `<dt>${esc(x[0])}</dt><dd>${esc(x[1])}</dd>`).join('')}</dl>` : ''}
        ${c.cost ? `<div class="small" style="margin-top:6px">Стоимость: ${esc(c.cost)} кредитов ElevenLabs</div>` : ''}
        ${real ? `<div class="row"><button class="btn" data-tr="${esc(c.conversation_id)}">Расшифровка</button><button class="btn" data-au="${esc(c.conversation_id)}">Запись</button></div>` : ''}
        ${au ? `<audio controls src="${au}" style="width:100%;margin-top:10px"></audio>` : ''}
        ${tr ? `<div class="transcript">${tr.map((t) => `<p><b>${t.role === 'agent' ? 'Alex' : 'Клиент'}:</b> ${esc(t.text)}</p>`).join('')}</div>` : ''}
      ` : '<div class="small" style="margin-top:6px">Нажми, чтобы открыть подробности</div>'}
    </div>`;
  }

  async function loadTranscript(id) {
    try {
      const r = await api('transcript', { conversation_id: id });
      state.transcripts[id] = r.transcript;
      render();
    } catch (e) { toast(e.message, true); }
  }

  async function loadAudio(id, btn) {
    btn.disabled = true; btn.textContent = 'Загружаю…';
    try {
      const r = await api('audio', { conversation_id: id });
      state.audio[id] = 'data:' + r.mime + ';base64,' + r.base64;
      render();
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Запись'; }
  }

  /* ---------- Настройки ---------- */
  function renderSettings() {
    const s = state.data.settings;
    const u = state.usage;
    $view.innerHTML = `
      <div class="section-title">Звонки</div>
      <div class="card">
        <div class="between"><div><b>${s.paused === '1' ? 'Звонки на паузе' : 'Звонки включены'}</b><div class="small">Пауза останавливает и кнопку, и повторные звонки.</div></div>
          <button class="btn ${s.paused === '1' ? 'primary' : ''}" id="s-pause">${s.paused === '1' ? 'Включить' : 'Пауза'}</button></div>
      </div>
      <div class="card">
        <label class="f" style="margin-top:0">Первая фраза Alex</label>
        <textarea id="s-first">${esc(state.firstMessage == null ? 'Загрузка…' : state.firstMessage)}</textarea>
        <p class="small">Alex говорит её первой на каждом звонке. Пиши на английском и оставь в ней, что Alex — ИИ-помощник.</p>
        <button class="btn primary" id="s-first-save" ${state.firstMessage == null ? 'disabled' : ''}>Сохранить фразу</button>
      </div>

      <div class="section-title">Расходы</div>
      <div class="card">
        ${u ? `<dl class="kv">
          <dt>Звонков в этом месяце</dt><dd>${esc(u.month_calls)}</dd>
          <dt>Минут</dt><dd>${esc(u.month_minutes)}</dd>
          <dt>Кредитов на звонки</dt><dd>${esc(u.month_credits)}</dd>
          <dt>Тариф ElevenLabs</dt><dd>${esc(u.tier)}</dd>
          <dt>Использовано кредитов</dt><dd>${esc(u.used)} из ${esc(u.limit)}</dd>
          ${u.reset_at ? `<dt>Обнулится</dt><dd>${fmtDate(u.reset_at)}</dd>` : ''}
        </dl><p class="small">Минуты Twilio оплачиваются отдельно в Twilio.</p>` : '<button class="btn" id="s-usage">Показать расходы</button>'}
      </div>

      <div class="section-title">Письма найденным бизнесам</div>
      <div class="card">
        <label class="f" style="margin-top:0">Название твоего бизнеса</label><input id="s-brand" value="${esc(s.brand)}">
        <label class="f">Имя отправителя</label><input id="s-sender" value="${esc(s.sender_name)}">
        <label class="f">Контакт для писем (почтовый адрес или телефон)</label><input id="s-contact" value="${esc(s.sender_contact)}" placeholder="обязательно по закону Канады">
        <label class="f">Тема письма</label><input id="s-subj" value="${esc(s.email_subject)}">
        <label class="f">Текст письма</label><textarea id="s-body" style="min-height:220px">${esc(s.email_body)}</textarea>
        <p class="small">Подставляются: {business}, {city}, {link}, {sender_name}, {brand}, {sender_contact}.</p>
        <label class="f">Ссылка на страницу заявки</label><input id="s-link" value="${esc(s.request_page_url)}">
      </div>

      <div class="section-title">Часы и номер</div>
      <div class="card">
        <label class="f" style="margin-top:0">Будни</label><input id="s-wd" value="${esc(s.hours_weekday)}">
        <label class="f">Выходные</label><input id="s-we" value="${esc(s.hours_weekend)}">
        <label class="f">Часовой пояс</label><input id="s-tz" value="${esc(s.tz)}">
        <label class="f">Попыток дозвониться</label><input id="s-max" inputmode="numeric" value="${esc(s.max_attempts)}">
        <label class="f">Номер, с которого звонит Alex</label>
        <select id="s-num">
          <option value="phnum_5201m7v36e37epmrwpycavvgpvd3" ${s.phone_number_id === 'phnum_5201m7v36e37epmrwpycavvgpvd3' ? 'selected' : ''}>+1 217 727 6180 (США)</option>
          <option value="phnum_1001m7v228xfemjryymf5m9egaq1" ${s.phone_number_id === 'phnum_1001m7v228xfemjryymf5m9egaq1' ? 'selected' : ''}>+1 236 969 9779 (Канада)</option>
        </select>
      </div>
      <button class="btn primary block" id="s-save">Сохранить настройки</button>

      <div class="section-title">Уведомления</div>
      <div class="card">
        <p class="sub" style="margin-top:0">Установи на телефон бесплатное приложение ntfy из Google Play, нажми «+» и подпишись на тему:</p>
        <code class="copy">${esc(s.ntfy_topic)}</code>
        <div class="row"><button class="btn" id="s-copy-topic">Скопировать тему</button><button class="btn" id="s-push">Проверить</button></div>
      </div>

      <div class="section-title">Подключение</div>
      <div class="card">
        <label class="f" style="margin-top:0">Ключ ElevenLabs ${s.api_key_set ? '(уже задан)' : '(не задан)'}</label>
        <input id="s-key" type="password" placeholder="${s.api_key_set ? 'оставь пустым, чтобы не менять' : 'вставь ключ'}">
        <label class="f">Ключ Google Maps ${s.places_key_set ? '(уже задан)' : '(не задан)'}</label>
        <input id="s-pkey" type="password" placeholder="${s.places_key_set ? 'оставь пустым, чтобы не менять' : 'вставь ключ'}">
        <label class="f">Адрес для Make (итоги звонков)</label>
        <code class="copy">${esc(s.webhook_url)}</code>
        <div class="row"><button class="btn" id="s-copy-hook">Скопировать адрес</button></div>
        <label class="f">Новый PIN</label><input id="s-pin" type="password" inputmode="numeric" placeholder="оставь пустым, чтобы не менять">
        <div class="row"><button class="btn primary" id="s-save2">Сохранить</button><button class="btn danger" id="s-logout">Выйти</button></div>
      </div>`;

    const v = (id) => document.getElementById(id).value;
    document.getElementById('s-pause').onclick = () => act('saveSettings', { settings: { paused: s.paused === '1' ? '0' : '1' } }, s.paused === '1' ? 'Звонки включены' : 'Звонки на паузе');
    document.getElementById('s-first-save').onclick = async () => {
      if (state.firstMessage == null) return toast('Фраза ещё не загрузилась', true);
      try { await api('setFirstMessage', { first_message: v('s-first') }); state.firstMessage = v('s-first'); toast('Фраза сохранена в Alex'); } catch (e) { toast(e.message, true); }
    };
    const usageBtn = document.getElementById('s-usage');
    if (usageBtn) usageBtn.onclick = async () => {
      usageBtn.disabled = true;
      try { state.usage = await api('usage'); render(); } catch (e) { toast(e.message, true); usageBtn.disabled = false; }
    };
    document.getElementById('s-save').onclick = () => act('saveSettings', {
      settings: {
        brand: v('s-brand'), sender_name: v('s-sender'), sender_contact: v('s-contact'), email_subject: v('s-subj'), email_body: v('s-body'),
        request_page_url: v('s-link'), hours_weekday: v('s-wd'), hours_weekend: v('s-we'), tz: v('s-tz'), max_attempts: v('s-max'), phone_number_id: v('s-num'),
      },
    }, 'Сохранено');
    document.getElementById('s-copy-topic').onclick = () => copy(s.ntfy_topic);
    document.getElementById('s-copy-hook').onclick = () => copy(s.webhook_url);
    document.getElementById('s-push').onclick = () => act('testPush', {}, 'Отправлено. Уведомление должно прийти через пару секунд.');
    document.getElementById('s-save2').onclick = async () => {
      const key = v('s-key').trim();
      const pkey = v('s-pkey').trim();
      const np = v('s-pin').trim();
      if (np && np.length < 4) return toast('PIN минимум 4 цифры', true);
      try {
        await api('saveSettings', { api_key: key || undefined, places_key: pkey || undefined, new_pin: np || undefined });
        if (np) LS.set('pin', np);
        toast('Сохранено');
        await load(true);
      } catch (e) { toast(e.message, true); }
    };
    document.getElementById('s-logout').onclick = () => { LS.del('pin'); state.data = null; renderLogin(); };

    if (state.firstMessage == null && s.api_key_set) {
      api('getFirstMessage').then((r) => { state.firstMessage = r.first_message; if (state.tab === 'settings') render(); })
        .catch((e) => { toast('Не удалось загрузить первую фразу: ' + e.message, true); });
    } else if (!s.api_key_set && state.firstMessage == null) {
      state.firstMessage = '';
      render();
    }
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Скопировано'); } catch (e) { prompt('Скопируй:', text); }
  }

  /* ---------- start ---------- */
  document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
    state.tab = b.dataset.tab; LS.set('tab', state.tab); render(); window.scrollTo(0, 0);
  });
  document.getElementById('refresh').onclick = () => (pin() && scriptUrl() ? load() : renderLogin());
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pin() && scriptUrl()) load(true); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  if (!scriptUrl() || !pin()) renderLogin();
  else { render(); load(true); }
})();
