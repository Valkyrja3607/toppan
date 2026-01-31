// client.js (fixed, safe DOM bootstrap & single socket instance)
(() => {
  // ---- Utilities ----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let DOM_READY = false;
  let PENDING_STATES = [];
  let TileRenderer = null;
  let socket = null;

  // game-local states
  let lastState = null;
  let lastPhase = null;
  let lastBetSent = null;
  let betConfirmedRound = false;
  let mySeat = null;
  let seats = ["東", "南", "西", "北"];

  // UI cache
  const UI = {};
  function cacheUI() {
    UI.tableEl = $("#table");
    UI.status = $("#status");

    UI.phaseEl = $("#phase");
    UI.turnEl = $("#turn");
    UI.wallEl = $("#wall");
    UI.betNotice = $("#betNotice");
    UI.betPanel = $("#betPanel");
    UI.betConfirm = $("#betConfirm");
    UI.resetPanel = $("#resetPanel");
    UI.resetYes = $("#resetYes");
    UI.resetNo = $("#resetNo");
    UI.statsBar = $("#statsBar");

    UI.bottomHand = $("#bottomHand");
    UI.bottomRiver = $("#bottomRiver");
    UI.topHand = $("#topHand");
    UI.topRiver = $("#topRiver");
    UI.leftHand = $("#leftHand");
    UI.leftRiver = $("#leftRiver");
    UI.rightHand = $("#rightHand");
    UI.rightRiver = $("#rightRiver");

    UI.leftName = $("#leftName");
    UI.rightName = $("#rightName");
    UI.topName = $("#topName");
    UI.bottomName = $("#bottomName");

    UI.leftSeatWind = $("#leftSeatWind");
    UI.rightSeatWind = $("#rightSeatWind");
    UI.topSeatWind = $("#topSeatWind");
    UI.bottomSeatWind = $("#bottomSeatWind");

    UI.playerName = $("#playerName");
    UI.roomId = $("#roomId");

    UI.btnCreate = $("#btnCreate");
    UI.btnJoin = $("#btnJoin");
    UI.btnReady = $("#btnReady");
    UI.btnUnready = $("#btnUnready");
    UI.btnStart = $("#btnStart");
    UI.btnDraw = $("#btnDraw");
    UI.btnStay = $("#btnStay");

    UI.chatLog = $("#chatLog");
    UI.chatMsg = $("#chatMsg");
    UI.btnChat = $("#btnChat");

    UI.mahjongTable = document.getElementById("mahjongTable");
    UI.actionBar = document.getElementById("actionBar");

    UI.doraRibbon = $("#doraRibbon");
    UI.doraTiles = $("#doraTiles");

    UI.leftSeat = $("#leftSeat");
    UI.topSeat = $("#topSeat");
    UI.rightSeat = $("#rightSeat");
    UI.bottomSeat = $("#bottomSeat");

    UI.startPoints = $("#startPoints");
    UI.betPoints = $("#betPoints");
  }

  function ensureUIReady() {
    if (!DOM_READY) return false;
    if (!UI.phaseEl) cacheUI();
    return !!UI.phaseEl; // キー要素
  }

  function info(msg) {
    if (UI.status) UI.status.textContent = msg;
    else console.log("[status]", msg);
  }

  // ---- Socket + App bootstrap after DOM ready ----
  document.addEventListener("DOMContentLoaded", async () => {
    DOM_READY = true;
    cacheUI();

    // ---- 下家の手牌とボタンを横並びにするラッパーを作成 ----
    const bottomSeatEl = document.getElementById("bottomSeat");
    if (bottomSeatEl && UI.bottomHand && UI.actionBar) {
      let row = document.getElementById("bottomRow");
      if (!row) {
        row = document.createElement("div");
        row.id = "bottomRow";
        // bottomHand の直前に差し込む
        bottomSeatEl.insertBefore(row, UI.bottomHand);
      }
      // 左にボタン、右に手牌
      row.appendChild(UI.actionBar);
      row.appendChild(UI.bottomHand);
    }

    // ---- 持ち点入力（なければ作る）----
    if (!UI.startPoints) {
      UI.startPoints = document.createElement("input");
      UI.startPoints.type = "number";
      UI.startPoints.id = "startPoints";
      UI.startPoints.placeholder = "持ち点(300)";
      UI.startPoints.value = "300";
      UI.startPoints.min = "0";
      UI.startPoints.step = "10";
      UI.startPoints.className = "pts-input";
      // 一番左に置く
      UI.actionBar?.insertBefore(UI.startPoints, UI.actionBar.firstChild);
    }
    // 変更時にサーバへ送る
    UI.startPoints?.addEventListener("change", () => {
      const v = parseInt(UI.startPoints.value, 10);
      const pts = Number.isFinite(v) ? v : 300;
      socket.emit("set_initial_points", { points: pts }, (ack) => {
        if (!ack?.ok) info(ack?.error || "持ち点設定エラー");
      });
    });

    // ---- 掛け金入力（子のみ・待機中）----
    if (!UI.betPoints) {
      UI.betPoints = document.createElement("input");
      UI.betPoints.type = "number";
      UI.betPoints.id = "betPoints";
      UI.betPoints.placeholder = "掛け金";
      UI.betPoints.value = "1";
      UI.betPoints.min = "0";
      UI.betPoints.step = "1";
      UI.betPoints.max = "10";
      UI.betPoints.className = "pts-input";
      const insertAfter = UI.startPoints?.nextSibling || UI.actionBar?.firstChild;
      UI.actionBar?.insertBefore(UI.betPoints, insertAfter);
    }
    if (!UI.betConfirm) {
      UI.betConfirm = document.createElement("button");
      UI.betConfirm.id = "betConfirm";
      UI.betConfirm.className = "btn btn-accent";
      UI.betConfirm.textContent = "ベット確定";
    }
    if (!UI.resetYes) {
      UI.resetYes = document.createElement("button");
      UI.resetYes.id = "resetYes";
      UI.resetYes.className = "btn btn-accent";
      UI.resetYes.textContent = "リセット";
    }
    if (!UI.resetNo) {
      UI.resetNo = document.createElement("button");
      UI.resetNo.id = "resetNo";
      UI.resetNo.className = "btn btn-ghost";
      UI.resetNo.textContent = "リセットしない";
    }
    UI.betPoints?.addEventListener("change", () => {
      const v = parseInt(UI.betPoints.value, 10);
      if (!Number.isFinite(v)) UI.betPoints.value = "0";
      betConfirmedRound = false;
    });
    UI.betConfirm?.addEventListener("click", () => {
      const v = parseInt(UI.betPoints?.value ?? "", 10);
      const bet = Number.isFinite(v) ? v : 0;
      lastBetSent = bet;
      socket.emit("set_bet_points", { bet }, (ack) => {
        if (!ack?.ok) info(ack?.error || "掛け金設定エラー");
        else betConfirmedRound = true;
      });
    });
    UI.resetYes?.addEventListener("click", () => {
      socket.emit("dealer_reset", { reset: true }, (ack) => {
        if (!ack?.ok) info(ack?.error || "リセットエラー");
      });
    });
    UI.resetNo?.addEventListener("click", () => {
      socket.emit("dealer_reset", { reset: false }, (ack) => {
        if (!ack?.ok) info(ack?.error || "リセットエラー");
      });
    });

    // Load SVG tile renderer (safe even if missing)
    try {
      TileRenderer = await import("./tile_renderer.js?v=20250831-5");
      console.log("[tile] SVG renderer loaded");
    } catch (e) {
      console.warn("[tile] failed to load renderer", e);
    }

    // Init socket
    socket = io("/", { path: "/socket.io", transports: ["websocket", "polling"] });
    socket.on("connect", () => console.log("[socket] connected", socket.id));
    socket.on("connect_error", (e) => console.error("[socket] connect_error", e));
    socket.on("error", (e) => console.error("[socket] error", e));

    // State flow: render now if UI ready, otherwise queue
    socket.on("state", (state) => {
      lastState = state;
      seats = state.seats || seats;
      // --- 自席は初回だけ確定（以後は固定して上書きしない）---
      if (typeof mySeat !== "number") {
        if (typeof state.you_seat === "number") {
          mySeat = state.you_seat;
        } else {
          // 初回未確定は保留
          PENDING_STATES.push(state);
          return;
        }
      }
      mySeat = state.you_seat;
      // 溜まっていた分を先に描画
      if (PENDING_STATES.length) {
        const q = PENDING_STATES.slice();
        PENDING_STATES.length = 0;
        q.forEach(safeRender);
      }
      if (ensureUIReady()) safeRender(state);
      else PENDING_STATES.push(state);
    });

    socket.on("chat", (p) => {
      const who = p.name || (p.sid ? p.sid.slice(0, 4) : "");
      const wind = p.seat_label || (lastState?.seats?.[p.seat] ?? "");
      const prefix = who ? `${who}${wind ? `（${wind}）` : ""}: ` : "";
      appendChat(`${prefix}${p.message}`);
    });

    // Wire buttons
    if (UI.btnCreate) UI.btnCreate.onclick = () => {
      const name = (UI.playerName?.value || "Player");
      socket.emit("create_room", { name }, (ack) => {
        console.log("[create_room ack]", ack);
        if (!ack?.ok) return info(ack?.error || "エラー");
        UI.tableEl?.classList.remove("hidden");
        if (UI.roomId) UI.roomId.value = ack.room_id;
        info(`ルーム作成: ${ack.room_id}`);
      });
    };

    if (UI.btnJoin) UI.btnJoin.onclick = () => {
      const name = (UI.playerName?.value || "Player");
      const rid = (UI.roomId?.value || "").trim();
      if (!rid) return info("ルームIDを入力してください");
      socket.emit("join_room", { room_id: rid, name }, (ack) => {
        console.log("[join_room ack]", ack);
        if (!ack?.ok) return info(ack?.error || "エラー");
        UI.tableEl?.classList.remove("hidden");
        info(`ルーム参加: ${rid}`);
      });
    };

    if (UI.btnReady) UI.btnReady.onclick = () =>
      socket.emit("set_ready", { ready: true }, (ack) => {
        if (!ack?.ok) info(ack?.error || "準備エラー");
      });

    if (UI.btnUnready) UI.btnUnready.onclick = () =>
      socket.emit("set_ready", { ready: false }, (ack) => {
        if (!ack?.ok) info(ack?.error || "準備解除エラー");
      });

    if (UI.btnStart) UI.btnStart.onclick = () =>
      socket.emit("start_game", {}, (ack) => {
        if (!ack?.ok) info(ack?.error || "開始エラー（ホストのみ/全員準備/2人以上）");
      });

    if (UI.btnDraw) UI.btnDraw.onclick = () =>
      socket.emit("draw_tile", {}, (ack) => {
        if (!ack?.ok) info(ack?.error || "ツモエラー");
      });

    if (!UI.btnStay) {
      UI.btnStay = document.createElement("button");
      UI.btnStay.id = "btnStay";
      UI.btnStay.className = "btn btn-ghost";
      UI.btnStay.textContent = "ステイ";
      UI.actionBar?.appendChild(UI.btnStay);
    }
    if (UI.btnStay) {
      UI.btnStay.onclick = () => {
        socket.emit("stay", {}, (ack) => {
          if (!ack?.ok) info(ack?.error || "ステイエラー");
        });
      };
    }

    if (UI.btnChat) UI.btnChat.onclick = () => {
      const m = (UI.chatMsg?.value || "").trim();
      if (!m) return;
      socket.emit("chat", { message: m });
      if (UI.chatMsg) UI.chatMsg.value = "";
    };

    // Flush any queued states (precaution)
    if (PENDING_STATES.length) {
      const q = PENDING_STATES.slice();
      PENDING_STATES.length = 0;
      q.forEach(safeRender);
    }
  });

  // ---- Rendering ----
  function safeRender(state) {
    try { render(state); } catch (e) { console.error("[render error]", e); }
  }

  function render(state) {
    if (!ensureUIReady()) return;
    const { players, phase, turn_seat, wall_count } = state;
    const mySeatEff = (typeof mySeat === "number") ? mySeat : null;
    if (typeof mySeatEff !== "number") return;
    if (phase !== lastPhase) {
      lastPhase = phase;
      if (phase !== "betting") lastBetSent = null;
      betConfirmedRound = false;
    }

    // ← これを既存のテキスト更新の前後どちらかに入れてください
    const isWaiting = (phase === "waiting");
    const isReset = (phase === "reset_prompt");
    const isBetting = (phase === "betting");
    ["btnReady", "btnUnready"].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.classList.add("hidden");
    });
    if (UI.btnStart) UI.btnStart.classList.toggle("hidden", !isWaiting);
    if (UI.mahjongTable) UI.mahjongTable.classList.toggle("playing", !isWaiting);
    if (UI.startPoints) UI.startPoints.classList.toggle("hidden", !isWaiting);
    if (UI.betPoints) {
      const isDealer = (typeof mySeatEff === "number") && (state.dealer_seat === mySeatEff);
      UI.betPoints.classList.toggle("hidden", !isBetting || isDealer);
    }
    if (UI.betNotice) {
      const isDealer = (typeof mySeatEff === "number") && (state.dealer_seat === mySeatEff);
      UI.betNotice.classList.toggle("hidden", !isBetting || isDealer);
    }
    if (UI.betPanel) {
      const isDealer = (typeof mySeatEff === "number") && (state.dealer_seat === mySeatEff);
      const showPanel = isBetting && !isDealer;
      UI.betPanel.classList.toggle("hidden", !showPanel);
      if (showPanel && UI.betPanel) {
        UI.betPanel.textContent = "掛け金: ";
        if (UI.betPoints && UI.betPoints.parentElement !== UI.betPanel) {
          UI.betPanel.appendChild(UI.betPoints);
        } else if (UI.betPoints) {
          UI.betPanel.appendChild(UI.betPoints);
        }
        if (UI.betConfirm && UI.betConfirm.parentElement !== UI.betPanel) {
          UI.betPanel.appendChild(UI.betConfirm);
        } else if (UI.betConfirm) {
          UI.betPanel.appendChild(UI.betConfirm);
        }
      } else if (!showPanel && UI.betPoints && UI.actionBar && UI.betPoints.parentElement !== UI.actionBar) {
        UI.actionBar.insertBefore(UI.betPoints, UI.actionBar.firstChild);
      }
    }
    if (UI.resetPanel) {
      const isDealer = (typeof mySeatEff === "number") && (state.dealer_seat === mySeatEff);
      const showReset = isReset;
      UI.resetPanel.classList.toggle("hidden", !showReset);
      if (showReset) {
        UI.resetPanel.innerHTML = isDealer
          ? `<span class="reset-label">山をリセットしますか？</span>`
          : `<span class="reset-label">親が山のリセットを選択中...</span>`;
        if (isDealer) {
          if (UI.resetYes && UI.resetYes.parentElement !== UI.resetPanel) UI.resetPanel.appendChild(UI.resetYes);
          if (UI.resetNo && UI.resetNo.parentElement !== UI.resetPanel) UI.resetPanel.appendChild(UI.resetNo);
        }
      }
    }

    // 既存の表示更新
    UI.tableEl?.classList.remove("hidden");
    if (UI.phaseEl) UI.phaseEl.textContent = phase;
    if (UI.turnEl) UI.turnEl.textContent = (turn_seat != null) ? state.seats[turn_seat] : "-";
    if (UI.wallEl) UI.wallEl.textContent = wall_count;

    // --- ドラ帯描画（34枚を並べ替え表示） ---
    if (Array.isArray(state.dora_displays)) {
      drawDora(UI.doraTiles, state.dora_displays);
      // 待機中以外は表示（betting/playing/ended）
      UI.doraRibbon?.classList.toggle("hidden", state.phase === "waiting");
    }

    // readiness & start availability
    const nPlayers = players.length;
    const isHost = (state.host === socket.id);
    const canStart = (phase === "waiting") && nPlayers >= 2 && isHost;

    if (UI.btnStart) {
      UI.btnStart.disabled = !canStart;
      UI.btnStart.classList.toggle("btn-disabled", !canStart);
      UI.btnStart.title = canStart ? "" : "開始条件：2人以上 / (ホスト) or (全員準備OK)";
    }
    info(`参加人数: ${nPlayers}`);

    const ordered = orderByRelativeSeat(players, mySeatEff);
    setSeatUI(ordered, turn_seat);

    const seatElByIndex = {
      [ordered.left?.seat ?? -1]: UI.leftSeat,
      [ordered.top?.seat ?? -1]: UI.topSeat,
      [ordered.right?.seat ?? -1]: UI.rightSeat,
      [ordered.me?.seat ?? -1]: UI.bottomSeat,
    };

    // いったん全席からクラスを外す
    [UI.leftSeat, UI.topSeat, UI.rightSeat, UI.bottomSeat].forEach(el => {
      if (!el) return;
      el.classList.remove("is-turn", "is-dealer");
    });

    // 親（dealer_seat）にバッジ
    if (state.dealer_seat != null) {
      const dEl = seatElByIndex[state.dealer_seat];
      if (dEl) dEl.classList.add("is-dealer");
    }

    // 手番（turn_seat）に光る枠
    if (state.turn_seat != null) {
      const tEl = seatElByIndex[state.turn_seat];
      if (tEl) tEl.classList.add("is-turn");
    }

    // 中央の「手番」表示も名前込みに（例: 東・Name）
    const turnP = state.players.find(p => p.seat === state.turn_seat);
    if (UI.turnEl) UI.turnEl.textContent =
      (turnP ? `${state.seats[state.turn_seat]}・${turnP.name}` : "-");

    // Bottom (me)
    const me = players.find((p) => p.seat === mySeatEff);
    if (UI.bottomHand) UI.bottomHand.innerHTML = "";
    if (me) {
      if (UI.statsBar) UI.statsBar.classList.add("hidden");
      if (UI.betPoints && typeof me.bet === "number") {
        UI.betPoints.value = String(me.bet);
      }
      // betting中の自動送信は行わない（必ず手動で確定）
      me.hand.forEach((tile, idx) => {
        UI.bottomHand?.appendChild(tileNode(tile, false));
      });
      drawRiver(UI.bottomRiver, me.discards);
    }

    // Others
    ["left", "top", "right"].forEach((who) => {
      const p = ordered[who];
      const handEl = UI[who + "Hand"];
      const riverEl = UI[who + "River"];
      if (handEl) handEl.innerHTML = "";
      if (riverEl) riverEl.innerHTML = "";
      if (!p || p.seat === mySeatEff) return;

      const hand = Array.isArray(p.hand) ? p.hand : [];
      hand.forEach((t) => {
        if (t === "🀫" || t === "BACK") {
          handEl?.appendChild(backNode(true));
        } else {
          handEl?.appendChild(tileNode(t, true)); // ← 実牌を描画
        }
      });

      drawRiver(riverEl, p.discards);
    });

    // --- あなたが手番の時だけ「引く/ステイ」ボタンを有効化 ---
    const my = (mySeatEff != null) ? players.find(p => p.seat === mySeatEff) : null;
    const canAct =
      state.phase === "playing" &&
      my && my.status === "playing" &&
      state.turn_seat === mySeatEff;

    [UI.btnDraw, UI.btnStay].forEach(b => {
      if (!b) return;
      b.disabled = !canAct;
      b.classList.toggle("btn-disabled", !canAct);
    });
  }

  function drawRiver(container, tiles) {
    if (!container || !tiles) return;
    container.innerHTML = "";
    tiles.forEach((t) => container.appendChild(tileNode(t, true)));
  }

  // ---- Seat helpers ----
  function orderByRelativeSeat(players, mySeat) {
    const bySeat = {};
    players.forEach((p) => (bySeat[p.seat] = p));
    const me = (mySeat != null) ? mySeat : 0;
    return {
      left: bySeat[(me + 3) % 4],
      top: bySeat[(me + 2) % 4],
      right: bySeat[(me + 1) % 4],
      me: bySeat[me],
    };
  }

  function setSeatUI(ordered, turnSeat) {
    // names
    const fmt = (p, fallback) => {
      if (!p) return fallback;
      const betText = (typeof p.bet === "number") ? `bet: ${p.bet}` : "bet: -";
      return `${p.name} (${p.points ?? 0}pt)\n${betText}`;
    };
    if (UI.leftName)   UI.leftName.textContent   = ordered.left ? fmt(ordered.left, "") : (lastState?.seats?.[ordered.left?.seat ?? -1] ?? "");
    if (UI.topName)    UI.topName.textContent    = ordered.top ? fmt(ordered.top, "") : (lastState?.seats?.[ordered.top?.seat ?? -1] ?? "");
    if (UI.rightName)  UI.rightName.textContent  = ordered.right ? fmt(ordered.right, "") : (lastState?.seats?.[ordered.right?.seat ?? -1] ?? "");
    if (UI.bottomName) UI.bottomName.textContent = ordered.me ? fmt(ordered.me, "") : (lastState?.seats?.[ordered.me?.seat ?? -1] ?? "");

    // winds
    if (UI.leftSeatWind) UI.leftSeatWind.textContent = ordered.left ? (lastState?.seats[ordered.left.seat] ?? "") : "";
    if (UI.topSeatWind) UI.topSeatWind.textContent = ordered.top ? (lastState?.seats[ordered.top.seat] ?? "") : "";
    if (UI.rightSeatWind) UI.rightSeatWind.textContent = ordered.right ? (lastState?.seats[ordered.right.seat] ?? "") : "";
    if (UI.bottomSeatWind) UI.bottomSeatWind.textContent = ordered.me ? (lastState?.seats[ordered.me.seat] ?? "") : "";

    // ready badges
    setReadyBadge(UI.leftStatus, ordered.left?.ready, ordered.left?.seat === turnSeat);
    setReadyBadge(UI.topStatus, ordered.top?.ready, ordered.top?.seat === turnSeat);
    setReadyBadge(UI.rightStatus, ordered.right?.ready, ordered.right?.seat === turnSeat);
    setReadyBadge(UI.bottomStatus, ordered.me?.ready, ordered.me?.seat === turnSeat);
  }

  function setReadyBadge(el, isReady, isTurn) {
    if (!el) return;
    el.textContent = isReady ? "準備OK" : "未準備";
    el.className = "badge " + (isReady ? "badge-ready" : "badge-wait");
    if (isTurn) el.classList.add("badge-turn");
  }


  // ---- Tiles ----
  function tileNode(label, small = false, _idx = null, onClick = null) {
    // Prefer SVG
    if (TileRenderer && TileRenderer.createTileSVG) {
      try {
        const svg = TileRenderer.createTileSVG(label, { small });
        if (onClick) svg.onclick = onClick;
        return svg;
      } catch (_) { }
    }
    // Fallback text tile
    const fb = document.createElement("div");
    fb.className = "tile-fallback" + (small ? " small" : "");
    fb.textContent = String(label ?? "");
    if (onClick) fb.onclick = onClick;
    return fb;
  }

  function backNode(small = false) {
    if (TileRenderer && TileRenderer.createTileSVG) {
      try {
        return TileRenderer.createTileSVG("BACK", { small, facedown: true });
      } catch (_) { }
    }
    const d = document.createElement("div");
    d.className = "tile-fallback" + (small ? " small" : "");
    d.textContent = "🀫";
    return d;
  }


  // ---- Dora（64px固定・1回だけ改行＝2行・安定レイアウト）----
  function drawDora(container, labels) {
    if (!container) return;
    container.innerHTML = "";

    // 表示順：9→1→2→…→8→役牌（同じ数字は一塊）
    const { byNum, windsGroup, dragonsGroup } = groupDoraFixed(labels);
    const ORDER = [9, 1, 2, 3, 4, 5, 6, 7, 8, "WINDS", "DRAGONS"];

    // グループ列を作る（順序維持）
    const groups = [];
    for (const key of ORDER) {
      if (key === "WINDS") {
        if (windsGroup.length) groups.push(windsGroup.slice());
      } else if (key === "DRAGONS") {
        if (dragonsGroup.length) groups.push(dragonsGroup.slice());
      } else {
        const g = byNum.get(key) || [];
        if (g.length) groups.push(g.slice());
      }
    }

    // ====== 幅計算（推定） & 分割位置の決定 ======
    // 牌の比率は 40x60 ~ 2:3 を想定 → 高さ64pxなら幅≒ 64 * 2/3 = 42.7
    const TILE_H = 64;
    const TILE_W = Math.round(TILE_H * 2 / 3); // ≒42
    const GROUP_GAP = 8;   // CSSと一致
    const ROW_GAP = 12;  // CSSと一致

    const gWidth = (g) => g.length * TILE_W + Math.max(0, g.length - 1) * GROUP_GAP;
    const widths = groups.map(gWidth);

    // 分割位置（1..n-1）を総当り → 2行の幅の最大値が最小になる位置を採用
    let split = 1, best = Infinity;
    for (let k = 1; k < groups.length; k++) {
      const w1 = widths.slice(0, k).reduce((s, w, i) => s + w + (i ? ROW_GAP : 0), 0);
      const w2 = widths.slice(k).reduce((s, w, i) => s + w + (i ? ROW_GAP : 0), 0);
      const score = Math.max(w1, w2);
      if (score < best) { best = score; split = k; }
    }

    // ====== DOM（2行を必ず生成・グループは折り返さない）======
    const rowA = document.createElement("div");
    rowA.className = "dora-row";
    for (let i = 0; i < split; i++) {
      rowA.appendChild(makeGroupNode(groups[i], /*big=*/true));
    }
    container.appendChild(rowA);

    const rowB = document.createElement("div");
    rowB.className = "dora-row";
    for (let i = split; i < groups.length; i++) {
      rowB.appendChild(makeGroupNode(groups[i], /*big=*/true));
    }
    container.appendChild(rowB);

    // ====== サイズ強制（CSSが負けても確実に64pxに）======
    forceDoraTileSize(container, TILE_H);

    // ====== はみ出す時だけ縮小（<=1）======
    const parentW = (UI?.mahjongTable?.clientWidth || container.parentElement?.clientWidth || 480) * 0.9;
    const widest = Math.max(
      Math.ceil(rowA.getBoundingClientRect().width),
      Math.ceil(rowB.getBoundingClientRect().width),
      1
    );
    const scale = Math.min(1, (parentW - 2) / widest);
    container.style.transform = (scale < 1) ? `scale(${scale})` : "none";
    container.style.transformOrigin = "top center";

    // 画像が遅れてロードされた場合でも再強制（初回だけ）
    rowA.querySelectorAll("img").forEach(img => {
      if (!img.complete) img.addEventListener("load", () => forceDoraTileSize(container, TILE_H), { once: true });
    });
    rowB.querySelectorAll("img").forEach(img => {
      if (!img.complete) img.addEventListener("load", () => forceDoraTileSize(container, TILE_H), { once: true });
    });
  }

  // グループDOM（同じ数字の塊）を作成。big=true なら大きい牌（small=false）を使う
  function makeGroupNode(groupLabels, big = false) {
    const gEl = document.createElement("div");
    gEl.className = "dora-group";
    for (const lbl of groupLabels) gEl.appendChild(tileNode(lbl, !big));
    return gEl;
  }

  // CSSに勝つためにインラインで 64px を強制。SVG/IMG/フォールバック全対応
  function forceDoraTileSize(root, px) {
    const tiles = root.querySelectorAll("img.tile-img, svg, .tile-fallback");
    tiles.forEach(el => {
      el.style.height = px + "px";
      if (el.tagName && el.tagName.toLowerCase() === "svg") {
        el.setAttribute("height", String(px));
        el.removeAttribute("width"); // 比率維持
      } else {
        el.style.width = "auto";
      }
    });
  }

  // 数字ごと（萬/筒/索まとめ）＋ 役牌（東南西北白發中）
  function groupDoraFixed(labels) {
    const parsed = labels.map(l => ({ raw: l, t: safeParse(l) }));
    const suitOrder = { m: 0, p: 1, s: 2 };
    const byNum = new Map(); for (let n = 1; n <= 9; n++) byNum.set(n, []);
    const honors = [];
    const misc = [];
    const honorSet = new Set(["東", "南", "西", "北", "白", "發", "中"]);
    for (const { raw, t } of parsed) {
      if (t?.kind === "number" && t.num >= 1 && t.num <= 9) byNum.get(t.num).push({ raw, suit: t.suit });
      else if (t?.kind === "honor" || honorSet.has(raw)) honors.push(raw);
      else misc.push(raw);
    }
    for (let n = 1; n <= 9; n++) {
      const arr = byNum.get(n);
      arr.sort((a, b) => (suitOrder[a.suit] ?? 9) - (suitOrder[b.suit] ?? 9));
      byNum.set(n, arr.map(x => x.raw));
    }
    const honorCounts = new Map();
    honors.forEach(h => honorCounts.set(h, (honorCounts.get(h) || 0) + 1));
    const windsOrder = ["東", "南", "西", "北"];
    const dragonsOrder = ["白", "發", "中"];
    const windsGroup = [];
    const dragonsGroup = [];
    for (const h of windsOrder) {
      const n = honorCounts.get(h) || 0;
      for (let i = 0; i < n; i++) windsGroup.push(h);
    }
    for (const h of dragonsOrder) {
      const n = honorCounts.get(h) || 0;
      for (let i = 0; i < n; i++) dragonsGroup.push(h);
    }
    // 解析できなかった牌も末尾に表示して枚数を欠かさない
    if (misc.length) dragonsGroup.push(...misc);
    return { byNum, windsGroup, dragonsGroup };
  }

  function safeParse(label) {
    try { return TileRenderer?.parseLabel ? TileRenderer.parseLabel(label) : null; }
    catch { return null; }
  }


  // ---- Chat ----
  function appendChat(msg) {
    if (!UI.chatLog) return;
    const d = document.createElement("div");
    d.textContent = msg;
    if (msg.startsWith("参加者:")) d.classList.add("system-msg");
    UI.chatLog.appendChild(d);
    UI.chatLog.scrollTop = UI.chatLog.scrollHeight;
  }
})();
