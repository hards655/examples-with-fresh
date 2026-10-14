import { define } from "../utils.ts";

/**
 * GHOST BYBIT API
 * Fresh 2 / Deno Deploy
 *
 * Public Bybit V5 API
 * USDT linear perpetual markets
 *
 * Endpoints:
 *   /api
 *   /api?endpoint=help
 *   /api?endpoint=markets
 *   /api?endpoint=scan
 *   /api?endpoint=candidates
 *   /api?endpoint=symbol&symbol=BTCUSDT
 *
 * Scan options:
 *   interval=5
 *   convergence=0.8
 *   pullback=1.5
 *   limit=50
 */

const BYBIT = "https://api.bybit.com";

const API_VERSION = "GHOST BYBIT API";
const CATEGORY = "linear";

const DEFAULT_INTERVAL = "5";
const DEFAULT_CONVERGENCE = 0.8;
const DEFAULT_PULLBACK = 1.5;

const REQUEST_TIMEOUT = 12000;
const SCAN_CONCURRENCY = 8;
const CACHE_TTL = 45000;
const SYMBOL_CACHE_TTL = 300000;

type JsonObject = Record<string, unknown>;

type Instrument = {
  symbol: string;
  status: string;
  contractType?: string;
  quoteCoin?: string;
  settleCoin?: string;
};

type Ticker = {
  symbol: string;
  lastPrice: string;
  price24hPcnt?: string;
  turnover24h?: string;
  volume24h?: string;
};

type Kline = {
  startTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
};

type Signal = {
  symbol: string;
  price: number;
  previousPrice: number;
  change24h: number;
  turnover24h: number;

  ma7: number;
  ma14: number;
  ma28: number;

  previousMa7: number;
  previousMa14: number;
  previousMa28: number;

  ma7AboveMa14: boolean;
  ma14AboveMa28: boolean;
  bullishAlignment: boolean;
  crossUp: boolean;
  convergence: number;

  priceAboveMA7: boolean;
  priceAboveMA14: boolean;
  priceAboveMA28: boolean;

  rvol: number;
  volumeAcceleration: number;

  score: number;
  signal: string;
  timestamp: number;
};

type Candidate = {
  symbol: string;
  entryPrice: number;
  lastPrice: number;
  highestPrice: number;
  changeFromEntry: number;
  pullbackFromHigh: number;
  firstSeen: number;
  lastSeen: number;
  state: string;
  score: number;
  signal: string;
};

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function response(
  data: JsonObject,
  status = 200,
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: jsonHeaders,
  });
}

function errorResponse(
  message: string,
  status = 500,
  extra: JsonObject = {},
): Response {
  return response({
    ok: false,
    engine: API_VERSION,
    error: message,
    ...extra,
    timestamp: Date.now(),
  }, status);
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;

  return values.reduce((sum, value) => sum + value, 0) /
    values.length;
}

function percentChange(current: number, previous: number): number {
  if (!previous) return 0;

  return ((current - previous) / previous) * 100;
}

function validInterval(value: string | null): string {
  const allowed = [
    "1",
    "3",
    "5",
    "15",
    "30",
    "60",
    "120",
    "240",
    "360",
    "720",
  ];

  if (value && allowed.includes(value)) return value;

  return DEFAULT_INTERVAL;
}

/* -------------------------------------------------------
   MEMORY CACHE
------------------------------------------------------- */

let instrumentCache: Instrument[] = [];
let instrumentCacheTime = 0;

let tickerCache = new Map<string, Ticker>();
let tickerCacheTime = 0;

let scanCache = new Map<string, Signal>();
let scanCacheTime = 0;

let scanInProgress: Promise<Signal[]> | null = null;

const candidateMemory = new Map<string, Candidate>();

/* -------------------------------------------------------
   BYBIT HTTP
------------------------------------------------------- */

