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

function formatDateTime(iso) {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} в ${formatTime(iso)}`;
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = Math.round((startOfDay(d) - startOfDay(today)) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Завтра';
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
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

  // Группировка по дням.
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
    // Мест нет: не ведём пользователя в тупик — кнопка неактивна.
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
        <p class="detail__when">${dayLabel(slot.start_time)} · ${formatDateTime(slot.start_time)}</p>
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
    document.getElementById('success-when').textContent =
      `${dayLabel(when)}, ${formatDateTime(when)}`;
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
        <p class="card__meta">${dayLabel(slot.start_time)}, ${formatDateTime(slot.start_time)}
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

/* ------------------------- маршрутизация --------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  if (page === 'schedule') initSchedule();
  else if (page === 'details') initDetails();
  else if (page === 'success') initSuccess();
  else if (page === 'masters') initMasters();
  else if (page === 'bookings') initBookings();
});
