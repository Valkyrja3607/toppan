# -*- coding: utf-8 -*-
"""
十半 (Toppan) online framework — Python backend
------------------------------------------------
- FastAPI + python-socketio (ASGI) server
- Rooms (2–4 players), seating (東/南/西/北), ready check
- Placeholder "deal/draw/discard" cycle to validate online play
- No full rules yet; easy to extend later

Run:
    uvicorn server:app --reload --port 8000

Then open http://localhost:8000 in multiple browsers to test.
"""

from __future__ import annotations
import asyncio
import random
import string
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from starlette.staticfiles import StaticFiles
import socketio  # python-socketio (ASGI)

# ---------------------- Utilities & Models ----------------------

SEATS = ["東", "南", "西", "北"]
DEFAULT_BET = 1
TARGET = 10.5
HONORS = {"東","南","西","北","白","發","中"}
INITIAL_HAND_SIZE = 1

def gen_room_id(n: int = 6) -> str:
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=n))

def make_standard_tiles() -> List[str]:
    """Return a simple 136-tile mahjong-like set (no flowers). Labels are text-based."""
    suits = [
        ("m", "萬"),  # Characters / Manzu
        ("p", "筒"),  # Dots / Pinzu
        ("s", "索"),  # Bamboo / Souzu
    ]
    tiles = []
    for code, kanji in suits:
        for num in range(1, 10):
            label = f"{num}{kanji}"
            tiles.extend([label] * 4)
    honors = ["東", "南", "西", "北", "白", "發", "中"]
    for h in honors:
        tiles.extend([h] * 4)
    random.shuffle(tiles)
    return tiles

def tile_value(label: str) -> float:
    s = (label or "").strip()
    if not s:
        return 0.0
    # 数牌: "5萬" / "7筒" / "3索"
    if len(s) >= 2 and s[0].isdigit() and s[1] in ("萬", "筒", "索"):
        return float(int(s[0]))
    # 字牌: 東南西北白發中 => 0.5
    if s in ("東", "南", "西", "北", "白", "發", "中"):
        return 0.5
    return 0.0

def hand_total(hand: List[str]) -> float:
    total_point = sum(tile_value(t) for t in hand)
    for card in hand:
        if card == "東":
            if total_point + 9.5 <= TARGET:
                total_point += 9.5
    return total_point

def is_toppan(hand):
    if hand_total(hand) == TARGET:
        return True
    return False

def is_tsumo(hand):
    if len(hand) == 2:
        if hand[0] == hand[1]:
            return True
        if hand[0][0] == hand[1][0]:
            return True
    return False

def count_role(hand: list[str], dora: list[str]) -> float:
    """役のカウント"""
    breakdown = role_breakdown(hand, dora)
    return breakdown["total"]


def role_breakdown(hand: list[str], dora: list[str]) -> dict:
    """役の内訳を返す: {total: int, items: [{name, points, multiplier}] }"""
    items = []
    total = 1
    items.append({"name": "基本", "points": 1, "multiplier": 1})

    if len(hand) == 2:
        if hand[0] == hand[1]:
            items.append({"name": "ツモ", "points": 10, "multiplier": 10})
            total += 10
        elif hand[0][0] == hand[1][0]:
            items.append({"name": "ツモ", "points": 5, "multiplier": 5})
            total += 5

    dora_points = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, "東南西北": 0, "白發中": 0}
    for card in dora:
        if len(card) == 2:
            dora_points[(int(card[0]) % 9) + 1] += 1
        if card in {"東", "南", "西", "北"}:
            dora_points["東南西北"] += 1
        if card in {"白", "發", "中"}:
            dora_points["白發中"] += 1

    dora_total = 0
    for card in hand:
        if len(card) == 2:
            dora_total += dora_points[int(card[0])]
        if card in {"東", "南", "西", "北"}:
            dora_total += dora_points["東南西北"]
        if card in {"白", "發", "中"}:
            dora_total += dora_points["白發中"]
    if dora_total:
        items.append({"name": "ドラ", "points": dora_total, "multiplier": dora_total})
        total += dora_total

    if is_toppan(hand):
        items.append({"name": "十半", "points": 10, "multiplier": 10})
        total += 10

    if hand_total(hand) > TARGET and not is_tsumo(hand):
        return {"total": 0, "items": []}

    if len(hand) >= 5:
        extra = (len(hand) - 4) * 5
        items.append({"name": f"{len(hand)}枚引き", "points": extra, "multiplier": extra})
        total += extra

    return {"total": total, "items": items}


