import asyncio
import pytest

from server import _end_round, Room, Player, GameState, role_breakdown


def _make_room(dealer_hand, child_hand, bet=5):
    room = Room(room_id="TEST")
    dealer = Player(sid="d", name="Dealer", seat_index=0, hand=dealer_hand, points=300)
    child = Player(sid="c", name="Child", seat_index=1, hand=child_hand, points=300, bet_points=bet)
    room.players_by_sid = {"d": dealer, "c": child}
    room.seat_to_sid = {0: "d", 1: "c", 2: None, 3: None}
    room.state = GameState(
        phase="playing",
        wall=[],
        turn_seat=0,
        dealer_seat=0,
        dealer_first_hidden=True,
        dora_displays=[],
        results={},
    )
    return room, dealer, child


def _expected_delta(room, dealer, child, outcome):
    dealer_role = role_breakdown(dealer.hand, room.state.dora_displays)["total"]
    child_role = role_breakdown(child.hand, room.state.dora_displays)["total"]
    bet = 5#int(child.bet_points or 0)
    if outcome == "child_win":
        return bet * child_role
    return -bet * dealer_role


@pytest.mark.parametrize(
    "dealer_hand,child_hand,outcome",
    [
        # 子が合計点で勝ち
        (["6萬", "2萬"], ["6萬", "4萬"], "child_win"),
        # 子が合計点で負け
        (["9萬", "1萬"], ["8萬", "1萬"], "dealer_win"),
        # 親バーストで子勝ち
        (["9萬", "8萬"], ["1萬", "2萬"], "child_win"),
        # 子バーストで負け（ツモではない）
        (["6萬", "2萬"], ["9萬", "8萬"], "dealer_win"),
        # 5枚引きで優先勝ち
        (["9萬", "1萬"], ["1萬", "1萬", "1萬", "1萬", "1萬"], "child_win"),
        # 5枚引きで優先勝ち
        (["1萬", "1萬", "1萬", "1萬", "1萬"], ["9萬", "1萬"], "dealer_win"),
        # ツモで優先勝ち
        (["9萬", "1萬"], ["9萬", "9萬"], "child_win"),
        # ツモで優先勝ち
        (["9萬", "9萬"], ["9萬", "1萬"], "dealer_win"),
        # その他
        (["東", "東"], ["東", "東"], "dealer_win"),
        (["東", "東"], ["東", "北"], "dealer_win"),
        (["東"], ["9萬", "北"], "dealer_win"),
        (["東"], ["東", "北"], "child_win"),
        (["9萬"], ["北", "北"], "child_win"),
        (["1萬", "1萬", "1萬", "1萬", "1萬", "9萬"], ["9萬", "1萬"], "child_win"),
        (["9萬"], ["9萬"], "dealer_win"),
    ],
)
def test_end_round_patterns(monkeypatch, dealer_hand, child_hand, outcome):
    monkeypatch.setattr(asyncio, "create_task", lambda coro: None)
    room, dealer, child = _make_room(dealer_hand, child_hand)
    _end_round(room)
    delta = room.state.results["pairs"][1]["delta"]
    assert delta == _expected_delta(room, dealer, child, outcome)
