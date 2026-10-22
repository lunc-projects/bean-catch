// Bean Catch — leaderboard API (Vercel serverless, zero dependencies).
//
// Boards live in Redis (Upstash REST): sorted sets lb:all and
// lb:week:<ISO week>, plus a name directory hash lb:names whose values
// are JSON records {name, guest}. A submission is only accepted after
// the score is recomputed from its catch breakdown and passes the
// plausibility limits derived from the game's own spawn model.
//
// Identity: Telegram launch data (initData) is verified with the
// standard HMAC check against the bot secret in COFFEE_BOT_TOKEN.
// Without it, players submit under a self-chosen guest name and are
// flagged as guests on the board — unverifiable by design, and the
// flag is how the board stays honest about that.

import { createHmac, timingSafeEqual } from 'node:crypto';

/* ---------------- storage (Upstash / Vercel KV REST) ---------------- */

function storeConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
  const auth = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
  return { url: url.replace(/\/+$/, ''), auth };
}

async function redis(cmd) {
  const { url, auth } = storeConfig();
  if (!url || !auth) throw new Error('storage not configured');
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json().catch(() => null);
  if (!j || j.error) throw new Error('storage error: ' + ((j && j.error) || ('http ' + r.status)));
  return j.result;
}

async function redisPipe(cmds) {
  const { url, auth } = storeConfig();
  if (!url || !auth) throw new Error('storage not configured');
  const r = await fetch(url + '/pipeline', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  const j = await r.json().catch(() => null);
  if (!Array.isArray(j)) throw new Error('storage error: http ' + r.status);
  return j.map((x) => {
    if (x && x.error) throw new Error('storage error: ' + x.error);
    return x ? x.result : null;
  });
}

/* ---------------- game model (mirrors bean-catch.html) ----------------
   pickType(): golden .05, cherry .10, burnt .12, rock .11, bean .62
   -> good fraction 0.77. Values: bean 10, cherry 25, golden 50.
   spawnInterval(t, score) = max(0.30, 0.92 - 0.0075 t - 0.00035 score),
   and each spawn gap is that interval times U(0.75, 1.25). */

const BASE = { bean: 10, cherry: 25, golden: 50 };
const GOOD_FRACTION = 0.77;
const SPAWN_FLOOR = 0.30, SPAWN_START = 0.92, SPAWN_TIME_K = 0.0075, SPAWN_SCORE_K = 0.00035;
const GAP_MIN_FACTOR = 0.75;   // spawn gap jitter minimum
const MARGIN = 1.15;           // safety margin required by design
const MAX_CATCH_VALUE = 150;   // golden 50 at the x3 tier

// Upper bound on good items that can have spawned within T seconds.
// The interval's score feedback is driven at its adversarial maximum
// (every spawn a top-value catch), which shrinks the interval as fast
// as the real model possibly can; gaps use the minimum jitter factor.
function maxGoodSpawns(T) {
  let spawns = 0, scoreFb = 0, t = 0;
  const dt = 0.05;
  while (t < T) {
    const interval = Math.max(SPAWN_FLOOR, SPAWN_START - SPAWN_TIME_K * t - SPAWN_SCORE_K * scoreFb);
    const n = (dt / (GAP_MIN_FACTOR * interval));
    spawns += n;
    scoreFb += n * MAX_CATCH_VALUE;
    t += dt;
  }
  return Math.ceil(spawns * GOOD_FRACTION * MARGIN);
}

function recomputeScore(b) {
  let total = 0;
  for (const type of Object.keys(BASE)) {
    const tiers = b[type] || {};
    for (const tier of [1, 2, 3]) total += BASE[type] * tier * (tiers[tier] || 0);
  }
  return total;
}

function catchCounts(b) {
  const per = { tier2: 0, tier3: 0 };
  let good = 0;
  for (const type of Object.keys(BASE)) {
    const tiers = b[type] || {};
    for (const tier of [1, 2, 3]) {
      const n = tiers[tier] || 0;
      good += n;
      if (tier === 2) per.tier2 += n;
      if (tier === 3) per.tier3 += n;
    }
  }
  return { good, tier2: per.tier2, tier3: per.tier3 };
}

/* ---------------- ISO week boards ---------------- */

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;              // Mon = 0
  date.setUTCDate(date.getUTCDate() - dayNum + 3);        // this week's Thursday
  const year = date.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 4));
  const firstDay = (first.getUTCDay() + 6) % 7;
  first.setUTCDate(first.getUTCDate() - firstDay + 3);    // first week's Thursday
  const week = 1 + Math.round((date - first) / (7 * 24 * 3600 * 1000));
  return year + '-W' + String(week).padStart(2, '0');
}