def is_special_role(hand) -> bool:
    if is_toppan(hand):
        return True
    if is_tsumo(hand):
        return True
    if hand_total(hand) > TARGET:
        return False
    if len(hand) >= 5:
        return True
    return False


@dataclass
class Player:
    sid: str
    name: str
    seat_index: int
    hand: List[str] = field(default_factory=list)
    discards: List[str] = field(default_factory=list)  # ← 未使用だが互換で残す
    ready: bool = False
    status: str = "playing"  # "playing" | "stay" | "bust"
    points: int = 300
    initial_points: Optional[int] = None  # ← 開始前に入力した持ち点（未入力は None）
    bet_points: Optional[int] = None   # ← このラウンドのベット（子のみ）

@dataclass
class GameState:
    phase: str = "waiting"    # "waiting" | "reset_prompt" | "betting" | "playing" | "ended"
    wall: List[str] = field(default_factory=list)
    turn_seat: Optional[int] = None
    # 十半用
    dealer_seat: int = 0                # 親（東固定）
    dealer_first_hidden: bool = True    # 親の1枚目を伏せる
    dora_displays: List[str] = field(default_factory=list)  # 参考表示用
    results: Dict[int, str] = field(default_factory=dict)   # seat_index -> "win"/"lose"/"push"

@dataclass
class Room:
    room_id: str
    host_sid: Optional[str] = None
    players_by_sid: Dict[str, Player] = field(default_factory=dict)
    seat_to_sid: Dict[int, Optional[str]] = field(default_factory=lambda: {0: None, 1: None, 2: None, 3: None})
    state: GameState = field(default_factory=GameState)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def seats_filled(self) -> int:
        return sum(1 for s in self.seat_to_sid.values() if s)

    def player_sids(self) -> List[str]:
        return [sid for sid in self.seat_to_sid.values() if sid]

    def players(self) -> List[Player]:
        return [self.players_by_sid[sid] for sid in self.player_sids()]

# ---------------------- In-memory Room Manager ----------------------

class RoomManager:
    def __init__(self) -> None:
        self.rooms: Dict[str, Room] = {}
        self._global_lock = asyncio.Lock()

    async def create_room(self) -> Room:
        async with self._global_lock:
            while True:
                rid = gen_room_id()
                if rid not in self.rooms:
                    room = Room(room_id=rid)
                    self.rooms[rid] = room
                    return room

    def get_room(self, room_id: str) -> Optional[Room]:
        return self.rooms.get(room_id)

    async def remove_player(self, sid: str) -> None:
        # Remove a player from any room they are in; if room empties, delete it
        for rid, room in list(self.rooms.items()):
            if sid in room.players_by_sid:
                async with room.lock:
                    player = room.players_by_sid.pop(sid)
                    # free their seat
                    if room.seat_to_sid.get(player.seat_index) == sid:
                        room.seat_to_sid[player.seat_index] = None
                    # If host left, choose a new host
                    if room.host_sid == sid:
                        sids = room.player_sids()
                        room.host_sid = sids[0] if sids else None
                    # If empty, delete room
                    if not room.players_by_sid:
                        del self.rooms[rid]
                break

manager = RoomManager()

# ---------------------- Socket.IO Setup ----------------------

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    ping_interval=25,
    ping_timeout=60,
)
fastapi_app = FastAPI()

# Serve static files (frontend)
fastapi_app.mount("/", StaticFiles(directory="static", html=True), name="static")

app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)

# ---------------------- Helper: Broadcast State ----------------------

async def emit_room_state(room: Room) -> None:
    """Broadcast tailored state to each player (your hand vs. others' counts)."""
    for sid in room.players_by_sid.keys():
        await emit_state_to_sid(room, sid)

