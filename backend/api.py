"""
Гончарная мастерская «Глина» — Backend REST API (MVP).

Изолированный REST API на Flask. База данных имитируется в памяти
(in-memory словари). Возвращает сырой JSON.

Реализует:
  * Каталог слотов с фильтрацией расписания (дефолт — 7 дней, R-027).
  * Карточку занятия (детали слота).
  * Транзакционное бронирование с атомарной проверкой мест (R-004)
    и запретом записи на отменённые мастерской слоты (R-008).
"""

import threading
import uuid
from datetime import datetime, timedelta

from flask import Flask, jsonify, request

app = Flask(__name__)

# Горизонт расписания по умолчанию — 7 дней (R-027).
DEFAULT_SCHEDULE_DAYS = 7

STATUS_SCHEDULED = "SCHEDULED"
STATUS_CANCELLED_BY_STUDIO = "CANCELLED_BY_STUDIO"

BOOKING_CONFIRMED = "CONFIRMED"
BOOKING_CANCELLED_BY_CLIENT = "CANCELLED_BY_CLIENT"

# Отмена брони клиентом возможна не позднее чем за 2 часа до начала
# (бриф: поздние отмены — проблема, место и глина простаивают).
CANCEL_CUTOFF_HOURS = 2

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
    "m1": {
        "id": "m1", "name": "Анна", "rating": 4.9, "ratings_count": 132,
        "specialty": "Гончарный круг",
        "bio": "Основательница мастерской. 12 лет за кругом, училась у мастеров "
               "в Гжели и Тоскане. Умеет поставить руки даже тем, кто «совсем не творческий».",
    },
    "m2": {
        "id": "m2", "name": "Пётр", "rating": 4.7, "ratings_count": 88,
        "specialty": "Лепка и глазурь",
        "bio": "Керамист-скульптор. Ведёт лепку и курс по глазурям — его фирменные "
               "«лунные» поливы разбирают в первый день после обжига.",
    },
    "m3": {
        "id": "m3", "name": "Света", "rating": 4.8, "ratings_count": 51,
        "specialty": "Гончарный круг",
        "bio": "Терпеливо объясняет центровку столько раз, сколько нужно. "
               "Любимый мастер новичков — после её занятий возвращаются чаще всего.",
    },
    "m4": {
        "id": "m4", "name": "Игорь", "rating": 4.5, "ratings_count": 27,
        "specialty": "Лепка руками",
        "bio": "Недавно в команде, но уже собрал свою аудиторию: посуда с характером, "
               "фактуры и «неправильные» формы.",
    },
}

# Прокат инструментов и фартука — без указания размеров (специфика брифа).
RENTAL_PRICE = 400
# Свободный прокатный фонд наборов инструментов на слот (R-015).
RENTAL_STOCK = 8

SLOTS = {}
BOOKINGS = {}


# Студия работает ежедневно. Каждый день — 3 занятия в фиксированное время;
# длительность 2–2.5 ч, сеансы не пересекаются, поэтому в любой момент занят
# лишь один мастер и одна группа кругов (ресурсы: 4 мастера, 10 кругов).
SESSIONS = [
    # (час, минута, длительность_мин) — 2–2.5 ч, окна без пересечений
    (11, 0, 150),   # 11:00–13:30 (2ч30м)
    (15, 0, 135),   # 15:00–17:15 (2ч15м)
    (19, 0, 120),   # 19:00–21:00 (2ч00м)
]

# Мастера по специальности (в MASTERS: m1/m3 — круг, m2/m4 — лепка).
WHEEL_MASTERS = ["m1", "m3"]
HAND_MASTERS = ["m2", "m4"]

# На сколько дней вперёд генерируем расписание: 14, чтобы и 7-, и 14-дневный
# горизонт (R-027) были полностью заполнены.
SCHEDULE_SEED_DAYS = 14

# Особые состояния для демонстрации крайних случаев на экране расписания:
#   (день, № занятия) -> модификатор заполненности/статуса.
SPECIAL_SLOTS = {
    (1, 1): {"full": True},                          # полностью занят (мест нет)
    (2, 0): {"almost": True},                        # осталось 1 место
    (2, 2): {"empty": True},                         # совсем свободно
    (3, 1): {"status": STATUS_CANCELLED_BY_STUDIO,
             "reason": "Форс-мажор: сломалась печь"},  # отменён мастерской (R-008)
}


