import { Chess } from "../lib/chess.js";
import { buildGameReport, CLASSIFICATION_META, CLASSIFICATION_ORDER } from "./analysis.js";
import { PIECE_SVG } from "./pieces.js";

const SERVER_URL = "http://127.0.0.1:8791";

const el = (id) => document.getElementById(id);

const state = {
  games: [],
  selectedGameIndex: -1,
  moves: [],      // chess.js verbose moves for the selected game
  fens: [],       // fens[0]=start, fens[i]=position after move i
  report: null,   // output of buildGameReport
  ply: 0,         // currently displayed ply (0 = start position)
  orientation: "white",
  searchedUsername: "",
  autoplayTimer: null,
  lineAnimationTimer: null,
};

// ---------- Engine health ----------

async function checkEngineHealth() {
  try {
    const res = await fetch(`${SERVER_URL}/health`, { cache: "no-store" });
    const data = await res.json();
    el("engineDot").className = "dot ok";
    el("engineStatusText").textContent = `Moteur local actif (${data.poolSize} instances Stockfish)`;
    return true;
  } catch {
    el("engineDot").className = "dot bad";
    el("engineStatusText").textContent = "Serveur local introuvable sur 127.0.0.1:8791";
    return false;
  }
}
checkEngineHealth();
setInterval(checkEngineHealth, 8000);

// ---------- Loading games from chess.com ----------

el("loadGamesBtn").addEventListener("click", loadGames);
el("usernameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadGames();
});

