# -*- coding: utf-8 -*-
"""
Гончарная мастерская «Глина» — Backend REST API (MVP).

Изолированный REST API на Flask. База данных имитируется в памяти
(in-memory словари). Возвращает сырой JSON.

Реализует:
  * Каталог слотов с фильтрацией расписания (дефолт — 7 дней, R-027).
  * Карточку занятия (детали слота).
  * Транзакционное бронирование с атомарной проверкой мест (R-004)
    и запретом записи на отменённые мастерской слоты (R-008).

Запуск:
    pip install -r requirements.txt
    python api.py
Сервер поднимается на http://127.0.0.1:5000
"""

import threading
import uuid
from datetime import datetime, timedelta

from flask import Flask, jsonify, request

app = Flask(__name__)

# Горизонт расписания по умолчанию — 7 дней (R-027).
DEFAULT_SCHEDULE_DAYS = 7

# Статусы слота.
STATUS_SCHEDULED = "SCHEDULED"
STATUS_CANCELLED_BY_STUDIO = "CANCELLED_BY_STUDIO"

# Замок для атомарного бронирования (защита от «двойных броней», R-004).
_booking_lock = threading.Lock()


# --------------------------------------------------------------------------- #
#  In-memory «база данных»
# --------------------------------------------------------------------------- #

STUDIO_ADDRESS = "г. Москва, ул. Гончарная, д. 12, мастерская «Глина»"

# Программы занятий. Вместимость зашита в бизнес-правилах:
#   - гончарный круг для новичков — строго до 6 человек;
#   - обычная лепка — до 10 человек.
PROGRAMS = {
    "wheel": {
        "id": "wheel",
        "code": "WHEEL",
        "title": "Гончарный круг для новичков",
        "description": "Работа на гончарном круге под пристальным вниманием мастера. "
                       "Малые группы — каждому хватит рук мастера.",
        "max_capacity": 6,
        "price": 2500,
    },
    "handbuilding": {
        "id": "handbuilding",
        "code": "HANDBUILDING",
        "title": "Лепка руками",
        "description": "Ручная лепка без круга: пласты, жгуты, фактуры. "
                       "Подходит для любого уровня.",
        "max_capacity": 10,
        "price": 1900,
    },
}

MASTERS = {
    "m1": {"id": "m1", "name": "Анна", "rating": 4.9, "ratings_count": 132},
    "m2": {"id": "m2", "name": "Пётр", "rating": 4.7, "ratings_count": 88},
    "m3": {"id": "m3", "name": "Света", "rating": 4.8, "ratings_count": 51},
    "m4": {"id": "m4", "name": "Игорь", "rating": 4.5, "ratings_count": 27},
}

# Прокат инструментов и фартука — без указания размеров (специфика брифа).
RENTAL_PRICE = 400

# Слоты и брони наполняются функцией seed_data() относительно текущей даты.
SLOTS = {}
BOOKINGS = {}


def seed_data():
    """Наполняет расписание слотами относительно текущего момента.

    Специально формируем разнообразные состояния для демонстрации:
      * свободные слоты обоих типов;
      * почти заполненный слот;
      * полностью заполненный слот (remaining_places == 0);
      * слот, отменённый мастерской (CANCELLED_BY_STUDIO);
      * «дырку» в расписании (день без занятий) — для проверки фильтра;
      * слот за пределами 7 дней — виден только через расширенный фильтр.
    """
    SLOTS.clear()
    BOOKINGS.clear()

    now = datetime.now()
    base = now.replace(hour=10, minute=0, second=0, microsecond=0)

    plan = [
        # (сдвиг в днях, час, программа, мастер, вместимость, занято, статус, причина)
        (0, 18, "wheel", "m1", 6, 2, STATUS_SCHEDULED, None),
        (1, 11, "handbuilding", "m2", 10, 5, STATUS_SCHEDULED, None),
        (1, 15, "wheel", "m3", 6, 6, STATUS_SCHEDULED, None),        # полностью занят
        (2, 12, "wheel", "m1", 6, 5, STATUS_SCHEDULED, None),        # осталось 1 место
        (2, 19, "handbuilding", "m4", 10, 0, STATUS_SCHEDULED, None),
        (3, 17, "wheel", "m2", 6, 1, STATUS_CANCELLED_BY_STUDIO,
         "Форс-мажор: сломалась печь"),
        (4, 10, "handbuilding", "m3", 10, 3, STATUS_SCHEDULED, None),
        # день 5 намеренно пуст — «дырка» в расписании
        (6, 14, "wheel", "m1", 6, 4, STATUS_SCHEDULED, None),
        (9, 13, "handbuilding", "m2", 10, 1, STATUS_SCHEDULED, None),  # за горизонтом 7 дней
    ]

    for i, (day, hour, prog, master, cap, booked, status, reason) in enumerate(plan, start=1):
        start = (base + timedelta(days=day)).replace(hour=hour)
        slot_id = "s%d" % i
        SLOTS[slot_id] = {
            "id": slot_id,
            "program_id": prog,
            "master_id": master,
            "start_time": start.isoformat(timespec="minutes"),
            "duration_min": 135,           # ~2ч15м
            "capacity": cap,
            "booked_count": booked,
            "status": status,
            "cancel_reason": reason,
            "rental_available": True,
            "rental_price": RENTAL_PRICE,
        }


# --------------------------------------------------------------------------- #
#  Сериализация
# --------------------------------------------------------------------------- #

