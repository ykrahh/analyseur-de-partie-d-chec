// Pure functions turning raw Stockfish evaluations into the same kind of
// report chess.com shows: win%, move-by-move accuracy, game accuracy,
// and a classification label per move (Best/Excellent/.../Blunder).
//
// The win% and accuracy formulas below are the ones published by Lichess
// (https://lichess.org/page/accuracy), which chess.com's own CAPS2 tracks
// very closely (both convert centipawns to a win-probability curve first,
// then measure accuracy as the drop in that probability rather than raw
// centipawns — this is what makes losing 100cp in a winning position
// matter far less than losing 100cp in an equal one).

const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export function sideToMoveIsWhite(fen) {
  return fen.split(" ")[1] === "w";
}

/** Centipawns (from some perspective) -> win% for that same perspective.
 *
 * Note: earlier versions clamped cp to ±1000 before the sigmoid. That flattened
 * any two "already winning big" evaluations (say +900 vs +1400) to nearly the
 * same win%, which is documented as the main reason Lichess's public accuracy
 * formula reads noticeably more generous than chess.com's CAPS2 for the same
 * game (both use a win%-based accuracy, but CAPS2 keeps penalizing suboptimal
 * play once a position is winning, instead of treating it as "good enough").
 * Removing the clamp lets the sigmoid's own natural saturation do that job —
 * it still asymptotes near 0/100, just without an extra artificial floor. */