def seed_data():
    """Наполняет расписание: студия работает ежедневно, по 3 занятия в день.

    Занятия генерируются на SCHEDULE_SEED_DAYS дней вперёд, с чередованием
    программ и мастеров и разнообразной заполненностью. Несколько слотов
    помечены особыми состояниями (полный / почти полный / свободный /
    отменённый мастерской) для демонстрации крайних случаев.
    """
    SLOTS.clear()
    BOOKINGS.clear()

    now = datetime.now()
    base = now.replace(minute=0, second=0, microsecond=0)

    idx = 0
    for day in range(SCHEDULE_SEED_DAYS):
        for s, (hour, minute, duration) in enumerate(SESSIONS):
            idx += 1

            # Программа: 1-е занятие — круг, 2-е — лепка, 3-е чередуется по дню.
            if s == 0:
                prog = "wheel"
            elif s == 1:
                prog = "handbuilding"
            else:
                prog = "wheel" if day % 2 == 0 else "handbuilding"

            if prog == "wheel":
                master = WHEEL_MASTERS[(day + s) % len(WHEEL_MASTERS)]
            else:
                master = HAND_MASTERS[(day + s) % len(HAND_MASTERS)]

            cap = PROGRAMS[prog]["max_capacity"]      # круг — 6, лепка — 10
            # Детерминированная «живая» заполненность (никогда не равна cap).
            booked = (day * 2 + s * 3) % (cap - 1)
            status = STATUS_SCHEDULED
            reason = None

            spec = SPECIAL_SLOTS.get((day, s))
            if spec:
                if spec.get("full"):
                    booked = cap
                elif spec.get("almost"):
                    booked = cap - 1
                elif spec.get("empty"):
                    booked = 0
                if spec.get("status"):
                    status = spec["status"]
                    reason = spec.get("reason")

            start = (base + timedelta(days=day)).replace(hour=hour, minute=minute)
            # Прошедшие сегодняшние сеансы не сеем — расписание остаётся «живым».
            if start < now:
                continue

            slot_id = "s%d" % idx
            SLOTS[slot_id] = {
                "id": slot_id,
                "program_id": prog,
                "master_id": master,
                "start_time": start.isoformat(timespec="minutes"),
                "duration_min": duration,
                "capacity": cap,
                "booked_count": booked,
                "status": status,
                "cancel_reason": reason,
                "rental_available": True,
                "rental_price": RENTAL_PRICE,
                "rental_stock": RENTAL_STOCK,
            }

    # Демо-брони для экрана «Мои записи» (телефон +7 900 000-00-00) —
    # привязываем к двум реальным будущим слотам, где ещё есть места.
    future = sorted(SLOTS.values(), key=lambda sl: sl["start_time"])

    def _pick(program_id, exclude=None):
        for sl in future:
            if (sl["status"] == STATUS_SCHEDULED
                    and sl["program_id"] == program_id
                    and sl["booked_count"] < sl["capacity"]
                    and sl["id"] != exclude):
                return sl
        return None

    demo_wheel = _pick("wheel")
    demo_hand = _pick("handbuilding",
                      exclude=demo_wheel["id"] if demo_wheel else None)

    if demo_wheel:
        demo_wheel["booked_count"] += 1
        BOOKINGS["demo-wheel"] = {
            "id": "demo-wheel", "slot_id": demo_wheel["id"],
            "customer_name": "Демо Клиент", "customer_phone": "+7 900 000-00-00",
            "rental": True, "status": BOOKING_CONFIRMED,
            "created_at": now.isoformat(timespec="seconds"),
        }
    if demo_hand:
        demo_hand["booked_count"] += 1
        BOOKINGS["demo-hand"] = {
            "id": "demo-hand", "slot_id": demo_hand["id"],
            "customer_name": "Демо Клиент", "customer_phone": "+7 900 000-00-00",
            "rental": False, "status": BOOKING_CONFIRMED,
            "created_at": now.isoformat(timespec="seconds"),
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
            "specialty": master["specialty"],
        },
        "rental_available": slot["rental_available"],
        "rental_price": slot["rental_price"],
        "rental_stock": slot.get("rental_stock", 0),
        "studio_address": STUDIO_ADDRESS,
    }


# --------------------------------------------------------------------------- #
#  CORS (фронтенд обслуживается отдельно)
# --------------------------------------------------------------------------- #

@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, OPTIONS"
    # Authorization обязателен: без него браузер блокирует preflight запросов
    # админки (Bearer-токен) ещё до отправки — расписание не загружается.
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
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
            "status": BOOKING_CONFIRMED,
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


def _normalize_phone(phone):
    """Сводит телефон к последним 10 цифрам для сравнения записей."""
    digits = "".join(ch for ch in (phone or "") if ch.isdigit())
    return digits[-10:]


