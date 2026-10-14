// GHOST BYBIT AI API
// Fresh route: /api

const BYBIT = "https://api.bybit.com";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

async function fetchBybit(path: string, params: Record<string, string> = {}) {
  const url = new URL(BYBIT + path);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Bybit HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.retCode !== 0) {
    throw new Error(data.retMsg || "Bybit API error");
  }

  return data.result;
}

function normalize(t: any) {
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
    timestamp: Date.now(),
  };
}

export const handler = {
  async GET(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const endpoint = url.searchParams.get("endpoint") || "help";

    try {
      if (endpoint === "help") {
        return response({
          name: "GHOST BYBIT AI DATA API",
          version: "1.0",
          source: "Bybit V5",
          endpoints: [
            "/api?endpoint=market",
            "/api?endpoint=scan",
            "/api?endpoint=top",
            "/api?endpoint=symbol&symbol=BTCUSDT",
          ],
          note: "Read-only public market data.",
        });
      }

      if (endpoint === "market") {
        let cursor = "";
        const symbols: any[] = [];

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

          symbols.push(...result.list);

          const next = result.nextPageCursor || "";
          if (!next || next === cursor) break;
          cursor = next;
        }

        const active = symbols.filter((x: any) =>
          x.status === "Trading" &&
          x.quoteCoin === "USDT" &&
          x.contractType === "LinearPerpetual"
        );

        return response({
          count: active.length,
          symbols: active.map((x: any) => x.symbol),
          timestamp: Date.now(),
        });
      }

      if (
        endpoint === "scan" ||
        endpoint === "top" ||
        endpoint === "symbol"
      ) {
        let list: any[];

        if (endpoint === "symbol") {
          const symbol = (
            url.searchParams.get("symbol") || ""
          ).toUpperCase();

          if (!/^[A-Z0-9]{2,30}USDT$/.test(symbol)) {
            return response({
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

          list = result.list.filter((x: any) =>
            x.symbol.endsWith("USDT")
          );
        }

        let data = list.map(normalize);

        if (endpoint === "top") {
          data.sort((a, b) => b.change24hPct - a.change24hPct);
          data = data.slice(
            0,
            Math.min(100, Math.max(1, Number(
              url.searchParams.get("limit") || 30
            ))),
          );
        }

        if (endpoint === "scan") {
          const minTurnover = Math.max(
            0,
            Number(url.searchParams.get("minTurnover") || 0),
          );

          data = data
            .filter((x) => x.turnover24hUSDT >= minTurnover)
            .sort((a, b) => b.turnover24hUSDT - a.turnover24hUSDT);

          const limit = Math.min(
            1000,
            Math.max(1, Number(url.searchParams.get("limit") || 1000)),
          );

          data = data.slice(0, limit);
        }

        return response({
          endpoint,
          count: data.length,
          data,
          timestamp: Date.now(),
        });
      }

      return response({ error: "Unknown endpoint" }, 404);
    } catch (error) {
      return response({
        error: error instanceof Error
          ? error.message
          : "Unknown error",
        timestamp: Date.now(),
      }, 502);
    }
  },
};