async function bybitGet(
  path: string,
  params: Record<string, string> = {},
): Promise<JsonObject> {
  const url = new URL(BYBIT + path);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  let lastError = "Bybit request failed";

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT,
    );

    try {
      const result = await fetch(url, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": "GHOST-Bybit-API/1.0",
        },
        signal: controller.signal,
      });

      if (result.status === 429 || result.status >= 500) {
        lastError = `Bybit HTTP ${result.status}`;

        await result.body?.cancel();

        await new Promise((resolve) =>
          setTimeout(resolve, 400 * (attempt + 1))
        );

        continue;
      }

      if (!result.ok) {
        throw new Error(`Bybit HTTP ${result.status}`);
      }

      const data = await result.json() as JsonObject;

      if (number(data.retCode, -1) !== 0) {
        const message = String(data.retMsg ?? "Unknown Bybit error");

        if (
          message.toLowerCase().includes("too many") ||
          message.toLowerCase().includes("frequency")
        ) {
          lastError = message;

          await new Promise((resolve) =>
            setTimeout(resolve, 500 * (attempt + 1))
          );

          continue;
        }

        throw new Error(message);
      }

      return data;
    } catch (error) {
      lastError = error instanceof Error
        ? error.message
        : String(error);

      if (attempt < 2) {
        await new Promise((resolve) =>
          setTimeout(resolve, 300 * (attempt + 1))
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(lastError);
}

/* -------------------------------------------------------
   MARKET UNIVERSE
------------------------------------------------------- */

async function getInstruments(
  forceRefresh = false,
): Promise<Instrument[]> {
  if (
    !forceRefresh &&
    instrumentCache.length > 0 &&
    Date.now() - instrumentCacheTime < SYMBOL_CACHE_TTL
  ) {
    return instrumentCache;
  }

  const instruments: Instrument[] = [];
  let cursor = "";

  for (let page = 0; page < 20; page++) {
    const params: Record<string, string> = {
      category: CATEGORY,
      limit: "1000",
    };

    if (cursor) params.cursor = cursor;

    const data = await bybitGet(
      "/v5/market/instruments-info",
      params,
    );

    const result = data.result as JsonObject | undefined;

    if (!result) break;

    const list = Array.isArray(result.list)
      ? result.list as JsonObject[]
      : [];

    for (const item of list) {
      const symbol = String(item.symbol ?? "");
      const quoteCoin = String(item.quoteCoin ?? "");
      const settleCoin = String(item.settleCoin ?? "");
      const status = String(item.status ?? "");
      const contractType = String(item.contractType ?? "");

      if (
        !symbol.endsWith("USDT") ||
        quoteCoin !== "USDT" ||
        settleCoin !== "USDT" ||
        status !== "Trading"
      ) {
        continue;
      }

      // Exclude dated futures where Bybit provides contract type.
      if (
        contractType &&
        !contractType.toLowerCase().includes("perpetual")
      ) {
        continue;
      }

      instruments.push({
        symbol,
        status,
        quoteCoin,
        settleCoin,
        contractType,
      });
    }

    cursor = String(result.nextPageCursor ?? "");

    if (!cursor || list.length === 0) break;
  }

  const unique = new Map<string, Instrument>();

  for (const item of instruments) {
    unique.set(item.symbol, item);
  }

  instrumentCache = [...unique.values()];
  instrumentCacheTime = Date.now();

  return instrumentCache;
}

/* -------------------------------------------------------
   LIVE TICKERS
------------------------------------------------------- */

async function getTickers(
  forceRefresh = false,
): Promise<Map<string, Ticker>> {
  if (
    !forceRefresh &&
    tickerCache.size > 0 &&
    Date.now() - tickerCacheTime < 5000
  ) {
    return tickerCache;
  }

  const data = await bybitGet("/v5/market/tickers", {
    category: CATEGORY,
  });

  const result = data.result as JsonObject | undefined;

  const list = Array.isArray(result?.list)
    ? result.list as JsonObject[]
    : [];

  const next = new Map<string, Ticker>();

  for (const item of list) {
    const symbol = String(item.symbol ?? "");

    if (!symbol.endsWith("USDT")) continue;

    next.set(symbol, {
      symbol,
      lastPrice: String(item.lastPrice ?? "0"),
      price24hPcnt: String(item.price24hPcnt ?? "0"),
      turnover24h: String(item.turnover24h ?? "0"),
      volume24h: String(item.volume24h ?? "0"),
    });
  }

  tickerCache = next;
  tickerCacheTime = Date.now();

  return tickerCache;
}

/* -------------------------------------------------------
   OHLCV
------------------------------------------------------- */

async function getKlines(
  symbol: string,
  interval: string,
): Promise<Kline[]> {
  const data = await bybitGet("/v5/market/kline", {
    category: CATEGORY,
    symbol,
    interval,
    limit: "40",
  });

  const result = data.result as JsonObject | undefined;

  const list = Array.isArray(result?.list)
    ? result.list as unknown[][]
    : [];

  const klines: Kline[] = [];

  for (const row of list) {
    if (!Array.isArray(row) || row.length < 7) continue;

    klines.push({
      startTime: number(row[0]),
      open: number(row[1]),
      high: number(row[2]),
      low: number(row[3]),
      close: number(row[4]),
      volume: number(row[5]),
      turnover: number(row[6]),
    });
  }

  // Bybit returns newest candle first.
  klines.sort((a, b) => a.startTime - b.startTime);

  return klines;
}

/* -------------------------------------------------------
   MOVING AVERAGES
------------------------------------------------------- */

function movingAverage(
  closes: number[],
  period: number,
  endIndex = closes.length - 1,
): number {
  const startIndex = endIndex - period + 1;

  if (startIndex < 0 || endIndex >= closes.length) {
    return 0;
  }

  const values = closes.slice(startIndex, endIndex + 1);

  if (values.length !== period) return 0;

  return average(values);
}

/* -------------------------------------------------------
   SIGNAL ENGINE
------------------------------------------------------- */

function analyzeKlines(
  symbol: string,
  klines: Kline[],
  ticker: Ticker,
): Signal | null {
  if (klines.length < 30) return null;

  const closes = klines.map((candle) => candle.close);

  const lastIndex = closes.length - 1;
  const previousIndex = lastIndex - 1;

  const ma7 = movingAverage(closes, 7, lastIndex);
  const ma14 = movingAverage(closes, 14, lastIndex);
  const ma28 = movingAverage(closes, 28, lastIndex);

  const previousMa7 = movingAverage(closes, 7, previousIndex);
  const previousMa14 = movingAverage(closes, 14, previousIndex);
  const previousMa28 = movingAverage(closes, 28, previousIndex);

  const price = number(ticker.lastPrice, closes[lastIndex]);

  if (
    price <= 0 ||
    ma7 <= 0 ||
    ma14 <= 0 ||
    ma28 <= 0
  ) {
    return null;
  }

  const ma7AboveMa14 = ma7 > ma14;
  const ma14AboveMa28 = ma14 > ma28;

  const bullishAlignment = ma7AboveMa14 && ma14AboveMa28;

  const crossUp =
    previousMa7 <= previousMa14 &&
    ma7 > ma14;

  const convergence = (
    Math.max(ma7, ma14, ma28) -
    Math.min(ma7, ma14, ma28)
  ) / price * 100;

  const priceAboveMA7 = price > ma7;
  const priceAboveMA14 = price > ma14;
  const priceAboveMA28 = price > ma28;

  const candleVolumes = klines
    .slice(-21, -1)
    .map((candle) => candle.volume);

  const averageVolume = average(candleVolumes);

  const latestVolume = klines[lastIndex].volume;

  const rvol = averageVolume > 0
    ? latestVolume / averageVolume
    : 0;

  const previousVolume = klines[lastIndex - 1].volume;

  const volumeAcceleration = previousVolume > 0
    ? latestVolume / previousVolume
    : 0;

  let score = 0;

  // MA geometry
  if (ma7AboveMa14) score += 15;
  if (ma14AboveMa28) score += 15;
  if (bullishAlignment) score += 10;

  // Upward cross
  if (crossUp) score += 25;

  // Price confirmation
  if (priceAboveMA7) score += 8;
  if (priceAboveMA14) score += 5;
  if (priceAboveMA28) score += 5;

  // Convergence before a potential move
  if (convergence <= 0.25) score += 15;
  else if (convergence <= 0.5) score += 12;
  else if (convergence <= 0.8) score += 8;
  else if (convergence <= 1.2) score += 4;

  // Volume is supporting evidence, not the only trigger.
  if (rvol >= 1.5) score += 5;
  if (volumeAcceleration >= 1.5) score += 5;

  score = clamp(score, 0, 100);

  let signal = "WATCH";

  if (
    crossUp &&
    priceAboveMA7 &&
    priceAboveMA14
  ) {
    signal = "CROSS-UP";
  } else if (
    bullishAlignment &&
    priceAboveMA7 &&
    convergence <= 1.2
  ) {
    signal = "PRE-LONG";
  } else if (
    ma7AboveMa14 &&
    priceAboveMA7
  ) {
    signal = "WAKE";
  }

  const change24h = number(ticker.price24hPcnt) * 100;

  return {
    symbol,
    price,
    previousPrice: closes[lastIndex],
    change24h,
    turnover24h: number(ticker.turnover24h),

    ma7,
    ma14,
    ma28,

    previousMa7,
    previousMa14,
    previousMa28,

    ma7AboveMa14,
    ma14AboveMa28,
    bullishAlignment,
    crossUp,
    convergence,

    priceAboveMA7,
    priceAboveMA14,
    priceAboveMA28,

    rvol,
    volumeAcceleration,

    score,
    signal,
    timestamp: Date.now(),
  };
}

/* -------------------------------------------------------
   CONCURRENT WORKER POOL
------------------------------------------------------- */

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);

  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      try {
        results[index] = await worker(items[index]);
      } catch {
        // One failed symbol must not abort the whole market scan.
        results[index] = null as R;
      }
    }
  }

  const count = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: count }, () => runWorker()),
  );

  return results;
}