async def emit_player_list_to_chat(room: Room) -> None:
    """Send current player list to room chat."""
    players_sorted = sorted(room.players(), key=lambda pl: pl.seat_index)
    names = []
    for p in players_sorted:
        seat = SEATS[p.seat_index] if p.seat_index is not None else ""
        names.append(f"{p.name}{seat and f'({seat})'}")
    msg = "参加者: " + (", ".join(names) if names else "なし")
    await sio.emit("chat", {"system": True, "message": msg}, room=room.room_id)

async def emit_settlement_to_chat(room: Room, results: dict) -> None:
    """清算結果をチャットに表示する。"""
    dealer_seat = results.get("dealer_seat", room.state.dealer_seat)
    dealer_sid = room.seat_to_sid.get(dealer_seat)
    dealer = room.players_by_sid.get(dealer_sid) if dealer_sid else None
    dealer_name = dealer.name if dealer else "親"

    pairs = results.get("pairs", {})
    for seat, r in pairs.items():
        child_sid = room.seat_to_sid.get(seat)
        child = room.players_by_sid.get(child_sid) if child_sid else None
        child_name = child.name if child else f"子{seat}"

        delta = int(r.get("delta", 0))
        amount = abs(delta)
        # delta > 0 は子の得点増（親->子の支払い）
        if delta > 0:
            line1 = f"{dealer_name}->{child_name}: {amount}"
        elif delta < 0:
            line1 = f"{child_name}->{dealer_name}: {amount}"
        else:
            line1 = f"{child_name}->{dealer_name}: 0"

        lines = [line1, f"bet額: {int(r.get('bet', 0))}"]
        # 勝者側の役内訳を表示（引き分け時は子→親の順で両方見る）
        if delta > 0:
            role_items = r.get("child_roles", [])
        elif delta < 0:
            role_items = r.get("dealer_roles", [])
        else:
            role_items = r.get("child_roles", []) or r.get("dealer_roles", [])
        for item in role_items:
            lines.append(f"{item.get('name')}: {int(item.get('points', 0))}")

        await sio.emit("chat", {"system": True, "message": "\n".join(lines)}, room=room.room_id)

def minimal_player_view(p: Player, is_you: bool, state: GameState) -> dict:
    hand_view = list(p.hand)
    # あなた以外に見せるとき、親の1枚目だけ伏せる
    if not is_you and p.seat_index == state.dealer_seat and state.dealer_first_hidden and hand_view:
        hand_view = ["🀫"] + hand_view[1:]
    return {
        "seat": p.seat_index,
        "seat_label": SEATS[p.seat_index],
        "name": p.name,
        "ready": p.ready,
        "hand": hand_view,               # ← 他家も公開（ただし親1枚目のみ伏せ）
        "hand_count": len(p.hand),
        "discards": p.discards,          # 未使用
        "status": p.status,              # UI用
        "points": p.points,                 # ← 追加
        "initial_points": p.initial_points, # ← 参考（UIで未入力か判断したい時）
        "bet": p.bet_points,
    }

async def emit_state_to_sid(room: Room, sid: str) -> None:
    you_p = room.players_by_sid.get(sid)
    you_seat = you_p.seat_index if you_p else None

    players_sorted = sorted(room.players(), key=lambda pl: pl.seat_index)
    st = room.state
    payload = {
        "room_id": room.room_id,
        "host": room.host_sid,
        "phase": st.phase,
        "turn_seat": st.turn_seat,
        "wall_count": len(st.wall),
        "players": [minimal_player_view(p, is_you=(p.sid == sid), state=st) for p in players_sorted],
        "seats": SEATS,
        "dora_displays": getattr(st, "dora_displays", []),
        "results": getattr(st, "results", {}),
        "dealer_seat": st.dealer_seat,
        "dealer_first_hidden": st.dealer_first_hidden,
        "you_seat": you_seat,
    }
    await sio.emit("state", payload, to=sid)

def seat_label(i: int) -> str:
    return SEATS[i]

