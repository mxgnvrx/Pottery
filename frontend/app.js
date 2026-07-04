/* Гончарная мастерская «Глина» — фронтенд-логика всех экранов. */

'use strict';

const API_BASE = 'http://127.0.0.1:5000/api';
const PHONE_KEY = 'glina_phone';

const PROGRAM_ICONS = { WHEEL: '🏺', HANDBUILDING: '🤲' };
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
                'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда',
                  'четверг', 'пятница', 'суббота'];

/* ----------------------------- утилиты ----------------------------------- */

const pad = (n) => String(n).padStart(2, '0');

function formatTime(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* «Сегодня» / «Завтра» / «Пятница, 10 июля» — месяц остаётся со строчной. */
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = Math.round((startOfDay(d) - startOfDay(today)) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Завтра';
  const weekday = WEEKDAYS[d.getDay()];
  return `${weekday[0].toUpperCase()}${weekday.slice(1)}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/* Полная метка с датой и временем: «Сегодня, 4 июля в 18:00». */
function formatWhen(iso) {
  const d = new Date(iso);
  const label = dayLabel(iso);
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const withDate = label.includes(date) ? label : `${label}, ${date}`;
  return `${withDate} в ${formatTime(iso)}`;
}

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

/* ----------------------------- авторизация ------------------------------- */

const AUTH_KEY = 'glina_auth';

function getAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY)); }
  catch (e) { return null; }
}
function setAuth(a) { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); }
function clearAuth() { localStorage.removeItem(AUTH_KEY); }
function authHeaders() {
  const a = getAuth();
  return a ? { 'Authorization': 'Bearer ' + a.token } : {};
}

/** Дорисовывает в шапке ссылки входа/выхода и «Админку» для роли admin. */
function renderNav() {
  const nav = document.querySelector('.nav');
  if (!nav) return;
  const auth = getAuth();

  if (auth && auth.role === 'admin' &&
      !nav.querySelector('[href="admin.html"]')) {
    const a = document.createElement('a');
    a.className = 'nav__link';
    a.href = 'admin.html';
    a.textContent = 'Админка';
    if (document.body.dataset.page === 'admin') a.classList.add('nav__link--active');
    nav.appendChild(a);
  }

  const ctrl = document.createElement('a');
  ctrl.className = 'nav__link nav__link--auth';
  if (auth) {
    ctrl.href = '#';
    ctrl.textContent = 'Выйти';
    ctrl.title = auth.name;
    ctrl.addEventListener('click', (e) => {
      e.preventDefault();
      clearAuth();
      window.location.href = 'index.html';
    });
  } else {
    ctrl.href = 'login.html';
    ctrl.textContent = 'Войти';
  }
  nav.appendChild(ctrl);
}

function starsHtml(rating) {
  const full = Math.round(rating);
  let out = '';
  for (let i = 1; i <= 5; i++) {
    out += `<span class="star${i <= full ? ' star--on' : ''}">★</span>`;
  }
  return `<span class="stars" title="${rating}">${out}</span>`;
}

function placesLabel(slot) {
  if (slot.status === 'CANCELLED_BY_STUDIO') return 'Отменено мастерской';
  if (slot.remaining_places <= 0) return 'Мест нет';
  return `Свободно ${slot.remaining_places} из ${slot.capacity}`;
}

function showError(text) {
  const box = document.getElementById('error-box');
  if (!box) return;
  box.hidden = false;
  box.textContent = text;
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok && res.status !== 404) throw new Error('HTTP ' + res.status);
  return res;
}

/* ------------------------- экран 1: расписание --------------------------- */

const scheduleState = { program: 'all', days: 7, slots: [] };

async function initSchedule() {
  document.getElementById('program-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-program]');
    if (!btn) return;
    scheduleState.program = btn.dataset.program;
    document.querySelectorAll('#program-filter .chip')
      .forEach((c) => c.classList.toggle('chip--active', c === btn));
    renderSchedule();
  });

  const extendBtn = document.getElementById('extend-days');
  extendBtn.addEventListener('click', async () => {
    scheduleState.days = scheduleState.days === 7 ? 14 : 7;
    extendBtn.textContent = scheduleState.days === 7
      ? 'Показать 14 дней' : 'Показать 7 дней';
    await loadSlots();
    renderSchedule();
  });

  await loadSlots();
  renderSchedule();
}

async function loadSlots() {
  try {
    let path = '/slots';
    if (scheduleState.days !== 7) {
      const to = new Date(Date.now() + scheduleState.days * 86400000);
      path += `?date_to=${to.getFullYear()}-${pad(to.getMonth() + 1)}-${pad(to.getDate())}`;
    }
    const res = await apiGet(path);
    scheduleState.slots = (await res.json()).slots || [];
  } catch (e) {
    showError('Не удалось загрузить расписание. Проверьте, что сервер запущен.');
    console.error(e);
  }
}

function renderSchedule() {
  const list = document.getElementById('slots');
  const empty = document.getElementById('empty-state');
  const filtered = scheduleState.slots.filter(
    (s) => scheduleState.program === 'all' || s.program.code === scheduleState.program
  );

  list.innerHTML = '';
  if (filtered.length === 0) {
    empty.hidden = false;
    empty.querySelector('.empty__title').textContent =
      scheduleState.slots.length === 0
        ? 'Пока нет доступных занятий'
        : 'По выбранному фильтру занятий нет';
    return;
  }
  empty.hidden = true;

  const groups = new Map();
  for (const slot of filtered) {
    const key = slot.start_time.slice(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(slot);
  }

  for (const [, slots] of groups) {
    const section = document.createElement('section');
    section.className = 'day-group';
    const h = document.createElement('h2');
    h.className = 'day-group__title';
    h.textContent = dayLabel(slots[0].start_time);
    section.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'day-group__grid';
    for (const slot of slots) grid.appendChild(renderSlotCard(slot));
    section.appendChild(grid);
    list.appendChild(section);
  }
}

function renderSlotCard(slot) {
  const cancelled = slot.status === 'CANCELLED_BY_STUDIO';
  const full = slot.remaining_places <= 0;
  const lastPlaces = !cancelled && !full && slot.remaining_places <= 2;

  const card = document.createElement('article');
  card.className = 'card' + (cancelled ? ' card--cancelled' : '');

  const badgeClass = cancelled ? 'badge badge--cancelled'
                    : full ? 'badge badge--full'
                    : lastPlaces ? 'badge badge--last'
                    : 'badge badge--free';

  const fillPct = Math.min(100, Math.round(slot.booked_count / slot.capacity * 100));
  const barMod = cancelled || full ? 'bar__fill--full' : lastPlaces ? 'bar__fill--last' : '';

  card.innerHTML = `
    <div class="card__top">
      <div class="card__icon">${PROGRAM_ICONS[slot.program.code] || '🎨'}</div>
      <div class="card__timebox">
        <span class="card__time">${formatTime(slot.start_time)}</span>
        <span class="card__dur">${slot.duration_min} мин</span>
      </div>
      <span class="${badgeClass}">${placesLabel(slot)}</span>
    </div>
    <h3 class="card__title">${slot.program.title}</h3>
    <p class="card__meta">Мастер — ${slot.master.name} ${starsHtml(slot.master.rating)}</p>
    <div class="bar"><div class="bar__fill ${barMod}" style="width:${fillPct}%"></div></div>
    <div class="card__foot">
      <span class="card__price">${slot.program.price.toLocaleString('ru-RU')} ₽</span>
      <span class="card__action"></span>
    </div>
  `;

  const action = card.querySelector('.card__action');
  if (full && !cancelled) {
    const btn = document.createElement('span');
    btn.className = 'btn btn--disabled';
    btn.textContent = 'Мест нет';
    action.appendChild(btn);
  } else {
    const btn = document.createElement('a');
    btn.className = cancelled ? 'btn btn--ghost' : 'btn btn--primary';
    btn.href = `details.html?id=${slot.id}`;
    btn.textContent = cancelled ? 'Подробнее' : 'Записаться';
    action.appendChild(btn);
  }
  return card;
}

/* ------------------------ экран 2: карточка слота ------------------------ */

let CURRENT_SLOT = null;

async function initDetails() {
  const id = getParam('id');
  const container = document.getElementById('slot-details');
  const form = document.getElementById('booking-form');

  if (!id) {
    container.innerHTML = '<p class="empty__title">Занятие не выбрано.</p>';
    return;
  }

  try {
    const res = await apiGet(`/slots/${id}`);
    if (res.status === 404) {
      container.innerHTML = '<p class="empty__title">Занятие не найдено.</p>';
      return;
    }
    const slot = await res.json();
    CURRENT_SLOT = slot;
    renderDetails(slot, container);

    const cancelled = slot.status === 'CANCELLED_BY_STUDIO';
    const full = slot.remaining_places <= 0;
    const unavailable = document.getElementById('unavailable');

    if (cancelled) {
      unavailable.hidden = false;
      unavailable.textContent = 'Занятие отменено мастерской' +
        (slot.cancel_reason ? `: ${slot.cancel_reason.toLowerCase()}` : '') +
        '. Запись недоступна.';
    } else if (full) {
      unavailable.hidden = false;
      unavailable.textContent = 'Все места заняты. Выберите другое время в расписании.';
    } else {
      form.hidden = false;
      const phone = localStorage.getItem(PHONE_KEY);
      if (phone) document.getElementById('phone').value = phone;
      document.getElementById('rental').addEventListener('change', updateTotal);
      updateTotal();
    }
  } catch (e) {
    showError('Не удалось загрузить занятие. Проверьте сервер.');
    console.error(e);
  }

  form.addEventListener('submit', submitBooking);
}

function updateTotal() {
  const rental = document.getElementById('rental').checked;
  const total = CURRENT_SLOT.program.price + (rental ? CURRENT_SLOT.rental_price : 0);
  document.getElementById('submit-btn').textContent =
    `Подтвердить запись · ${total.toLocaleString('ru-RU')} ₽`;
}

function renderDetails(slot, container) {
  container.innerHTML = `
    <div class="detail__head">
      <div class="detail__icon">${PROGRAM_ICONS[slot.program.code] || '🎨'}</div>
      <div>
        <h1 class="detail__title">${slot.program.title}</h1>
        <p class="detail__when">${formatWhen(slot.start_time)}</p>
      </div>
    </div>
    <p class="detail__desc">${slot.program.description}</p>
    <dl class="detail__grid">
      <div class="detail__cell"><dt>Длительность</dt><dd>${slot.duration_min} минут</dd></div>
      <div class="detail__cell"><dt>Группа</dt><dd>до ${slot.program.max_capacity} человек</dd></div>
      <div class="detail__cell"><dt>Мастер</dt>
        <dd>${slot.master.name} ${starsHtml(slot.master.rating)}
        <span class="muted">(${slot.master.ratings_count})</span></dd></div>
      <div class="detail__cell"><dt>Места</dt><dd>${placesLabel(slot)}</dd></div>
    </dl>
    <p class="detail__address">📍 ${slot.studio_address}</p>
    <p class="detail__price">${slot.program.price.toLocaleString('ru-RU')} ₽ <span class="muted">за занятие</span></p>
  `;
}

async function submitBooking(evt) {
  evt.preventDefault();
  const errorBox = document.getElementById('error-box');
  errorBox.hidden = true;

  const payload = {
    slot_id: CURRENT_SLOT.id,
    customer_name: document.getElementById('name').value.trim(),
    customer_phone: document.getElementById('phone').value.trim(),
    rental: document.getElementById('rental').checked,
  };

  if (!payload.customer_name || !payload.customer_phone) {
    showError('Заполните имя и телефон.');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.status === 201) {
      const data = await res.json();
      localStorage.setItem(PHONE_KEY, payload.customer_phone);
      const params = new URLSearchParams({
        name: data.booking.customer_name,
        program: data.slot.program.title,
        when: data.slot.start_time,
        rental: data.booking.rental ? '1' : '0',
      });
      window.location.href = `success.html?${params.toString()}`;
      return;
    }

    const data = await res.json().catch(() => ({}));
    showError(data.message || data.error || 'Не удалось создать бронь.');
  } catch (e) {
    showError('Ошибка сети. Проверьте сервер.');
    console.error(e);
  }
}

/* ------------------------- экран 3: успех -------------------------------- */

function initSuccess() {
  const name = getParam('name') || 'Гость';
  const program = getParam('program') || 'занятие';
  const when = getParam('when');
  const rental = getParam('rental') === '1';

  document.getElementById('success-name').textContent = name;
  document.getElementById('success-program').textContent = program;
  if (when) {
    document.getElementById('success-when').textContent = formatWhen(when);
  }
  document.getElementById('success-rental').textContent =
    rental ? 'Инструменты и фартук — напрокат' : 'Со своими инструментами';
}

/* ------------------------- экран 4: мастера ------------------------------ */

async function initMasters() {
  const grid = document.getElementById('masters');
  try {
    const res = await apiGet('/masters');
    const masters = (await res.json()).masters || [];
    grid.innerHTML = '';
    for (const m of masters) {
      const card = document.createElement('article');
      card.className = 'master';
      card.innerHTML = `
        <div class="master__avatar">${m.name[0]}</div>
        <h3 class="master__name">${m.name}</h3>
        <p class="master__spec">${m.specialty}</p>
        <p class="master__rating">${starsHtml(m.rating)}
          <b>${m.rating}</b> <span class="muted">· ${m.ratings_count} оценок</span></p>
        <p class="master__bio">${m.bio}</p>
      `;
      grid.appendChild(card);
    }
  } catch (e) {
    showError('Не удалось загрузить мастеров. Проверьте сервер.');
    console.error(e);
  }
}

/* ------------------------- экран 5: мои записи --------------------------- */

async function initBookings() {
  const form = document.getElementById('phone-form');
  const input = document.getElementById('phone-input');

  const saved = localStorage.getItem(PHONE_KEY);
  if (saved) {
    input.value = saved;
    loadBookings(saved);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const phone = input.value.trim();
    if (phone.replace(/\D/g, '').length < 10) {
      showError('Введите номер телефона полностью (10 цифр и больше).');
      return;
    }
    document.getElementById('error-box').hidden = true;
    localStorage.setItem(PHONE_KEY, phone);
    loadBookings(phone);
  });
}

async function loadBookings(phone) {
  const list = document.getElementById('bookings');
  const empty = document.getElementById('empty-state');
  list.innerHTML = '<p class="muted">Загрузка…</p>';
  empty.hidden = true;

  try {
    const res = await apiGet(`/bookings?phone=${encodeURIComponent(phone)}`);
    const data = await res.json();
    const bookings = data.bookings || [];

    list.innerHTML = '';
    if (bookings.length === 0) {
      empty.hidden = false;
      return;
    }
    for (const b of bookings) list.appendChild(renderBookingCard(b, phone));
  } catch (e) {
    list.innerHTML = '';
    showError('Не удалось загрузить записи. Проверьте сервер.');
    console.error(e);
  }
}

function renderBookingCard(b, phone) {
  const slot = b.slot;
  const studioCancelled = slot.status === 'CANCELLED_BY_STUDIO';
  const clientCancelled = b.status === 'CANCELLED_BY_CLIENT';
  const past = new Date(slot.start_time) < new Date();

  let badge, badgeClass;
  if (studioCancelled) { badge = 'Отменено мастерской'; badgeClass = 'badge--cancelled'; }
  else if (clientCancelled) { badge = 'Отменена вами'; badgeClass = 'badge--muted'; }
  else if (past) { badge = 'Прошло'; badgeClass = 'badge--muted'; }
  else { badge = 'Подтверждена'; badgeClass = 'badge--free'; }

  const card = document.createElement('article');
  card.className = 'card booking' +
    (studioCancelled || clientCancelled ? ' card--cancelled' : '');
  card.innerHTML = `
    <div class="card__top">
      <div class="card__icon">${PROGRAM_ICONS[slot.program.code] || '🎨'}</div>
      <div class="booking__info">
        <h3 class="card__title">${slot.program.title}</h3>
        <p class="card__meta">${dayLabel(slot.start_time)}, ${formatTime(slot.start_time)}
          · мастер ${slot.master.name}</p>
        <p class="card__meta">${b.rental ? '🧰 прокат инструментов' : 'со своими инструментами'}</p>
        ${studioCancelled && slot.cancel_reason
          ? `<p class="booking__reason">Причина: ${slot.cancel_reason.toLowerCase()}</p>` : ''}
      </div>
      <span class="badge ${badgeClass}">${badge}</span>
    </div>
  `;

  if (!studioCancelled && !clientCancelled && !past) {
    const btn = document.createElement('button');
    btn.className = 'btn btn--ghost btn--small booking__cancel';
    btn.textContent = 'Отменить запись';
    btn.addEventListener('click', () => cancelBooking(b.id, phone, btn));
    card.appendChild(btn);
  }
  return card;
}

async function cancelBooking(id, phone, btn) {
  if (!confirm('Отменить запись? Место освободится для других.')) return;
  btn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/bookings/${id}/cancel`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      loadBookings(phone);
    } else {
      btn.disabled = false;
      showError(data.message || 'Не удалось отменить запись.');
    }
  } catch (e) {
    btn.disabled = false;
    showError('Ошибка сети. Проверьте сервер.');
  }
}

