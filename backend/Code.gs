/**
 * Alex Calls — сервер для приложения.
 * Живёт внутри Google Таблицы (Расширения → Apps Script).
 * Хранит клиентов, найденные бизнесы и звонки в листах таблицы,
 * запускает звонки Alex через ElevenLabs и принимает итоги звонков (через Make).
 */

const SHEETS = {
  found: {
    name: 'Найденные',
    cols: ['id', 'business', 'category', 'city', 'phone', 'email', 'instagram', 'website', 'maps_url', 'status', 'contacted_at', 'note', 'created_at'],
  },
  clients: {
    name: 'Клиенты',
    cols: ['id', 'name', 'business', 'phone', 'email', 'city', 'note', 'source', 'consent', 'consent_text', 'consent_at', 'status', 'attempts', 'last_call_at', 'last_conversation_id', 'created_at'],
  },
  calls: {
    name: 'Звонки',
    cols: ['conversation_id', 'client_id', 'started_at', 'direction', 'name', 'business', 'phone', 'status', 'duration_s', 'cost', 'summary_ru', 'site_type', 'budget', 'timeline', 'email', 'best_time', 'interest', 'wants_website', 'do_not_call', 'voicemail', 'summary_en'],
  },
};

const CONSENT_TEXT = 'I agree to receive a phone call from Alex, an AI voice assistant, at the number above about getting a website. I can ask not to be called again at any time.';

const DEFAULTS = {
  brand: 'ToFast',
  agent_id: 'agent_3001m7ttv9tvf70sxwztyj04b7jd',
  phone_number_id: 'phnum_5201m7v36e37epmrwpycavvgpvd3',
  paused: '0',
  tz: 'America/Vancouver',
  hours_weekday: '09:00-21:00',
  hours_weekend: '10:00-18:00',
  max_attempts: '2',
  ntfy_topic: '',
  sender_name: 'Omar',
  sender_contact: '',
  request_page_url: 'https://tofastgold.github.io/ToFast/request/',
  email_subject: 'A website for {business} from $99 CAD',
  email_body: [
    'Hi {business} team,',
    '',
    'I came across {business} online. I build simple, mobile-friendly websites for small businesses in BC, starting at $99 CAD.',
    '',
    'If you would like to hear more, leave your number here and Alex, our AI assistant, will give you a quick call: {link}',
    '',
    'Or just reply to this email.',
    '',
    '{sender_name}',
    '{brand}',
    '{sender_contact}',
    '',
    'Not interested? Reply STOP and I will not email you again.',
  ].join('\n'),
};

const SETTING_KEYS = Object.keys(DEFAULTS);
const EL_API = 'https://api.elevenlabs.io';

/* ---------- setup ---------- */

/** Запусти один раз из редактора: создаёт листы, токен для Make и ежечасную проверку повторных звонков. */
function setup() {
  Object.keys(SHEETS).forEach(function (k) { sheet_(k); });
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('webhook_token')) props.setProperty('webhook_token', randomId_(24));
  if (!props.getProperty('S_ntfy_topic')) props.setProperty('S_ntfy_topic', 'alex-' + randomId_(12).toLowerCase());
  if (!props.getProperty('pin')) {
    let pin = '';
    for (let i = 0; i < 6; i++) pin += Math.floor(Math.random() * 10);
    props.setProperty('pin', pin);
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'retryCalls') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('retryCalls').timeBased().everyHours(1).create();
  Logger.log('Твой PIN для входа в приложение: ' + props.getProperty('pin'));
  Logger.log('Готово. Теперь: Начать развертывание → Новое развертывание → Веб-приложение.');
}

/* ---------- HTTP ---------- */

function doGet() {
  return json_({ ok: true, app: 'alex-calls' });
}