def serialize_slot(slot):
    """Разворачивает слот в полный контракт API (с программой и мастером)."""
    program = PROGRAMS[slot["program_id"]]
    master = MASTERS[slot["master_id"]]
    remaining = slot["capacity"] - slot["booked_count"]
    return {
        "id": slot["id"],
        "start_time": slot["start_time"],
        "duration_min": slot["duration_min"],
        "status": slot["status"],
        "cancel_reason": slot["cancel_reason"],
        "capacity": slot["capacity"],
        "booked_count": slot["booked_count"],
        "remaining_places": remaining,
        "is_bookable": slot["status"] == STATUS_SCHEDULED and remaining > 0,
        "program": {
            "code": program["code"],
            "title": program["title"],
            "description": program["description"],
            "max_capacity": program["max_capacity"],
            "price": program["price"],
        },
        "master": {
            "name": master["name"],
            "rating": master["rating"],
            "ratings_count": master["ratings_count"],
        },
        "rental_available": slot["rental_available"],
        "rental_price": slot["rental_price"],
        "studio_address": STUDIO_ADDRESS,
    }


# --------------------------------------------------------------------------- #
#  CORS (фронтенд обслуживается отдельно)
# --------------------------------------------------------------------------- #

@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


# --------------------------------------------------------------------------- #
#  Роуты
# --------------------------------------------------------------------------- #

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "slots": len(SLOTS)})


@app.route("/api/slots", methods=["GET"])
def list_slots():
    """Каталог занятий.

    Query-параметры (опциональны):
      * date_from — YYYY-MM-DD, начало периода (по умолчанию — сегодня);
      * date_to   — YYYY-MM-DD, конец периода (по умолчанию — +7 дней, R-027).

    Прошедшие слоты не показываются. Если в периоде ничего нет —
    возвращается пустой список (фронтенд рисует empty state).
    """
    now = datetime.now()

    date_from_raw = request.args.get("date_from")
    date_to_raw = request.args.get("date_to")

    if date_from_raw:
        try:
            date_from = datetime.fromisoformat(date_from_raw)
        except ValueError:
            return jsonify({"error": "invalid date_from"}), 400
    else:
        date_from = now

    if date_to_raw:
        try:
            date_to = datetime.fromisoformat(date_to_raw) + timedelta(days=1)
        except ValueError:
            return jsonify({"error": "invalid date_to"}), 400
    else:
        # Горизонт по умолчанию — ближайшие 7 дней (R-027).
        date_to = now + timedelta(days=DEFAULT_SCHEDULE_DAYS)

    result = []
    for slot in SLOTS.values():
        start = datetime.fromisoformat(slot["start_time"])
        if start < now:
            continue
        if start >= date_from and start < date_to:
            result.append(serialize_slot(slot))

    result.sort(key=lambda s: s["start_time"])
    return jsonify({"slots": result, "count": len(result)})


@app.route("/api/slots/<slot_id>", methods=["GET"])
def get_slot(slot_id):
    """Карточка занятия — детали одного слота."""
    slot = SLOTS.get(slot_id)
    if slot is None:
        return jsonify({"error": "slot not found"}), 404
    return jsonify(serialize_slot(slot))


@app.route("/api/bookings", methods=["POST"])
def create_booking():
    """Бронирование места на занятии.

    Тело запроса (JSON):
      { "slot_id": str, "customer_name": str,
        "customer_phone": str, "rental": bool }

    Ответы:
      * 201 — бронь создана;
      * 400 — некорректные данные;
      * 404 — слот не найден;
      * 409 — нет мест (защита от двойных броней, R-004).
    """
    data = request.get_json(silent=True) or {}

    slot_id = data.get("slot_id")
    customer_name = (data.get("customer_name") or "").strip()
    customer_phone = (data.get("customer_phone") or "").strip()
    rental = bool(data.get("rental", False))

    if not slot_id:
        return jsonify({"error": "slot_id is required"}), 400
    if not customer_name:
        return jsonify({"error": "customer_name is required"}), 400
    if not customer_phone:
        return jsonify({"error": "customer_phone is required"}), 400

    # Атомарная секция: проверка мест и запись брони под замком,
    # чтобы исключить гонку и «двойные брони» (R-004).
    with _booking_lock:
        slot = SLOTS.get(slot_id)
        if slot is None:
            return jsonify({"error": "slot not found"}), 404

        # R-008: запрет записи на слот, отменённый мастерской.
        if slot["status"] == STATUS_CANCELLED_BY_STUDIO:
            return jsonify({
                "error": "slot_cancelled",
                "message": "Занятие отменено мастерской. Запись недоступна.",
                "cancel_reason": slot["cancel_reason"],
            }), 409

        remaining = slot["capacity"] - slot["booked_count"]
        # R-004: нет свободных мест — отклоняем бронь (защита от двойных броней).
        if remaining <= 0:
            return jsonify({
                "error": "no_places",
                "message": "Мест не осталось",
                "remaining_places": 0,
            }), 409

        booking_id = uuid.uuid4().hex[:12]
        slot["booked_count"] += 1
        BOOKINGS[booking_id] = {
            "id": booking_id,
            "slot_id": slot_id,
            "customer_name": customer_name,
            "customer_phone": customer_phone,
            "rental": rental,
            "status": "CONFIRMED",
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }

    return jsonify({
        "booking": BOOKINGS[booking_id],
        "slot": serialize_slot(SLOTS[slot_id]),
        "message": "Бронирование подтверждено",
    }), 201


@app.route("/api/bookings/<booking_id>", methods=["GET"])
def get_booking(booking_id):
    booking = BOOKINGS.get(booking_id)
    if booking is None:
        return jsonify({"error": "booking not found"}), 404
    return jsonify({
        "booking": booking,
        "slot": serialize_slot(SLOTS[booking["slot_id"]]),
    })


seed_data()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