async function loadGames() {
  const username = el("usernameInput").value.trim();
  if (!username) return;
  state.searchedUsername = username.toLowerCase();
  el("loadHint").textContent = "Chargement…";
  el("gamesList").innerHTML = "";

  try {
    const archivesRes = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`);
    if (!archivesRes.ok) throw new Error(`Pseudo introuvable (${archivesRes.status})`);
    const { archives } = await archivesRes.json();
    if (!archives || archives.length === 0) {
      el("loadHint").textContent = "Aucune partie trouvée pour ce pseudo.";
      return;
    }
    const recentArchives = archives.slice(-2); // current + previous month
    const monthly = await Promise.all(
      recentArchives.map((url) => fetch(url).then((r) => r.json()))
    );
    let games = monthly.flatMap((m) => m.games || []);
    games.sort((a, b) => b.end_time - a.end_time);
    games = games.slice(0, 25);

    state.games = games;
    el("loadHint").textContent = `${games.length} parties récentes chargées.`;
    renderGamesList();
  } catch (err) {
    el("loadHint").textContent = `Erreur : ${err.message}`;
  }
}

function renderGamesList() {
  const list = el("gamesList");
  list.innerHTML = "";
  state.games.forEach((game, idx) => {
    const row = document.createElement("div");
    row.className = "game-row";
    const white = game.white?.username || "?";
    const black = game.black?.username || "?";
    const isUserWhite = white.toLowerCase() === state.searchedUsername;
    const opponent = isUserWhite ? black : white;
    const userResult = isUserWhite ? game.white?.result : game.black?.result;
    const resultLabel = userResult === "win" ? "Victoire" : userResult && userResult !== "win" ? "Défaite/Nulle" : "";
    const date = new Date(game.end_time * 1000).toLocaleDateString("fr-FR");

    row.innerHTML = `
      <span class="title">vs ${escapeHtml(opponent)} — ${resultLabel}</span>
      <span class="sub">${date} · ${escapeHtml(game.time_class || "")}</span>
    `;
    row.addEventListener("click", () => selectGame(idx));
    list.appendChild(row);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Selecting & parsing a game ----------

function selectGame(idx) {
  stopPlayback();
  document.querySelectorAll(".game-row").forEach((r, i) => r.classList.toggle("active", i === idx));
  state.selectedGameIndex = idx;
  const game = state.games[idx];

  const chess = new Chess();
  try {
    chess.loadPgn(game.pgn);
  } catch (err) {
    el("loadHint").textContent = `Impossible de lire cette partie : ${err.message}`;
    return;
  }
  const headers = chess.getHeaders();
  const verboseMoves = chess.history({ verbose: true });

  state.moves = verboseMoves;
  state.fens = [verboseMoves[0]?.before || chess.fen(), ...verboseMoves.map((m) => m.after)];
  state.report = null;
  state.ply = 0;

  const whiteName = headers.White || game.white?.username || "Blancs";
  const blackName = headers.Black || game.black?.username || "Noirs";
  state.orientation = whiteName.toLowerCase() === state.searchedUsername ? "white" : "black";

  el("whiteName").textContent = `${whiteName} (${headers.WhiteElo || game.white?.rating || "?"})`;
  el("blackName").textContent = `${blackName} (${headers.BlackElo || game.black?.rating || "?"})`;
  el("gameMeta").textContent = `${headers.Result || ""} · ${headers.ECO ? "ECO " + headers.ECO + " · " : ""}${game.time_class || ""} · ${new Date(game.end_time * 1000).toLocaleDateString("fr-FR")}`;

  // Opponent's name above the board, the user's own name (+ avatar) below —
  // the board is oriented so the user is always at the bottom.
  const opponentName = state.orientation === "white" ? blackName : whiteName;
  const userName = state.orientation === "white" ? whiteName : blackName;
  el("opponentNameLabel").textContent = opponentName;
  el("userNameLabel").textContent = userName;

  el("emptyState").hidden = true;
  el("gameView").hidden = false;
  el("accuracyRow").hidden = true;
  el("countsColumns").hidden = true;
  el("progressWrap").hidden = true;
  el("analyzeBtn").disabled = false;
  el("analyzeBtn").textContent = "Analyser cette partie";

  renderMovesListSkeleton();
  renderBoardAtPly(0);
  drawEvalGraph(null);
  el("moveDetail").textContent = "Position de départ.";
  updateAvatar();
}

function renderMovesListSkeleton() {
  const list = el("movesList");
  list.innerHTML = "";
  state.moves.forEach((m, i) => {
    const ply = i + 1;
    const row = document.createElement("li");
    row.className = "move-row";
    row.dataset.ply = String(ply);
    const num = ply % 2 === 1 ? `${Math.ceil(ply / 2)}.` : `${Math.ceil(ply / 2)}...`;
    row.innerHTML = `<span class="num">${num}</span><span class="san">${escapeHtml(m.san)}</span><span class="tag"></span>`;
    row.addEventListener("click", () => {
      stopPlayback();
      setPly(ply);
    });
    list.appendChild(row);
  });
}

// ---------- Analysis ----------

el("analyzeBtn").addEventListener("click", runAnalysis);

async function runAnalysis() {
  const healthy = await checkEngineHealth();
  if (!healthy) {
    alert("Le serveur Stockfish local ne répond pas sur 127.0.0.1:8791.\nLance-le avec: node ~/chess-analyzer/server/index.js");
    return;
  }

  const depth = parseInt(el("depthSelect").value, 10);
  const fens = state.fens;
  const total = fens.length;

  el("analyzeBtn").disabled = true;
  el("progressWrap").hidden = false;
  el("progressFill").style.width = "0%";
  el("progressText").textContent = `0 / ${total} positions`;

  // Streamed: the server writes one line the instant each position finishes,
  // in whatever order they complete (not input order) — so every Stockfish
  // worker stays busy the whole time instead of idling at artificial batch
  // boundaries waiting for the slowest position in a chunk.
  const engineResults = new Array(total);
  let done = 0;
  try {
    const res = await fetch(`${SERVER_URL}/analyze-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fens, depth }),
    });
    if (!res.ok || !res.body) {
      const errBody = await res.text();
      throw new Error(errBody || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error);
        engineResults[msg.index] = msg.result;
        done++;
        el("progressFill").style.width = `${Math.round((done / total) * 100)}%`;
        el("progressText").textContent = `${done} / ${total} positions (profondeur ${depth})`;
      }
    }
  } catch (err) {
    el("progressText").textContent = "Erreur d'analyse";
    alert("Erreur du serveur d'analyse : " + err.message);
    el("analyzeBtn").disabled = false;
    return;
  }

  const report = buildGameReport(fens, state.moves, engineResults);
  state.report = report;

  el("progressWrap").hidden = true;
  el("analyzeBtn").disabled = false;
  el("analyzeBtn").textContent = "Ré-analyser";

  renderAccuracy();
  renderMoveTags();
  drawEvalGraph(report);
  setPly(state.ply || 0);
}

function renderAccuracy() {
  const { white, black } = state.report;
  el("whiteAccuracy").textContent = `${white.accuracy}%`;
  el("blackAccuracy").textContent = `${black.accuracy}%`;
  el("accuracyRow").hidden = false;

  renderCountsColumn("countsWhite", white.counts);
  renderCountsColumn("countsBlack", black.counts);
  el("countsColumns").hidden = false;
}

