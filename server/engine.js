import { spawn } from "node:child_process";
import readline from "node:readline";

const STOCKFISH_PATH = process.env.STOCKFISH_PATH || "/opt/homebrew/bin/stockfish";

/**
 * Wraps a single Stockfish process speaking UCI over stdin/stdout.
 * One instance = one OS process. A pool of these gives us parallelism
 * across the cores of the machine.
 */
class StockfishInstance {
  constructor({ threads = 1, hash = 64, multiPv = 2 } = {}) {
    this.multiPv = multiPv;
    this.proc = spawn(STOCKFISH_PATH, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.busy = false;
    this._pendingResolvers = [];

    this.rl.on("line", (line) => this._onLine(line));
    this.proc.on("exit", (code) => {
      // Reject anything still waiting if the process dies unexpectedly.
      this._pendingResolvers.forEach((r) => r.reject(new Error(`stockfish exited (${code})`)));
      this._pendingResolvers = [];
    });

    this._ready = this._init(threads, hash, multiPv);
  }

  _send(cmd) {
    this.proc.stdin.write(cmd + "\n");
  }

  _onLine(line) {
    if (this._lineHandler) this._lineHandler(line);
  }

  _waitFor(matcher) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this._pendingResolvers.push(entry);
      this._lineHandler = (line) => {
        if (matcher(line)) {
          const idx = this._pendingResolvers.indexOf(entry);
          if (idx >= 0) this._pendingResolvers.splice(idx, 1);
          resolve(line);
        }
      };
    });
  }

  async _init(threads, hash, multiPv) {
    this._send("uci");
    await this._waitFor((l) => l.trim() === "uciok");
    this._send(`setoption name Threads value ${threads}`);
    this._send(`setoption name Hash value ${hash}`);
    this._send(`setoption name MultiPV value ${multiPv}`);
    this._send("isready");
    await this._waitFor((l) => l.trim() === "readyok");
  }

  /**
   * Analyze one FEN to a fixed depth. Returns the top `multiPv` lines,
   * each with a score from the perspective of the side to move (UCI
   * convention), plus the raw best move.
   */
  async analyze(fen, depth = 18) {
    await this._ready;
    const lines = new Map(); // multipv index -> {cp, mate, pv[]}
    let bestmove = null;

    this._send("position fen " + fen);
    this._send(`go depth ${depth}`);

    await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this._pendingResolvers.push(entry);
      this._lineHandler = (line) => {
        if (line.startsWith("info") && line.includes(" pv ")) {
          const mpvMatch = line.match(/multipv (\d+)/);
          const mpv = mpvMatch ? parseInt(mpvMatch[1], 10) : 1;
          const cpMatch = line.match(/score cp (-?\d+)/);
          const mateMatch = line.match(/score mate (-?\d+)/);
          const pvMatch = line.match(/ pv (.+)$/);
          const depthMatch = line.match(/^info depth (\d+)/);
          lines.set(mpv, {
            cp: cpMatch ? parseInt(cpMatch[1], 10) : null,
            mate: mateMatch ? parseInt(mateMatch[1], 10) : null,
            pv: pvMatch ? pvMatch[1].trim().split(" ") : [],
            depth: depthMatch ? parseInt(depthMatch[1], 10) : null,
          });
        } else if (line.startsWith("bestmove")) {
          bestmove = line.split(" ")[1];
          const idx = this._pendingResolvers.indexOf(entry);
          if (idx >= 0) this._pendingResolvers.splice(idx, 1);
          resolve();
        }
      };
    });

    const ordered = Array.from(lines.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);

    return { bestmove, lines: ordered };
  }

  quit() {
    try {
      this._send("quit");
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (!this.proc.killed) this.proc.kill();
    }, 500);
  }
}

/**
 * A small pool of Stockfish processes so a whole game (dozens of
 * positions) analyzes in parallel instead of one position at a time.
 */
export class EnginePool {
  constructor({ size, threadsPerEngine = 1, hash = 64, multiPv = 2 } = {}) {
    this.size = size;
    this.multiPv = multiPv;
    this.workers = Array.from(
      { length: size },
      () => new StockfishInstance({ threads: threadsPerEngine, hash, multiPv })
    );
    this.queue = [];
    this.freeWorkers = [...this.workers];
  }

  _dispatch() {
    while (this.freeWorkers.length && this.queue.length) {
      const worker = this.freeWorkers.pop();
      const job = this.queue.shift();
      worker
        .analyze(job.fen, job.depth)
        .then((result) => job.resolve(result))
        .catch((err) => job.reject(err))
        .finally(() => {
          this.freeWorkers.push(worker);
          this._dispatch();
        });
    }
  }

  analyze(fen, depth = 18) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fen, depth, resolve, reject });
      this._dispatch();
    });
  }

  async analyzeBatch(fens, depth = 18) {
    return Promise.all(fens.map((fen) => this.analyze(fen, depth)));
  }

  shutdown() {
    this.workers.forEach((w) => w.quit());
  }
}