export function cpToWinPercent(cp) {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/**
 * Normalizes one engine line's score to a single signed "cp-like" number
 * and a win% for a given perspective, folding mate scores into the same
 * scale (a mate for you is capped at the edge of the win% curve).
 */
export function lineToWinPercent(line) {
  if (!line) return 50;
  if (line.mate !== null && line.mate !== undefined) {
    // A flat 99.9%/0.1% regardless of mate distance hides real differences:
    // letting a mate-in-2 slip to a mate-in-15 (still winning, but a real
    // step down) would otherwise show as zero loss. Map mate distance to an
    // equivalent centipawn score and run it through the same curve instead —
    // short mates read as ~99%+, long ones taper down but never below a
    // floor (a found forced mate is still a very good position).
    const magnitude = Math.max(400, 2500 - Math.abs(line.mate) * 100);
    return cpToWinPercent(line.mate > 0 ? magnitude : -magnitude);
  }
  return cpToWinPercent(line.cp ?? 0);
}

function accuracyFromWinPercentLoss(loss) {
  const acc = 103.1668 * Math.exp(-0.04354 * Math.max(0, loss)) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

function harmonicMean(a, b) {
  if (a <= 0 || b <= 0) return 0;
  return (2 * a * b) / (a + b);
}

function stdev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function materialBalance(fen) {
  const board = fen.split(" ")[0];
  let balance = 0;
  for (const ch of board) {
    const lower = ch.toLowerCase();
    if (PIECE_VALUES[lower] === undefined) continue;
    const value = PIECE_VALUES[lower];
    balance += ch === lower ? -value : value; // uppercase = white
  }
  return balance; // positive = White has more material
}

function uciOf(moveObj) {
  return moveObj.from + moveObj.to + (moveObj.promotion || "");
}

const CLASSIFICATIONS = [
  { key: "brilliant", label: "Brillant", short: "!!" },
  { key: "great", label: "Coup fort", short: "!" },
  { key: "best", label: "Meilleur coup", short: "★" },
  { key: "excellent", label: "Excellent", short: "" },
  { key: "good", label: "Bon", short: "" },
  { key: "book", label: "Théorie", short: "" },
  { key: "inaccuracy", label: "Imprécision", short: "?!" },
  { key: "mistake", label: "Erreur", short: "?" },
  { key: "miss", label: "Occasion manquée", short: "?" },
  { key: "blunder", label: "Gaffe", short: "??" },
];
export const CLASSIFICATION_META = Object.fromEntries(CLASSIFICATIONS.map((c) => [c.key, c]));
export const CLASSIFICATION_ORDER = CLASSIFICATIONS.map((c) => c.key);

/**
 * Builds the full game report.
 *
 * @param fens            positions 0..n (n = number of half-moves), fens[0] = start position
 * @param moves           chess.js verbose move objects, length n, moves[i] led from fens[i] to fens[i+1]
 * @param engineResults   server /analyze results, one per fen, same length as fens
 * @param bookPlies       how many opening plies to consider possible "book" moves (heuristic, no opening DB)
 */
export function buildGameReport(fens, moves, engineResults, { bookPlies = 8 } = {}) {
  const n = moves.length;

  // White-perspective win% at every position, used for the accuracy weighting window.
  const whiteWinPercents = fens.map((fen, k) => {
    const top = engineResults[k]?.lines?.[0];
    if (!top) return 50;
    const wp = lineToWinPercent(top);
    return sideToMoveIsWhite(fen) ? wp : 100 - wp;
  });

  const perMove = [];
  for (let i = 1; i <= n; i++) {
    const moverIsWhite = i % 2 === 1;
    const beforeFen = fens[i - 1];
    const afterFen = fens[i];
    const beforeLines = engineResults[i - 1]?.lines || [];
    const afterLines = engineResults[i]?.lines || [];
    const bestLineBefore = beforeLines[0];
    const secondLineBefore = beforeLines[1];
    const topLineAfter = afterLines[0];

    // Before: side to move at beforeFen IS the mover, so no flip needed.
    const winBefore = bestLineBefore ? lineToWinPercent(bestLineBefore) : 50;
    // After: side to move at afterFen is the opponent, so flip to mover's perspective.
    // When there's no line at all (typically because the move ended the game —
    // checkmate/stalemate — so there's nothing left to search), don't fabricate
    // a 50% eval: treat it as no measurable loss instead of a fake blunder.
    const winAfter = topLineAfter ? 100 - lineToWinPercent(topLineAfter) : winBefore;

    const loss = Math.max(0, winBefore - winAfter);
    const moveAccuracy = accuracyFromWinPercentLoss(loss);

    const playedUci = uciOf(moves[i - 1]);
    const bestUci = bestLineBefore?.pv?.[0] || null;
    const isBestMove = bestUci !== null && playedUci === bestUci;

    let key;
    if (isBestMove) {
      const gapToSecond =
        secondLineBefore != null
          ? lineToWinPercent(bestLineBefore) - lineToWinPercent(secondLineBefore)
          : 0;
      key = gapToSecond >= 15 ? "great" : "best";
    } else if (loss <= 2) {
      key = "excellent";
    } else if (loss <= 5) {
      key = "good";
    } else if (loss <= 10) {
      key = "inaccuracy";
    } else if (loss <= 20) {
      key = bestLineBefore?.mate != null ? "miss" : "mistake";
    } else {
      key = bestLineBefore?.mate != null ? "miss" : "blunder";
    }

    // Heuristic "book" override: only for very early, uncontested moves.
    if (i <= bookPlies && loss <= 5 && key !== "great") {
      key = "book";
    }

    // Heuristic "brilliant" override: a near-best move that specifically offers
    // a piece — the opponent's very next move captures exactly on the square
    // the mover just moved to — for a net material loss, in a position that
    // wasn't already a one-sided win or loss. Requiring the capture to land on
    // that same square (rather than just "material dropped somewhere in the
    // next two plies") is what tells a real sacrifice apart from an ordinary
    // forced exchange sequence elsewhere on the board.
    if ((key === "best" || key === "excellent") && winBefore > 2 && winBefore < 98) {
      const replyMove = moves[i]; // opponent's actual next move, if the game continues
      const offeredSquareTaken = replyMove && replyMove.captured != null && replyMove.to === moves[i - 1].to;
      if (offeredSquareTaken) {
        const sign = moverIsWhite ? 1 : -1;
        const matBefore = materialBalance(beforeFen) * sign;
        const matAfterReply = materialBalance(fens[i + 1]) * sign;
        if (matAfterReply - matBefore <= -3) {
          key = "brilliant";
        }
      }
    }

    perMove.push({
      ply: i,
      moverIsWhite,
      san: moves[i - 1].san,
      uci: playedUci,
      bestUci,
      fenBefore: beforeFen,
      fenAfter: afterFen,
      winBefore,
      winAfter,
      loss: Number(loss.toFixed(2)),
      accuracy: Number(moveAccuracy.toFixed(1)),
      classification: key,
      evalWhiteAfter: whiteWinPercents[i],
      bestLine: bestLineBefore || null,
    });
  }

  const bySide = { white: [], black: [] };
  perMove.forEach((m) => bySide[m.moverIsWhite ? "white" : "black"].push(m));

  function sideAccuracy(sideMoves) {
    if (sideMoves.length === 0) return { accuracy: 0, counts: {} };
    const accs = sideMoves.map((m) => m.accuracy);
    const simpleMean = accs.reduce((s, v) => s + v, 0) / accs.length;

    const weights = sideMoves.map((m) => {
      const idx = m.ply; // index into whiteWinPercents (position AFTER this ply)
      const lo = Math.max(0, idx - 2);
      const hi = Math.min(whiteWinPercents.length - 1, idx + 2);
      const window = whiteWinPercents.slice(lo, hi + 1);
      return Math.max(0.5, stdev(window));
    });
    const weightSum = weights.reduce((s, v) => s + v, 0);
    const weightedMean =
      weightSum > 0
        ? sideMoves.reduce((s, m, idx) => s + m.accuracy * weights[idx], 0) / weightSum
        : simpleMean;

    const finalAccuracy = harmonicMean(simpleMean, weightedMean);

    const counts = {};
    for (const m of sideMoves) counts[m.classification] = (counts[m.classification] || 0) + 1;

    return { accuracy: Number(finalAccuracy.toFixed(1)), counts };
  }

  return {
    perMove,
    whiteWinPercents,
    white: sideAccuracy(bySide.white),
    black: sideAccuracy(bySide.black),
  };
}