/* -------------------------------------------------------
   CANDIDATE TRACKING
------------------------------------------------------- */

function updateCandidates(
  signals: Signal[],
  pullbackThreshold: number,
  convergenceThreshold: number,
) {
  const now = Date.now();

  const validSignals = new Map<string, Signal>();

  for (const signal of signals) {
    validSignals.set(signal.symbol, signal);

    const existing = candidateMemory.get(signal.symbol);

    const qualified =
      signal.score >= 50 &&
      signal.priceAboveMA7 &&
      signal.convergence <= convergenceThreshold &&
      (
        signal.signal === "CROSS-UP" ||
        signal.signal === "PRE-LONG" ||
        signal.signal === "WAKE"
      );

    if (existing) {
      existing.lastPrice = signal.price;

      existing.highestPrice = Math.max(
        existing.highestPrice,
        signal.price,
      );

      existing.changeFromEntry = percentChange(
        signal.price,
        existing.entryPrice,
      );

      existing.pullbackFromHigh = existing.highestPrice > 0
        ? (
          (existing.highestPrice - signal.price) /
          existing.highestPrice
        ) * 100
        : 0;

      existing.lastSeen = now;
      existing.score = signal.score;
      existing.signal = signal.signal;

      if (
        existing.pullbackFromHigh >= pullbackThreshold ||
        !signal.priceAboveMA7
      ) {
        candidateMemory.delete(signal.symbol);
      } else {
        existing.state = "TRACKING";
      }

      continue;
    }

    if (qualified) {
      candidateMemory.set(signal.symbol, {
        symbol: signal.symbol,
        entryPrice: signal.price,
        lastPrice: signal.price,
        highestPrice: signal.price,
        changeFromEntry: 0,
        pullbackFromHigh: 0,
        firstSeen: now,
        lastSeen: now,
        state: "NEW",
        score: signal.score,
        signal: signal.signal,
      });
    }
  }

  // Avoid retaining inactive symbols forever.
  for (const [symbol, candidate] of candidateMemory.entries()) {
    if (now - candidate.lastSeen > 6 * 60 * 60 * 1000) {
      candidateMemory.delete(symbol);
    }
  }

  return {
    total: candidateMemory.size,
    candidates: [...candidateMemory.values()].sort(
      (a, b) => b.score - a.score,
    ),
  };
}