function renderCountsColumn(elementId, counts) {
  const row = el(elementId);
  row.innerHTML = "";
  for (const key of CLASSIFICATION_ORDER) {
    const count = counts[key];
    if (!count) continue;
    const meta = CLASSIFICATION_META[key];
    const chip = document.createElement("span");
    chip.className = "count-chip";
    chip.innerHTML = `<b>${count}</b> ${escapeHtml(meta.label)}`;
    row.appendChild(chip);
  }
}

function renderMoveTags() {
  state.report.perMove.forEach((m) => {
    const row = document.querySelector(`.move-row[data-ply="${m.ply}"]`);
    if (!row) return;
    const tagEl = row.querySelector(".tag");
    const meta = CLASSIFICATION_META[m.classification];
    tagEl.textContent = meta.short || meta.label.slice(0, 3);
    tagEl.className = `tag tag-${m.classification}`;
    tagEl.title = meta.label;
  });
}

// ---------- Board rendering ----------

function renderBoardAtPly(ply) {
  const move = ply > 0 ? state.moves[ply - 1] : null;
  renderBoardFen(state.fens[ply], move ? { from: move.from, to: move.to } : null);
}

/** Draws an arbitrary FEN on the board, independent of the loaded game — used both for
 * normal navigation (via renderBoardAtPly) and for animating a hypothetical best line. */
function renderBoardFen(fen, move) {
  const board = el("board");
  board.innerHTML = "";

  const rows = fen.split(" ")[0].split("/"); // rows[0] = rank 8 ... rows[7] = rank 1
  const byRank8ToRank1 = rows.map((r) => {
    const cells = [];
    for (const ch of r) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < parseInt(ch, 10); i++) cells.push(null);
      } else {
        cells.push(ch);
      }
    }
    return cells;
  }); // index 0 = rank8 row ... index7 = rank1 row, each length 8 (file a..h)

  for (let displayRow = 0; displayRow < 8; displayRow++) {
    for (let displayCol = 0; displayCol < 8; displayCol++) {
      let rankIdxFromTop, fileIdx;
      if (state.orientation === "white") {
        rankIdxFromTop = displayRow;
        fileIdx = displayCol;
      } else {
        rankIdxFromTop = 7 - displayRow;
        fileIdx = 7 - displayCol;
      }
      const piece = byRank8ToRank1[rankIdxFromTop][fileIdx];
      const rankNumber = 8 - rankIdxFromTop; // 1..8
      const fileLetter = "abcdefgh"[fileIdx];
      const squareName = `${fileLetter}${rankNumber}`;

      const sq = document.createElement("div");
      const isLight = (fileIdx + rankNumber) % 2 === 1;
      sq.className = `sq ${isLight ? "light" : "dark"}`;
      if (move && (squareName === move.from || squareName === move.to)) {
        sq.classList.add(squareName === move.from ? "from" : "to");
      }
      if (piece && PIECE_SVG[piece]) {
        const pieceEl = document.createElement("div");
        pieceEl.className = "piece";
        pieceEl.innerHTML = PIECE_SVG[piece];
        sq.appendChild(pieceEl);
      }
      // Coordinates, chess.com-style: rank numbers along the left edge,
      // file letters along the bottom edge, tucked into the square's corner.
      if (displayCol === 0) {
        const rankLabel = document.createElement("span");
        rankLabel.className = "coord rank";
        rankLabel.textContent = String(rankNumber);
        sq.appendChild(rankLabel);
      }
      if (displayRow === 7) {
        const fileLabel = document.createElement("span");
        fileLabel.className = "coord file";
        fileLabel.textContent = fileLetter;
        sq.appendChild(fileLabel);
      }
      board.appendChild(sq);
    }
  }
}

// ---------- Navigation ----------

el("prevBtn").addEventListener("click", () => { stopPlayback(); setPly(state.ply - 1); });
el("nextBtn").addEventListener("click", () => { stopPlayback(); setPly(state.ply + 1); });
el("playBtn").addEventListener("click", toggleAutoplay);

document.addEventListener("keydown", (e) => {
  if (el("gameView").hidden) return;
  if (e.key === "ArrowLeft") { stopPlayback(); setPly(state.ply - 1); }
  if (e.key === "ArrowRight") { stopPlayback(); setPly(state.ply + 1); }
});

