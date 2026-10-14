import { define } from "../utils.ts";

const BYBIT = "https://api.bybit.com";

const headers = {
"Content-Type": "application/json; charset=utf-8",
"Access-Control-Allow-Origin": "*",
"Cache-Control": "no-store",
};

function json(data: unknown, status = 200): Response {
return new Response(JSON.stringify(data), { status, headers });
}

async function fetchBybit(
path: string,
params: Record<string, string> = {},
) {
const url = new URL(path, BYBIT);

for (const [key, value] of Object.entries(params)) {
url.searchParams.set(key, value);
}

const res = await fetch(url);

if (!res.ok) {
throw new Error("Bybit HTTP ${res.status}");
}

const body = await res.json();

if (body.retCode !== 0) {
throw new Error(body.retMsg || "Bybit API error");
}

return body.result;
}

function normalize(t: Record<string, string>) {
return {
symbol: t.symbol,
price: Number(t.lastPrice),
change24hPct: Number(t.price24hPcnt) * 100,
turnover24hUSDT: Number(t.turnover24h),
volume24h: Number(t.volume24h),
fundingRate: Number(t.fundingRate),
openInterest: Number(t.openInterest),
openInterestValueUSDT: Number(t.openInterestValue),
bid: Number(t.bid1Price),
ask: Number(t.ask1Price),
};
}

export const handler = define.handlers({
async GET(ctx) {
const url = new URL(ctx.req.url);
const endpoint = url.searchParams.get("endpoint") || "help";

try {
  if (endpoint === "help") {
    return json({
      name: "GHOST BYBIT AI DATA API",
      version: "1.1",
      source: "Bybit V5 public market data",
      endpoints: [
        "/api?endpoint=help",
        "/api?endpoint=market",
        "/api?endpoint=scan",
        "/api?endpoint=top&limit=30",
        "/api?endpoint=symbol&symbol=BTCUSDT",
      ],
    });
  }

  if (endpoint === "market") {
    let cursor = "";
    const instruments: Record<string, string>[] = [];

    for (let page = 0; page < 20; page++) {
      const params: Record<string, string> = {
        category: "linear",
        limit: "1000",
      };

      if (cursor) params.cursor = cursor;

      const result = await fetchBybit(
        "/v5/market/instruments-info",
        params,
      );

      instruments.push(...result.list);

      const next = result.nextPageCursor || "";
      if (!next || next === cursor) break;

      cursor = next;
    }

    const active = instruments.filter((x) =>
      x.status === "Trading" &&
      x.quoteCoin === "USDT" &&
      x.contractType === "LinearPerpetual"
    );

    return json({
      count: active.length,
      symbols: active.map((x) => x.symbol),
      timestamp: Date.now(),
    });
  }

  if (
    endpoint === "scan" ||
    endpoint === "top" ||
    endpoint === "symbol"
  ) {
    let list: Record<string, string>[];

    if (endpoint === "symbol") {
      const symbol = (
        url.searchParams.get("symbol") || ""
      ).toUpperCase();

      if (!/^[A-Z0-9]{2,30}USDT$/.test(symbol)) {
        return json({
          error: "Provide a valid symbol, e.g. BTCUSDT",
        }, 400);
      }

      const result = await fetchBybit(
        "/v5/market/tickers",
        { category: "linear", symbol },
      );

      list = result.list;
    } else {
      const result = await fetchBybit(
        "/v5/market/tickers",
        { category: "linear" },
      );

      list = result.list.filter((x: Record<string, string>) =>
        x.symbol.endsWith("USDT")
      );
    }

    let data = list.map(normalize);

    if (endpoint === "top") {
      data.sort((a, b) => b.change24hPct - a.change24hPct);

      const requested = Number(url.searchParams.get("limit") || 30);
      const limit = Number.isFinite(requested)
        ? Math.min(100, Math.max(1, Math.floor(requested)))
        : 30;

      data = data.slice(0, limit);
    }

    if (endpoint === "scan") {
      const rawTurnover = Number(
        url.searchParams.get("minTurnover") || 0,
      );
      const minTurnover = Number.isFinite(rawTurnover)
        ? Math.max(0, rawTurnover)
        : 0;

      const rawLimit = Number(url.searchParams.get("limit") || 1000);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(1000, Math.max(1, Math.floor(rawLimit)))
        : 1000;

      data = data
        .filter((x) => x.turnover24hUSDT >= minTurnover)
        .sort((a, b) => b.turnover24hUSDT - a.turnover24hUSDT)
        .slice(0, limit);
    }

    return json({
      endpoint,
      count: data.length,
      data,
      timestamp: Date.now(),
    });
  }

  return json({ error: "Unknown endpoint" }, 404);
} catch (error) {
  return json({
    error: error instanceof Error ? error.message : "Unknown error",
    timestamp: Date.now(),
  }, 502);
}

},
});
