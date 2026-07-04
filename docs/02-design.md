# Этап 2. Проектирование: архитектура и контракт API

> Отчёт о генерации архитектурного плана и схемы данных с ИИ.
> Ссылка на требования: `docs/01-analytics.md`.

## 1. Архитектура

Клиент-серверное приложение из двух независимых частей:

```
┌──────────────────────────┐        HTTP/JSON        ┌──────────────────────────┐
│  Frontend (browser)      │  ───────────────────▶   │  Backend REST API        │
│  HTML/CSS/JS,            │  ◀───────────────────   │  Python / Flask          │
│  без фреймворков         │      сырой JSON         │  in-memory «БД»          │
│  index / details /       │                         │  (словари SLOTS/BOOKINGS)│
│  success                 │                         │  атомарное бронирование  │
└──────────────────────────┘                         └──────────────────────────┘
```

* **Backend** — изолированный REST API (`backend/api.py`). Хранилище имитируется
  in-memory словарями. Отдаёт **сырой JSON**. Отвечает за фильтрацию расписания,
  валидацию и **транзакционное** бронирование.
* **Frontend** — три статических экрана (`index.html`, `details.html`,
  `success.html`) + общий `app.js`, ходит в API через `fetch`.
* Связь между слоями закрыта **контрактом API** (см. ниже). Бэкенд —
  black-box источник истины; гарантия «0 двойных броней» на его стороне (R-004).

### Почему так
* Разделение фронта и API — требование задания и упрощает ручную проверку.
* In-memory хранилище достаточно для MVP (проект учебный, легаси нет — R-015).
* Атомарность реализуется одним `threading.Lock` вокруг критической секции —
  минимально достаточно для защиты от гонки при бронировании.

## 2. Модель данных (in-memory)

### Program (программа занятия)
| Поле | Тип | Пример / примечание |
|------|-----|---------------------|
| id | str | `"wheel"` \| `"handbuilding"` |
| code | str | `WHEEL` \| `HANDBUILDING` |
| title | str | «Гончарный круг для новичков» |
| description | str | текст программы |
| max_capacity | int | **6** (круг) / **10** (лепка) |
| price | int | цена, ₽ |

### Master (мастер)
| Поле | Тип | Примечание |
|------|-----|------------|
| id | str | `"m1"` |
| name | str | «Анна» |
| rating | float | 4.9 |
| ratings_count | int | 132 |

### Slot (слот расписания) — каноническая сущность
| Поле | Тип | Примечание |
|------|-----|------------|
| id | str | `"s1"` |
| program_id | str | → Program |
| master_id | str | → Master |
| start_time | str (ISO) | `"2026-07-05T18:00"` |
| duration_min | int | 135 |
| capacity | int | вместимость слота (≤ max_capacity программы) |
| booked_count | int | сколько уже занято |
| status | str | `SCHEDULED` \| `CANCELLED_BY_STUDIO` |
| cancel_reason | str \| null | причина отмены (R-008) |
| rental_available | bool | доступен ли прокат |
| rental_price | int | цена проката (без размеров) |

Вычисляемое поле в ответе API: `remaining_places = capacity − booked_count`,
`is_bookable = status == SCHEDULED AND remaining_places > 0`.

### Booking (бронь)
| Поле | Тип | Примечание |
|------|-----|------------|
| id | str | генерируется |
| slot_id | str | → Slot |
| customer_name | str | обязательно |
| customer_phone | str | обязательно |
| rental | bool | взял ли прокат |
| status | str | `CONFIRMED` |
| created_at | str (ISO) | момент брони |

## 3. Контракт API

Базовый префикс: `/api`. Все ответы — JSON. CORS открыт (`*`) для локальной разработки.

### GET /api/slots — каталог занятий
Query-параметры (опциональны):
* `date_from` — `YYYY-MM-DD`, по умолчанию сегодня;
* `date_to` — `YYYY-MM-DD`, по умолчанию **+7 дней** (R-027).

Прошедшие слоты исключаются. Пустой период → пустой массив (empty state).