function doPost(e) {
  try {
    const body = e && e.postData ? JSON.parse(e.postData.contents || '{}') : {};
    // Итоги звонков от ElevenLabs, пересланные Make: ?token=...
    if (e.parameter && e.parameter.token) {
      if (e.parameter.token !== prop_('webhook_token')) return json_({ ok: false, error: 'bad token' });
      return json_(handleWebhook_(body));
    }
    const action = body.action;
    // Действия без PIN
    if (action === 'status') return json_({ ok: true, pinSet: !!prop_('pin') });
    if (action === 'request') return json_(publicRequest_(body));
    // Остальное только с PIN
    if (!prop_('pin') || String(body.pin) !== prop_('pin')) return json_({ ok: false, error: 'Неверный PIN' });
    const fn = ACTIONS[action];
    if (!fn) return json_({ ok: false, error: 'Неизвестное действие: ' + action });
    return json_(fn(body));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

const ACTIONS = {
  load: function () {
    return { ok: true, found: rows_('found'), clients: rows_('clients'), calls: rows_('calls').reverse(), settings: publicSettings_() };
  },
  saveSettings: function (b) {
    const props = PropertiesService.getScriptProperties();
    const s = b.settings || {};
    SETTING_KEYS.forEach(function (k) { if (s[k] !== undefined) props.setProperty('S_' + k, String(s[k])); });
    if (b.api_key) props.setProperty('api_key', String(b.api_key).trim());
    if (b.new_pin) props.setProperty('pin', String(b.new_pin).trim());
    return { ok: true, settings: publicSettings_() };
  },
  addClient: function (b) {
    const c = b.client || {};
    const phone = normPhone_(c.phone);
    if (!phone) throw new Error('Нужен телефон');
    if (!c.consent_text) throw new Error('Опиши, как клиент дал согласие на звонок');
    return withLock_(function () {
      const existing = rows_('clients').filter(function (r) { return r.phone === phone; })[0];
      if (existing) throw new Error('Клиент с этим номером уже есть: ' + (existing.business || existing.name));
      const row = {
        id: randomId_(10), name: c.name || '', business: c.business || '', phone: phone, email: c.email || '',
        city: c.city || '', note: c.note || '', source: 'вручную', consent: true, consent_text: c.consent_text,
        consent_at: nowIso_(), status: 'новый', attempts: 0, last_call_at: '', last_conversation_id: '', created_at: nowIso_(),
      };
      append_('clients', row);
      return { ok: true, client: row };
    });
  },
  updateClient: function (b) {
    const allowed = ['name', 'business', 'email', 'city', 'note', 'status'];
    return withLock_(function () {
      const patch = {};
      allowed.forEach(function (k) { if (b.patch && b.patch[k] !== undefined) patch[k] = b.patch[k]; });
      update_('clients', 'id', b.id, patch);
      return { ok: true };
    });
  },
  deleteClient: function (b) {
    return withLock_(function () { remove_('clients', 'id', b.id); return { ok: true }; });
  },
  call: function (b) {
    return withLock_(function () { return startCall_(b.id); });
  },
  addFound: function (b) {
    return withLock_(function () {
      const existing = rows_('found');
      const seen = {};
      existing.forEach(function (r) { seen[key_(r)] = true; });
      let added = 0;
      (b.items || []).forEach(function (it) {
        const row = {
          id: randomId_(10), business: it.business || '', category: it.category || '', city: it.city || '',
          phone: normPhone_(it.phone) || '', email: it.email || '', instagram: it.instagram || '', website: it.website || '',
          maps_url: it.maps_url || '', status: 'новый', contacted_at: '', note: it.note || '', created_at: nowIso_(),
        };
        if (!row.business || seen[key_(row)]) return;
        seen[key_(row)] = true;
        append_('found', row);
        added++;
      });
      return { ok: true, added: added };
    });
  },
  updateFound: function (b) {
    return withLock_(function () {
      const patch = {};
      ['status', 'note', 'email', 'instagram'].forEach(function (k) { if (b.patch && b.patch[k] !== undefined) patch[k] = b.patch[k]; });
      if (patch.status === 'написали') patch.contacted_at = nowIso_();
      update_('found', 'id', b.id, patch);
      return { ok: true };
    });
  },
  deleteFound: function (b) {
    return withLock_(function () { remove_('found', 'id', b.id); return { ok: true }; });
  },
  transcript: function (b) {
    const conv = el_('get', '/v1/convai/conversations/' + encodeURIComponent(b.conversation_id));
    const turns = (conv.transcript || []).filter(function (t) { return t.message; }).map(function (t) {
      return { role: t.role, text: t.message, t: t.time_in_call_secs };
    });
    return { ok: true, transcript: turns };
  },
  audio: function (b) {
    const res = UrlFetchApp.fetch(EL_API + '/v1/convai/conversations/' + encodeURIComponent(b.conversation_id) + '/audio', {
      method: 'get', headers: { 'xi-api-key': apiKey_() }, muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) throw new Error('Запись недоступна (' + res.getResponseCode() + ')');
    return { ok: true, mime: 'audio/mpeg', base64: Utilities.base64Encode(res.getBlob().getBytes()) };
  },
  usage: function () {
    const sub = el_('get', '/v1/user/subscription');
    const calls = rows_('calls');
    const tz = setting_('tz');
    const month = Utilities.formatDate(new Date(), tz, 'yyyy-MM');
    let monthCost = 0, monthSecs = 0, monthCalls = 0;
    calls.forEach(function (c) {
      if (String(c.started_at).slice(0, 7) !== month) return;
      monthCalls++;
      monthCost += Number(c.cost) || 0;
      monthSecs += Number(c.duration_s) || 0;
    });
    return {
      ok: true, tier: sub.tier, used: sub.character_count, limit: sub.character_limit,
      reset_at: sub.next_character_count_reset_unix ? new Date(sub.next_character_count_reset_unix * 1000).toISOString() : '',
      month_calls: monthCalls, month_minutes: Math.round(monthSecs / 6) / 10, month_credits: monthCost,
    };
  },
  getFirstMessage: function () {
    const agent = el_('get', '/v1/convai/agents/' + setting_('agent_id'));
    return { ok: true, first_message: (((agent.conversation_config || {}).agent) || {}).first_message || '' };
  },
  setFirstMessage: function (b) {
    const msg = String(b.first_message || '').trim();
    if (!msg) throw new Error('Первая фраза пустая');
    el_('patch', '/v1/convai/agents/' + setting_('agent_id'), { conversation_config: { agent: { first_message: msg } } });
    return { ok: true };
  },
  testPush: function () {
    push_('Проверка', 'Уведомления от Alex работают.');
    return { ok: true };
  },
};

/* ---------- страница заявки ---------- */

function publicRequest_(b) {
  if (b.website_url_hp) return { ok: true }; // ловушка для ботов
  if (b.consent !== true) return { ok: false, error: 'Consent is required' };
  const phone = normPhone_(b.phone);
  if (!phone) return { ok: false, error: 'Please enter a valid phone number' };
  const clean = function (v, n) { return String(v || '').trim().slice(0, n || 200); };
  return withLock_(function () {
    const clients = rows_('clients');
    const existing = clients.filter(function (r) { return r.phone === phone; })[0];
    const consentText = CONSENT_TEXT + ' [form ' + setting_('request_page_url') + ']';
    if (existing) {
      update_('clients', 'id', existing.id, {
        consent: true, consent_text: consentText, consent_at: nowIso_(),
        status: existing.status === 'не звонить' ? 'новый' : existing.status,
        note: [existing.note, clean(b.needs, 500)].filter(String).join(' | '),
      });
    } else {
      append_('clients', {
        id: randomId_(10), name: clean(b.name), business: clean(b.business), phone: phone, email: clean(b.email),
        city: clean(b.city), note: clean(b.needs, 500), source: 'страница', consent: true, consent_text: consentText,
        consent_at: nowIso_(), status: 'новый', attempts: 0, last_call_at: '', last_conversation_id: '', created_at: nowIso_(),
      });
    }
    // если это бизнес из «Найденных» — отметить
    rows_('found').forEach(function (f) {
      if (f.phone && f.phone === phone) update_('found', 'id', f.id, { status: 'оставил заявку' });
    });
    push_('Новая заявка', (clean(b.business) || clean(b.name) || phone) + ' просит звонок от Alex');
    return { ok: true };
  });
}

/* ---------- звонок ---------- */

function startCall_(clientId) {
  if (setting_('paused') === '1') throw new Error('Звонки на паузе (Настройки)');
  const client = rows_('clients').filter(function (r) { return r.id === clientId; })[0];
  if (!client) throw new Error('Клиент не найден');
  if (client.status === 'не звонить') throw new Error('Клиент просил не звонить');
  if (client.consent !== true && String(client.consent).toUpperCase() !== 'TRUE') throw new Error('Нет согласия клиента на звонок');
  if (!withinHours_()) throw new Error('Сейчас нельзя звонить. Часы звонков: будни ' + setting_('hours_weekday') + ', выходные ' + setting_('hours_weekend'));
  const payload = {
    agent_id: setting_('agent_id'),
    agent_phone_number_id: setting_('phone_number_id'),
    to_number: client.phone,
    conversation_initiation_client_data: {
      dynamic_variables: {
        customer_name: client.name || '',
        business_name: client.business || '',
        brand_name: setting_('brand'),
        call_reason: 'They asked for a callback about getting a website.',
      },
    },
  };
  let res;
  try {
    res = el_('post', '/v1/convai/twilio/outbound-call', payload);
  } catch (err) {
    // если агент не принимает переменные — повторить без них
    if (/dynamic/i.test(String(err))) {
      delete payload.conversation_initiation_client_data;
      res = el_('post', '/v1/convai/twilio/outbound-call', payload);
    } else {
      throw err;
    }
  }
  if (!res.success) throw new Error(res.message || 'ElevenLabs не начал звонок');
  const now = nowIso_();
  append_('calls', {
    conversation_id: res.conversation_id || ('pending-' + randomId_(8)), client_id: client.id, started_at: now, direction: 'исходящий',
    name: client.name, business: client.business, phone: client.phone, status: 'звоним',
  });
  update_('clients', 'id', client.id, {
    status: 'звоним', attempts: (Number(client.attempts) || 0) + 1, last_call_at: now, last_conversation_id: res.conversation_id || '',
  });
  return { ok: true, conversation_id: res.conversation_id };
}

/** Запускается каждый час: один повторный звонок тем, кто не ответил или попал на автоответчик. */
function retryCalls() {
  if (setting_('paused') === '1' || !withinHours_()) return;
  const max = Number(setting_('max_attempts')) || 2;
  const dayAgo = Date.now() - 20 * 3600 * 1000;
  rows_('clients').forEach(function (c) {
    if (['не ответил', 'автоответчик'].indexOf(c.status) < 0) return;
    if ((Number(c.attempts) || 0) >= max) return;
    if (c.last_call_at && new Date(c.last_call_at).getTime() > dayAgo) return;
    try {
      withLock_(function () { startCall_(c.id); });
    } catch (err) {
      Logger.log('Повтор не удался для ' + c.id + ': ' + err);
    }
  });
}

/* ---------- итоги звонков ---------- */

function handleWebhook_(body) {
  // Make может прислать тело как строку
  if (typeof body === 'string') body = JSON.parse(body);
  if (body && body.value && !body.type) body = typeof body.value === 'string' ? JSON.parse(body.value) : body.value;
  const type = body.type;
  const d = body.data || {};
  if (type === 'post_call_transcription') return withLock_(function () { return onTranscript_(d); });
  if (type === 'call_initiation_failure') return withLock_(function () { return onFailure_(d); });
  return { ok: true, ignored: type || 'unknown' };
}

function dc_(d) {
  const res = ((d.analysis || {}).data_collection_results) || {};
  const out = {};
  Object.keys(res).forEach(function (k) { out[k] = res[k] && res[k].value; });
  return out;
}

function truthy_(v) {
  return v === true || String(v).toLowerCase() === 'true' || String(v).toLowerCase() === 'yes';
}

function onTranscript_(d) {
  const f = dc_(d);
  const meta = d.metadata || {};
  const phoneCall = meta.phone_call || {};
  let call = rows_('calls').filter(function (r) { return r.conversation_id === d.conversation_id; })[0];
  let client = call ? rows_('clients').filter(function (r) { return r.id === call.client_id; })[0] : null;

  // входящий звонок: найти или создать клиента по номеру
  if (!call) {
    const ext = normPhone_(phoneCall.external_number);
    if (ext) {
      client = rows_('clients').filter(function (r) { return r.phone === ext; })[0];
      if (!client) {
        client = {
          id: randomId_(10), name: f.customer_name || '', business: f.business_name || '', phone: ext, email: f.email || '',
          city: '', note: '', source: 'входящий', consent: truthy_(f.callback_consent),
          consent_text: truthy_(f.callback_consent) ? 'Agreed to a callback during inbound call ' + d.conversation_id : '',
          consent_at: truthy_(f.callback_consent) ? nowIso_() : '', status: 'новый', attempts: 0, last_call_at: '',
          last_conversation_id: d.conversation_id, created_at: nowIso_(),
        };
        append_('clients', client);
      }
    }
    call = {
      conversation_id: d.conversation_id, client_id: client ? client.id : '', direction: 'входящий',
      started_at: meta.start_time_unix_secs ? new Date(meta.start_time_unix_secs * 1000).toISOString() : nowIso_(),
      name: client ? client.name : '', business: client ? client.business : '', phone: client ? client.phone : '',
    };
    append_('calls', call);
  }

  const voicemail = truthy_(f.reached_voicemail);
  const dnc = truthy_(f.do_not_call);
  const status = dnc ? 'просил не звонить' : voicemail ? 'автоответчик' : 'поговорили';
  update_('calls', 'conversation_id', d.conversation_id, {
    status: status, duration_s: meta.call_duration_secs || '', cost: meta.cost || '',
    summary_ru: f.summary_ru || '', site_type: f.site_type || '', budget: f.budget || '', timeline: f.timeline || '',
    email: f.email || '', best_time: f.best_time || '', interest: f.interest_level || '',
    wants_website: truthy_(f.wants_website), do_not_call: dnc, voicemail: voicemail,
    summary_en: ((d.analysis || {}).transcript_summary) || '',
  });

  if (client) {
    const patch = { status: dnc ? 'не звонить' : voicemail ? 'автоответчик' : 'поговорили', last_conversation_id: d.conversation_id };
    if (f.email && !client.email) patch.email = f.email;
    if (f.business_name && !client.business) patch.business = f.business_name;
    if (f.customer_name && !client.name) patch.name = f.customer_name;
    update_('clients', 'id', client.id, patch);
  }

  const who = (client && (client.business || client.name)) || 'Клиент';
  if (truthy_(f.wants_website)) {
    push_('Клиент хочет сайт', who + ': ' + (f.summary_ru || f.site_type || 'смотри вкладку Звонки'));
  } else if (!voicemail) {
    push_('Звонок завершён', who + ': ' + (f.summary_ru || 'итог во вкладке Звонки'));
  }
  return { ok: true };
}

function onFailure_(d) {
  const reason = d.failure_reason === 'busy' ? 'занято' : d.failure_reason === 'no-answer' ? 'не ответил' : 'ошибка звонка';
  update_('calls', 'conversation_id', d.conversation_id, { status: reason });
  const call = rows_('calls').filter(function (r) { return r.conversation_id === d.conversation_id; })[0];
  if (call && call.client_id) update_('clients', 'id', call.client_id, { status: 'не ответил' });
  return { ok: true };
}

/* ---------- ElevenLabs ---------- */

function apiKey_() {
  const k = prop_('api_key');
  if (!k) throw new Error('Не задан ключ ElevenLabs (Настройки)');
  return k;
}

function el_(method, path, payload) {
  const opts = { method: method, headers: { 'xi-api-key': apiKey_() }, muteHttpExceptions: true, contentType: 'application/json' };
  if (payload) opts.payload = JSON.stringify(payload);
  const res = UrlFetchApp.fetch(EL_API + path, opts);
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 300) throw new Error('ElevenLabs ' + code + ': ' + text.slice(0, 300));
  return text ? JSON.parse(text) : {};
}

/* ---------- уведомления (ntfy) ---------- */

function push_(title, message) {
  const topic = setting_('ntfy_topic');
  if (!topic) return;
  try {
    UrlFetchApp.fetch('https://ntfy.sh/', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ topic: topic, title: title, message: String(message).slice(0, 1000), tags: ['telephone_receiver'] }),
    });
  } catch (err) {
    Logger.log('push failed: ' + err);
  }
}

