// Early-momentum paper bot for the pump.fun replay (agent-fun/replay/v2).
//
// Paper trading only: this program never touches real funds. It talks to the
// replay harness through the vendored shim (vendor/makefun-bot.ts) and answers
// every batch with a list of orders. The harness delivers one batch per slot:
// the slot's chain events, the marks for held curves, and the fills of orders
// decided on earlier batches (latency_slots = 2).
//
// Strategy in one paragraph: buy a fresh curve early, once its tape shows real
// buy pressure, and sell the whole position on the first of a take-profit, a
// stop-loss, a trailing stop, or a time limit. One buy per mint, at most five
// open positions, so the bot turns over many coins across the 6-hour window
// and clears the guardrail of a round trip of at least 0.01 SOL on at least
// 20 coins. Every decision is deterministic: no clock, no randomness, and
// iteration only over insertion-ordered maps fed by the batch stream, so the
// two graded executions produce byte-identical action logs.
//
// Entry signal (per mint, per batch):
//   - the curve is at least MIN_AGE slots old (fresh curves are mostly
//     bundled launches that get dumped at once) and not complete;
//   - over the last WINDOW slots its tape has at least MIN_BUYS buys from at
//     least MIN_BUYERS distinct wallets, net inflow of at least MIN_NET_SOL,
//     and the price up at least MIN_UP from the window start while sitting
//     within NEAR_HIGH of the window high (rising, not already faded);
//   - its size cap (hello.caps.max_order_bps_of_real_reserve of its real SOL
//     reserve) is at least STAKE_LAMPORTS, so the buy is meaningful.
// Exits (checked before entries on every batch, so a position never lingers
// while a fresh buy is placed): sell everything when the position's close
// value is up TAKE_PROFIT on cost, down STOP_LOSS on cost, down TRAIL from
// its peak once the peak reached TRAIL_ARM, or held longer than MAX_HOLD.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per buy.
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL: the guardrail round-trip floor.
const MAX_SLIPPAGE_BPS = 10_000; // Wide open: a fill is never refused for price drift in latency.
const CURVE_FEE = 0.0125; // 1.25% curve fee, charged on the sell side of a close value.

const WINDOW = 60; // Entry lookback, in slots.
const MIN_AGE = 10; // Slots since CreateEvent before an entry is allowed.
const MIN_BUYS = 3; // Buy trades in the window.
const MIN_BUYERS = 3; // Distinct buying wallets in the window.
const MIN_NET_SOL = 0.5; // Net SOL inflow (buys minus sells) over the window.
const MIN_UP = 0.02; // Price now at least 2% above the window start.
const NEAR_HIGH = 0.95; // Price now at least 95% of the window high.
const TAKE_PROFIT = 0.3; // Sell when the close value is up 30% on cost.
const STOP_LOSS = 0.12; // Sell when the close value is down 12% on cost.
const TRAIL = 0.15; // Sell when the close value falls 15% from its peak.
const TRAIL_ARM = 0.15; // The trailing stop arms once the peak is up 15% on cost.
const MAX_HOLD = 800; // Sell after this many slots held, whatever the price.
const COOLDOWN = 150; // Slots to wait after an exit before the same curve may be bought again.
const MAX_ENTRIES = 2; // Most entries per curve over the run.

const LAMPORTS = 1e9;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  exiting: boolean;
  filled: boolean;
}

const tapes = new Map<string, Tape>();
const held = new Map<string, Held>();

function tapeOf(mint: string): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** True when the mint's tape shows early buy pressure worth buying into. */
function entrySignal(t: Tape, now: number): boolean {
  if (t.created === null || now - t.created < MIN_AGE) return false;
  const from = now - WINDOW;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const buyers = new Set<string>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      buyers.add(tr.user);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < MIN_BUYS || buyers.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  if (startPrice <= 0) return false;
  if (last / startPrice - 1 < MIN_UP) return false;
  if (last < high * NEAR_HIGH) return false;
  return true;
}

await runBot({
  onBatch(state, batch) {
    const now = batch.slot;
    const { caps } = state.hello;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;
    const orders: (BuyInput | SellInput)[] = [];
    const traded = new Set<string>();

    // Fold this batch's events into the tapes.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / LAMPORTS,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
      }
    }
    // Prune trades older than the entry window.
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - WINDOW) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<string, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    // Exits first: a position that must go is sold before any fresh buy.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
      const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
      const tokens = Number(pos.token_amount);
      const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      let exit = h.exiting;
      if (!exit && value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && value <= cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value <= h.peakValue * (1 - TRAIL)) exit = true;
      if (!exit && now - h.opened > MAX_HOLD) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (pendingByMint.has(mint)) {
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
      }
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }

    // Entries: one buy per mint, at most caps.max_open_positions open at once.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = caps.max_open_positions - state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slotsLeft <= 0) break;
      if (held.has(mint) || pendingByMint.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const t = tapes.get(mint)!;
      if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN) continue;
      if (!entrySignal(t, now)) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < Number(amount) / LAMPORTS + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      free -= Number(amount) / LAMPORTS + tx;
      slotsLeft--;
      held.set(mint, { opened: now, peakValue: 0, exiting: false, filled: false });
      t.entries++;
    }
    return orders;
  },
});