def first_open_seat(seat_to_sid: Dict[int, Optional[str]]) -> Optional[int]:
    for i in range(4):
        if not seat_to_sid[i]:
            return i
    return None


def _advance_turn(room: Room) -> None:
    st = room.state
    if st.turn_seat is None:
        return
    for step in range(1, 5):
        nxt = (st.turn_seat + step) % 4
        sid = room.seat_to_sid.get(nxt)
        if not sid:
            continue
        p = room.players_by_sid.get(sid)
        if p and p.status == "playing":
            st.turn_seat = nxt
            return
    # playing が誰もいない
    st.turn_seat = None

def _all_children_bet(room: Room) -> bool:
    st = room.state
    for p in room.players():
        if p.seat_index == st.dealer_seat:
            continue
        if p.bet_points is None:
            return False
    return True

def _deal_initial_tiles(room: Room, count: int = INITIAL_HAND_SIZE) -> None:
    st = room.state
    if count <= 0:
        return
    for p in room.players():
        while len(p.hand) < count and st.wall:
            p.hand.append(st.wall.pop())

def _clear_for_next_round(room: Room) -> None:
    for p in room.players():
        p.hand = []
        p.discards = []
        p.status = "playing"
        if p.seat_index != room.state.dealer_seat:
            p.bet_points = None
        else:
            p.bet_points = None

def _start_playing_phase(room: Room) -> None:
    st = room.state
    # betting時に配られていない場合の保険
    _deal_initial_tiles(room, INITIAL_HAND_SIZE)
    st.phase = "playing"
    st.turn_seat = st.dealer_seat

def _prepare_betting_phase(room: Room) -> None:
    st = room.state
    _clear_for_next_round(room)
    _deal_initial_tiles(room, INITIAL_HAND_SIZE)
    st.phase = "betting"
    st.turn_seat = None
    st.dealer_first_hidden = True
    st.results = {}

def _maybe_finish_round(room: Room) -> None:
    st = room.state
    if st.phase != "playing":
        return
    # まだ誰かが playing 中なら続行
    if any(p.status == "playing" for p in room.players()):
        return

    # 全員終了 → 親の伏せ札公開
    st.dealer_first_hidden = False

    # 清算（子 vs 親）
    players_sorted = sorted(room.players(), key=lambda pl: pl.seat_index)
    dealer = next((p for p in players_sorted if p.seat_index == st.dealer_seat), None)
    if not dealer:
        st.phase = "ended"; return

    dealer_total = hand_total(dealer.hand)
    dealer_bust = dealer_total > TARGET

    results = []
    dealer_delta = 0

    for p in players_sorted:
        if p.seat_index == st.dealer_seat:  # 親はスキップ
            continue
        bet = int(p.bet_points or 0)
        if bet <= 0:
            results.append({"child_seat": p.seat_index, "bet": 0, "outcome": "push"})
            continue

        child_total = hand_total(p.hand)
        child_bust = child_total > TARGET

        # 勝敗判定
        if child_bust and dealer_bust:
            outcome = "push"
            delta = 0
        elif child_bust:
            outcome = "dealer_win"
            delta = -bet
        elif dealer_bust:
            outcome = "child_win"
            delta = +bet
        else:
            d_child = abs(TARGET - child_total)
            d_deal  = abs(TARGET - dealer_total)
            if d_child < d_deal:
                outcome = "child_win"; delta = +bet
            elif d_child > d_deal:
                outcome = "dealer_win"; delta = -bet
            else:
                outcome = "push"; delta = 0

        # 点数移動（子のdelta。親は反対符号）
        p.points += delta
        dealer_delta -= delta

        results.append({
            "child_seat": p.seat_index,
            "child_total": child_total,
            "dealer_total": dealer_total,
            "bet": bet,
            "outcome": outcome,
            "delta_child": delta,
        })

    dealer.points += dealer_delta
    st.results = {"dealer_seat": st.dealer_seat, "pairs": results, "dealer_delta": dealer_delta}
    st.phase = "ended"