function weekResetIso(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 7);        // next Monday 00:00 UTC
  return date.toISOString();
}

/* ---------------- identity ---------------- */

function cleanName(raw, maxLen) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[<>&"'`\/\\]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

// Standard Telegram WebApp launch-data verification. Returns the user
// object on success, null on any mismatch or staleness (> 24 h).
function validateInitData(initData, botSecret) {
  if (typeof initData !== 'string' || !initData || !botSecret) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch { return null; }
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(k + '=' + v);
  pairs.sort();
  const secret = createHmac('sha256', 'WebAppData').update(botSecret).digest();
  const calc = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  const a = Buffer.from(calc, 'utf8');
  const b = Buffer.from(String(hash).toLowerCase(), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > 86400 || authDate - now > 300) return null;
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { user = null; }
  if (!user || typeof user.id !== 'number') return null;
  return user;
}

function telegramIdentity(user) {
  let name = cleanName(user.first_name || 'Player', 24) || 'Player';
  if (user.username) name += ' @' + cleanName(user.username, 32);
  else if (user.last_name) name += ' ' + cleanName(user.last_name, 24);
  return { id: 'tg:' + user.id, name: name.slice(0, 40), guest: false };
}

function guestIdentity(rawName) {
  const name = cleanName(rawName, 16);
  if (name.length < 3) return null;
  return { id: 'guest:' + name.toLowerCase(), name, guest: true };
}

/* ---------------- payload validation ---------------- */

function isCount(n) { return Number.isInteger(n) && n >= 0 && n <= 100000; }

function validatePayload(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  const { score, breakdown, durationSec } = body;
  if (!Number.isInteger(score) || score < 0) return 'score must be a non-negative integer';
  if (typeof durationSec !== 'number' || !isFinite(durationSec) || durationSec <= 0) return 'durationSec must be a positive number';
  if (durationSec > 3600) return 'durationSec too large';
  if (!breakdown || typeof breakdown !== 'object') return 'breakdown is required';
  for (const type of Object.keys(BASE)) {
    const tiers = breakdown[type];
    if (!tiers || typeof tiers !== 'object') return 'breakdown.' + type + ' is required';
    for (const k of Object.keys(tiers)) {
      if (!['1', '2', '3'].includes(k)) return 'breakdown.' + type + ' has an unknown tier';
      if (!isCount(tiers[k])) return 'breakdown.' + type + '.' + k + ' must be a non-negative integer';
    }
  }
  if (!isCount(breakdown.badCatches)) return 'breakdown.badCatches must be a non-negative integer';
  if (!isCount(breakdown.goodMisses)) return 'breakdown.goodMisses must be a non-negative integer';
  if (!isCount(breakdown.maxStreak)) return 'breakdown.maxStreak must be a non-negative integer';

  // The claimed score must be exactly what the breakdown adds up to.
  if (recomputeScore(breakdown) !== score) return 'score does not match breakdown';

  // A run ends on the third lost life; earlier endings are abandoned runs.
  if (breakdown.badCatches + breakdown.goodMisses > 3) return 'too many lost lives for one run';

  const { good, tier2, tier3 } = catchCounts(breakdown);
  if (breakdown.maxStreak > good) return 'maxStreak cannot exceed total catches';
  if (tier3 > 0 && breakdown.maxStreak < 25) return 'tier-3 catches require a streak of 25+';
  if (tier2 > 0 && breakdown.maxStreak < 10) return 'tier-2 catches require a streak of 10+';

  // Plausibility against the game's real spawn model.
  const maxGood = maxGoodSpawns(durationSec);
  if (good > maxGood) return 'more catches than the game can spawn in that time';
  if (score > MAX_CATCH_VALUE * maxGood) return 'score above the theoretical maximum for that duration';
  if (durationSec < (good + breakdown.badCatches) * 0.25) return 'catches faster than humanly possible';
  return null;
}

/* ---------------- boards ---------------- */

async function readBoard(board) {
  const now = new Date();
  const wk = isoWeekKey(now);
  const key = board === 'week' ? 'lb:week:' + wk : 'lb:all';
  const flat = await redis(['ZRANGE', key, '0', '19', 'REV', 'WITHSCORES']);
  const entries = [];
  if (Array.isArray(flat)) {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      entries.push({ id: String(flat[i]), score: Number(flat[i + 1]) });
    }
  }
  if (entries.length) {
    const args = ['HMGET', 'lb:names', ...entries.map((e) => e.id)];
    const names = await redis(args);
    entries.forEach((e, i) => {
      let rec = null;
      try { rec = names && names[i] ? JSON.parse(names[i]) : null; } catch { rec = null; }
      e.name = rec && rec.name ? rec.name : 'Player';
      e.guest = !!(rec && rec.guest);
    });
  }
  return {
    ok: true,
    board,
    week: wk,
    resetsAt: board === 'week' ? weekResetIso(now) : null,
    entries,
  };
}