function stopPlayback() {
  stopAutoplay();
  stopLineAnimation();
}

function setPly(ply) {
  const max = state.moves.length;
  state.ply = Math.max(0, Math.min(max, ply));
  renderBoardAtPly(state.ply);
  updateEvalBar();
  highlightSelectedMoveRow();
  renderMoveDetail();
  redrawEvalGraphMarker();
  updateAvatar();
}

// A piece worth reacting to losing: knight, bishop, rook or queen — not a pawn.
const IMPORTANT_PIECE_TYPES = new Set(["n", "b", "r", "q"]);

/** Switches the user's avatar to the "alert" photo right when the move that led to
 * the current position was the opponent capturing one of the user's important pieces. */
function updateAvatar() {
  const img = el("userAvatarImg");
  if (!img) return;
  const move = state.ply > 0 ? state.moves[state.ply - 1] : null;
  const moverIsWhite = state.ply % 2 === 1;
  const moverIsUser = move && (moverIsWhite ? state.orientation === "white" : state.orientation === "black");
  const lostImportantPiece =
    move && !moverIsUser && move.captured && IMPORTANT_PIECE_TYPES.has(move.captured.toLowerCase());
  img.src = lostImportantPiece ? "../assets/avatar-alert.jpg" : "../assets/avatar-normal.jpg";
}

function highlightSelectedMoveRow() {
  document.querySelectorAll(".move-row").forEach((row) => {
    row.classList.toggle("selected", Number(row.dataset.ply) === state.ply);
  });
  if (state.ply > 0) {
    const row = document.querySelector(`.move-row[data-ply="${state.ply}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }
}

function updateEvalBar() {
  let whiteWinPct = 50;
  if (state.report) {
    whiteWinPct = state.report.whiteWinPercents[state.ply];
  }
  el("evalBarFill").style.height = `${whiteWinPct}%`;
}

const ERROR_CLASSIFICATIONS = new Set(["inaccuracy", "mistake", "miss", "blunder"]);
const BEST_LINE_PLIES = 7;

function renderMoveDetail() {
  const box = el("moveDetail");
  if (state.ply === 0 || !state.report) {
    box.textContent = state.ply === 0 ? "Position de départ." : "Clique sur \"Analyser cette partie\" pour voir le détail des coups.";
    return;
  }
  const m = state.report.perMove[state.ply - 1];
  const meta = CLASSIFICATION_META[m.classification];
  const mover = m.moverIsWhite ? "Blancs" : "Noirs";
  let bestSan = "";
  if (m.bestUci && m.bestUci !== m.uci) {
    bestSan = sanForUci(m.fenBefore, m.bestUci);
  }

  let bestLineHtml = "";
  let bestLineSteps = null;
  if (ERROR_CLASSIFICATIONS.has(m.classification) && m.bestLine?.pv?.length) {
    bestLineSteps = pvToSteps(m.fenBefore, m.bestLine.pv, BEST_LINE_PLIES);
    if (bestLineSteps.length) {
      const sanLine = bestLineSteps.map((s) => s.san);
      bestLineHtml = `<br/><span class="best-line-label">Meilleure suite (${sanLine.length} coups) :</span> <span class="best-line">${escapeHtml(formatMoveLine(m.ply, sanLine))}</span> <button id="bestLineBtn" class="secondary">▶ Voir l'animation</button>`;
    }
  }

  box.innerHTML = `
    <span class="tag tag-${m.classification}" style="margin-right:6px;">${escapeHtml(meta.label)}</span>
    <strong>${mover} joue ${escapeHtml(m.san)}</strong> — précision du coup : ${m.accuracy}%<br/>
    Probabilité de gain avant/après (perspective du joueur) : ${m.winBefore.toFixed(1)}% → ${m.winAfter.toFixed(1)}%
    ${bestSan ? ` · Meilleur coup du moteur : <strong>${escapeHtml(bestSan)}</strong>` : ""}
    ${bestLineHtml}
  `;

  if (bestLineSteps) {
    el("bestLineBtn").addEventListener("click", () => {
      if (state.lineAnimationTimer) {
        stopLineAnimation();
      } else {
        playBestLineAnimation(m.fenBefore, bestLineSteps);
      }
    });
  }
}