/* -------------------------------------------------------
   FULL MARKET SCAN
------------------------------------------------------- */

async function runScan(
  interval: string,
  convergenceThreshold: number,
  pullbackThreshold: number,
  forceRefresh = false,
): Promise<Signal[]> {
  const cacheKey = `${interval}:${convergenceThreshold}`;

  if (
    !forceRefresh &&
    scanCache.size > 0 &&
    Date.now() - scanCacheTime < CACHE_TTL
  ) {
    return [...scanCache.values()];
  }

  if (scanInProgress) {
    return await scanInProgress;
  }

  scanInProgress = (async () => {
    const instruments = await getInstruments(forceRefresh);
    const tickers = await getTickers(forceRefresh);

    // Symbols with no current ticker are skipped.
    const symbols = instruments.filter(
      (item) => tickers.has(item.symbol),
    );

    const results = await mapLimit(
      symbols,
      SCAN_CONCURRENCY,
      async (instrument) => {
        const ticker = tickers.get(instrument.symbol);

        if (!ticker) return null;

        const klines = await getKlines(
          instrument.symbol,
          interval,
        );

        return analyzeKlines(
          instrument.symbol,
          klines,
          ticker,
        );
      },
    );

    const signals = results
      .filter((item): item is Signal => item !== null)
      .sort((a, b) => b.score - a.score);

    scanCache = new Map(
      signals.map((signal) => [signal.symbol, signal]),
    );

    scanCacheTime = Date.now();

    updateCandidates(
      signals,
      pullbackThreshold,
      convergenceThreshold,
    );

    return signals;
  })();

  try {
    return await scanInProgress;
  } finally {
    scanInProgress = null;
  }
}