/* ---------- правила звонков ---------- */

function withinHours_() {
  const tz = setting_('tz');
  const now = new Date();
  const dow = Number(Utilities.formatDate(now, tz, 'u')); // 1 = пн ... 7 = вс
  const hm = Utilities.formatDate(now, tz, 'HH:mm');
  const range = (dow >= 6 ? setting_('hours_weekend') : setting_('hours_weekday')).split('-');
  return hm >= range[0].trim() && hm < range[1].trim();
}

/* ---------- настройки ---------- */

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }

function setting_(k) {
  const v = prop_('S_' + k);
  return v === null ? DEFAULTS[k] : v;
}

function publicSettings_() {
  const s = {};
  SETTING_KEYS.forEach(function (k) { s[k] = setting_(k); });
  s.api_key_set = !!prop_('api_key');
  s.webhook_url = ScriptApp.getService().getUrl() + '?token=' + prop_('webhook_token');
  s.consent_text = CONSENT_TEXT;
  return s;
}

/* ---------- листы ---------- */

function sheet_(kind) {
  const def = SHEETS[kind];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // телефоны как текст, чтобы не терялся «+»
    const phoneCol = def.cols.indexOf('phone');
    if (phoneCol >= 0) sh.getRange(2, phoneCol + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  }
  return sh;
}