/** Replays a UCI principal variation from `fen` and returns, for each played
 * move (up to maxPlies), its SAN, from/to squares and the resulting FEN —
 * everything needed both to print the line and to animate it on the board. */
function pvToSteps(fen, pvUci, maxPlies) {
  const chess = new Chess(fen);
  const steps = [];
  const limit = Math.min(maxPlies, pvUci.length);
  for (let i = 0; i < limit; i++) {
    const uci = pvUci[i];
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4) : undefined;
    let move;
    try {
      move = chess.move({ from, to, promotion });
    } catch {
      break;
    }
    if (!move) break;
    steps.push({ san: move.san, from: move.from, to: move.to, fenAfter: chess.fen() });
  }
  return steps;
}

/** Steps the board through a hypothetical line (the engine's suggested improvement),
 * one move at a time, then restores the real game position once it's done. */
function playBestLineAnimation(startFen, steps) {
  stopAutoplay();
  stopLineAnimation();
  if (!steps.length) return;

  const btn = document.getElementById("bestLineBtn");
  if (btn) btn.textContent = "⏸ Arrêter l'animation";

  let i = -1; // -1 = show the starting position before the line's first move
  renderBoardFen(startFen, null);
  state.lineAnimationTimer = setInterval(() => {
    i++;
    if (i >= steps.length) {
      stopLineAnimation();
      return;
    }
    const step = steps[i];
    renderBoardFen(step.fenAfter, { from: step.from, to: step.to });
  }, 700);
}

function stopLineAnimation() {
  if (state.lineAnimationTimer) {
    clearInterval(state.lineAnimationTimer);
    state.lineAnimationTimer = null;
    // Restore the board to the actual game position (the animation only ever
    // borrows the board temporarily to show a hypothetical line).
    renderBoardAtPly(state.ply);
  }
  const btn = document.getElementById("bestLineBtn");
  if (btn) btn.textContent = "▶ Voir l'animation";
}

/** Formats a SAN sequence starting at ply `startPly` with standard move numbers (e.g. "12...Nxe5 13.Rd1 Rd8"). */
function formatMoveLine(startPly, sanMoves) {
  return sanMoves
    .map((san, k) => {
      const ply = startPly + k;
      const moveNumber = Math.ceil(ply / 2);
      const isWhiteMove = ply % 2 === 1;
      if (isWhiteMove) return `${moveNumber}.${san}`;
      return k === 0 ? `${moveNumber}...${san}` : san;
    })
    .join(" ");
}

function sanForUci(fen, uci) {
  try {
    const c = new Chess(fen);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4) : undefined;
    const move = c.move({ from, to, promotion });
    return move ? move.san : uci;
  } catch {
    return uci;
  }
}

function toggleAutoplay() {
  stopLineAnimation();
  if (state.autoplayTimer) {
    stopAutoplay();
  } else {
    el("playBtn").textContent = "⏸ Pause";
    state.autoplayTimer = setInterval(() => {
      if (state.ply >= state.moves.length) {
        stopAutoplay();
        return;
      }
      setPly(state.ply + 1);
    }, 700);
  }
}
function stopAutoplay() {
  if (state.autoplayTimer) {
    clearInterval(state.autoplayTimer);
    state.autoplayTimer = null;
    el("playBtn").textContent = "▶ Autoplay";
  }
}

// ---------- Eval graph ----------

function drawEvalGraph(report) {
  const canvas = el("evalGraph");
  canvas._graphData = report ? report.whiteWinPercents : null;
  redrawEvalGraphMarker();
}

function redrawEvalGraphMarker() {
  const canvas = el("evalGraph");
  const data = canvas._graphData;
  drawEvalGraphBase(canvas, data);
  if (!data) return;
  const ctx = canvas.getContext("2d");
  const n = data.length;
  const x = (state.ply / (n - 1 || 1)) * canvas.width;
  ctx.strokeStyle = "#e8e9ed";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvas.height);
  ctx.stroke();
}

function drawEvalGraphBase(canvas, data) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#1c1f27";
  ctx.fillRect(0, 0, width, height);
  const midY = height / 2;
  ctx.strokeStyle = "#2c303a";
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(width, midY);
  ctx.stroke();
  if (!data) return;
  const n = data.length;
  ctx.beginPath();
  data.forEach((wp, i) => {
    const x = (i / (n - 1 || 1)) * width;
    const y = height - (wp / 100) * height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#81b64c";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