@app.route("/api/bookings", methods=["GET"])
def list_bookings():
    """Мои записи: все брони по номеру телефона (?phone=...)."""
    key = _normalize_phone(request.args.get("phone", ""))
    if len(key) < 10:
        return jsonify({"error": "phone is required (min 10 digits)"}), 400

    items = [
        {**b, "slot": serialize_slot(SLOTS[b["slot_id"]])}
        for b in BOOKINGS.values()
        if _normalize_phone(b["customer_phone"]) == key
    ]
    items.sort(key=lambda b: b["slot"]["start_time"])
    return jsonify({"bookings": items, "count": len(items)})


@app.route("/api/bookings/<booking_id>/cancel", methods=["POST"])
def cancel_booking(booking_id):
    """Отмена брони клиентом.

    Правила (бриф: поздние отмены — проблема):
      * отменить можно не позднее чем за CANCEL_CUTOFF_HOURS часа до начала;
      * место освобождается (booked_count -= 1);
      * бронь по отменённому мастерской слоту отменять не нужно (R-008 —
        она уже помечена статусом слота).
    """
    with _booking_lock:
        booking = BOOKINGS.get(booking_id)
        if booking is None:
            return jsonify({"error": "booking not found"}), 404
        if booking["status"] != BOOKING_CONFIRMED:
            return jsonify({"error": "already_cancelled",
                            "message": "Бронь уже отменена"}), 409

        slot = SLOTS[booking["slot_id"]]
        if slot["status"] == STATUS_CANCELLED_BY_STUDIO:
            return jsonify({"error": "slot_cancelled",
                            "message": "Занятие отменено мастерской — "
                                       "бронь снимать не нужно"}), 409

        start = datetime.fromisoformat(slot["start_time"])
        if start - datetime.now() < timedelta(hours=CANCEL_CUTOFF_HOURS):
            return jsonify({
                "error": "late_cancellation",
                "message": "До начала занятия менее %d часов — отмена онлайн "
                           "недоступна, позвоните нам" % CANCEL_CUTOFF_HOURS,
            }), 409

        booking["status"] = BOOKING_CANCELLED_BY_CLIENT
        slot["booked_count"] = max(slot["booked_count"] - 1, 0)

    return jsonify({
        "booking": booking,
        "slot": serialize_slot(slot),
        "message": "Бронь отменена, место освобождено",
    })


@app.route("/api/masters", methods=["GET"])
def list_masters():
    """Команда мастерской с рейтингами."""
    masters = sorted(MASTERS.values(), key=lambda m: -m["rating"])
    return jsonify({"masters": masters, "count": len(masters)})


# --------------------------------------------------------------------------- #
#  Аутентификация и роль администратора
# --------------------------------------------------------------------------- #
#
#  Учебная схема: пароли и токены в открытом виде in-memory. В реальной
#  инфраструктуре аутентификация и админка уже существует (R-028) — здесь
#  добавлен минимальный слой, чтобы продемонстрировать роль владельца/админа
#  из исходного письма Марины («экран, где я вижу всё расписание и могу
#  что-то поправить руками»).

USERS = {
    "admin": {"password": "admin123", "role": "admin", "name": "Марина"},
    "client": {"password": "client123", "role": "client",
               "name": "Демо Клиент", "phone": "+7 900 000-00-00"},
}

# token -> username
TOKENS = {}


def _public_user(username):
    u = USERS[username]
    data = {"login": username, "role": u["role"], "name": u["name"]}
    if "phone" in u:
        data["phone"] = u["phone"]
    return data


def _auth_user():
    """Возвращает username по заголовку Authorization: Bearer <token>."""
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    return TOKENS.get(header[7:])


def require_admin():
    """Проверка прав администратора. Возвращает (username | None)."""
    username = _auth_user()
    if username and USERS.get(username, {}).get("role") == "admin":
        return username
    return None