async function submitScore(identity, body) {
  const wk = isoWeekKey(new Date());
  const allKey = 'lb:all';
  const weekKey = 'lb:week:' + wk;
  const rec = JSON.stringify({ name: identity.name, guest: identity.guest });
  await redisPipe([
    ['ZADD', allKey, 'GT', String(body.score), identity.id],
    ['ZADD', weekKey, 'GT', String(body.score), identity.id],
    ['HSET', 'lb:names', identity.id, rec],
  ]);
  const [rankAll, rankWeek, bestAll, bestWeek] = await redisPipe([
    ['ZREVRANK', allKey, identity.id],
    ['ZREVRANK', weekKey, identity.id],
    ['ZSCORE', allKey, identity.id],
    ['ZSCORE', weekKey, identity.id],
  ]);
  const rank = (r) => (r === null || r === undefined ? null : Number(r) + 1);
  const best = (s, fallback) => (s === null || s === undefined ? fallback : Number(s));
  return {
    ok: true,
    id: identity.id,
    name: identity.name,
    guest: identity.guest,
    score: body.score,
    rankWeek: rank(rankWeek),
    rankAll: rank(rankAll),
    bestWeek: best(bestWeek, body.score),
    bestAll: best(bestAll, body.score),
  };
}

/* ---------------- handler ---------------- */

export default async function handler(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET') {
      const board = url.searchParams.get('board') === 'all' ? 'all' : 'week';
      const out = await readBoard(board);
      res.status(200).json(out);
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'method not allowed' });
      return;
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    if (!body || typeof body !== 'object') {
      res.status(400).json({ ok: false, error: 'body must be a JSON object' });
      return;
    }

    // Identity first, so the rate limit can key on it.
    let identity = null;
    if (body.initData) {
      const user = validateInitData(body.initData, process.env.COFFEE_BOT_TOKEN || '');
      if (!user) {
        res.status(401).json({ ok: false, error: 'Telegram sign-in check failed' });
        return;
      }
      identity = telegramIdentity(user);
    } else {
      identity = guestIdentity(body.guestName);
      if (!identity) {
        res.status(400).json({ ok: false, error: 'guest name must be 3-16 characters' });
        return;
      }
    }

    // One submission per identity per 10 seconds.
    const rl = await redis(['SET', 'rl:' + identity.id, '1', 'EX', '10', 'NX']);
    if (rl !== 'OK') {
      res.status(429).json({ ok: false, error: 'slow down — one score every 10 seconds' });
      return;
    }

    const problem = validatePayload(body);
    if (problem) {
      res.status(400).json({ ok: false, error: problem });
      return;
    }

    const out = await submitScore(identity, body);
    res.status(200).json(out);
  } catch (e) {
    const msg = e && e.message ? e.message : 'server error';
    res.status(500).json({ ok: false, error: msg.startsWith('storage') ? 'leaderboard storage unavailable' : 'server error' });
  }
}

export const _internals = {
  maxGoodSpawns, recomputeScore, catchCounts, isoWeekKey, weekResetIso,
  validateInitData, guestIdentity, telegramIdentity, validatePayload,
};
