/* Гончарная мастерская «Глина» — общий фронтенд-скрипт для трёх экранов. */

'use strict';

const API_BASE = 'http://127.0.0.1:5000/api';

/* ----------------------------- утилиты ----------------------------------- */

function formatDateTime(iso) {
  const d = new Date(iso);
  const days = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${days[d.getDay()]}, ${pad(d.getDate())}.${pad(d.getMonth() + 1)} ` +
         `в ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function placesLabel(slot) {
  if (slot.status === 'CANCELLED_BY_STUDIO') {
    return 'Отменено мастерской';
  }
  if (slot.remaining_places <= 0) {
    return 'Мест нет';
  }
  return `Свободно ${slot.remaining_places} из ${slot.capacity}`;
}

/* ------------------------- экран 1: расписание --------------------------- */

async function initSchedule() {
  const list = document.getElementById('slots');
  const empty = document.getElementById('empty-state');
  const errorBox = document.getElementById('error-box');

  try {
    const res = await fetch(`${API_BASE}/slots`);
    if (!res.ok) throw new Error('bad status ' + res.status);
    const data = await res.json();
    const slots = data.slots || [];

    if (slots.length === 0) {
      empty.hidden = false;
      return;
    }

    list.innerHTML = '';
    for (const slot of slots) {
      list.appendChild(renderSlotCard(slot));
    }
  } catch (e) {
    errorBox.hidden = false;
    errorBox.textContent = 'Не удалось загрузить расписание. Проверьте, что сервер запущен.';
    console.error(e);
  }
}

function renderSlotCard(slot) {
  const cancelled = slot.status === 'CANCELLED_BY_STUDIO';
  const full = slot.remaining_places <= 0;

  const card = document.createElement('article');
  card.className = 'card' + (cancelled ? ' card--cancelled' : '');

  const badgeClass = cancelled ? 'badge badge--cancelled'
                    : full ? 'badge badge--full'
                    : 'badge badge--free';

  card.innerHTML = `
    <div class="card__head">
      <h3 class="card__title">${slot.program.title}</h3>
      <span class="${badgeClass}">${placesLabel(slot)}</span>
    </div>
    <p class="card__meta">${formatDateTime(slot.start_time)}</p>
    <p class="card__meta">Мастер: ${slot.master.name} ⭐ ${slot.master.rating}</p>
    <p class="card__price">${slot.program.price} ₽</p>
  `;

  if (full && !cancelled) {
    // Мест нет: не ведём пользователя в тупик, показываем неактивную кнопку.
    const btn = document.createElement('span');
    btn.className = 'btn btn--disabled card__btn';
    btn.textContent = 'Мест нет';
    card.appendChild(btn);
  } else {
    const btn = document.createElement('a');
    btn.className = 'btn btn--primary card__btn';
    btn.href = `details.html?id=${slot.id}`;
    btn.textContent = cancelled ? 'Подробнее' : 'Записаться';
    card.appendChild(btn);
  }

  return card;
}

/* ------------------------ экран 2: карточка слота ------------------------ */

let CURRENT_SLOT = null;

async function initDetails() {
  const id = getParam('id');
  const container = document.getElementById('slot-details');
  const form = document.getElementById('booking-form');
  const errorBox = document.getElementById('error-box');

  if (!id) {
    container.innerHTML = '<p class="empty">Занятие не выбрано.</p>';
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/slots/${id}`);
    if (res.status === 404) {
      container.innerHTML = '<p class="empty">Занятие не найдено.</p>';
      return;
    }
    const slot = await res.json();
    CURRENT_SLOT = slot;
    renderDetails(slot, container);

    const cancelled = slot.status === 'CANCELLED_BY_STUDIO';
    const full = slot.remaining_places <= 0;

    if (cancelled) {
      form.hidden = true;
      document.getElementById('unavailable').hidden = false;
      document.getElementById('unavailable').textContent =
        'Занятие отменено мастерской' +
        (slot.cancel_reason ? `: ${slot.cancel_reason}` : '') +
        '. Запись недоступна.';
    } else if (full) {
      form.hidden = true;
      document.getElementById('unavailable').hidden = false;
      document.getElementById('unavailable').textContent =
        'Все места заняты. Запись недоступна.';
    } else {
      form.hidden = false;
    }
  } catch (e) {
    errorBox.hidden = false;
    errorBox.textContent = 'Не удалось загрузить занятие. Проверьте сервер.';
    console.error(e);
  }

  form.addEventListener('submit', submitBooking);
}

function renderDetails(slot, container) {
  const rentalLine = slot.rental_available
    ? `<p class="detail__row">Прокат инструментов и фартука — ${slot.rental_price} ₽ (по желанию)</p>`
    : '';

  container.innerHTML = `
    <h2 class="detail__title">${slot.program.title}</h2>
    <p class="detail__row detail__when">${formatDateTime(slot.start_time)} · ${slot.duration_min} мин</p>
    <p class="detail__row">${slot.program.description}</p>
    <p class="detail__row">Мастер: <b>${slot.master.name}</b> ⭐ ${slot.master.rating}
       (${slot.master.ratings_count} оценок)</p>
    <p class="detail__row">Вместимость: до ${slot.program.max_capacity} чел.</p>
    <p class="detail__row"><b>${placesLabel(slot)}</b></p>
    ${rentalLine}
    <p class="detail__row detail__address">📍 ${slot.studio_address}</p>
    <p class="detail__price">${slot.program.price} ₽</p>
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
    errorBox.hidden = false;
    errorBox.textContent = 'Заполните имя и телефон.';
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
    errorBox.hidden = false;
    if (res.status === 409) {
      errorBox.textContent = data.message || 'Записаться не удалось: мест не осталось.';
    } else {
      errorBox.textContent = data.message || data.error || 'Не удалось создать бронь.';
    }
  } catch (e) {
    errorBox.hidden = false;
    errorBox.textContent = 'Ошибка сети. Проверьте сервер.';
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
    document.getElementById('success-when').textContent = formatDateTime(when);
  }
  document.getElementById('success-rental').textContent =
    rental ? 'Прокат инструментов и фартука — да' : 'Со своими инструментами';
}

/* ------------------------- маршрутизация --------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  if (page === 'schedule') initSchedule();
  else if (page === 'details') initDetails();
  else if (page === 'success') initSuccess();
});