@app.route("/api/auth/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    username = (data.get("login") or "").strip()
    password = data.get("password") or ""

    user = USERS.get(username)
    if user is None or user["password"] != password:
        return jsonify({"error": "invalid_credentials",
                        "message": "Неверный логин или пароль"}), 401

    token = uuid.uuid4().hex
    TOKENS[token] = username
    return jsonify({"token": token, "user": _public_user(username)})


@app.route("/api/auth/me", methods=["GET"])
def me():
    username = _auth_user()
    if username is None:
        return jsonify({"error": "unauthorized"}), 401
    return jsonify({"user": _public_user(username)})


def _admin_slot_view(slot):
    """Расширенное представление слота для админа — с составом брони."""
    view = serialize_slot(slot)
    # id мастера нужны форме правки для предвыбора в выпадающем списке.
    view["master_id"] = slot["master_id"]
    view["bookings"] = [
        {"id": b["id"], "customer_name": b["customer_name"],
         "customer_phone": b["customer_phone"], "rental": b["rental"],
         "status": b["status"]}
        for b in BOOKINGS.values() if b["slot_id"] == slot["id"]
    ]
    return view


@app.route("/api/admin/slots", methods=["GET"])
def admin_list_slots():
    """Всё расписание для админа — включая прошедшие и отменённые слоты."""
    if not require_admin():
        return jsonify({"error": "forbidden"}), 403
    slots = [_admin_slot_view(s) for s in SLOTS.values()]
    slots.sort(key=lambda s: s["start_time"])
    return jsonify({"slots": slots, "count": len(slots)})


@app.route("/api/admin/slots/<slot_id>/cancel", methods=["POST"])
def admin_cancel_slot(slot_id):
    """Отмена занятия мастерской/по форс-мажору (R-008)."""
    if not require_admin():
        return jsonify({"error": "forbidden"}), 403
    slot = SLOTS.get(slot_id)
    if slot is None:
        return jsonify({"error": "slot not found"}), 404

    data = request.get_json(silent=True) or {}
    reason = (data.get("reason") or "").strip() or "Отмена мастерской"
    slot["status"] = STATUS_CANCELLED_BY_STUDIO
    slot["cancel_reason"] = reason
    # R-008: брони не удаляются — остаются со статусом отменённого слота.
    return jsonify({"slot": _admin_slot_view(slot),
                    "message": "Занятие отменено, клиенты будут уведомлены"})


@app.route("/api/admin/slots/<slot_id>/restore", methods=["POST"])
def admin_restore_slot(slot_id):
    """Вернуть ошибочно отменённое занятие в расписание."""
    if not require_admin():
        return jsonify({"error": "forbidden"}), 403
    slot = SLOTS.get(slot_id)
    if slot is None:
        return jsonify({"error": "slot not found"}), 404

    slot["status"] = STATUS_SCHEDULED
    slot["cancel_reason"] = None
    return jsonify({"slot": _admin_slot_view(slot),
                    "message": "Занятие возвращено в расписание"})


@app.route("/api/admin/slots/<slot_id>", methods=["PATCH"])
def admin_update_slot(slot_id):
    """Ручная правка слота владельцем — «поправить, если что-то пошло не так».

    Принимает любой набор полей (все опциональны):
      * capacity     — число мест (в пределах максимума программы, не ниже брони);
      * master_id    — заменить мастера (например, если исходный заболел);
      * start_time   — перенести дату/время (ISO 8601, напр. 2026-07-10T15:00);
      * duration_min — длительность в минутах (30–300).
    """
    if not require_admin():
        return jsonify({"error": "forbidden"}), 403
    slot = SLOTS.get(slot_id)
    if slot is None:
        return jsonify({"error": "slot not found"}), 404

    data = request.get_json(silent=True) or {}

    if "capacity" in data:
        try:
            capacity = int(data["capacity"])
        except (TypeError, ValueError):
            return jsonify({"error": "invalid capacity"}), 400
        program_max = PROGRAMS[slot["program_id"]]["max_capacity"]
        if capacity < slot["booked_count"]:
            return jsonify({"error": "capacity_below_booked",
                            "message": "Вместимость не может быть меньше числа "
                                       "уже записанных (%d)" % slot["booked_count"]}), 409
        if capacity > program_max:
            return jsonify({"error": "capacity_above_max",
                            "message": "Максимум для этой программы — %d" % program_max}), 409
        slot["capacity"] = capacity

    if "master_id" in data:
        master_id = data["master_id"]
        if master_id not in MASTERS:
            return jsonify({"error": "invalid_master",
                            "message": "Такого мастера нет"}), 400
        slot["master_id"] = master_id

    if "start_time" in data:
        try:
            new_start = datetime.fromisoformat(data["start_time"])
        except (TypeError, ValueError):
            return jsonify({"error": "invalid_start_time",
                            "message": "Некорректные дата/время"}), 400
        slot["start_time"] = new_start.isoformat(timespec="minutes")

    if "duration_min" in data:
        try:
            duration = int(data["duration_min"])
        except (TypeError, ValueError):
            return jsonify({"error": "invalid duration"}), 400
        if not 30 <= duration <= 300:
            return jsonify({"error": "duration_out_of_range",
                            "message": "Длительность — от 30 до 300 минут"}), 400
        slot["duration_min"] = duration

    return jsonify({"slot": _admin_slot_view(slot),
                    "message": "Слот обновлён"})


seed_data()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