async def auto_next_round(room_id: str):
    await asyncio.sleep(3.0)  # 清算表示の小休止
    room = manager.get_room(room_id)
    if not room:
        return
    async with room.lock:
        if room.state.phase != "ended":
            return
        _start_next_round_locked(room)
    await emit_room_state(room)

def _start_next_round_locked(room: Room) -> None:
    st = room.state
    _clear_for_next_round(room)
    # 山・ドラは原則固定。次ラウンド開始前に親へリセット確認
    room.state = GameState(
        phase="reset_prompt",
        wall=st.wall,
        turn_seat=None,
        dealer_seat=st.dealer_seat,
        dealer_first_hidden=True,
        dora_displays=getattr(st, "dora_displays", []),
        results={}
    )

# ---------------------- Socket.IO Event Handlers ----------------------

@sio.event
async def connect(sid, environ, auth):
    # Nothing here; wait for join/create
    pass

@sio.event
async def disconnect(sid):
    await manager.remove_player(sid)

@sio.event
async def create_room(sid, data):
    """
    Client asks to create a room.
    data: { "name": "<player name>" }
    """
    name = (data or {}).get("name") or f"Player-{sid[:4]}"
    room = await manager.create_room()
    async with room.lock:
        seat = first_open_seat(room.seat_to_sid)
        if seat is None:
            return {"ok": False, "error": "Room is full"}
        player = Player(sid=sid, name=name, seat_index=seat)
        room.players_by_sid[sid] = player
        room.seat_to_sid[seat] = sid
        room.host_sid = sid
        await sio.save_session(sid, {"room_id": room.room_id})
        await sio.enter_room(sid, room.room_id)
    await emit_room_state(room)
    await emit_player_list_to_chat(room)
    return {"ok": True, "room_id": room.room_id}

@sio.event
async def join_room(sid, data):
    """
    Join an existing room
    data: { "room_id": "ABC123", "name": "Alice" }
    """
    if not data or "room_id" not in data:
        return {"ok": False, "error": "room_id required"}
    name = data.get("name") or f"Player-{sid[:4]}"
    room = manager.get_room(data["room_id"])
    if not room:
        return {"ok": False, "error": "Room not found"}
    async with room.lock:
        if room.seats_filled() >= 4:
            return {"ok": False, "error": "Room is full"}
        if sid in room.players_by_sid:
            return {"ok": True, "room_id": room.room_id}
        seat = first_open_seat(room.seat_to_sid)
        player = Player(sid=sid, name=name, seat_index=seat)
        room.players_by_sid[sid] = player
        room.seat_to_sid[seat] = sid
        await sio.save_session(sid, {"room_id": room.room_id})
        await sio.enter_room(sid, room.room_id)
    await emit_room_state(room)
    await emit_player_list_to_chat(room)
    return {"ok": True, "room_id": room.room_id}

@sio.event
async def set_ready(sid, data):
    """Mark yourself ready/unready. data: {"ready": bool}"""
    session = await sio.get_session(sid)
    room = manager.get_room(session.get("room_id", "")) if session else None
    if not room:
        return {"ok": False, "error": "Not in a room"}
    async with room.lock:
        p = room.players_by_sid.get(sid)
        if not p:
            return {"ok": False, "error": "Player not found"}
        p.ready = bool((data or {}).get("ready", True))
    await emit_room_state(room)
    return {"ok": True}


@sio.event
async def set_initial_points(sid, data):
    """待機中に自分の持ち点(開始時に採用)を設定。data: {"points": int}"""
    pts = (data or {}).get("points")
    try:
        pts = int(pts)
    except Exception:
        return {"ok": False, "error": "invalid points"}
    if pts < 0 or pts > 1000000:
        return {"ok": False, "error": "points out of range"}

    session = await sio.get_session(sid)
    room = manager.get_room(session.get("room_id", "")) if session else None
    if not room:
        return {"ok": False, "error": "Not in a room"}
    async with room.lock:
        p = room.players_by_sid.get(sid)
        if not p:
            return {"ok": False, "error": "Player not found"}
        if room.state.phase != "waiting":
            return {"ok": False, "error": "Game already started"}
        p.initial_points = pts
        # 既にベット設定済みなら、持ち点に合わせてクランプ
        if p.bet_points is not None and p.seat_index != room.state.dealer_seat:
            p.bet_points = max(0, min(p.bet_points, pts))
    await emit_room_state(room)
    return {"ok": True}