**200 OK**
```json
{
  "count": 1,
  "slots": [
    {
      "id": "s1",
      "start_time": "2026-07-04T18:00",
      "duration_min": 135,
      "status": "SCHEDULED",
      "cancel_reason": null,
      "capacity": 6,
      "booked_count": 2,
      "remaining_places": 4,
      "is_bookable": true,
      "program": {
        "code": "WHEEL",
        "title": "Гончарный круг для новичков",
        "description": "…",
        "max_capacity": 6,
        "price": 2500
      },
      "master": { "name": "Анна", "rating": 4.9, "ratings_count": 132 },
      "rental_available": true,
      "rental_price": 400,
      "studio_address": "г. Москва, ул. Гончарная, д. 12, …"
    }
  ]
}
```

### GET /api/slots/{id} — карточка занятия
* **200 OK** — объект слота (та же схема, что элемент `slots[]`).
* **404 Not Found** — `{ "error": "slot not found" }`.

### POST /api/bookings — создать бронь
Тело запроса:
```json
{ "slot_id": "s1", "customer_name": "Иван",
  "customer_phone": "+7…", "rental": true }
```

Ответы:
| Код | Когда | Тело |
|-----|-------|------|
| **201** | бронь создана | `{ "booking": {…}, "slot": {…}, "message": "Бронирование подтверждено" }` |
| **400** | нет обязательных полей | `{ "error": "customer_name is required" }` |
| **404** | слот не найден | `{ "error": "slot not found" }` |
| **409** | нет мест **или** слот отменён (R-004 / R-008) | `{ "error": "no_places" \| "slot_cancelled", "message": "…" }` |

### GET /api/health — проверка живости
`{ "status": "ok", "slots": 9 }`

## 4. Транзакционность бронирования (R-004)

Критическая секция «проверить места → записать бронь» выполняется под глобальным
`threading.Lock`. Это гарантирует, что два параллельных запроса не смогут
одновременно пройти проверку и «переполнить» слот:

```
with _booking_lock:
    slot = SLOTS[slot_id]
    if slot.status == CANCELLED_BY_STUDIO:   # R-008
        return 409
    if remaining_places <= 0:                # R-004
        return 409
    slot.booked_count += 1
    BOOKINGS[id] = {...}
```

## 5. Маршрут пользователя (frontend)

```
index.html ──выбор слота──▶ details.html ──POST /bookings 201──▶ success.html
   (GET /slots)               (GET /slots/{id})
```

---

## Приложение. Использованные промпты

**Промпт 1 (архитектура):**
> На основе требований (`01-analytics.md`) предложи архитектуру MVP: независимый
> REST API на Python/Flask с in-memory хранилищем и фронтенд на чистом HTML/CSS/JS
> из трёх экранов. Нарисуй схему связей ASCII, объясни ключевые решения. Учитывай,
> что бэкенд — black-box источник истины, а гарантия отсутствия двойных броней
> обеспечивается атомарной проверкой на сервере (R-004). Формат — чистый Markdown.

**Промпт 2 (схема данных):**
> Спроектируй модель данных для in-memory хранилища: сущности Program, Master,
> Slot, Booking. Для Slot учти статус CANCELLED_BY_STUDIO и причину отмены,
> вместимость (круг 6 / лепка 10), прокат без размеров. Выдай таблицы полей
> с типами и примерами.

**Промпт 3 (контракт API):**
> Опиши контракт REST API: GET /api/slots (с фильтром дат, дефолт 7 дней, R-027),
> GET /api/slots/{id}, POST /api/bookings. Для каждого эндпоинта — параметры,
> примеры JSON-ответов и полный список кодов (200/201/400/404/409). Явно опиши
> поведение 409 при отсутствии мест (R-004) и при отменённом слоте (R-008).

**Промпт 4 (транзакционность):**
> Покажи псевдокод атомарной секции бронирования под threading.Lock, где сначала
> проверяется статус слота (R-008), затем число мест (R-004), и только потом
> инкрементируется booked_count и создаётся бронь.