function rows_(kind) {
  const def = SHEETS[kind];
  const sh = sheet_(kind);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  return sh.getRange(2, 1, last - 1, header.length).getValues().map(function (r) {
    const o = {};
    header.forEach(function (h, i) {
      let v = r[i];
      if (v instanceof Date) v = v.toISOString();
      o[h] = v;
    });
    return o;
  }).filter(function (o) { return o[def.cols[0]] !== ''; });
}

function append_(kind, obj) {
  const sh = sheet_(kind);
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const row = header.map(function (h) { return obj[h] === undefined ? '' : obj[h]; });
  sh.appendRow(row);
  // appendRow может превратить «+1604...» в число — перезаписать телефон как текст
  const pi = header.indexOf('phone');
  if (pi >= 0 && obj.phone) sh.getRange(sh.getLastRow(), pi + 1).setNumberFormat('@').setValue(String(obj.phone));
}

function update_(kind, keyCol, keyVal, patch) {
  if (!keyVal) return;
  const sh = sheet_(kind);
  const data = sh.getDataRange().getValues();
  const header = data[0];
  const ki = header.indexOf(keyCol);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][ki]) === String(keyVal)) {
      Object.keys(patch).forEach(function (k) {
        const ci = header.indexOf(k);
        if (ci >= 0) sh.getRange(i + 1, ci + 1).setValue(patch[k]);
      });
      return;
    }
  }
}

function remove_(kind, keyCol, keyVal) {
  const sh = sheet_(kind);
  const data = sh.getDataRange().getValues();
  const ki = data[0].indexOf(keyCol);
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][ki]) === String(keyVal)) sh.deleteRow(i + 1);
  }
}

/* ---------- мелочи ---------- */

function normPhone_(p) {
  const digits = String(p || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length >= 8 && String(p).trim()[0] === '+') return '+' + digits;
  return '';
}

function key_(r) {
  return r.phone ? 'p' + r.phone : 'b' + String(r.business).toLowerCase() + '|' + String(r.city).toLowerCase();
}

function randomId_(n) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function nowIso_() { return new Date().toISOString(); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