def _tile_sort_key(label: str) -> tuple:
    # "1萬"/"5筒"/"7索"/"東南西北白發中" 前提
    suit_order = {"萬":0, "筒":1, "索":2}
    honor_order = {"東":0, "南":1, "西":2, "北":3, "白":4, "發":5, "中":6}
    s = label.strip()
    # 数牌
    if len(s) >= 2 and s[0].isdigit():
        num = int(s[0])
        suit = s[1]
        return (0, num, suit_order.get(suit, 9))
    # 字牌
    if s in honor_order:
        return (1, honor_order[s])
    return (9, 9, 99)

@sio.event
async def start_game(sid, data):
    session = await sio.get_session(sid)
    room = manager.get_room(session.get("room_id", "")) if session else None
    if not room:
        return {"ok": False, "error": "Not in a room"}
    async with room.lock:
        if room.state.phase != "waiting":
            return {"ok": False, "error": "Game already started"}
        if not (sid == room.host_sid):
            return {"ok": False, "error": "Only host can start"}
        n_players = room.seats_filled()
        if n_players < 2:
            return {"ok": False, "error": "Need at least 2 players"}
        # 山生成（以後のラウンドでは固定）
        wall = make_standard_tiles()

        # ドラ表示牌（ゲーム影響なし／表示用）34枚
        # 毎ラウンド固定にするため、壁からは取り除かない
        dora = wall[:min(34, len(wall))]
        wall = wall[min(34, len(wall)):]

        # 点数確定＆状態初期化
        for p in room.players():
            p.points = p.initial_points if (p.initial_points is not None) else 300
            p.hand = []
            p.discards = []
            p.ready = False
            p.status = "playing"
            # ラウンド開始時に掛け金は必ず再設定
            if p.seat_index != room.state.dealer_seat:
                p.bet_points = None
            else:
                p.bet_points = None

        # 親は東（seat_index=0）固定
        room.state = GameState(
            phase="reset_prompt",
            wall=wall,
            turn_seat=None,
            dealer_seat=0,
            dealer_first_hidden=True,
            dora_displays=dora,
            results={}
        )
    await emit_room_state(room)
    return {"ok": True}


@sio.event
async def set_bet_points(sid, data):
    """待機中に子がベット額を設定。data: {"bet": int}"""
    bet = (data or {}).get("bet")
    try:
        bet = int(bet)
    except Exception:
        return {"ok": False, "error": "invalid bet"}
    if bet < 0 or bet > 10:
        return {"ok": False, "error": "bet out of range"}

    session = await sio.get_session(sid)
    room = manager.get_room(session.get("room_id", "")) if session else None
    if not room:
        return {"ok": False, "error": "Not in a room"}

    async with room.lock:
        if room.state.phase != "betting":
            return {"ok": False, "error": "Not in betting phase"}
        p = room.players_by_sid.get(sid)
        if not p:
            return {"ok": False, "error": "Player not found"}
        # 親はベット不要（無視）
        if p.seat_index == room.state.dealer_seat:
            return {"ok": False, "error": "Dealer does not bet"}
        # 所持点（開始時持ち点を優先）を超えないようにクランプ
        available = p.initial_points if p.initial_points is not None else (p.points if p.points is not None else 300)
        p.bet_points = max(0, min(bet, available))
        if room.state.phase == "betting" and _all_children_bet(room):
            _start_playing_phase(room)
    await emit_room_state(room)
    return {"ok": True}


