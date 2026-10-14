// GHOST BYBIT AI DATA API v1.0
// Public market data for ChatGPT, DeepSeek and other AI clients.
// Data source: Bybit V5 public market API.

const BYBIT = "https://api.bybit.com";
const CATEGORY = "linear";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const jsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=5",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: jsonHeaders,
  });
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function bybit(path: string, params: Record<string, string> = {}) {
  const url = new URL(BYBIT + path);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: { "User-Agent": "GHOST-Bybit-AI-API/1.0" },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Bybit HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.retCode !== 0) {
    throw new Error(`Bybit API error: ${data.retMsg}`);
  }

  return data.result;
}

// Fetch the complete instrument list using cursor pagination.
async function getAllInstruments() {
  const instruments: any[] = [];
  let cursor = "";

  for (let page = 0; page < 20; page++) {
    const params: Record<string, string> = {
      category: CATEGORY,
      limit: "1000",
    };

    if (cursor) params.cursor = cursor;

    const result = await bybit("/v5/market/instruments-info", params);

    instruments.push(...(result.list ?? []));

    const next = result.nextPageCursor ?? "";

    if (!next || next === cursor) break;
    cursor = next;
  }

  return instruments.filter((x) =>
    x.status === "Trading" &&
    x.quoteCoin === "USDT" &&
    x.contractType === "LinearPerpetual"
  );
}

// Fetch market tickers in pages of up to 1000.
async function getTickers() {
  const result = await bybit("/v5/market/tickers", {
    category: CATEGORY,
  });

  return (result.list ?? []).filter((x: any) =>
    x.symbol.endsWith("USDT")
  );
}

function normalizeTicker(t: any) {
  const last = num(t.lastPrice);
  const high = num(t.highPrice24h);
  const low = num(t.lowPrice24h);
  const open = num(t.prevPrice24h);
  const turnover = num(t.turnover24h);
  const volume = num(t.volume24h);

  return {
    symbol: t.symbol,
    lastPrice: last,
    markPrice: num(t.markPrice),
    indexPrice: num(t.indexPrice),

    change24hPct: num(t.price24hPcnt) * 100,

    high24h: high,
    low24h: low,
    open24h: open,

    turnover24hUSDT: turnover,
    volume24h: volume,

    bid1Price: num(t.bid1Price),
    bid1Size: num(t.bid1Size),
    ask1Price: num(t.ask1Price),
    ask1Size: num(t.ask1Size),

    fundingRate: num(t.fundingRate),
    nextFundingTime: t.nextFundingTime ?? null,

    openInterest: num(t.openInterest),
    openInterestValueUSDT: num(t.openInterestValue),

    pricePosition24hPct:
      high > low ? ((last - low) / (high - low)) * 100 : null,

    priceVs24hOpenPct:
      open > 0 ? ((last - open) / open) * 100 : null,

    timestamp: Date.now(),
  };
}

async function getSymbol(symbol: string) {
  const s = symbol.toUpperCase();

  if (!/^[A-Z0-9]{2,30}USDT$/.test(s)) {
    throw new Error("Invalid symbol. Example: BTCUSDT");
  }

  const [tickerResult, klineResult, oiResult] = await Promise.all([
    bybit("/v5/market/tickers", {
      category: CATEGORY,
      symbol: s,
    }),

    bybit("/v5/market/kline", {
      category: CATEGORY,
      symbol: s,
      interval: "5",
      limit: "100",
    }),

    bybit("/v5/market/open-interest", {
      category: CATEGORY,
      symbol: s,
      intervalTime: "5min",
      limit: "50",
    }),
  ]);

  const rawTicker = tickerResult.list?.[0];

  if (!rawTicker) {
    throw new Error(`Symbol not found: ${s}`);
  }

  const candles = (klineResult.list ?? [])
    .map((k: any[]) => ({
      startTime: Number(k[0]),
      open: num(k[1]),
      high: num(k[2]),
      low: num(k[3]),
      close: num(k[4]),
      volume: num(k[5]),
      turnover: num(k[6]),
    }))
    .reverse();

  const closes = candles.map((c: any) => c.close);

  function ma(period: number) {
    if (closes.length < period) return null;

    const slice = closes.slice(-period);
    return slice.reduce((a: number, b: number) => a + b, 0) /
      period;
  }

  const oiHistory = (oiResult.list ?? [])
    .map((x: any) => ({
      timestamp: Number(x.timestamp),
      openInterest: num(x.openInterest),
    }))
    .reverse();

  const oiFirst = oiHistory[0]?.openInterest ?? 0;
  const oiLast = oiHistory.at(-1)?.openInterest ?? 0;

  return {
    ...normalizeTicker(rawTicker),

    timeframe: "5m",

    movingAverages: {
      MA7: ma(7),
      MA14: ma(14),
      MA28: ma(28),

      bullishAlignment:
        ma(7) !== null &&
        ma(14) !== null &&
        ma(28) !== null &&
        ma(7)! > ma(14)! &&
        ma(14)! > ma(28)!,
    },

    candles,
    openInterestHistory: oiHistory,

    openInterestChangePct:
      oiFirst > 0 ? ((oiLast - oiFirst) / oiFirst) * 100 : null,

    dataTimestamp: Date.now(),
  };
}