/* -------------------------------------------------------
   API HANDLER
------------------------------------------------------- */

export const handler = define.handlers({
  OPTIONS() {
    return new Response(null, {
      status: 204,
      headers: jsonHeaders,
    });
  },

  async GET(ctx) {
    const url = new URL(ctx.req.url);

    const endpoint = url.searchParams.get("endpoint") ?? "help";

    const interval = validInterval(
      url.searchParams.get("interval"),
    );

    const convergence = clamp(
      number(
        url.searchParams.get("convergence"),
        DEFAULT_CONVERGENCE,
      ),
      0.05,
      5,
    );

    const pullback = clamp(
      number(
        url.searchParams.get("pullback"),
        DEFAULT_PULLBACK,
      ),
      0.2,
      10,
    );

    const limit = Math.floor(
      clamp(
        number(url.searchParams.get("limit"), 50),
        1,
        500,
      ),
    );

    try {
      if (endpoint === "help") {
        return response({
          ok: true,
          engine: API_VERSION,
          version: "1.0.0",
          source: "Bybit V5 public market API",
          category: CATEGORY,
          description:
            "Full USDT perpetual market scanner using MA7/14/28 geometry, cross-up detection and candidate tracking.",
          endpoints: {
            help: "/api?endpoint=help",
            markets: "/api?endpoint=markets",
            scan: "/api?endpoint=scan",
            candidates: "/api?endpoint=candidates",
            symbol: "/api?endpoint=symbol&symbol=BTCUSDT",
          },
          parameters: {
            interval: [
              "1",
              "3",
              "5",
              "15",
              "30",
              "60",
              "120",
              "240",
              "360",
              "720",
            ],
            convergence:
              "Maximum percentage distance between MA7, MA14 and MA28 for candidate qualification.",
            pullback:
              "Maximum allowed percentage pullback from candidate's tracked high before removal.",
            limit: "Maximum number of returned records.",
            refresh: "Set refresh=1 to force a fresh scan.",
          },
          notes: [
            "MA values are calculated from Bybit OHLCV candles.",
            "Live lastPrice is obtained from Bybit tickers.",
            "The latest candle may still be forming.",
            "Candidate memory is local to the running server instance.",
            "This API provides market signals, not guaranteed predictions.",
          ],
          timestamp: Date.now(),
        });
      }

      if (endpoint === "markets") {
        const instruments = await getInstruments(
          url.searchParams.get("refresh") === "1",
        );

        const tickers = await getTickers(
          url.searchParams.get("refresh") === "1",
        );

        return response({
          ok: true,
          engine: API_VERSION,
          category: CATEGORY,
          totalSymbols: instruments.length,
          tickerCount: tickers.size,
          symbols: instruments.map((item) => ({
            symbol: item.symbol,
            status: item.status,
            price: number(tickers.get(item.symbol)?.lastPrice),
            change24h:
              number(tickers.get(item.symbol)?.price24hPcnt) * 100,
            turnover24h:
              number(tickers.get(item.symbol)?.turnover24h),
          })),
          timestamp: Date.now(),
        });
      }

      if (endpoint === "scan") {
        const forceRefresh =
          url.searchParams.get("refresh") === "1";

        const signals = await runScan(
          interval,
          convergence,
          pullback,
          forceRefresh,
        );

        const signalFilter =
          url.searchParams.get("signal")?.toUpperCase();

        const filtered = signalFilter
          ? signals.filter((item) => item.signal === signalFilter)
          : signals;

        const offset = Math.floor(
          clamp(
            number(url.searchParams.get("offset"), 0),
            0,
            100000,
          ),
        );

        return response({
          ok: true,
          engine: API_VERSION,
          category: CATEGORY,
          interval,
          totalScanned: signals.length,
          totalMatching: filtered.length,
          offset,
          limit,
          convergenceThreshold: convergence,
          pullbackThreshold: pullback,
          results: filtered.slice(offset, offset + limit),
          timestamp: Date.now(),
        });
      }

      if (endpoint === "candidates") {
        // A fresh scan updates candidate state.
        const refresh = url.searchParams.get("refresh") === "1";

        if (refresh || scanCache.size === 0) {
          await runScan(
            interval,
            convergence,
            pullback,
            refresh,
          );
        }

        const candidates = [...candidateMemory.values()].sort(
          (a, b) => b.score - a.score,
        );

        return response({
          ok: true,
          engine: API_VERSION,
          totalCandidates: candidates.length,
          candidates: candidates.slice(0, limit),
          timestamp: Date.now(),
        });
      }

      if (endpoint === "symbol") {
        const symbol = (
          url.searchParams.get("symbol") ?? ""
        ).toUpperCase();

        if (!/^[A-Z0-9]+USDT$/.test(symbol)) {
          return errorResponse(
            "Invalid symbol. Example: BTCUSDT",
            400,
          );
        }

        const [tickerMap, klines] = await Promise.all([
          getTickers(true),
          getKlines(symbol, interval),
        ]);

        const ticker = tickerMap.get(symbol);

        if (!ticker) {
          return errorResponse(
            `Symbol ${symbol} was not found in the current linear market.`,
            404,
          );
        }

        const signal = analyzeKlines(
          symbol,
          klines,
          ticker,
        );

        if (!signal) {
          return errorResponse(
            `Not enough OHLCV data for ${symbol}.`,
            502,
          );
        }

        return response({
          ok: true,
          engine: API_VERSION,
          result: signal,
          candlesAvailable: klines.length,
          timestamp: Date.now(),
        });
      }

      return errorResponse(
        `Unknown endpoint: ${endpoint}. Use endpoint=help.`,
        400,
        {
          availableEndpoints: [
            "help",
            "markets",
            "scan",
            "candidates",
            "symbol",
          ],
        },
      );
    } catch (error) {
      return errorResponse(
        error instanceof Error
          ? error.message
          : String(error),
        502,
      );
    }
  },
});