@sio.event
async def dealer_reset(sid, data):
    """親が山のリセット可否を確定する。data: {"reset": bool}"""
    reset = bool((data or {}).get("reset", False))
    session = await sio.get_session(sid)
    room = manager.get_room(session.get("room_id", "")) if session else None
    if not room:
        return {"ok": False, "error": "Not in a room"}
    async with room.lock:
        st = room.state
        if st.phase != "reset_prompt":
            return {"ok": False, "error": "Not in reset prompt"}
        if st.dealer_seat is None:
            return {"ok": False, "error": "Dealer not set"}
        if room.seat_to_sid.get(st.dealer_seat) != sid:
            return {"ok": False, "error": "Only dealer can decide"}

        if reset:
            wall = make_standard_tiles()
            random.shuffle(wall)
            dora = wall[: min(34, len(wall))]
            st.wall = wall[min(34, len(wall)):]
            st.dora_displays = dora
        else:
            required = INITIAL_HAND_SIZE * len(room.players())
            if len(st.wall) < required:
                return {"ok": False, "error": "Wall empty. Please reset."}

        _prepare_betting_phase(room)
    await emit_room_state(room)
    return {"ok": True}


def _next_active_seat(room: Room, from_seat: int) -> Optional[int]:
    # 次の "playing" 状態の着席者へ
    for step in range(1, 5):
        nxt = (from_seat + step) % 4
        sid = room.seat_to_sid.get(nxt)
        if not sid:
            continue
        p = room.players_by_sid[sid]
        if p.status == "playing":
            return nxt
    return None

def _next_seated_seat(room: Room, from_seat: int) -> Optional[int]:
    # 次の着席者（東→南→西→北の順）
    for step in range(1, 5):
        nxt = (from_seat + step) % 4
        if room.seat_to_sid.get(nxt):
            return nxt
    return None

def _all_done(room: Room) -> bool:
    return all(p.status != "playing" for p in room.players())

def _end_round(room: Room) -> None:
    st = room.state
    st.dealer_first_hidden = False  # 親の伏せ札を公開
    # 親・子それぞれの合計
    current_dealer_seat = st.dealer_seat
    dealer_sid = room.seat_to_sid.get(current_dealer_seat)
    dealer = room.players_by_sid[dealer_sid] if dealer_sid else None
    dealer_sum = hand_total(dealer.hand) if dealer else 0.0
    dealer_breakdown = role_breakdown(dealer.hand, room.state.dora_displays) if dealer else {"total": 0, "items": []}
    dealer_role = dealer_breakdown["total"]

    results = {}
    dealer_delta = 0
    for p in room.players():
        if p.seat_index == st.dealer_seat:
            continue
        child_sum = hand_total(p.hand)
        child_breakdown = role_breakdown(p.hand, room.state.dora_displays)
        if is_special_role(p.hand):
            result_value = child_breakdown["total"]
        # バーストは即負け。親がバーストなら子が10.5以下なら勝ち
        elif child_sum > TARGET and not is_tsumo(p.hand):
            result_value = -dealer_role
        elif dealer_sum > TARGET and not is_tsumo(dealer.hand):
            result_value = child_breakdown["total"]
        else:
            if abs(TARGET - child_sum) < abs(TARGET - dealer_sum):
                result_value = child_breakdown["total"]
            elif abs(TARGET - child_sum) >= abs(TARGET - dealer_sum):
                result_value = -dealer_role

        bet = int(p.bet_points or 0)
        delta = int(bet * result_value)
        p.points = (p.points or 0) + delta
        dealer_delta -= delta
        results[p.seat_index] = {
            "result": result_value,
            "bet": bet,
            "delta": delta,
            "child_total": child_sum,
            "dealer_total": dealer_sum,
            "child_roles": child_breakdown["items"],
            "child_role_total": child_breakdown["total"],
            "dealer_roles": dealer_breakdown["items"],
            "dealer_role_total": dealer_breakdown["total"],
        }

    if dealer:
        dealer.points = (dealer.points or 0) + dealer_delta
    # 次ラウンドで必ず再設定させる
    for p in room.players():
        if p.seat_index != st.dealer_seat:
            p.bet_points = None
    st.results = {
        "dealer_seat": current_dealer_seat,
        "dealer_delta": dealer_delta,
        "pairs": results,
    }
    # 親がバーストしたら次の着席者へ交代
    if dealer_sum > TARGET and not is_tsumo(dealer.hand):
        nxt = _next_seated_seat(room, current_dealer_seat)
        if nxt is not None:
            st.dealer_seat = nxt
    st.phase = "ended"
    st.turn_seat = None
    # 清算後に必ず次ラウンド（配牌→betting）へ
    asyncio.create_task(auto_next_round(room.room_id))
    asyncio.create_task(emit_settlement_to_chat(room, st.results))