/* ------------------------- экран 6: вход --------------------------------- */

function initLogin() {
  const form = document.getElementById('login-form');

  document.querySelectorAll('[data-demo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [login, pass] = btn.dataset.demo.split(':');
      document.getElementById('login').value = login;
      document.getElementById('password').value = pass;
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    document.getElementById('error-box').hidden = true;
    const payload = {
      login: document.getElementById('login').value.trim(),
      password: document.getElementById('password').value,
    };
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(data.message || 'Не удалось войти.');
        return;
      }
      setAuth({ token: data.token, ...data.user });
      if (data.user.phone) localStorage.setItem(PHONE_KEY, data.user.phone);
      window.location.href =
        data.user.role === 'admin' ? 'admin.html' : 'bookings.html';
    } catch (err) {
      showError('Ошибка сети. Проверьте сервер.');
      console.error(err);
    }
  });
}

/* ------------------------- экран 7: админка ------------------------------ */

async function initAdmin() {
  const auth = getAuth();
  if (!auth || auth.role !== 'admin') {
    window.location.href = 'login.html';
    return;
  }
  document.getElementById('admin-user').textContent = auth.name;
  await loadAdminSlots();
}

async function loadAdminSlots() {
  const box = document.getElementById('admin-slots');
  box.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const res = await fetch(`${API_BASE}/admin/slots`, { headers: authHeaders() });
    if (res.status === 403 || res.status === 401) {
      clearAuth();
      window.location.href = 'login.html';
      return;
    }
    const data = await res.json();
    renderAdminSlots(data.slots || []);
  } catch (e) {
    box.innerHTML = '';
    showError('Не удалось загрузить расписание. Проверьте сервер.');
    console.error(e);
  }
}