async function getMarket() {
  const [instruments, tickers] = await Promise.all([
    getAllInstruments(),
    getTickers(),
  ]);

  const tickerMap = new Map(
    tickers.map((t: any) => [t.symbol, t])
  );

  const symbols = instruments
    .map((i: any) => {
      const ticker = tickerMap.get(i.symbol);

      return {
        symbol: i.symbol,
        baseCoin: i.baseCoin,
        quoteCoin: i.quoteCoin,
        status: i.status,
        contractType: i.contractType,
        priceScale: i.priceScale,
        tickSize: i.priceFilter?.tickSize,
        minOrderQty: i.lotSizeFilter?.minOrderQty,
        turnover24hUSDT: ticker
          ? num((ticker as any).turnover24h)
          : 0,
      };
    })
    .sort((a: any, b: any) =>
      b.turnover24hUSDT - a.turnover24hUSDT
    );

  return {
    source: "Bybit V5",
    category: CATEGORY,
    count: symbols.length,
    symbols,
    timestamp: Date.now(),
  };
}

async function getScan(url: URL) {
  const limit = Math.min(
    1000,
    Math.max(1, Number(url.searchParams.get("limit") ?? 1000))
  );

  const minTurnover = Math.max(
    0,
    Number(url.searchParams.get("minTurnover") ?? 0)
  );

  const [instruments, tickers] = await Promise.all([
    getAllInstruments(),
    getTickers(),
  ]);

  const activeSymbols = new Set(
    instruments.map((x: any) => x.symbol)
  );

  const rows = tickers
    .filter((t: any) =>
      activeSymbols.has(t.symbol) &&
      num(t.turnover24h) >= minTurnover
    )
    .map(normalizeTicker)
    .sort((a: any, b: any) =>
      b.turnover24hUSDT - a.turnover24hUSDT
    );

  return {
    source: "Bybit V5",
    category: CATEGORY,
    totalAvailable: instruments.length,
    returned: Math.min(limit, rows.length),
    minTurnoverUSDT: minTurnover,
    data: rows.slice(0, limit),
    timestamp: Date.now(),
  };
}

async function getTop(url: URL) {
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit") ?? 30))
  );

  const scan = await getScan(
    new URL("https://local/scan?limit=1000")
  ) as any;

  const data = scan.data
    .slice()
    .sort((a: any, b: any) =>
      b.change24hPct - a.change24hPct
    )
    .slice(0, limit);

  return {
    description: "Largest positive 24h price changes",
    count: data.length,
    data,
    timestamp: Date.now(),
  };
}

function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "GHOST Bybit AI Data API",
      version: "1.0.0",
      description:
        "Read-only public Bybit linear USDT perpetual market data.",
    },
    servers: [{ url: new URL("/", "https://YOUR-APP.deno.net").origin }],
    paths: {
      "/market": {
        get: {
          operationId: "getMarket",
          summary: "Get all active USDT perpetual instruments",
          responses: { "200": { description: "Instrument list" } },
        },
      },
      "/scan": {
        get: {
          operationId: "scanMarket",
          summary: "Get market tickers",
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", default: 1000 },
            },
            {
              name: "minTurnover",
              in: "query",
              schema: { type: "number", default: 0 },
            },
          ],
          responses: { "200": { description: "Market data" } },
        },
      },
      "/symbol": {
        get: {
          operationId: "getSymbol",
          summary: "Get ticker, 5m candles, MAs and OI history",
          parameters: [
            {
              name: "symbol",
              in: "query",
              required: true,
              schema: { type: "string", example: "BTCUSDT" },
            },
          ],
          responses: { "200": { description: "Symbol data" } },
        },
      },
      "/top": {
        get: {
          operationId: "getTop",
          summary: "Get largest 24h gainers",
          responses: { "200": { description: "Top gainers" } },
        },
      },
    },
  };
}

const instructions = `
GHOST BYBIT AI DATA API

This is a read-only market-data API for Bybit USDT perpetual contracts.

Available endpoints:
GET /market
GET /scan?limit=1000
GET /scan?limit=1000&minTurnover=500000
GET /symbol?symbol=BTCUSDT
GET /top?limit=30
GET /openapi.json

For market-wide analysis:
1. Fetch /scan?limit=1000.
2. Inspect every returned symbol; do not analyze only the first few.
3. Rank candidates by liquidity, price action, funding, open interest and
   distance from recent highs.
4. Fetch /symbol?symbol=SYMBOLUSDT for promising candidates.
5. Distinguish current measurements from historical changes.
6. Never describe a 24h gainer as a confirmed future gainer.
7. State data timestamps and uncertainty.
8. This API does not execute trades or provide private account data.
`;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return json({ error: "Method not allowed. Use GET." }, 405);
  }

  try {
    switch (url.pathname) {
      case "/":
        return new Response(
          JSON.stringify({
            name: "GHOST BYBIT AI DATA API",
            version: "1.0.0",
            status: "online",
            source: "Bybit V5 public API",
            endpoints: [
              "/market",
              "/scan?limit=1000",
              "/scan?limit=1000&minTurnover=500000",
              "/symbol?symbol=BTCUSDT",
              "/top?limit=30",
              "/openapi.json",
            ],
            instructions,
            timestamp: Date.now(),
          }, null, 2),
          { headers: jsonHeaders }
        );

      case "/market":
        return json(await getMarket());

      case "/scan":
        return json(await getScan(url));

      case "/symbol": {
        const symbol = url.searchParams.get("symbol");

        if (!symbol) {
          return json({
            error: "Missing symbol",
            example: "/symbol?symbol=BTCUSDT",
          }, 400);
        }

        return json(await getSymbol(symbol));
      }

      case "/top":
        return json(await getTop(url));

      case "/openapi.json":
        return json(openApiDocument());

      default:
        return json({
          error: "Endpoint not found",
          available: [
            "/",
            "/market",
            "/scan",
            "/symbol?symbol=BTCUSDT",
            "/top",
            "/openapi.json",
          ],
        }, 404);
    }
  } catch (error) {
    return json({
      error: error instanceof Error
        ? error.message
        : "Unknown error",
      source: "GHOST BYBIT AI DATA API",
      timestamp: Date.now(),
    }, 502);
  }
});