@sio.event
async def draw_tile(sid, data):
    session = await sio.get_session(sid)
    room = manager.get_room(session.get("room_id", "")) if session else None
    if not room:
        return {"ok": False, "error": "Not in a room"}
    async with room.lock:
        st = room.state
        if st.phase != "playing":
            return {"ok": False, "error": "Not in playing phase"}
        p = room.players_by_sid.get(sid)
        if not p:
            return {"ok": False, "error": "Player not found"}
        if p.seat_index != st.turn_seat:
            return {"ok": False, "error": "Not your turn"}
        if p.status != "playing":
            return {"ok": False, "error": "You are not in playing state"}
        if not st.wall:
            _end_round(room)
            await emit_room_state(room)
            return {"ok": False, "error": "Wall empty. Round ended."}
        # 引く
        tile = st.wall.pop()
        p.hand.append(tile)
        # バースト判定
        if hand_total(p.hand) > TARGET and not is_special_role(p.hand):
            p.status = "bust"
            # 親がバーストしたら即終了
            if p.seat_index == st.dealer_seat:
                _end_round(room)
            else:
                # 次のアクティブへ
                nxt = _next_active_seat(room, st.turn_seat)
                if nxt is None:
                    _end_round(room)
                else:
                    st.turn_seat = nxt
    await emit_room_state(room)
    return {"ok": True}

@sio.event
async def stay(sid, data):
    session = await sio.get_session(sid)
    room = manager.get_room(session.get("room_id", "")) if session else None
    if not room:
        return {"ok": False, "error": "Not in a room"}
    async with room.lock:
        st = room.state
        if st.phase != "playing":
            return {"ok": False, "error": "Not in playing phase"}
        p = room.players_by_sid.get(sid)
        if not p:
            return {"ok": False, "error": "Player not found"}
        if p.seat_index != st.turn_seat:
            return {"ok": False, "error": "Not your turn"}
        if p.status != "playing":
            return {"ok": False, "error": "You are not in playing state"}

        p.status = "stay"
        # 親がステイした時に特殊役なら即清算
        if p.seat_index == st.dealer_seat and is_special_role(p.hand):
            _end_round(room)
            await emit_room_state(room)
            return {"ok": True}
        nxt = _next_active_seat(room, st.turn_seat)
        if nxt is None:
            _end_round(room)
        else:
            st.turn_seat = nxt
    await emit_room_state(room)
    return {"ok": True}


@sio.event
async def chat(sid, data):
    """Simple room chat broadcast."""
    msg = ((data or {}).get("message") or "").strip()
    if not msg:
        return {"ok": False, "error": "empty message"}

    session = await sio.get_session(sid)
    room_id = session.get("room_id") if session else None
    if not room_id:
        return {"ok": False, "error": "no room"}

    room = manager.get_room(room_id)
    name = None
    seat = None
    seat_label = None
    if room and sid in room.players_by_sid:
        p = room.players_by_sid[sid]
        name = p.name
        seat = p.seat_index
        seat_label = SEATS[p.seat_index]

    # 互換のため sid も残しつつ、名前・席も送る
    payload = {
        "sid": sid,
        "name": name,              # ← これを使って表示
        "seat": seat,              # 例: 0..3
        "seat_label": seat_label,  # 例: "東"
        "message": msg
    }
    await sio.emit("chat", payload, room=room_id)
    return {"ok": True}

# -------------- Minimal REST helper (optional create-room) --------------

@fastapi_app.get("/api/new", response_class=JSONResponse)
async def api_new():
    room = await manager.create_room()
    return {"room_id": room.room_id}

# ---------------------- End server.py ----------------------