function renderAdminSlots(slots) {
  const box = document.getElementById('admin-slots');
  box.innerHTML = '';

  const total = slots.length;
  const cancelled = slots.filter((s) => s.status === 'CANCELLED_BY_STUDIO').length;
  const booked = slots.reduce((n, s) => n + s.booked_count, 0);
  document.getElementById('admin-summary').innerHTML =
    `<span class="stat">Слотов: ${total}</span>
     <span class="stat">Записей: ${booked}</span>
     <span class="stat">Отменено: ${cancelled}</span>`;

  for (const slot of slots) {
    box.appendChild(renderAdminRow(slot));
  }
}

function renderAdminRow(slot) {
  const cancelled = slot.status === 'CANCELLED_BY_STUDIO';
  const past = new Date(slot.start_time) < new Date();

  const row = document.createElement('article');
  row.className = 'admin-row' + (cancelled ? ' admin-row--cancelled' : '')
    + (past ? ' admin-row--past' : '');

  const names = slot.bookings
    .filter((b) => b.status === 'CONFIRMED')
    .map((b) => b.customer_name).join(', ') || '—';

  row.innerHTML = `
    <div class="admin-row__main">
      <div class="admin-row__when">
        <b>${dayLabel(slot.start_time)}</b>
        <span>${formatTime(slot.start_time)}${past ? ' · прошло' : ''}</span>
      </div>
      <div class="admin-row__prog">
        ${PROGRAM_ICONS[slot.program.code] || '🎨'} ${slot.program.title}
        <span class="muted">· ${slot.master.name}</span>
      </div>
      <div class="admin-row__cap">
        <span class="badge ${cancelled ? 'badge--cancelled'
          : slot.remaining_places <= 0 ? 'badge--full' : 'badge--free'}">
          ${slot.booked_count} / ${slot.capacity}
        </span>
      </div>
    </div>
    <div class="admin-row__people">Записаны: ${names}
      ${cancelled && slot.cancel_reason
        ? `<span class="booking__reason">Отменено: ${slot.cancel_reason.toLowerCase()}</span>` : ''}
    </div>
    <div class="admin-row__actions"></div>
  `;

  const actions = row.querySelector('.admin-row__actions');

  if (cancelled) {
    actions.appendChild(makeBtn('Вернуть в расписание', 'btn--ghost',
      () => adminAction(`/admin/slots/${slot.id}/restore`, 'POST')));
  } else {
    const stepper = document.createElement('div');
    stepper.className = 'stepper';
    stepper.innerHTML = `<span class="stepper__label">Мест:</span>`;
    const minus = makeBtn('−', 'stepper__btn', () =>
      adminPatchCapacity(slot.id, slot.capacity - 1));
    const val = document.createElement('span');
    val.className = 'stepper__val';
    val.textContent = slot.capacity;
    const plus = makeBtn('+', 'stepper__btn', () =>
      adminPatchCapacity(slot.id, slot.capacity + 1));
    stepper.append(minus, val, plus);
    actions.appendChild(stepper);

    actions.appendChild(makeBtn('Отменить занятие', 'btn--danger', () => {
      const reason = prompt('Причина отмены (увидят клиенты):', 'Форс-мажор: сломалась печь');
      if (reason === null) return;
      adminAction(`/admin/slots/${slot.id}/cancel`, 'POST', { reason });
    }));
  }

  return row;
}

function makeBtn(text, cls, handler) {
  const b = document.createElement('button');
  b.className = 'btn btn--small ' + cls;
  b.textContent = text;
  b.addEventListener('click', handler);
  return b;
}

async function adminAction(path, method, body) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showError(data.message || 'Действие не выполнено.'); return; }
    document.getElementById('error-box').hidden = true;
    await loadAdminSlots();
  } catch (e) {
    showError('Ошибка сети. Проверьте сервер.');
    console.error(e);
  }
}

function adminPatchCapacity(id, capacity) {
  adminAction(`/admin/slots/${id}`, 'PATCH', { capacity });
}

/* ------------------------- маршрутизация --------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  renderNav();
  const page = document.body.dataset.page;
  if (page === 'schedule') initSchedule();
  else if (page === 'details') initDetails();
  else if (page === 'success') initSuccess();
  else if (page === 'masters') initMasters();
  else if (page === 'bookings') initBookings();
  else if (page === 'login') initLogin();
  else if (page === 'admin') initAdmin();
});
