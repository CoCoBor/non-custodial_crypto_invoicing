# How far apart do our exchanges' prices really get? Evidence for an outlier limit

Written 2026-11-20 (data pulled 2026-11-19 ~17:00 UTC). Read-only study: nothing in the repo was edited, no `.env` read, no API keys, only unauthenticated public GET requests with sleeps and back-off.

## 1. Short answer

**Recommended limit: 2.5% for every non-stablecoin pair, and 1% for the three stablecoin pairs (USDT/USD, USDC/USD, USDC/USDT).** If the owner wants a single number, 2.5% is the one the data supports; 2% costs about twice as many TRX refusals and buys almost no extra protection.

Evidence in one paragraph:

- **Calm month (last 30 days).** Liquid pairs (BTC, ETH, SOL, BNB, LTC, USDC, USDT) almost never get near 2%: on the 1-minute and 5-minute grids p99 of an exchange's distance from the cross-exchange median is at most 0.32% and p99.9 at most 0.72%; the worst single point in the 2.0 million 1-minute observations on these pairs is 2.2% (one MEXC LTC/USDT minute). On the coarser grids Gemini's stale candles reach 3.7% (5m, BTC/USDT) and 4.3% (1h, ETH/USDT). Stablecoin pairs never exceed 0.63%.
- **The only pairs where a limit bites in a calm month are the thin ones:** TRX/USDT (6 exchanges), XMR/USDT (5), and TON direct USD (4). TRX had a real, volume-backed 5–8% split between exchange groups on 2026-10-29 to 10-31: at 2% a TRX invoice could not be priced for 571 one-minute steps (11 episodes), at 2.5% for 273 steps (8 episodes), on the 1-minute grid (an upper bound, see §2.4). On the 5-minute grid, where every configured TRX exchange has a candle, it is 0.09% of steps at 2% (about 39 minutes) and 0.06% at 2.5% (about 26 minutes).
- **Stress windows (three big-move episodes).** The majors stay inside 2% on almost every minute even in crashes (BTC/USDT worst 1.75%, ETH/USDT worst 4.2%), but single exchanges do fly off in crashes: SOL/USDT spread from 131 to 181 across exchanges at the same minute on 2025-10-10, and bad prints (Bitfinex TON up to 108% off, Crypto.com USDT/USD 12.6% off for one minute). In W1 a 2.5% limit drops 1.6% of the (non-stable) exchange-observations and a 2% limit 2.2%; in W3 0.70% and 0.87%; in W2 (a slower crash) essentially none.
- **The volume-weighted average already ignores thin outliers.** On calm hourly data the weighted price is within 0.5% of the median on every pair that has enough usable hours (TON/USD, with 23, is the exception), and the rule changes the weighted price by at most 0.85% (TRX) and usually by nothing. The rule only matters in crashes: it cut SOL/USDT's error vs. the median from 1.65% to 0.79% and TON/USDT's from 5.0% to 1.35% in the 2025-10-10 window. So the rule is mainly a crash-time and bad-feed safeguard, and its price is refusals on thin pairs.
- **Cost summary at 2.5%** (details §3, §4): no refusals for BTC, ETH, SOL, BNB, LTC, USDC, USDT, TON/USDT in the calm month; TRX 26 min (5m grid) to 273 min (1m grid, upper bound) per 30 days; XMR 0 on the 1m and 1h grids, up to 0.56% of 5-minute steps (upper bound). In the crash windows no pair loses its price if the exchanges we have no candles for are healthy (lower bound 0%); if they are all absent the upper bound is high for TON/USDT, XMR and USDT/USD (§4).
- **Design notes that change the cost:** (a) put the rule inside `weightedPrice`; then a USD request whose direct price is refused still falls back to coin/USDT × USDT/USD in `priceOfCoin`, which is what rescues TON/USD (the direct USD book disagrees by 1–5% *right now*, §6). (b) 4-source pairs (LTC/USD, TON/USD, USDC/USD) are refused after *any* drop; today's 4-source minimum already makes them fragile. (c) TRX is only used for the Tron fee burn, not for payers.

What this study cannot tell: whether a close-to-close gap would also have been a bid/ask-midpoint gap (§6 estimates this on a small live sample), anything below one minute, and how the four exchanges with no fine history that far back (Gate, MEXC, Gemini, HTX) behaved (Kraken needed trade-built candles) in the crash windows.

## 2. What was measured

### 2.1 Pairs and exchanges actually used

From `src/storage/markets.json` and `src/invoice/price.function.ts` (`weightedPrice` drops `bitstamp`; every other listed exchange counts; XT and Bitfinex count for every coin from 2026-11-20; MIN_SOURCES = 4). Sixteen pairs have at least four exchanges and were analysed; `xmr/usd` (2), `bnb/usd` (3), `dai/usd` (2) and `dai/usdt` (1) never price directly, so no outlier rule applies to them directly (XMR and BNB USD go through coin/USDT × USDT/USD, DAI through USDC).

| pair | exchanges used for weighting (bitstamp is excluded in code) | n | how a USD invoice is priced |
|---|---|---|---|
| btc/usd | binance, bitfinex, bybit, cryptocom, gate, gemini, kraken | 7 | direct |
| btc/usdt | binance, bitfinex, bybit, cryptocom, gate, gemini, kraken, kucoin, mexc, okx, xt | 11 | direct |
| eth/usd | binance, bitfinex, bybit, cryptocom, gate, gemini, kraken | 7 | direct |
| eth/usdt | binance, bitfinex, bybit, cryptocom, gate, gemini, kraken, kucoin, mexc, okx, xt | 11 | direct |
| sol/usd | binance, bitfinex, cryptocom, gemini, kraken | 5 | direct |
| sol/usdt | binance, bitfinex, bybit, cryptocom, gate, kraken, kucoin, mexc, okx, xt | 10 | direct |
| ltc/usd | bitfinex, cryptocom, gemini, kraken | 4 | direct |
| ltc/usdt | binance, bitfinex, bybit, cryptocom, gate, kraken, kucoin, mexc, okx, xt | 10 | direct |
| xmr/usdt | bitfinex, htx, kraken, kucoin, xt | 5 | direct |
| xmr/usd | bitfinex, kraken | 2 | below MIN_SOURCES: never priced directly |
| bnb/usd | binance, gemini, kraken | 3 | below MIN_SOURCES: never priced directly |
| bnb/usdt | binance, bybit, gate, kraken, kucoin, mexc, okx, xt | 8 | direct |
| ton/usd | bitfinex, cryptocom, gemini, kraken | 4 | direct |
| ton/usdt | binance, bitfinex, bybit, cryptocom, gate, kraken, kucoin, mexc, okx, xt | 10 | direct |
| usdt/usd | binance, bitfinex, bybit, cryptocom, gemini, kraken, okx | 7 | direct |
| usdc/usd | binance, bitfinex, gemini, kraken | 4 | direct |
| usdc/usdt | binance, bitfinex, bybit, gate, kraken, kucoin, mexc, okx, xt | 9 | direct |
| dai/usd | gemini, kraken | 2 | DAI is priced from USDC (peg rule, 1% check); outlier rule not applicable |
| dai/usdt | kraken | 1 | DAI is priced from USDC (peg rule, 1% check); outlier rule not applicable |
| trx/usdt | binance, bybit, gate, kucoin, mexc, okx | 6 | direct |

Pair names on each exchange are exactly the strings in `markets.json` (for example TON trades as `GRAM…` on Binance, MEXC, Bybit, OKX, Gate, KuCoin, XT, Crypto.com and Gemini, and as `TON…` on Kraken and Bitfinex).

### 2.2 Data sources (public, unauthenticated) and how deep each API goes

All requests were plain GETs. Rate limiting: per-exchange sleeps from 0.15 s (OKX) to 2.3 s (Bitfinex), 1.3 s on Kraken, exponential back-off on 429/418/403/5xx. Zero errors in the final run (`download.log`).

| exchange | endpoint | official docs | granularity and depth actually used |
|---|---|---|---|
| Binance | `GET https://api.binance.com/api/v3/klines` | https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints (read via the docs repo, https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md) | 1m, 5m, 1h, any date, 1000 per call |
| Bybit | `GET https://api.bybit.com/v5/market/kline?category=spot` | https://bybit-exchange.github.io/docs/v5/market/kline (limit 1–1000 confirmed in the page) | 1m, 5m, 1h, any date |
| OKX | `GET https://www.okx.com/api/v5/market/history-candles` | https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks-history | 1m, 5m, 1h, any date, 100 per call |
| Gate | `GET https://api.gateio.ws/api/v4/spot/candlesticks` | https://www.gate.com/docs/developers/apiv4/en/#market-candlesticks (page refused my script with 403; limits taken from the API's own error: "Maximum 10000 points ago are allowed") | 1m only last ~6.9 days, 5m ~34 days, 1h ~416 days |
| MEXC | `GET https://api.mexc.com/api/v3/klines` | https://www.mexc.com/api-docs/spot-v3/market-data-endpoints (403 to my script; limits observed) | 1m last ~30 days (empty at 35 days), 5m returned empty at 400 days, 60m available for 650 days |
| KuCoin | `GET https://api.kucoin.com/api/v1/market/candles` | https://www.kucoin.com/docs/rest/spot-trading/market/get-klines | 1m, 5m, 1h, any date, 1500 per call |
| Crypto.com | `GET https://api.crypto.com/exchange/v1/public/get-candlestick` | https://exchange-docs.crypto.com/exchange/v1/rest-ws/index.html#public-get-candlestick | 1m, 5m, 1h, any date, 300 per call |
| XT | `GET https://sapi.xt.com/v4/public/kline` | https://doc.xt.com/ | 1m, 5m, 1h, any date, 1000 per call |
| Bitfinex | `GET https://api-pub.bitfinex.com/v2/candles/trade:{tf}:{symbol}/hist` | https://docs.bitfinex.com/reference/rest-public-candles (max 10000 per call confirmed) | 1m, 5m, 1h, any date |
| Gemini | `GET https://api.gemini.com/v2/candles/{symbol}/{timeframe}` | https://docs.gemini.com/rest/market-data (List Candles) | no time range parameter: 1m last 24 h (1439 candles), 5m ~7 days, 1h ~61 days |
| HTX | `GET https://api.huobi.pro/market/history/kline` | https://huobiapi.github.io/docs/spot/v1/en/#get-klines-candles | no time range parameter: newest 2000 candles: 1m ~33 h, 5m ~7 days, 1h ~83 days |
| Kraken | `GET https://api.kraken.com/0/public/OHLC` | https://docs.kraken.com/api/docs/rest-api/get-ohlc-data (page text: "up to 720 of the most recent entries (older data cannot be retrieved, regardless of the value of since)") | 1m last 12 h, 5m last 60 h, 1h last 30 d. For the three stress windows I rebuilt 1-minute candles from `GET https://api.kraken.com/0/public/Trades` (`since`, `count` ≤ 1000; https://docs.kraken.com/api/docs/rest-api/get-recent-trades) |

Live tickers (§6) use exactly the URLs in `price.function.ts`.

Consequences for coverage, which matter for how to read the tables:

- **30-day grids.** 1-minute: Binance, Bybit, OKX, MEXC, KuCoin, Crypto.com, XT, Bitfinex have the full 30 days; Gate only 6.9 days; Kraken 12 h; Gemini 24 h; HTX 33 h. 5-minute: everybody except Kraken (60 h), Gemini (7 d) and HTX (7 d) has all 30 days. 1-hour: everybody, all 30 days (Kraken exactly 720 candles). So on the 1m grid USD pairs (which depend on Kraken and Gemini) almost never have four candles at once; the 1-hour grid is the only one that includes every exchange.
- **Stress windows** (1-minute): Binance, Bybit, OKX, KuCoin, Crypto.com, XT, Bitfinex, and Kraken (from trades). **Gate, MEXC, Gemini and HTX are missing**, because their APIs have no 1-minute (or any fine) history that far back. Pairs that depend on those four (all USD pairs except BTC/USD in W2 and USDT/USD, plus TON) therefore show "not enough exchanges" or inflated refusal counts; see the lower/upper bounds in §2.4.

### 2.3 Stress windows (chosen from the data, not from memory)

I ranked the last 730 days of Binance daily BTC, ETH and SOL candles by high-low range and by move, then looked at the hourly ranges to place a 6–12 hour core around the spike.

| window | UTC span | why |
|---|---|---|
| W1 | 2025-10-10 18:00 to 2025-10-11 02:00 | BTC range 16.9% (7.3% down) on the day; 11.5% range in the 21:00 hour alone, ETH 24% in that hour; SOL range 25%. The liquidation cascade (the data show individual exchanges diverging by 10–30% in the same minute). |
| W2 | 2026-02-05 14:00 to 2026-02-06 02:00 | 2026-02-05 BTC −14.0% (range 15.0%) and 2026-02-06 +12.2% (range 18.7%, the largest BTC day in the 730 days); SOL range 28.5% on 02-06. Repeated hourly ranges of 3–8%. |
| W3 | 2025-02-02 22:00 to 2025-02-03 04:00 | The 02-03 tariff-shock crash: ETH range 27.7% on the day (largest ETH day in the 730 days), hourly ranges of 15.7% and 17.6% at 01:00 and 02:00 UTC. |

### 2.4 Method

For each pair, grid and timestamp where at least 4 exchanges have a candle:

1. Take each exchange's **close**. Candles with zero volume are dropped (Gemini, Crypto.com, Binance, Bybit, OKX, KuCoin and Gate fill quiet minutes with a flat zero-volume candle repeating the last price; that is not a price observation). Dropped counts per exchange are in the result files. A second run also dropped candles with notional (close × volume) under $100; it changes little (§5.3).
2. `median` of the closes (mean of the two middle values when the count is even), `deviation = |close − median| / median`.
3. For each limit X in 0.5, 1, 1.5, 2, 2.5, 3, 5%: **dropped** = exchanges with deviation > X; **cannot price** = fewer than 4 exchanges left after dropping.
4. Percentiles are over all (exchange, timestamp) observations of a pair; "POOLED" rows pool every observation of the listed pairs.

Two bounds for "cannot price", because candles are sparse for thin exchanges and missing for some exchanges in the windows:

- **upper** counts only exchanges that have a candle at that timestamp (a missing candle = an exchange that did not answer). This is pessimistic for thin venues that simply had no trade in the interval.
- **lower** assumes every configured exchange answers and any exchange without a candle is healthy and in agreement, so only observed exchanges can be dropped. Optimistic.

Reality is between them; where the two are equal (5-minute grid, TRX; 1-hour grid, LTC/USD) the number is solid.

A subtle point: the live code needs four *fresh* sources already; the rule only ever removes sources, so it can only increase refusals, never reduce them.

### 2.5 What each grid is good for

| grid | strength | weakness |
|---|---|---|
| 30 days @ 1 min | finest; best tail statistics for the 8 exchanges that have it | no Kraken, Gemini, HTX, almost no Gate; USD pairs have <5% coverage; sparse minutes for thin exchanges inflate the upper bound |
| 30 days @ 5 min | all `usdt` pairs have every configured exchange except where Kraken/Gemini/HTX are missing; cleanest cost number for TRX | still partial for XMR (Kraken 60 h, HTX 7 d) |
| 30 days @ 1 hour | every exchange, every pair, full 720 points | hourly closes hide intra-hour gaps; 720 points means p99.9 is ~7 observations |
| 3 windows @ 1 min | real stress | 4 exchanges absent; 6–12 h each |

## 3. Calm month: last 30 days (2026-10-20 17:00 to 2026-11-19 17:00 UTC)

Market context: BTC fell from about 81k to 63k over the month, with visible cross-exchange dislocations on 2026-10-29 to 10-31 (TRX) and 2026-11-12 to 11-15 (TON, LTC), so it is not a dead month.

### 3.1 Deviation from the cross-exchange median

1-minute grid (finest):

| pair | exchanges with data | timestamps with ≥4 (of all) | obs | p50 | p90 | p99 | p99.9 | max (when, who) |
|---|---|---|---|---|---|---|---|---|
| btc/usd | 7 | 1813 of 43200 (4%) | 8087 | 0.028% | 0.107% | 0.200% | 0.431% | 0.74% (2026-11-05 15:10 UTC, binance) |
| btc/usdt | 11 | 43200 of 43200 (100%) | 355476 | 0.004% | 0.014% | 0.058% | 0.080% | 0.50% (2026-11-14 21:17 UTC, mexc) |
| eth/usd | 7 | 1453 of 43195 (3%) | 6288 | 0.033% | 0.114% | 0.283% | 0.532% | 0.95% (2026-10-30 00:18 UTC, bybit) |
| eth/usdt | 11 | 43200 of 43200 (100%) | 352293 | 0.004% | 0.019% | 0.060% | 0.130% | 0.89% (2026-11-08 21:55 UTC, xt) |
| sol/usd | 5 | 352 of 43040 (1%) | 1425 | 0.029% | 0.091% | 0.154% | 0.228% | 0.30% (2026-11-19 15:00 UTC, gemini) |
| sol/usdt | 10 | 43200 of 43200 (100%) | 354252 | 0.007% | 0.027% | 0.089% | 0.332% | 0.77% (2026-10-29 20:42 UTC, mexc) |
| ltc/usd | 4 | 22 of 41840 (0%) | 88 | 0.035% | 0.104% | 0.166% | 0.205% | 0.21% (2026-11-19 12:25 UTC, gemini) |
| ltc/usdt | 10 | 43192 of 43200 (100%) | 320437 | 0.017% | 0.045% | 0.110% | 0.392% | 2.21% (2026-11-15 01:10 UTC, mexc) |
| xmr/usdt | 5 | 1532 of 43200 (4%) | 6474 | 0.121% | 0.397% | 1.114% | 1.648% | 2.48% (2026-11-19 13:47 UTC, xt) |
| bnb/usdt | 8 | 43193 of 43200 (100%) | 265624 | 0.007% | 0.029% | 0.060% | 0.116% | 0.49% (2026-11-10 13:31 UTC, mexc) |
| ton/usd | 3 | 0 of 4226 | 0 | - | - | - | - | not enough exchanges with candles |
| ton/usdt | 10 | 42911 of 43200 (99%) | 263086 | 0.000% | 0.095% | 0.444% | 1.050% | 19.50% (2026-11-15 00:21 UTC, bitfinex) |
| trx/usdt | 6 | 42907 of 43200 (99%) | 219845 | 0.013% | 0.078% | 1.691% | 3.776% | 9.36% (2026-10-29 22:33 UTC, kucoin) |
| usdt/usd | 7 | 12769 of 43194 (30%) | 53512 | 0.013% | 0.122% | 0.177% | 0.328% | 0.63% (2026-10-30 06:37 UTC, binance) |
| usdc/usd | 4 | 9 of 42676 (0%) | 36 | 0.012% | 0.089% | 0.102% | 0.102% | 0.10% (2026-11-19 15:37 UTC, bitfinex) |
| usdc/usdt | 9 | 43200 of 43200 (100%) | 286064 | 0.001% | 0.011% | 0.034% | 0.054% | 0.31% (2026-10-30 15:52 UTC, bitfinex) |
| POOLED all |  | 362953 | 2492987 | 0.005% | 0.041% | 0.191% | 1.570% | 19.50% (ton/usdt 2026-11-15 00:21 UTC, bitfinex) |
| POOLED excl stablecoins |  | 306975 | 2153375 | 0.006% | 0.043% | 0.223% | 1.720% | 19.50% (ton/usdt 2026-11-15 00:21 UTC, bitfinex) |
| POOLED stablecoin pairs |  | 55978 | 339612 | 0.001% | 0.020% | 0.136% | 0.189% | 0.63% (usdt/usd 2026-10-30 06:37 UTC, binance) |

5-minute grid:

| pair | exchanges with data | timestamps with ≥4 (of all) | obs | p50 | p90 | p99 | p99.9 | max (when, who) |
|---|---|---|---|---|---|---|---|---|
| btc/usd | 7 | 4463 of 8640 (52%) | 19878 | 0.036% | 0.125% | 0.270% | 0.513% | 1.42% (2026-11-15 02:05 UTC, gate) |
| btc/usdt | 11 | 8640 of 8640 (100%) | 78882 | 0.004% | 0.015% | 0.062% | 0.165% | 3.69% (2026-11-14 05:00 UTC, gemini) |
| eth/usd | 7 | 4268 of 8640 (49%) | 18858 | 0.037% | 0.127% | 0.317% | 0.655% | 1.58% (2026-11-17 15:55 UTC, bybit) |
| eth/usdt | 11 | 8640 of 8640 (100%) | 78520 | 0.004% | 0.019% | 0.064% | 0.160% | 1.54% (2026-11-15 02:05 UTC, gemini) |
| sol/usd | 5 | 1017 of 8640 (12%) | 4236 | 0.035% | 0.111% | 0.319% | 0.715% | 1.09% (2026-11-14 22:15 UTC, binance) |
| sol/usdt | 10 | 8640 of 8640 (100%) | 78468 | 0.010% | 0.027% | 0.087% | 0.322% | 0.56% (2026-11-09 16:00 UTC, mexc) |
| ltc/usd | 4 | 176 of 8613 (2%) | 704 | 0.036% | 0.130% | 0.273% | 0.407% | 0.41% (2026-11-18 14:30 UTC, gemini) |
| ltc/usdt | 10 | 8640 of 8640 (100%) | 77298 | 0.018% | 0.051% | 0.159% | 0.419% | 1.82% (2026-11-15 01:05 UTC, mexc) |
| xmr/usdt | 5 | 1968 of 8640 (23%) | 8530 | 0.136% | 0.499% | 1.435% | 4.349% | 4.65% (2026-11-17 07:10 UTC, xt) |
| bnb/usdt | 8 | 8640 of 8640 (100%) | 60666 | 0.008% | 0.029% | 0.063% | 0.129% | 0.40% (2026-11-18 14:30 UTC, kraken) |
| ton/usd | 4 | 0 of 3047 | 0 | - | - | - | - | not enough exchanges with candles |
| ton/usdt | 10 | 8640 of 8640 (100%) | 61693 | 0.009% | 0.096% | 0.492% | 1.197% | 18.20% (2026-11-14 00:55 UTC, bitfinex) |
| trx/usdt | 6 | 8640 of 8640 (100%) | 51838 | 0.015% | 0.080% | 1.646% | 3.610% | 7.77% (2026-10-29 23:00 UTC, kucoin) |
| usdt/usd | 7 | 7855 of 8640 (91%) | 37159 | 0.012% | 0.119% | 0.172% | 0.239% | 0.62% (2026-10-30 06:35 UTC, binance) |
| usdc/usd | 4 | 100 of 8639 (1%) | 400 | 0.010% | 0.111% | 0.135% | 0.142% | 0.14% (2026-11-18 08:55 UTC, bitfinex) |
| usdc/usdt | 9 | 8640 of 8640 (100%) | 68480 | 0.001% | 0.010% | 0.034% | 0.054% | 0.26% (2026-10-30 16:00 UTC, bitfinex) |
| POOLED all |  | 88967 | 645610 | 0.007% | 0.062% | 0.284% | 1.582% | 18.20% (ton/usdt 2026-11-14 00:55 UTC, bitfinex) |
| POOLED excl stablecoins |  | 72372 | 539571 | 0.008% | 0.066% | 0.322% | 1.747% | 18.20% (ton/usdt 2026-11-14 00:55 UTC, bitfinex) |
| POOLED stablecoin pairs |  | 16595 | 106039 | 0.002% | 0.031% | 0.157% | 0.197% | 0.62% (usdt/usd 2026-10-30 06:35 UTC, binance) |

1-hour grid (all exchanges):

| pair | exchanges with data | timestamps with ≥4 (of all) | obs | p50 | p90 | p99 | p99.9 | max (when, who) |
|---|---|---|---|---|---|---|---|---|
| btc/usd | 7 | 720 of 720 (100%) | 4840 | 0.032% | 0.154% | 0.419% | 0.908% | 1.26% (2026-10-29 23:00 UTC, gate) |
| btc/usdt | 11 | 720 of 720 (100%) | 7713 | 0.005% | 0.025% | 0.281% | 0.844% | 1.67% (2026-11-13 13:00 UTC, gemini) |
| eth/usd | 7 | 720 of 720 (100%) | 4590 | 0.033% | 0.151% | 0.516% | 1.217% | 2.39% (2026-10-22 10:00 UTC, gemini) |
| eth/usdt | 11 | 720 of 720 (100%) | 7380 | 0.005% | 0.029% | 0.231% | 1.082% | 4.29% (2026-11-15 02:00 UTC, gemini) |
| sol/usd | 5 | 720 of 720 (100%) | 3481 | 0.033% | 0.158% | 0.566% | 1.092% | 2.40% (2026-11-13 06:00 UTC, binance) |
| sol/usdt | 10 | 720 of 720 (100%) | 7200 | 0.009% | 0.031% | 0.110% | 0.310% | 0.48% (2026-10-30 02:00 UTC, kraken) |
| ltc/usd | 4 | 684 of 720 (95%) | 2736 | 0.049% | 0.171% | 0.494% | 0.932% | 1.83% (2026-10-22 11:00 UTC, gemini) |
| ltc/usdt | 10 | 720 of 720 (100%) | 7200 | 0.018% | 0.058% | 0.203% | 0.421% | 1.01% (2026-11-15 00:00 UTC, mexc) |
| xmr/usdt | 5 | 720 of 720 (100%) | 3600 | 0.080% | 0.491% | 1.489% | 7.999% | 16.48% (2026-10-28 02:00 UTC, xt) |
| bnb/usdt | 8 | 720 of 720 (100%) | 5718 | 0.009% | 0.045% | 0.263% | 0.536% | 0.80% (2026-11-10 14:00 UTC, kraken) |
| ton/usd | 4 | 23 of 720 (3%) | 92 | 0.295% | 3.577% | 14.377% | 15.635% | 15.77% (2026-10-23 22:00 UTC, gemini) |
| ton/usdt | 10 | 720 of 720 (100%) | 6048 | 0.038% | 0.237% | 1.087% | 8.751% | 18.20% (2026-11-14 00:00 UTC, bitfinex) |
| trx/usdt | 6 | 720 of 720 (100%) | 4320 | 0.015% | 0.084% | 1.609% | 3.276% | 5.08% (2026-10-29 22:00 UTC, kucoin) |
| usdt/usd | 7 | 720 of 720 (100%) | 5018 | 0.011% | 0.106% | 0.180% | 0.263% | 0.60% (2026-10-30 06:00 UTC, binance) |
| usdc/usd | 4 | 612 of 720 (85%) | 2448 | 0.012% | 0.131% | 0.190% | 0.248% | 0.60% (2026-10-30 06:00 UTC, binance) |
| usdc/usdt | 9 | 720 of 720 (100%) | 6477 | 0.001% | 0.010% | 0.033% | 0.056% | 0.07% (2026-10-30 19:00 UTC, xt) |
| POOLED all |  | 10679 | 78861 | 0.010% | 0.110% | 0.563% | 2.203% | 18.20% (ton/usdt 2026-11-14 00:00 UTC, bitfinex) |
| POOLED excl stablecoins |  | 8627 | 64918 | 0.012% | 0.118% | 0.623% | 2.329% | 18.20% (ton/usdt 2026-11-14 00:00 UTC, bitfinex) |
| POOLED stablecoin pairs |  | 2052 | 13943 | 0.005% | 0.060% | 0.170% | 0.242% | 0.60% (usdc/usd 2026-10-30 06:00 UTC, binance) |

Reading it: the p50 deviation of an exchange is 0.000% to 0.05% on every pair; pooled non-stable p99 is 0.22% (1m) / 0.32% (5m) / 0.62% (1h), and p99.9 (1.7% on 1m and 5m, 2.3% on 1h) is where 1% first shows up on the 1m and 5m grids, entirely from TRX, XMR and TON. The maxima are single points on thin exchanges: Gemini (stale), MEXC (LTC/USDT 2.21% at 2026-11-15 01:10, a minute in the volatile stretch), Bitfinex (TON), KuCoin (TRX), XT (XMR).

### 3.2 What each limit would have cost

Share of exchange-observations that would have been dropped (5-minute grid; 1h and 1m in the appendix):

| pair | n timestamps (≥4 candles) | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|---|
| btc/usdt | 8640 | 0.01% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| eth/usdt | 8640 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| sol/usdt | 8640 | 0.01% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| bnb/usdt | 8640 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ltc/usdt | 8640 | 0.06% | 0.01% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| usdc/usdt | 8640 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| trx/usdt | 8640 | 2.55% | 1.80% | 1.19% | 0.68% | 0.35% | 0.23% | 0.02% |
| xmr/usdt | 1968 | 9.93% | 2.57% | 0.73% | 0.38% | 0.30% | 0.21% | 0.00% |
| ton/usdt | 8640 | 0.98% | 0.21% | 0.06% | 0.04% | 0.02% | 0.02% | 0.02% |
| usdt/usd | 7855 | 0.02% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| btc/usd | 4463 | 0.12% | 0.01% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| eth/usd | 4268 | 0.26% | 0.01% | 0.01% | 0.00% | 0.00% | 0.00% | 0.00% |
| sol/usd | 1017 | 0.35% | 0.02% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ltc/usd | 176 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| usdc/usd | 100 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| POOLED excl stablecoins | 72372 | 0.54% | 0.24% | 0.13% | 0.08% | 0.04% | 0.03% | 0.00% |
| POOLED stablecoin pairs | 16595 | 0.01% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |

Share of timestamps where at least one exchange would have been dropped (5-minute grid):

| pair | n timestamps (≥4 candles) | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|---|
| btc/usdt | 8640 | 0.06% | 0.03% | 0.03% | 0.03% | 0.01% | 0.01% | 0.00% |
| eth/usdt | 8640 | 0.02% | 0.01% | 0.01% | 0.00% | 0.00% | 0.00% | 0.00% |
| sol/usdt | 8640 | 0.06% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| bnb/usdt | 8640 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ltc/usdt | 8640 | 0.52% | 0.10% | 0.02% | 0.00% | 0.00% | 0.00% | 0.00% |
| usdc/usdt | 8640 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| trx/usdt | 8640 | 5.53% | 4.92% | 3.97% | 2.47% | 1.39% | 0.98% | 0.09% |
| xmr/usdt | 1968 | 40.70% | 11.13% | 3.15% | 1.63% | 1.32% | 0.91% | 0.00% |
| ton/usdt | 8640 | 6.66% | 1.50% | 0.41% | 0.25% | 0.17% | 0.17% | 0.12% |
| usdt/usd | 7855 | 0.11% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| btc/usd | 4463 | 0.52% | 0.04% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| eth/usd | 4268 | 1.10% | 0.05% | 0.02% | 0.00% | 0.00% | 0.00% | 0.00% |
| sol/usd | 1017 | 1.47% | 0.10% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ltc/usd | 176 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| usdc/usd | 100 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| POOLED excl stablecoins | 72372 | 2.76% | 1.09% | 0.62% | 0.37% | 0.22% | 0.16% | 0.02% |

**Share of timestamps where fewer than 4 exchanges remain (cannot price), upper bound, 5-minute grid:**

| pair | n timestamps (≥4 candles) | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|---|
| btc/usdt | 8640 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| eth/usdt | 8640 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| sol/usdt | 8640 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| bnb/usdt | 8640 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ltc/usdt | 8640 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| usdc/usdt | 8640 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| trx/usdt | 8640 | 3.24% | 1.00% | 0.15% | 0.09% | 0.06% | 0.05% | 0.00% |
| xmr/usdt | 1968 | 31.05% | 8.89% | 1.93% | 0.61% | 0.56% | 0.30% | 0.00% |
| ton/usdt | 8640 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| usdt/usd | 7855 | 0.04% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| btc/usd | 4463 | 0.13% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| eth/usd | 4268 | 0.40% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| sol/usd | 1017 | 1.28% | 0.10% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ltc/usd | 176 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| usdc/usd | 100 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| POOLED excl stablecoins | 72372 | 1.28% | 0.36% | 0.07% | 0.03% | 0.02% | 0.01% | 0.00% |
| POOLED stablecoin pairs | 16595 | 0.02% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |

Same, 1-minute grid (upper bound; USD pairs have almost no 4-candle minutes here):

| pair | n timestamps (≥4 candles) | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|---|
| btc/usdt | 43200 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| eth/usdt | 43200 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| sol/usdt | 43200 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| bnb/usdt | 43193 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ltc/usdt | 43192 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| usdc/usdt | 43200 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| trx/usdt | 42907 | 5.11% | 4.48% | 2.53% | 1.33% | 0.64% | 0.36% | 0.06% |
| xmr/usdt | 1532 | 19.84% | 5.09% | 0.91% | 0.07% | 0.00% | 0.00% | 0.00% |
| ton/usdt | 42911 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| usdt/usd | 12769 | 0.15% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| btc/usd | 1813 | 0.17% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| eth/usd | 1453 | 0.62% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| sol/usd | 352 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ltc/usd | 22 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| usdc/usd | 9 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| POOLED excl stablecoins | 306975 | 0.82% | 0.65% | 0.36% | 0.19% | 0.09% | 0.05% | 0.01% |

Same, 1-hour grid (all exchanges):

| pair | n timestamps (≥4 candles) | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|---|
| btc/usdt | 720 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| eth/usdt | 720 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| sol/usdt | 720 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| bnb/usdt | 720 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ltc/usdt | 720 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| usdc/usdt | 720 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| trx/usdt | 720 | 3.33% | 0.83% | 0.14% | 0.00% | 0.00% | 0.00% | 0.00% |
| xmr/usdt | 720 | 1.39% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ton/usdt | 720 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| usdt/usd | 720 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| btc/usd | 720 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| eth/usd | 720 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| sol/usd | 720 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ltc/usd | 684 | 3.95% | 0.44% | 0.15% | 0.00% | 0.00% | 0.00% | 0.00% |
| ton/usd | 23 | 86.96% | 60.87% | 47.83% | 47.83% | 43.48% | 43.48% | 34.78% |
| usdc/usd | 612 | 0.16% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| POOLED excl stablecoins | 8627 | 0.94% | 0.27% | 0.15% | 0.13% | 0.12% | 0.12% | 0.09% |

Upper and lower bounds side by side, 5-minute grid (`n` = configured / with candles at all):

| pair | configured / with candles | timestamps | cannot price @1% (upper / lower) | @2% | @2.5% |
|---|---|---|---|---|---|
| btc/usdt | 11 / 11 | 8640 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| ton/usdt | 10 / 10 | 8640 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| usdt/usd | 7 / 7 | 7855 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| ltc/usdt | 10 / 10 | 8640 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| bnb/usdt | 8 / 8 | 8640 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| eth/usdt | 11 / 11 | 8640 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| eth/usd | 7 / 7 | 4268 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| usdc/usdt | 9 / 9 | 8640 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| trx/usdt | 6 / 6 | 8640 | 1.00% / 1.00% | 0.09% / 0.09% | 0.06% / 0.06% |
| sol/usdt | 10 / 10 | 8640 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| btc/usd | 7 / 7 | 4463 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| ltc/usd | 4 / 4 | 176 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| xmr/usdt | 5 / 5 | 1968 | 8.89% / 0.00% | 0.61% / 0.00% | 0.56% / 0.00% |
| usdc/usd | 4 / 4 | 100 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| sol/usd | 5 / 5 | 1017 | 0.10% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |

Upper and lower bounds, 1-minute grid:

| pair | configured / with candles | timestamps | cannot price @1% (upper / lower) | @2% | @2.5% |
|---|---|---|---|---|---|
| bnb/usdt | 8 / 8 | 43193 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| usdt/usd | 7 / 7 | 12769 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| xmr/usdt | 5 / 5 | 1532 | 5.09% / 0.00% | 0.07% / 0.00% | 0.00% / 0.00% |
| usdc/usdt | 9 / 9 | 43200 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| ltc/usd | 4 / 4 | 22 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| ltc/usdt | 10 / 10 | 43192 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| ton/usdt | 10 / 10 | 42911 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| trx/usdt | 6 / 6 | 42907 | 4.48% / 0.97% | 1.33% / 0.00% | 0.64% / 0.00% |
| btc/usd | 7 / 7 | 1813 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| btc/usdt | 11 / 11 | 43200 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| sol/usdt | 10 / 10 | 43200 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| eth/usd | 7 / 7 | 1453 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| eth/usdt | 11 / 11 | 43200 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| sol/usd | 5 / 5 | 352 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| usdc/usd | 4 / 4 | 9 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |

Translating to time (30 days = 43,200 minutes):

| pair | limit | 1m grid, upper bound | 5m grid | 1h grid |
|---|---|---|---|---|
| TRX/USDT | 2% | 571 minutes in 11 episodes (longest 246 min, 10-30 22:31 to 10-31 03:31) | 0.09% ≈ 39 min | 0 h |
| TRX/USDT | 2.5% | 273 minutes in 8 episodes (longest 121 min) | 0.06% ≈ 26 min | 0 h |
| TRX/USDT | 3% | 0.36% ≈ 156 min | 0.05% ≈ 22 min | 0 h |
| XMR/USDT | 2% | 1 minute | 0.61% of 5-min steps (12 steps in 2 episodes, upper bound; lower bound 0) | 0 h |
| XMR/USDT | 2.5% | 0 | 0.56% (11 steps, upper; lower 0) | 0 h |
| every other pair with data | 2% and 2.5% | 0 | 0 | 0 (TON/USD excepted, see §6) |

The TRX episodes are one real event: from 2026-10-29 ~21:30 UTC KuCoin, Gate and OKX traded TRX 5–8% above Binance, Bybit and MEXC for hours, with large volume on both sides (§5.2).

## 4. Stress windows

### 4.1 Distance from the median, 1-minute grid (exchanges available: Binance, Bybit, OKX, KuCoin, Crypto.com, XT, Bitfinex, Kraken)

W1, 2025-10-10 18:00 to 2025-10-11 02:00:

| pair | exchanges with data | timestamps with ≥4 (of all) | obs | p50 | p90 | p99 | p99.9 | max (when, who) |
|---|---|---|---|---|---|---|---|---|
| btc/usd | 3 | 0 of 480 | 0 | - | - | - | - | not enough exchanges with candles |
| btc/usdt | 8 | 480 of 480 (100%) | 3817 | 0.010% | 0.085% | 0.477% | 0.901% | 1.39% (2025-10-10 21:51 UTC, kraken) |
| eth/usd | 3 | 0 of 480 | 0 | - | - | - | - | not enough exchanges with candles |
| eth/usdt | 8 | 480 of 480 (100%) | 3787 | 0.018% | 0.224% | 1.149% | 1.694% | 2.68% (2025-10-10 21:56 UTC, binance) |
| sol/usd | 3 | 0 of 480 | 0 | - | - | - | - | not enough exchanges with candles |
| sol/usdt | 8 | 480 of 480 (100%) | 3769 | 0.044% | 0.643% | 2.941% | 13.035% | 21.47% (2025-10-10 21:20 UTC, kucoin) |
| ltc/usd | 3 | 0 of 480 | 0 | - | - | - | - | not enough exchanges with candles |
| ltc/usdt | 8 | 480 of 480 (100%) | 3663 | 0.054% | 0.725% | 4.427% | 10.072% | 12.64% (2025-10-10 21:23 UTC, kucoin) |
| xmr/usdt | 4 | 172 of 480 (36%) | 688 | 0.089% | 0.404% | 1.967% | 2.713% | 2.88% (2025-10-10 22:45 UTC, bitfinex) |
| bnb/usdt | 6 | 480 of 480 (100%) | 2601 | 0.031% | 0.158% | 3.173% | 7.872% | 10.42% (2025-10-10 22:15 UTC, kraken) |
| ton/usd | 2 | 0 of 410 | 0 | - | - | - | - | not enough exchanges with candles |
| ton/usdt | 5 | 247 of 480 (51%) | 1039 | 0.168% | 2.963% | 20.205% | 101.069% | 108.44% (2025-10-10 21:19 UTC, bitfinex) |
| trx/usdt | 4 | 479 of 480 (100%) | 1916 | 0.027% | 0.171% | 1.205% | 1.886% | 2.89% (2025-10-10 21:19 UTC, binance) |
| usdt/usd | 4 | 366 of 480 (76%) | 1464 | 0.033% | 0.170% | 0.711% | 1.705% | 12.55% (2025-10-10 21:38 UTC, cryptocom) |
| usdc/usd | 2 | 0 of 480 | 0 | - | - | - | - | not enough exchanges with candles |
| usdc/usdt | 7 | 480 of 480 (100%) | 2959 | 0.010% | 0.060% | 0.231% | 0.596% | 0.75% (2025-10-10 21:31 UTC, bitfinex) |
| POOLED all |  | 4144 | 25703 | 0.024% | 0.307% | 2.957% | 12.161% | 108.44% (ton/usdt 2025-10-10 21:19 UTC, bitfinex) |
| POOLED excl stablecoins |  | 3298 | 21280 | 0.029% | 0.392% | 3.338% | 13.184% | 108.44% (ton/usdt 2025-10-10 21:19 UTC, bitfinex) |
| POOLED stablecoin pairs |  | 846 | 4423 | 0.010% | 0.125% | 0.452% | 1.290% | 12.55% (usdt/usd 2025-10-10 21:38 UTC, cryptocom) |

W2, 2026-02-05 14:00 to 2026-02-06 02:00:

| pair | exchanges with data | timestamps with ≥4 (of all) | obs | p50 | p90 | p99 | p99.9 | max (when, who) |
|---|---|---|---|---|---|---|---|---|
| btc/usd | 4 | 712 of 720 (99%) | 2848 | 0.030% | 0.315% | 0.389% | 0.796% | 1.56% (2026-02-06 00:19 UTC, kraken) |
| btc/usdt | 8 | 720 of 720 (100%) | 5757 | 0.008% | 0.038% | 0.152% | 0.754% | 1.35% (2026-02-06 00:14 UTC, kraken) |
| eth/usd | 3 | 0 of 720 | 0 | - | - | - | - | not enough exchanges with candles |
| eth/usdt | 8 | 720 of 720 (100%) | 5757 | 0.010% | 0.052% | 0.151% | 0.242% | 0.33% (2026-02-05 22:30 UTC, bitfinex) |
| sol/usd | 3 | 0 of 720 | 0 | - | - | - | - | not enough exchanges with candles |
| sol/usdt | 8 | 720 of 720 (100%) | 5755 | 0.012% | 0.064% | 0.181% | 0.293% | 0.53% (2026-02-06 00:15 UTC, xt) |
| ltc/usd | 3 | 0 of 720 | 0 | - | - | - | - | not enough exchanges with candles |
| ltc/usdt | 8 | 720 of 720 (100%) | 5190 | 0.018% | 0.092% | 0.453% | 0.813% | 1.33% (2026-02-06 00:17 UTC, bitfinex) |
| xmr/usdt | 4 | 395 of 720 (55%) | 1580 | 0.062% | 0.230% | 0.614% | 2.160% | 2.50% (2026-02-05 18:25 UTC, xt) |
| bnb/usdt | 6 | 720 of 720 (100%) | 3702 | 0.014% | 0.055% | 0.208% | 0.549% | 0.80% (2026-02-05 19:06 UTC, kraken) |
| ton/usd | 2 | 0 of 517 | 0 | - | - | - | - | not enough exchanges with candles |
| ton/usdt | 5 | 170 of 720 (24%) | 708 | 0.037% | 0.218% | 0.768% | 1.286% | 1.30% (2026-02-06 00:18 UTC, bitfinex) |
| trx/usdt | 4 | 720 of 720 (100%) | 2880 | 0.016% | 0.048% | 0.095% | 0.164% | 0.18% (2026-02-06 00:08 UTC, binance) |
| usdt/usd | 5 | 703 of 720 (98%) | 3215 | 0.017% | 0.281% | 0.306% | 0.313% | 0.32% (2026-02-05 19:04 UTC, bitfinex) |
| usdc/usd | 3 | 0 of 720 | 0 | - | - | - | - | not enough exchanges with candles |
| usdc/usdt | 7 | 720 of 720 (100%) | 4429 | 0.000% | 0.010% | 0.025% | 0.030% | 0.04% (2026-02-05 21:54 UTC, kucoin) |
| POOLED all |  | 7020 | 41821 | 0.012% | 0.080% | 0.338% | 0.739% | 2.50% (xmr/usdt 2026-02-05 18:25 UTC, xt) |
| POOLED excl stablecoins |  | 5597 | 34177 | 0.013% | 0.081% | 0.352% | 0.794% | 2.50% (xmr/usdt 2026-02-05 18:25 UTC, xt) |
| POOLED stablecoin pairs |  | 1423 | 7644 | 0.009% | 0.044% | 0.301% | 0.311% | 0.32% (usdt/usd 2026-02-05 19:04 UTC, bitfinex) |

W3, 2025-02-02 22:00 to 2025-02-03 04:00:

| pair | exchanges with data | timestamps with ≥4 (of all) | obs | p50 | p90 | p99 | p99.9 | max (when, who) |
|---|---|---|---|---|---|---|---|---|
| btc/usd | 3 | 0 of 360 | 0 | - | - | - | - | not enough exchanges with candles |
| btc/usdt | 8 | 360 of 360 (100%) | 2863 | 0.009% | 0.065% | 0.399% | 1.349% | 1.75% (2025-02-03 01:57 UTC, kucoin) |
| eth/usd | 3 | 0 of 360 | 0 | - | - | - | - | not enough exchanges with candles |
| eth/usdt | 8 | 360 of 360 (100%) | 2856 | 0.014% | 0.136% | 1.112% | 3.903% | 4.16% (2025-02-03 02:19 UTC, cryptocom) |
| sol/usd | 3 | 0 of 360 | 0 | - | - | - | - | not enough exchanges with candles |
| sol/usdt | 8 | 360 of 360 (100%) | 2865 | 0.019% | 0.118% | 0.398% | 0.713% | 0.85% (2025-02-03 02:10 UTC, bitfinex) |
| ltc/usd | 3 | 0 of 360 | 0 | - | - | - | - | not enough exchanges with candles |
| ltc/usdt | 8 | 360 of 360 (100%) | 2640 | 0.028% | 0.204% | 0.649% | 1.195% | 1.75% (2025-02-03 01:56 UTC, bitfinex) |
| xmr/usdt | 4 | 77 of 360 (21%) | 308 | 0.081% | 0.334% | 0.826% | 1.207% | 1.29% (2025-02-03 01:54 UTC, bitfinex) |
| bnb/usdt | 5 | 360 of 360 (100%) | 1800 | 0.015% | 0.060% | 0.209% | 0.878% | 0.98% (2025-02-03 02:07 UTC, okx) |
| ton/usd | 2 | 0 of 343 | 0 | - | - | - | - | not enough exchanges with candles |
| ton/usdt | 4 | 293 of 360 (81%) | 1172 | 0.035% | 2.116% | 16.576% | 23.104% | 31.28% (2025-02-03 02:07 UTC, bitfinex) |
| trx/usdt | 4 | 360 of 360 (100%) | 1440 | 0.019% | 0.062% | 0.141% | 0.591% | 0.86% (2025-02-03 01:55 UTC, binance) |
| usdt/usd | 4 | 260 of 360 (72%) | 1040 | 0.009% | 0.052% | 0.080% | 0.120% | 0.12% (2025-02-03 02:16 UTC, cryptocom) |
| usdc/usd | 2 | 0 of 360 | 0 | - | - | - | - | not enough exchanges with candles |
| usdc/usdt | 7 | 360 of 360 (100%) | 2147 | 0.010% | 0.025% | 0.050% | 0.060% | 0.10% (2025-02-03 01:14 UTC, bitfinex) |
| POOLED all |  | 3150 | 19131 | 0.015% | 0.111% | 1.465% | 15.158% | 31.28% (ton/usdt 2025-02-03 02:07 UTC, bitfinex) |
| POOLED excl stablecoins |  | 2530 | 15944 | 0.018% | 0.132% | 1.772% | 15.928% | 31.28% (ton/usdt 2025-02-03 02:07 UTC, bitfinex) |
| POOLED stablecoin pairs |  | 620 | 3187 | 0.010% | 0.035% | 0.074% | 0.115% | 0.12% (usdt/usd 2025-02-03 02:16 UTC, cryptocom) |

### 4.2 Share of exchange-observations dropped

W1:

| pair | n timestamps (≥4 candles) | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|---|
| btc/usdt | 480 | 0.89% | 0.08% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| eth/usdt | 480 | 4.46% | 1.40% | 0.53% | 0.03% | 0.03% | 0.00% | 0.00% |
| sol/usdt | 480 | 12.74% | 5.73% | 3.79% | 2.36% | 1.49% | 0.96% | 0.56% |
| ltc/usdt | 480 | 12.78% | 8.03% | 6.14% | 4.70% | 3.22% | 2.24% | 0.82% |
| bnb/usdt | 480 | 4.88% | 2.88% | 2.31% | 1.92% | 1.54% | 1.15% | 0.46% |
| trx/usdt | 479 | 6.11% | 2.82% | 0.31% | 0.05% | 0.05% | 0.00% | 0.00% |
| xmr/usdt | 172 | 7.70% | 3.05% | 2.33% | 1.02% | 0.44% | 0.00% | 0.00% |
| ton/usdt | 247 | 32.72% | 22.14% | 17.23% | 14.05% | 11.93% | 9.82% | 6.64% |
| usdt/usd | 366 | 2.25% | 0.48% | 0.20% | 0.07% | 0.07% | 0.07% | 0.07% |
| usdc/usdt | 480 | 0.24% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| POOLED excl stablecoins | 3298 | 8.40% | 4.45% | 3.05% | 2.19% | 1.61% | 1.17% | 0.62% |
| POOLED stablecoin pairs | 846 | 0.90% | 0.16% | 0.07% | 0.02% | 0.02% | 0.02% | 0.02% |

W2:

| pair | n timestamps (≥4 candles) | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|---|
| btc/usd | 712 | 0.46% | 0.07% | 0.04% | 0.00% | 0.00% | 0.00% | 0.00% |
| btc/usdt | 720 | 0.19% | 0.03% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| eth/usdt | 720 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| sol/usdt | 720 | 0.03% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ltc/usdt | 720 | 0.75% | 0.04% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| bnb/usdt | 720 | 0.19% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| trx/usdt | 720 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| xmr/usdt | 395 | 1.65% | 0.57% | 0.19% | 0.19% | 0.00% | 0.00% | 0.00% |
| ton/usdt | 170 | 3.11% | 0.56% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| usdt/usd | 703 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| usdc/usdt | 720 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| POOLED excl stablecoins | 5597 | 0.35% | 0.06% | 0.01% | 0.01% | 0.00% | 0.00% | 0.00% |

W3:

| pair | n timestamps (≥4 candles) | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|---|
| btc/usdt | 360 | 0.70% | 0.45% | 0.10% | 0.00% | 0.00% | 0.00% | 0.00% |
| eth/usdt | 360 | 2.49% | 1.16% | 0.81% | 0.63% | 0.53% | 0.39% | 0.00% |
| sol/usdt | 360 | 0.35% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ltc/usdt | 360 | 1.93% | 0.34% | 0.04% | 0.00% | 0.00% | 0.00% | 0.00% |
| bnb/usdt | 360 | 0.33% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| trx/usdt | 360 | 0.14% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| xmr/usdt | 77 | 5.19% | 0.65% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ton/usdt | 293 | 19.20% | 17.15% | 13.65% | 10.32% | 8.28% | 7.34% | 5.63% |
| usdt/usd | 260 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| usdc/usdt | 360 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| POOLED excl stablecoins | 2530 | 2.52% | 1.62% | 1.17% | 0.87% | 0.70% | 0.61% | 0.41% |
| POOLED stablecoin pairs | 620 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |

(The `n timestamps` column is how many minutes had four or more candles.) In W1, pooled non-stable pairs lose 2.19% of observations at 2%, 1.61% at 2.5%, 1.18% at 3%, 0.62% at 5%; in W3 0.87%, 0.70%, 0.61%, 0.41%; in W2 0.009%, 0, 0, 0. BTC/USDT never loses an observation at 2% or above in any window; ETH/USDT loses 0.03% in W1 and 0.63% in W3 at 2% (0.53% at 2.5%).

### 4.3 Cannot price (fewer than 4 left): bounds

These depend heavily on how many exchanges are missing from the window data (`configured / with candles`), so read the two bounds, not one number.

W1:

| pair | configured / with candles | timestamps | cannot price @1% (upper / lower) | @2% | @2.5% |
|---|---|---|---|---|---|
| eth/usdt | 11 / 8 | 480 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| bnb/usdt | 8 / 6 | 480 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| sol/usdt | 10 / 8 | 480 | 1.46% / 0.21% | 0.83% / 0.00% | 0.83% / 0.00% |
| usdc/usdt | 9 / 7 | 480 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| usdt/usd | 7 / 4 | 366 | 1.91% / 0.00% | 0.27% / 0.00% | 0.27% / 0.00% |
| ltc/usdt | 10 / 8 | 480 | 1.25% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| ton/usdt | 10 / 5 | 247 | 52.23% / 0.00% | 38.46% / 0.00% | 32.79% / 0.00% |
| btc/usdt | 11 / 8 | 480 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| xmr/usdt | 5 / 4 | 172 | 11.05% / 1.16% | 4.07% / 0.00% | 1.74% / 0.00% |
| trx/usdt | 6 / 4 | 479 | 4.18% / 1.88% | 0.21% / 0.00% | 0.21% / 0.00% |

W2:

| pair | configured / with candles | timestamps | cannot price @1% (upper / lower) | @2% | @2.5% |
|---|---|---|---|---|---|
| usdt/usd | 7 / 5 | 703 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| sol/usdt | 10 / 8 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| ton/usdt | 10 / 5 | 170 | 1.76% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| trx/usdt | 6 / 4 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| eth/usdt | 11 / 8 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| ltc/usdt | 10 / 8 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| usdc/usdt | 9 / 7 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| bnb/usdt | 8 / 6 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| btc/usd | 7 / 4 | 712 | 0.28% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| xmr/usdt | 5 / 4 | 395 | 2.28% / 0.00% | 0.76% / 0.00% | 0.00% / 0.00% |
| btc/usdt | 11 / 8 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |

W3:

| pair | configured / with candles | timestamps | cannot price @1% (upper / lower) | @2% | @2.5% |
|---|---|---|---|---|---|
| eth/usdt | 11 / 8 | 360 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| trx/usdt | 6 / 4 | 360 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| ltc/usdt | 10 / 8 | 360 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| usdc/usdt | 9 / 7 | 360 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| xmr/usdt | 5 / 4 | 77 | 2.60% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| usdt/usd | 7 / 4 | 260 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| ton/usdt | 10 / 4 | 293 | 68.60% / 0.00% | 41.30% / 0.00% | 33.11% / 0.00% |
| sol/usdt | 10 / 8 | 360 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| btc/usdt | 11 / 8 | 360 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| bnb/usdt | 8 / 5 | 360 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |

Reading: with every configured exchange answering, the crash windows would not have made any pair unpriceable at 2% or 2.5% (lower bound 0%; at 1% the lower bound is 0 except XMR 1.16%, TRX 1.88% and SOL 0.21% in W1). The upper bounds are high only where I am missing most of the exchanges (TON/USDT: 4–5 of 10 present; USDT/USD W1: 4 of 7) and there the true answer depends on how Gate, MEXC, Gemini, HTX, Binance, Bybit and OKX behaved, which I cannot see.

## 5. Who is the outlier, and is it a broken feed or a real market gap?

Exchange-observations more than 1% from the median, by exchange, 5-minute grid (non-stable pairs):

| exchange | pairs | observations | >1% from median | >2% | >2.5% | worst (pair) |
|---|---|---|---|---|---|---|
| kucoin | 8 | 62444 | 0.641% | 0.314% | 0.186% | 7.8% (trx/usdt) |
| okx | 7 | 60480 | 0.577% | 0.212% | 0.078% | 4.4% (trx/usdt) |
| xt | 7 | 53718 | 0.393% | 0.060% | 0.048% | 4.7% (xmr/usdt) |
| gemini | 6 | 5182 | 0.077% | 0.058% | 0.019% | 3.7% (btc/usdt) |
| bitfinex | 10 | 46434 | 0.149% | 0.045% | 0.032% | 18.2% (ton/usdt) |
| kraken | 11 | 5935 | 0.017% | 0.017% | 0.000% | 2.1% (ton/usdt) |
| mexc | 7 | 60480 | 0.141% | 0.015% | 0.008% | 4.6% (trx/usdt) |
| binance | 10 | 68011 | 0.198% | 0.015% | 0.010% | 4.4% (trx/usdt) |
| gate | 9 | 67499 | 0.028% | 0.009% | 0.009% | 5.0% (trx/usdt) |
| bybit | 9 | 62793 | 0.032% | 0.006% | 0.003% | 3.5% (trx/usdt) |
| cryptocom | 9 | 44627 | 0.011% | 0.000% | 0.000% | 1.5% (ton/usdt) |
| htx | 1 | 1968 | 0.051% | 0.000% | 0.000% | 1.1% (xmr/usdt) |

1-minute grid:

| exchange | pairs | observations | >1% from median | >2% | >2.5% | worst (pair) |
|---|---|---|---|---|---|---|
| kucoin | 8 | 295519 | 0.663% | 0.318% | 0.189% | 9.4% (trx/usdt) |
| okx | 7 | 299269 | 0.551% | 0.215% | 0.094% | 7.8% (trx/usdt) |
| bitfinex | 10 | 154685 | 0.047% | 0.013% | 0.012% | 19.5% (ton/usdt) |
| bybit | 9 | 299516 | 0.013% | 0.004% | 0.001% | 3.0% (trx/usdt) |
| mexc | 7 | 301300 | 0.107% | 0.002% | 0.001% | 7.2% (trx/usdt) |
| binance | 10 | 303940 | 0.276% | 0.002% | 0.000% | 3.1% (trx/usdt) |
| xt | 7 | 257673 | 0.031% | 0.000% | 0.000% | 2.5% (xmr/usdt) |
| cryptocom | 9 | 163855 | 0.001% | 0.000% | 0.000% | 1.1% (ton/usdt) |
| gate | 9 | 70607 | 0.000% | 0.000% | 0.000% | 0.7% (eth/usd) |
| gemini | 6 | 1929 | 0.000% | 0.000% | 0.000% | 0.8% (eth/usd) |
| kraken | 11 | 3550 | 0.000% | 0.000% | 0.000% | 0.4% (xmr/usdt) |
| htx | 1 | 1532 | 0.000% | 0.000% | 0.000% | 0.4% (xmr/usdt) |

1-hour grid:

| exchange | pairs | observations | >1% from median | >2% | >2.5% | worst (pair) |
|---|---|---|---|---|---|---|
| xt | 7 | 5040 | 1.825% | 0.496% | 0.357% | 16.5% (xmr/usdt) |
| gemini | 7 | 3557 | 0.843% | 0.337% | 0.253% | 15.8% (ton/usd) |
| kucoin | 8 | 5760 | 0.556% | 0.330% | 0.156% | 5.1% (trx/usdt) |
| bitfinex | 11 | 6728 | 0.669% | 0.297% | 0.208% | 18.2% (ton/usdt) |
| okx | 7 | 5040 | 0.575% | 0.218% | 0.060% | 3.5% (trx/usdt) |
| kraken | 12 | 7606 | 0.210% | 0.053% | 0.026% | 3.1% (ton/usdt) |
| cryptocom | 10 | 6033 | 0.199% | 0.033% | 0.000% | 2.2% (ton/usdt) |
| binance | 10 | 7061 | 0.241% | 0.014% | 0.000% | 2.4% (sol/usd) |
| bybit | 9 | 5853 | 0.171% | 0.000% | 0.000% | 1.9% (eth/usd) |
| gate | 9 | 6480 | 0.046% | 0.000% | 0.000% | 1.7% (eth/usd) |
| mexc | 7 | 5040 | 0.139% | 0.000% | 0.000% | 1.7% (trx/usdt) |
| htx | 1 | 720 | 0.000% | 0.000% | 0.000% | 0.9% (xmr/usdt) |

W1 (crash):

| exchange | pairs | observations | >1% from median | >2% | >2.5% | worst (pair) |
|---|---|---|---|---|---|---|
| kraken | 7 | 2082 | 12.536% | 7.685% | 5.956% | 19.9% (ton/usdt) |
| kucoin | 8 | 3298 | 4.609% | 3.214% | 2.911% | 29.2% (ton/usdt) |
| cryptocom | 4 | 1917 | 4.121% | 1.982% | 1.200% | 7.4% (ltc/usdt) |
| okx | 6 | 2879 | 5.523% | 1.806% | 0.903% | 13.2% (sol/usdt) |
| bitfinex | 6 | 2283 | 3.855% | 1.489% | 1.183% | 108.4% (ton/usdt) |
| bybit | 7 | 3126 | 3.615% | 1.312% | 0.672% | 6.8% (ton/usdt) |
| xt | 7 | 2816 | 2.131% | 0.888% | 0.604% | 8.1% (sol/usdt) |
| binance | 6 | 2879 | 1.181% | 0.347% | 0.313% | 8.5% (sol/usdt) |

W3 (crash):

| exchange | pairs | observations | >1% from median | >2% | >2.5% | worst (pair) |
|---|---|---|---|---|---|---|
| bitfinex | 6 | 1639 | 12.691% | 7.383% | 5.918% | 31.3% (ton/usdt) |
| cryptocom | 4 | 1430 | 1.329% | 1.189% | 0.979% | 4.2% (eth/usdt) |
| kucoin | 8 | 2530 | 0.949% | 0.040% | 0.040% | 2.7% (eth/usdt) |
| binance | 6 | 2160 | 0.093% | 0.000% | 0.000% | 1.1% (ltc/usdt) |
| bybit | 7 | 2453 | 0.000% | 0.000% | 0.000% | 0.8% (ltc/usdt) |
| kraken | 5 | 1402 | 0.143% | 0.000% | 0.000% | 1.1% (ltc/usdt) |
| okx | 6 | 2160 | 0.046% | 0.000% | 0.000% | 1.0% (ltc/usdt) |
| xt | 7 | 2170 | 0.092% | 0.000% | 0.000% | 1.6% (eth/usdt) |

Pairs, with each >1% observation classed as *timing* (the candle's own low–high range contains the median, so the exchange did trade at the consensus price during that candle), *persistent* (at least 5 consecutive candles on the same side) or *isolated*:

5-minute grid:

| pair | exchange-observations >1% from median | by exchange | timing / persistent / isolated |
|---|---|---|---|
| btc/usd | 2 | gate 1, binance 1 | 0 / 0 / 2 |
| btc/usdt | 3 | gemini 3 | 2 / 0 / 1 |
| eth/usd | 2 | bybit 2 | 0 / 0 / 2 |
| eth/usdt | 1 | gemini 1 | 0 / 0 / 1 |
| sol/usd | 1 | binance 1 | 1 / 0 / 0 |
| ltc/usdt | 9 | mexc 9 | 0 / 5 / 4 |
| xmr/usdt | 219 | xt 211, bitfinex 7, htx 1 | 1 / 177 / 41 |
| ton/usdt | 130 | bitfinex 62, mexc 62, cryptocom 5, kraken 1 | 39 / 6 / 85 |
| trx/usdt | 932 | kucoin 400, okx 349, binance 133, gate 18, bybit 18, mexc 14 | 36 / 870 / 26 |

W1:

| pair | exchange-observations >1% from median | by exchange | timing / persistent / isolated |
|---|---|---|---|
| btc/usdt | 3 | kraken 3 | 2 / 0 / 1 |
| eth/usdt | 53 | okx 30, bitfinex 11, kraken 5, xt 3, bybit 2, cryptocom 1, binance 1 | 13 / 25 / 15 |
| sol/usdt | 216 | okx 64, cryptocom 52, kraken 33, kucoin 20, bybit 20, binance 10, xt 10, bitfinex 7 | 48 / 125 / 43 |
| ltc/usdt | 294 | kraken 117, okx 52, bybit 50, bitfinex 27, cryptocom 26, kucoin 11, binance 8, xt 3 | 58 / 172 / 64 |
| xmr/usdt | 21 | bitfinex 11, xt 10 | 3 / 0 / 18 |
| bnb/usdt | 75 | kraken 73, xt 1, kucoin 1 | 16 / 23 / 36 |
| ton/usdt | 230 | kucoin 107, xt 33, bitfinex 32, kraken 30, bybit 28 | 55 / 106 / 69 |
| trx/usdt | 54 | binance 15, bybit 13, kucoin 13, okx 13 | 11 / 14 / 29 |
| usdt/usd | 7 | cryptocom 7 | 5 / 0 / 2 |

### 5.1 Summary by exchange

- **KuCoin and OKX** are the most frequent >1% / >2% outliers in the calm month, entirely because of the TRX/USDT split (and a few TON/SOL minutes). That is a real market gap (both sides had large volume), not bad data.
- **XT** is the clearest *broken/stale feed* on a thin pair: on XMR/USDT it is more than 1% from the median in 12.8% of hours and 10.7% of 5-minute steps, with a median signed bias of −0.44%.
- **Bitfinex** and **Crypto.com** TON books are the worst bad-data cases (see below). Bitfinex also produced the largest deviation in each calm grid (TON/USDT 18–19.5%).
- **Gemini** USDT markets (BTC/USDT, ETH/USDT): candles are mostly zero-volume repeats of an old price (540 of 720 hourly ETH/USDT candles), and the few real ones are stale by minutes to hours: up to 4.3% off. Its *live mid* is fine (§6): that market has a real book that is just rarely traded.
- **Kraken** is the biggest outlier in W1, but those minutes are rebuilt from trades (last trade in the minute), so are noisy by construction.
- **MEXC** is a persistent mild outlier on LTC and TON in the volatile days.
- Binance, Bybit, Gate, Crypto.com (other than TON and the USDT/USD print), HTX: outliers in the calm month only inside the TRX split (Binance and Bybit were on the low side).

### 5.2 Case studies (closes, same minute; * = under $100 traded in that candle)

**Real market gap: TRX/USDT, 2026-10-29 (5-min closes).** Two groups stay 4–8% apart for an hour with real volume (KuCoin traded 15 million TRX in the 22:00 hour):

| UTC | binance | bybit | gate | kucoin | mexc | okx |
|---|---|---|---|---|---|---|
| 21:30 | 0.3394 | 0.3403 | 0.3461 | 0.3417 | 0.3397 | 0.33955 |
| 21:40 | 0.3471 | 0.3493 | 0.3637 | 0.3735 | 0.3486 | 0.34753 |
| 22:00 | 0.357 | 0.3679 | 0.3684 | 0.3685 | 0.3705 | 0.37005 |
| 22:15 | 0.3515 | 0.3551 | 0.3694 | 0.3736 | 0.3544 | 0.37332 |
| 22:25 | 0.3426 | 0.3458 | 0.3711 | 0.372 | 0.3426 | 0.37177 |

When six exchanges split 3 against 3, the median lies in the gap, so every exchange is up to half the gap away from it; at 22:15 three of the six are more than 2.5% from the median and only three remain, so the rule refuses. That is arguably right, since nothing here says which side is correct.

**Real market gap in a crash: SOL/USDT, 2025-10-10 21:19–21:22 (1-min closes).** Binance and XT hold ~180 while KuCoin falls to 131 and OKX to 145; Bitfinex/Bybit/Crypto.com/Kraken in between. A 20%+ spread between large exchanges, every candle with volume:

| UTC | binance | bitfinex | bybit | cryptocom | kraken | kucoin | okx | xt |
|---|---|---|---|---|---|---|---|---|
| 21:17 | 182.02 | 174.8 | 174.08 | 175.09 | 173.91 | 169.88 | 170 | 181.53 |
| 21:19 | 180.05 | 170 | 160.39 | 169.54 | 170.19 | 139.99 | 147.29 | 180.03 |
| 21:20 | 181.31 | 169.32 | 163.04 | 172.43 | 165.01 | 131.28 | 145.48 | 180.7 |
| 21:22 | 177.14 | 174.88 | 173.12 | 173.99 | 169.31 | 149.84 | 161.99 | 176.9 |

**Broken or stale feed: XMR/USDT on XT, 2026-10-28 (1-hour closes).** XT drops to 500 (−16%) at 02:00 and then sits 7–9% below everyone else from 03:00 to 08:00; the other four exchanges agree within 0.5%:

| UTC | bitfinex | htx | kraken | kucoin | xt |
|---|---|---|---|---|---|
| 02:00 | 599.15 | 600.18 | 599.07 | 599.13 | **500.37** |
| 03:00 | 601.25 | 602.34 | 601 | 601.58 | **555.02** |
| 05:00 | 607.42 | 607.97 | 607.41 | 607.58 | **554.95** |
| 07:00 | 612.27 | 612.59 | 611.89 | 612.75 | **562.86** |
| 09:00 | 606.4 | 607.83 | 606.81 | 607.24 | 582.52 |

Also on 5-minute data: XT XMR/USDT was 4.5–4.65% above the others on 2026-11-17 06:50–07:30 with ~1 XMR per candle.

**Bad data, thin book: TON/USDT on Bitfinex, 2025-10-10 21:16–21:23 (1-min closes).** Everyone else crashes to 0.57–0.6; Bitfinex's last trade stays at 1.2152 and then 1.1752 for three minutes, 108% above the median:

| UTC | bitfinex | bybit | kraken | kucoin | xt |
|---|---|---|---|---|---|
| 21:16 | 2.0634 | 1.936 | 1.905 | 1.9372 | 1.934 |
| 21:18 | 1.5544 | 1.163 | 1.222 | 1.173 | 1.159 |
| 21:19 | **1.2152** | 0.576 | 0.606 | 0.5797 | 0.583 |
| 21:20 | **1.1752** | 0.574 | 0.698 | 0.582 | 0.559 |
| 21:21 | **1.1752** | 0.655 | 0.655 | 0.6501 | 0.649 |

In the calm month Bitfinex TON/USDT is more than 1% off in 15% of its 261 (sparse) 1-hour candles, up to 18%; the biggest 5-minute outlier (18.2%, 2026-11-14 00:55) had 5.9 TON, about $6, traded in the candle.

**Bad print: USDT/USD on Crypto.com, 2025-10-10 21:38–21:40.** 1.1275, 1.0111, 1.0100 while the other exchanges say 1.0008–1.0021: one venue, three minutes, and the USDT leg multiplies every cross-priced coin.

### 5.3 What a thin-candle filter changes

Dropping candles with under $100 traded (`results_thin100.json`) leaves the conclusions the same: pooled non-stable cannot-price (upper) at 2.5%: 0.11% (1m) / 0.03% (5m) / 0.00% (1h); TRX 5m 0.06% (unchanged, TRX candles are not thin); XMR 5m 0.73% at 2.5% (the 3-exchange-present steps get slightly more frequent); TON/USDT 5m 0% at ≥1%. In the windows it changes nothing material (TON/USDT W1 still 35% upper bound at 2.5% because of the missing exchanges).

## 6. What candles cannot show, and how much it matters

The price code uses bid/ask midpoints from each exchange's ticker. A candle close is the last trade in the interval. Differences:

1. **A close is not a midpoint.** In calm markets the gap is tiny, but it has fat tails on thin books.
2. **Candles hide sub-minute spikes.** The close is a single instant at the end of the minute; a 20-second dislocation inside a minute is invisible, so the real frequency of >X% gaps in a live midpoint feed is **higher than my tables** for crash minutes. My windows show 1-minute closes only.
3. **Stale thin-exchange candles.** A thin exchange's close can be minutes or hours old (Gemini USDT markets, Bitfinex TON, XT XMR), so a close-vs-close deviation overstates how wrong that exchange's *quote* is, if its book is tight and maintained; and understates it if its book is wide (see below).
4. **Candles for exchanges with no trade in an interval do not exist**, which shrinks the 4-candle coverage and inflates "cannot price" (the upper bound).
5. **24 h volume weights and the 60 s freshness filter** of the live code are not in my numbers; the freshness filter already drops some stale tickers before the rule would see them.

Estimate from live data: 6 samples, 150 s apart, 2026-11-19 17:17 to 17:31 UTC (calm market), for 11 pairs, 450 exchange-observations, no request errors. Each sample took the same public ticker URLs as `price.function.ts`, computed the bid/ask midpoint, and the latest completed 1-minute close of the same market.

| measure | n | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| exchange live mid vs cross-exchange median of live mids | 450 | 0.015% | 0.165% | 1.83% | 4.67% |
| exchange last-1m-close vs median of last-1m-closes (same instant) | 404 | 0.016% | 0.272% | 1.54% | 2.01% |
| \|live mid − latest completed 1m close\| / mid (same exchange) | 404 | 0.049% | 0.281% | 1.64% | 1.88% |

Share of live exchange-mids beyond each limit:

| share of live observations beyond limit | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| exchange mid vs median (450 obs) | 6.89% | 3.33% | 1.56% | 0.89% | 0.67% | 0.22% | 0.00% |

What the rule would have refused on the live mids (cannot price = fewer than four within X of the median of mids; n/samples):

| pair | live samples | exchanges | cannot price @0.5% | cannot price @1% | cannot price @1.5% | cannot price @2% | cannot price @2.5% | cannot price @3% | cannot price @5% |
|---|---|---|---|---|---|---|---|---|---|
| bnb/usdt | 6 | 8 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 |
| btc/usdt | 6 | 11 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 |
| eth/usdt | 6 | 11 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 |
| ltc/usd | 6 | 4 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 |
| sol/usd | 6 | 5 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 |
| ton/usd | 6 | 4 | 6/6 | 6/6 | 5/6 | 4/6 | 3/6 | 1/6 | 0/6 |
| ton/usdt | 6 | 10 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 |
| trx/usdt | 6 | 6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 |
| usdc/usd | 6 | 4 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 |
| usdt/usd | 6 | 7 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 |
| xmr/usdt | 6 | 5 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 | 0/6 |

Exchange-pairs whose live mid was more than 0.5% from the median at some point:

| pair | exchange | mean mid deviation from median | max | mean bid-ask spread |
|---|---|---|---|---|
| ton/usd | bitfinex | 1.75% | 4.67% | 5.86% |
| ton/usd | gemini | 1.69% | 2.53% | 0.01% |
| xmr/usdt | xt | 0.85% | 1.83% | 2.63% |
| ton/usd | kraken | 0.90% | 1.28% | 0.16% |
| ton/usd | cryptocom | 0.93% | 1.28% | 0.15% |
| ton/usdt | cryptocom | 0.54% | 0.70% | 1.31% |

Reading this:

- For liquid pairs live midpoints are much tighter than closes: median distance of a live mid from the median is 0.015%; mid vs. same-exchange close differs by a median 0.05% (p90 0.28%) but up to 1.9% on thin books (Gemini ETH/USDT, Crypto.com TON/USDT, Kraken TON/USDT, Binance SOL/USD, XT XMR/USDT). So candle-based deviations on thin pairs are *noisier than the real quotes*, and the conclusion "candles show 2% gaps on thin pairs" is partly noise; on liquid pairs candles and mids agree.
- The live sample also shows something candles cannot: **thin-exchange quotes are wide**. Bitfinex TON/USD has a mean bid-ask spread of 5.9%, XT XMR/USDT 2.6%, Crypto.com TON/USDT 1.3%. A midpoint of a 4%-wide book is only accurate to ±2%; those venues sit near any 2% limit by construction.
- **TON/USD direct is structurally split right now**: Gemini's mid sits +1.7% above the median (tight 0.01% spread, so a real quote), Kraken and Crypto.com about −0.9%, Bitfinex wide and jumpy. With only four sources, any limit ≤2.5% refuses it in 3 of 6 samples (2% in 4 of 6). The fallback to TON/USDT × USDT/USD (10 USDT sources) saves the invoice **if the rule sits inside `weightedPrice`**, but the cross price and the direct price differ by about 1%.
- Over the 15-minute calm sample every other pair stayed inside 0.5% except XT XMR/USDT (up to 1.8%) and Crypto.com TON/USDT (0.7%, spread 1.3%).

Limits of the live sample: 15 minutes, one afternoon, calm; it is a sanity check for the candle-vs-mid gap, not a distribution of mid-based deviations over a month. To get that, record the tickers every few seconds for a few weeks (the only way to also see sub-minute spikes).

## 7. Does the rule change the price at all?

For each timestamp I computed the volume-weighted average of the closes (weights = trailing 24 h volume per exchange for the 30-day hourly data; the whole-window volume per exchange in the windows) with and without the rule, and compared both with the median.

30 days, 1-hour grid (24 h weights): the no-rule weighted price is already within 0.5% of the median on every pair; the rule at 2% changes the weighted price in at most 25 hours (XMR) and by at most 0.85% (TRX, 19 hours), 0.08% (XMR), 0.03% (ETH/USD) and 0 for the rest:

| pair | timestamps | no-rule price vs median: p99 / max | rule @2% changed the price in | largest price change @2% | @2.5% changed in | largest @2.5% |
|---|---|---|---|---|---|---|
| usdt/usd | 720 | 0.057% / 0.07% | 0 | 0.000% | 0 | 0.000% |
| usdc/usd | 612 | 0.046% / 0.07% | 0 | 0.000% | 0 | 0.000% |
| bnb/usdt | 720 | 0.034% / 0.06% | 0 | 0.000% | 0 | 0.000% |
| sol/usdt | 720 | 0.035% / 0.05% | 0 | 0.000% | 0 | 0.000% |
| ton/usd | 23 | 1.410% / 1.53% | 0 | 0.000% | 0 | 0.000% |
| btc/usdt | 720 | 0.025% / 0.04% | 0 | 0.000% | 0 | 0.000% |
| sol/usd | 720 | 0.119% / 0.27% | 1 | 0.001% | 0 | 0.000% |
| btc/usd | 720 | 0.092% / 0.16% | 0 | 0.000% | 0 | 0.000% |
| eth/usdt | 720 | 0.018% / 0.03% | 2 | 0.000% | 1 | 0.000% |
| ltc/usd | 684 | 0.144% / 0.42% | 0 | 0.000% | 0 | 0.000% |
| ltc/usdt | 720 | 0.029% / 0.09% | 0 | 0.000% | 0 | 0.000% |
| usdc/usdt | 720 | 0.016% / 0.03% | 0 | 0.000% | 0 | 0.000% |
| eth/usd | 720 | 0.104% / 0.31% | 1 | 0.028% | 0 | 0.000% |
| trx/usdt | 720 | 0.307% / 0.47% | 19 | 0.853% | 9 | 0.506% |
| ton/usdt | 720 | 0.079% / 0.13% | 23 | 0.007% | 14 | 0.007% |
| xmr/usdt | 720 | 0.329% / 0.50% | 25 | 0.077% | 18 | 0.077% |

W1 (crash):

| pair | timestamps | no-rule price vs median: p99 / max | rule @2% changed the price in | largest price change @2% | @2.5% changed in | largest @2.5% |
|---|---|---|---|---|---|---|
| eth/usdt | 480 | 0.403% / 0.95% | 1 | 1.190% | 1 | 1.190% |
| bnb/usdt | 480 | 0.239% / 0.63% | 50 | 0.003% | 40 | 0.003% |
| sol/usdt | 480 | 0.791% / 1.65% | 54 | 1.757% | 30 | 2.574% |
| usdc/usdt | 480 | 0.035% / 0.10% | 0 | 0.000% | 0 | 0.000% |
| usdt/usd | 366 | 0.223% / 0.50% | 0 | 0.000% | 0 | 0.000% |
| ltc/usdt | 480 | 1.453% / 1.86% | 101 | 2.803% | 82 | 2.803% |
| ton/usdt | 247 | 3.585% / 4.99% | 12 | 0.980% | 13 | 0.980% |
| btc/usdt | 480 | 0.142% / 0.19% | 0 | 0.000% | 0 | 0.000% |
| xmr/usdt | 172 | 0.332% / 0.69% | 0 | 0.000% | 0 | 0.000% |
| trx/usdt | 479 | 0.870% / 2.18% | 0 | 0.000% | 0 | 0.000% |

W3 (crash):

| pair | timestamps | no-rule price vs median: p99 / max | rule @2% changed the price in | largest price change @2% | @2.5% changed in | largest @2.5% |
|---|---|---|---|---|---|---|
| eth/usdt | 360 | 0.571% / 0.65% | 18 | 0.676% | 15 | 0.676% |
| trx/usdt | 360 | 0.231% / 0.71% | 0 | 0.000% | 0 | 0.000% |
| ltc/usdt | 360 | 0.080% / 0.32% | 0 | 0.000% | 0 | 0.000% |
| usdc/usdt | 360 | 0.019% / 0.03% | 0 | 0.000% | 0 | 0.000% |
| xmr/usdt | 77 | 0.557% / 0.74% | 0 | 0.000% | 0 | 0.000% |
| usdt/usd | 260 | 0.034% / 0.03% | 0 | 0.000% | 0 | 0.000% |
| ton/usdt | 293 | 0.314% / 0.51% | 0 | 0.000% | 0 | 0.000% |
| sol/usdt | 360 | 0.061% / 0.11% | 0 | 0.000% | 0 | 0.000% |
| btc/usdt | 360 | 0.039% / 0.06% | 0 | 0.000% | 0 | 0.000% |
| bnb/usdt | 360 | 0.095% / 0.53% | 0 | 0.000% | 0 | 0.000% |

W2 (2026-02-05/06): the rule never changes the price at 2% or 2.5%; the no-rule weighted price stays within 0.41% of the median on every pair.

So in a calm month the rule is nearly a no-op on price (thin venues already carry little weight) and works through refusal; in a crash it moves prices by about 1% to 2.8% on SOL, LTC, ETH, TON and cuts the error against the median (SOL/USDT 1.65% → 0.79%, LTC/USDT 1.86% → 1.44%, TON/USDT 4.99% → 1.35%). I treat "the median" as the reference here; it is not ground truth. Weights in the windows are crude (whole-window volume).

## 8. Recommendation and what the owner needs to decide

1. **Use 2.5% for non-stablecoin pairs.** It never touches BTC, ETH, SOL, BNB, LTC, USDC, USDT or TON/USDT in a calm month, drops ~0.04% of exchange-observations pooled (5m), and halves the TRX refusals relative to 2% (273 vs 571 minutes per month, 1m grid upper bound). It still catches every bad-feed case I found (XT XMR −16% / −8% for hours, Bitfinex TON +18% to +108%, Crypto.com USDT +12.6%, the SOL/LTC/TON crash dislocations of 10–30%). The difference between 2% and 2.5% on the majors, even in W3 (the worst ETH crash window), is 0.63% vs 0.53% of observations: negligible.
2. **Stablecoins: 1%.** The three stablecoin pairs never exceed 0.63% in 30 days; in the windows the worst is 0.75% (USDC/USDT, W1), 0.32% (W2) and 0.12% (W3), apart from single-venue bad prints (Crypto.com USDT/USD 12.6%). A 2.5% limit on the USDT/USD leg would allow a 2.5% error into every coin priced as coin/USDT × USDT/USD. Cost at 1% in the calm month: 0 exchange-observations dropped on every grid (0.5% would drop 0.007–0.014%), 0 cannot-price. In W1 it drops 0.16% of stable observations (the Crypto.com prints). Note the existing DAI peg check already uses 1%.
3. **XMR and TRX are the pairs that will actually hit the limit.** If refusals on them are unacceptable, either raise their limit to 3% (TRX 1m upper 0.36%, XMR 5m 0.30%) or add sources; do not lower below 2.5%. TRX is never a payment currency (fee burn only).
4. **Put the rule inside `weightedPrice`** so a refused direct USD price still falls back to coin/USDT × USDT/USD (that rescues TON/USD, whose four direct sources disagree).
5. **Think about 4-source pairs** (LTC/USD, TON/USD, USDC/USD): they are refused after any single drop, so for them the rule adds nothing beyond "all four must agree within X"; the 1h data show LTC/USD cannot-price 0.44% at 1%, 0 at 2%+.
6. **Before trusting the number for crashes**, record live bid/ask midpoints from all exchanges for a few weeks (seconds resolution). Candles cannot show sub-minute dislocations, which is where a crash-time rule earns its keep.

What I did not verify or could not do:
- No data for Gate, MEXC, Gemini, HTX in the stress windows (their APIs do not serve it); Kraken windows are rebuilt from trades.
- Live mid sample is 15 minutes only.
- Doc pages for Gate and MEXC refused my script (403); their depth limits come from the API's behaviour (error text and empty responses), not from documentation text. Binance, Bybit, Bitfinex, Kraken limits were cross-checked against the doc text; the others were verified only against API behaviour.
- "Median as truth": when exchanges truly disagree (TRX Oct 29, SOL Oct 10) no data here says which is right.
- The current-month TON "GRAM" symbols are as configured in `markets.json`; I did not investigate the TON/GRAM naming.

## 9. Reproducibility

The raw candles, scripts and results were kept in a temporary scratchpad and were not saved to the repo.

- `raw/`: 624 JSON files, one per (dataset, exchange, market, interval): rows `[open_ts_ms, open, high, low, close, base_volume]` (downloaded data, treated as untrusted).
- `scripts/`: `pairs.py` (reads `markets.json` only), `fetchlib.py` (per-exchange downloaders), `download.py` (batch driver; `manifest.json` fixes the "now" at 2026-11-19 17:00 UTC), `analyze.py` (deviation, percentiles, limits, classification), `bounds.py`, `impact.py`, `live.py`, `tables.py`, `build_report.py`, `report_template.md`.
- `results.json` (main), `results_thin100.json` ($100 notional floor), `bounds.json`, `impact.json`, `live.json`, `download.log`.
- All scripts were run with `python3 -I` (stdlib only, no downloaded code executed).
- Re-run: `python3 -I scripts/download.py && python3 -I scripts/analyze.py results.json && python3 -I scripts/bounds.py && python3 -I scripts/impact.py impact.json && python3 -I scripts/build_report.py`.

## Appendix: full per-pair tables

### A. 30 days @ 1 minute

#### 30d@1m: deviation percentiles

| pair | exchanges with data | timestamps with ≥4 (of all) | obs | p50 | p90 | p99 | p99.9 | max (when, who) |
|---|---|---|---|---|---|---|---|---|
| btc/usd | 7 | 1813 of 43200 (4%) | 8087 | 0.028% | 0.107% | 0.200% | 0.431% | 0.74% (2026-11-05 15:10 UTC, binance) |
| btc/usdt | 11 | 43200 of 43200 (100%) | 355476 | 0.004% | 0.014% | 0.058% | 0.080% | 0.50% (2026-11-14 21:17 UTC, mexc) |
| eth/usd | 7 | 1453 of 43195 (3%) | 6288 | 0.033% | 0.114% | 0.283% | 0.532% | 0.95% (2026-10-30 00:18 UTC, bybit) |
| eth/usdt | 11 | 43200 of 43200 (100%) | 352293 | 0.004% | 0.019% | 0.060% | 0.130% | 0.89% (2026-11-08 21:55 UTC, xt) |
| sol/usd | 5 | 352 of 43040 (1%) | 1425 | 0.029% | 0.091% | 0.154% | 0.228% | 0.30% (2026-11-19 15:00 UTC, gemini) |
| sol/usdt | 10 | 43200 of 43200 (100%) | 354252 | 0.007% | 0.027% | 0.089% | 0.332% | 0.77% (2026-10-29 20:42 UTC, mexc) |
| ltc/usd | 4 | 22 of 41840 (0%) | 88 | 0.035% | 0.104% | 0.166% | 0.205% | 0.21% (2026-11-19 12:25 UTC, gemini) |
| ltc/usdt | 10 | 43192 of 43200 (100%) | 320437 | 0.017% | 0.045% | 0.110% | 0.392% | 2.21% (2026-11-15 01:10 UTC, mexc) |
| xmr/usdt | 5 | 1532 of 43200 (4%) | 6474 | 0.121% | 0.397% | 1.114% | 1.648% | 2.48% (2026-11-19 13:47 UTC, xt) |
| bnb/usdt | 8 | 43193 of 43200 (100%) | 265624 | 0.007% | 0.029% | 0.060% | 0.116% | 0.49% (2026-11-10 13:31 UTC, mexc) |
| ton/usd | 3 | 0 of 4226 | 0 | - | - | - | - | not enough exchanges with candles |
| ton/usdt | 10 | 42911 of 43200 (99%) | 263086 | 0.000% | 0.095% | 0.444% | 1.050% | 19.50% (2026-11-15 00:21 UTC, bitfinex) |
| trx/usdt | 6 | 42907 of 43200 (99%) | 219845 | 0.013% | 0.078% | 1.691% | 3.776% | 9.36% (2026-10-29 22:33 UTC, kucoin) |
| usdt/usd | 7 | 12769 of 43194 (30%) | 53512 | 0.013% | 0.122% | 0.177% | 0.328% | 0.63% (2026-10-30 06:37 UTC, binance) |
| usdc/usd | 4 | 9 of 42676 (0%) | 36 | 0.012% | 0.089% | 0.102% | 0.102% | 0.10% (2026-11-19 15:37 UTC, bitfinex) |
| usdc/usdt | 9 | 43200 of 43200 (100%) | 286064 | 0.001% | 0.011% | 0.034% | 0.054% | 0.31% (2026-10-30 15:52 UTC, bitfinex) |
| POOLED all |  | 362953 | 2492987 | 0.005% | 0.041% | 0.191% | 1.570% | 19.50% (ton/usdt 2026-11-15 00:21 UTC, bitfinex) |
| POOLED excl stablecoins |  | 306975 | 2153375 | 0.006% | 0.043% | 0.223% | 1.720% | 19.50% (ton/usdt 2026-11-15 00:21 UTC, bitfinex) |
| POOLED stablecoin pairs |  | 55978 | 339612 | 0.001% | 0.020% | 0.136% | 0.189% | 0.63% (usdt/usd 2026-10-30 06:37 UTC, binance) |



#### 30d@1m: % of exchange-observations that would be dropped

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usd | 0.037% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| btc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usd | 0.159% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 0.001% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usdt | 0.008% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usdt | 0.055% | 0.014% | 0.003% | 0.000% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 6.194% | 1.236% | 0.216% | 0.015% | 0.000% | 0.000% | 0.000% |
| bnb/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usdt | 0.799% | 0.128% | 0.016% | 0.008% | 0.007% | 0.007% | 0.004% |
| trx/usdt | 2.668% | 2.047% | 1.205% | 0.730% | 0.385% | 0.254% | 0.044% |
| usdt/usd | 0.045% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 0.346% | 0.199% | 0.109% | 0.065% | 0.035% | 0.023% | 0.004% |
| POOLED excl stablecoins | 0.399% | 0.230% | 0.126% | 0.076% | 0.040% | 0.027% | 0.005% |
| POOLED stablecoin pairs | 0.007% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |



#### 30d@1m: % of timestamps where at least one exchange would be dropped

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usd | 0.165% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| btc/usdt | 0.002% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usd | 0.688% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 0.002% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usdt | 0.069% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usdt | 0.407% | 0.104% | 0.025% | 0.002% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 25.979% | 5.222% | 0.914% | 0.065% | 0.000% | 0.000% | 0.000% |
| bnb/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usdt | 4.838% | 0.783% | 0.098% | 0.047% | 0.042% | 0.042% | 0.026% |
| trx/usdt | 5.768% | 5.050% | 3.668% | 2.431% | 1.356% | 0.956% | 0.165% |
| usdt/usd | 0.188% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 1.431% | 0.724% | 0.452% | 0.293% | 0.165% | 0.118% | 0.023% |
| POOLED excl stablecoins | 1.684% | 0.856% | 0.535% | 0.347% | 0.195% | 0.139% | 0.027% |
| POOLED stablecoin pairs | 0.043% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |



#### 30d@1m: % of timestamps with fewer than 4 exchanges left (upper bound, see method)

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usd | 0.165% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| btc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usd | 0.619% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 19.843% | 5.091% | 0.914% | 0.065% | 0.000% | 0.000% | 0.000% |
| bnb/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| trx/usdt | 5.106% | 4.479% | 2.526% | 1.331% | 0.636% | 0.364% | 0.058% |
| usdt/usd | 0.149% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 0.696% | 0.551% | 0.303% | 0.158% | 0.075% | 0.043% | 0.007% |
| POOLED excl stablecoins | 0.817% | 0.652% | 0.358% | 0.186% | 0.089% | 0.051% | 0.008% |
| POOLED stablecoin pairs | 0.034% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |



#### 30d@1m: which exchange is the outlier (pooled, non-stablecoin pairs)

| exchange | pairs | observations | >1% from median | >2% | >2.5% | worst (pair) |
|---|---|---|---|---|---|---|
| kucoin | 8 | 295519 | 0.663% | 0.318% | 0.189% | 9.4% (trx/usdt) |
| okx | 7 | 299269 | 0.551% | 0.215% | 0.094% | 7.8% (trx/usdt) |
| bitfinex | 10 | 154685 | 0.047% | 0.013% | 0.012% | 19.5% (ton/usdt) |
| bybit | 9 | 299516 | 0.013% | 0.004% | 0.001% | 3.0% (trx/usdt) |
| mexc | 7 | 301300 | 0.107% | 0.002% | 0.001% | 7.2% (trx/usdt) |
| binance | 10 | 303940 | 0.276% | 0.002% | 0.000% | 3.1% (trx/usdt) |
| xt | 7 | 257673 | 0.031% | 0.000% | 0.000% | 2.5% (xmr/usdt) |
| cryptocom | 9 | 163855 | 0.001% | 0.000% | 0.000% | 1.1% (ton/usdt) |
| gate | 9 | 70607 | 0.000% | 0.000% | 0.000% | 0.7% (eth/usd) |
| gemini | 6 | 1929 | 0.000% | 0.000% | 0.000% | 0.8% (eth/usd) |
| kraken | 11 | 3550 | 0.000% | 0.000% | 0.000% | 0.4% (xmr/usdt) |
| htx | 1 | 1532 | 0.000% | 0.000% | 0.000% | 0.4% (xmr/usdt) |



#### 30d@1m: observations more than 1% from the median, by pair and class

| pair | exchange-observations >1% from median | by exchange | timing / persistent / isolated |
|---|---|---|---|
| ltc/usdt | 45 | mexc 45 | 0 / 36 / 9 |
| xmr/usdt | 80 | xt 80 | 1 / 43 / 36 |
| ton/usdt | 336 | mexc 262, bitfinex 72, cryptocom 2 | 79 / 22 / 235 |
| trx/usdt | 4501 | kucoin 1960, okx 1648, binance 838, bybit 39, mexc 16 | 20 / 4331 / 150 |

### B. 30 days @ 5 minutes

#### 30d@5m: deviation percentiles

| pair | exchanges with data | timestamps with ≥4 (of all) | obs | p50 | p90 | p99 | p99.9 | max (when, who) |
|---|---|---|---|---|---|---|---|---|
| btc/usd | 7 | 4463 of 8640 (52%) | 19878 | 0.036% | 0.125% | 0.270% | 0.513% | 1.42% (2026-11-15 02:05 UTC, gate) |
| btc/usdt | 11 | 8640 of 8640 (100%) | 78882 | 0.004% | 0.015% | 0.062% | 0.165% | 3.69% (2026-11-14 05:00 UTC, gemini) |
| eth/usd | 7 | 4268 of 8640 (49%) | 18858 | 0.037% | 0.127% | 0.317% | 0.655% | 1.58% (2026-11-17 15:55 UTC, bybit) |
| eth/usdt | 11 | 8640 of 8640 (100%) | 78520 | 0.004% | 0.019% | 0.064% | 0.160% | 1.54% (2026-11-15 02:05 UTC, gemini) |
| sol/usd | 5 | 1017 of 8640 (12%) | 4236 | 0.035% | 0.111% | 0.319% | 0.715% | 1.09% (2026-11-14 22:15 UTC, binance) |
| sol/usdt | 10 | 8640 of 8640 (100%) | 78468 | 0.010% | 0.027% | 0.087% | 0.322% | 0.56% (2026-11-09 16:00 UTC, mexc) |
| ltc/usd | 4 | 176 of 8613 (2%) | 704 | 0.036% | 0.130% | 0.273% | 0.407% | 0.41% (2026-11-18 14:30 UTC, gemini) |
| ltc/usdt | 10 | 8640 of 8640 (100%) | 77298 | 0.018% | 0.051% | 0.159% | 0.419% | 1.82% (2026-11-15 01:05 UTC, mexc) |
| xmr/usdt | 5 | 1968 of 8640 (23%) | 8530 | 0.136% | 0.499% | 1.435% | 4.349% | 4.65% (2026-11-17 07:10 UTC, xt) |
| bnb/usdt | 8 | 8640 of 8640 (100%) | 60666 | 0.008% | 0.029% | 0.063% | 0.129% | 0.40% (2026-11-18 14:30 UTC, kraken) |
| ton/usd | 4 | 0 of 3047 | 0 | - | - | - | - | not enough exchanges with candles |
| ton/usdt | 10 | 8640 of 8640 (100%) | 61693 | 0.009% | 0.096% | 0.492% | 1.197% | 18.20% (2026-11-14 00:55 UTC, bitfinex) |
| trx/usdt | 6 | 8640 of 8640 (100%) | 51838 | 0.015% | 0.080% | 1.646% | 3.610% | 7.77% (2026-10-29 23:00 UTC, kucoin) |
| usdt/usd | 7 | 7855 of 8640 (91%) | 37159 | 0.012% | 0.119% | 0.172% | 0.239% | 0.62% (2026-10-30 06:35 UTC, binance) |
| usdc/usd | 4 | 100 of 8639 (1%) | 400 | 0.010% | 0.111% | 0.135% | 0.142% | 0.14% (2026-11-18 08:55 UTC, bitfinex) |
| usdc/usdt | 9 | 8640 of 8640 (100%) | 68480 | 0.001% | 0.010% | 0.034% | 0.054% | 0.26% (2026-10-30 16:00 UTC, bitfinex) |
| POOLED all |  | 88967 | 645610 | 0.007% | 0.062% | 0.284% | 1.582% | 18.20% (ton/usdt 2026-11-14 00:55 UTC, bitfinex) |
| POOLED excl stablecoins |  | 72372 | 539571 | 0.008% | 0.066% | 0.322% | 1.747% | 18.20% (ton/usdt 2026-11-14 00:55 UTC, bitfinex) |
| POOLED stablecoin pairs |  | 16595 | 106039 | 0.002% | 0.031% | 0.157% | 0.197% | 0.62% (usdt/usd 2026-10-30 06:35 UTC, binance) |



#### 30d@5m: % of exchange-observations that would be dropped

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usd | 0.116% | 0.010% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| btc/usdt | 0.006% | 0.004% | 0.004% | 0.004% | 0.001% | 0.001% | 0.000% |
| eth/usd | 0.260% | 0.011% | 0.005% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 0.003% | 0.001% | 0.001% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usd | 0.354% | 0.024% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usdt | 0.006% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usdt | 0.060% | 0.012% | 0.003% | 0.000% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 9.930% | 2.567% | 0.727% | 0.375% | 0.305% | 0.211% | 0.000% |
| bnb/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usdt | 0.979% | 0.211% | 0.057% | 0.036% | 0.024% | 0.024% | 0.016% |
| trx/usdt | 2.554% | 1.798% | 1.190% | 0.681% | 0.353% | 0.230% | 0.017% |
| usdt/usd | 0.024% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 0.454% | 0.201% | 0.112% | 0.064% | 0.035% | 0.024% | 0.003% |
| POOLED excl stablecoins | 0.541% | 0.241% | 0.134% | 0.076% | 0.042% | 0.028% | 0.004% |
| POOLED stablecoin pairs | 0.008% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |



#### 30d@5m: % of timestamps where at least one exchange would be dropped

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usd | 0.515% | 0.045% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| btc/usdt | 0.058% | 0.035% | 0.035% | 0.035% | 0.012% | 0.012% | 0.000% |
| eth/usd | 1.101% | 0.047% | 0.023% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 0.023% | 0.012% | 0.012% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usd | 1.475% | 0.098% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usdt | 0.058% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usdt | 0.521% | 0.104% | 0.023% | 0.000% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 40.701% | 11.128% | 3.150% | 1.626% | 1.321% | 0.915% | 0.000% |
| bnb/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usdt | 6.655% | 1.505% | 0.405% | 0.255% | 0.174% | 0.174% | 0.116% |
| trx/usdt | 5.532% | 4.919% | 3.970% | 2.465% | 1.389% | 0.984% | 0.093% |
| usdt/usd | 0.115% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 2.254% | 0.890% | 0.502% | 0.303% | 0.182% | 0.134% | 0.020% |
| POOLED excl stablecoins | 2.758% | 1.094% | 0.618% | 0.373% | 0.224% | 0.164% | 0.025% |
| POOLED stablecoin pairs | 0.054% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |



#### 30d@5m: % of timestamps with fewer than 4 exchanges left (upper bound, see method)

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usd | 0.134% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| btc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usd | 0.398% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usd | 1.278% | 0.098% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 31.047% | 8.892% | 1.931% | 0.610% | 0.559% | 0.305% | 0.000% |
| bnb/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| trx/usdt | 3.241% | 0.995% | 0.150% | 0.093% | 0.058% | 0.046% | 0.000% |
| usdt/usd | 0.038% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 1.045% | 0.294% | 0.057% | 0.022% | 0.018% | 0.011% | 0.000% |
| POOLED excl stablecoins | 1.281% | 0.362% | 0.070% | 0.028% | 0.022% | 0.014% | 0.000% |
| POOLED stablecoin pairs | 0.018% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |



#### 30d@5m: which exchange is the outlier (pooled, non-stablecoin pairs)

| exchange | pairs | observations | >1% from median | >2% | >2.5% | worst (pair) |
|---|---|---|---|---|---|---|
| kucoin | 8 | 62444 | 0.641% | 0.314% | 0.186% | 7.8% (trx/usdt) |
| okx | 7 | 60480 | 0.577% | 0.212% | 0.078% | 4.4% (trx/usdt) |
| xt | 7 | 53718 | 0.393% | 0.060% | 0.048% | 4.7% (xmr/usdt) |
| gemini | 6 | 5182 | 0.077% | 0.058% | 0.019% | 3.7% (btc/usdt) |
| bitfinex | 10 | 46434 | 0.149% | 0.045% | 0.032% | 18.2% (ton/usdt) |
| kraken | 11 | 5935 | 0.017% | 0.017% | 0.000% | 2.1% (ton/usdt) |
| mexc | 7 | 60480 | 0.141% | 0.015% | 0.008% | 4.6% (trx/usdt) |
| binance | 10 | 68011 | 0.198% | 0.015% | 0.010% | 4.4% (trx/usdt) |
| gate | 9 | 67499 | 0.028% | 0.009% | 0.009% | 5.0% (trx/usdt) |
| bybit | 9 | 62793 | 0.032% | 0.006% | 0.003% | 3.5% (trx/usdt) |
| cryptocom | 9 | 44627 | 0.011% | 0.000% | 0.000% | 1.5% (ton/usdt) |
| htx | 1 | 1968 | 0.051% | 0.000% | 0.000% | 1.1% (xmr/usdt) |



#### 30d@5m: observations more than 1% from the median, by pair and class

| pair | exchange-observations >1% from median | by exchange | timing / persistent / isolated |
|---|---|---|---|
| btc/usd | 2 | gate 1, binance 1 | 0 / 0 / 2 |
| btc/usdt | 3 | gemini 3 | 2 / 0 / 1 |
| eth/usd | 2 | bybit 2 | 0 / 0 / 2 |
| eth/usdt | 1 | gemini 1 | 0 / 0 / 1 |
| sol/usd | 1 | binance 1 | 1 / 0 / 0 |
| ltc/usdt | 9 | mexc 9 | 0 / 5 / 4 |
| xmr/usdt | 219 | xt 211, bitfinex 7, htx 1 | 1 / 177 / 41 |
| ton/usdt | 130 | bitfinex 62, mexc 62, cryptocom 5, kraken 1 | 39 / 6 / 85 |
| trx/usdt | 932 | kucoin 400, okx 349, binance 133, gate 18, bybit 18, mexc 14 | 36 / 870 / 26 |

### C. 30 days @ 1 hour

#### 30d@1h: deviation percentiles

| pair | exchanges with data | timestamps with ≥4 (of all) | obs | p50 | p90 | p99 | p99.9 | max (when, who) |
|---|---|---|---|---|---|---|---|---|
| btc/usd | 7 | 720 of 720 (100%) | 4840 | 0.032% | 0.154% | 0.419% | 0.908% | 1.26% (2026-10-29 23:00 UTC, gate) |
| btc/usdt | 11 | 720 of 720 (100%) | 7713 | 0.005% | 0.025% | 0.281% | 0.844% | 1.67% (2026-11-13 13:00 UTC, gemini) |
| eth/usd | 7 | 720 of 720 (100%) | 4590 | 0.033% | 0.151% | 0.516% | 1.217% | 2.39% (2026-10-22 10:00 UTC, gemini) |
| eth/usdt | 11 | 720 of 720 (100%) | 7380 | 0.005% | 0.029% | 0.231% | 1.082% | 4.29% (2026-11-15 02:00 UTC, gemini) |
| sol/usd | 5 | 720 of 720 (100%) | 3481 | 0.033% | 0.158% | 0.566% | 1.092% | 2.40% (2026-11-13 06:00 UTC, binance) |
| sol/usdt | 10 | 720 of 720 (100%) | 7200 | 0.009% | 0.031% | 0.110% | 0.310% | 0.48% (2026-10-30 02:00 UTC, kraken) |
| ltc/usd | 4 | 684 of 720 (95%) | 2736 | 0.049% | 0.171% | 0.494% | 0.932% | 1.83% (2026-10-22 11:00 UTC, gemini) |
| ltc/usdt | 10 | 720 of 720 (100%) | 7200 | 0.018% | 0.058% | 0.203% | 0.421% | 1.01% (2026-11-15 00:00 UTC, mexc) |
| xmr/usdt | 5 | 720 of 720 (100%) | 3600 | 0.080% | 0.491% | 1.489% | 7.999% | 16.48% (2026-10-28 02:00 UTC, xt) |
| bnb/usdt | 8 | 720 of 720 (100%) | 5718 | 0.009% | 0.045% | 0.263% | 0.536% | 0.80% (2026-11-10 14:00 UTC, kraken) |
| ton/usd | 4 | 23 of 720 (3%) | 92 | 0.295% | 3.577% | 14.377% | 15.635% | 15.77% (2026-10-23 22:00 UTC, gemini) |
| ton/usdt | 10 | 720 of 720 (100%) | 6048 | 0.038% | 0.237% | 1.087% | 8.751% | 18.20% (2026-11-14 00:00 UTC, bitfinex) |
| trx/usdt | 6 | 720 of 720 (100%) | 4320 | 0.015% | 0.084% | 1.609% | 3.276% | 5.08% (2026-10-29 22:00 UTC, kucoin) |
| usdt/usd | 7 | 720 of 720 (100%) | 5018 | 0.011% | 0.106% | 0.180% | 0.263% | 0.60% (2026-10-30 06:00 UTC, binance) |
| usdc/usd | 4 | 612 of 720 (85%) | 2448 | 0.012% | 0.131% | 0.190% | 0.248% | 0.60% (2026-10-30 06:00 UTC, binance) |
| usdc/usdt | 9 | 720 of 720 (100%) | 6477 | 0.001% | 0.010% | 0.033% | 0.056% | 0.07% (2026-10-30 19:00 UTC, xt) |
| POOLED all |  | 10679 | 78861 | 0.010% | 0.110% | 0.563% | 2.203% | 18.20% (ton/usdt 2026-11-14 00:00 UTC, bitfinex) |
| POOLED excl stablecoins |  | 8627 | 64918 | 0.012% | 0.118% | 0.623% | 2.329% | 18.20% (ton/usdt 2026-11-14 00:00 UTC, bitfinex) |
| POOLED stablecoin pairs |  | 2052 | 13943 | 0.005% | 0.060% | 0.170% | 0.242% | 0.60% (usdc/usd 2026-10-30 06:00 UTC, binance) |



#### 30d@1h: % of exchange-observations that would be dropped

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usd | 0.661% | 0.062% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| btc/usdt | 0.246% | 0.065% | 0.013% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usd | 1.046% | 0.218% | 0.087% | 0.022% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 0.339% | 0.149% | 0.041% | 0.027% | 0.014% | 0.014% | 0.000% |
| sol/usd | 1.350% | 0.144% | 0.029% | 0.029% | 0.000% | 0.000% | 0.000% |
| sol/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usd | 0.987% | 0.110% | 0.037% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usdt | 0.042% | 0.014% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 9.778% | 2.583% | 0.972% | 0.694% | 0.500% | 0.417% | 0.250% |
| bnb/usdt | 0.122% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usd | 34.783% | 18.478% | 15.217% | 11.957% | 10.870% | 10.870% | 8.696% |
| ton/usdt | 4.431% | 1.157% | 0.546% | 0.397% | 0.231% | 0.198% | 0.132% |
| trx/usdt | 2.523% | 1.736% | 1.111% | 0.694% | 0.278% | 0.231% | 0.023% |
| usdt/usd | 0.020% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usd | 0.041% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 1.231% | 0.372% | 0.178% | 0.119% | 0.070% | 0.061% | 0.033% |
| POOLED excl stablecoins | 1.493% | 0.451% | 0.216% | 0.145% | 0.085% | 0.074% | 0.040% |
| POOLED stablecoin pairs | 0.014% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |



#### 30d@1h: % of timestamps where at least one exchange would be dropped

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usd | 4.028% | 0.417% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| btc/usdt | 2.639% | 0.694% | 0.139% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usd | 6.389% | 1.389% | 0.556% | 0.139% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 3.472% | 1.528% | 0.417% | 0.278% | 0.139% | 0.139% | 0.000% |
| sol/usd | 6.528% | 0.694% | 0.139% | 0.139% | 0.000% | 0.000% | 0.000% |
| sol/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usd | 3.947% | 0.439% | 0.146% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usdt | 0.417% | 0.139% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 47.500% | 12.917% | 4.861% | 3.472% | 2.500% | 2.083% | 1.250% |
| bnb/usdt | 0.972% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usd | 86.957% | 60.870% | 47.826% | 47.826% | 43.478% | 43.478% | 34.783% |
| ton/usdt | 29.861% | 9.028% | 4.444% | 3.194% | 1.944% | 1.667% | 1.111% |
| trx/usdt | 5.694% | 4.861% | 3.750% | 2.639% | 1.250% | 1.111% | 0.139% |
| usdt/usd | 0.139% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usd | 0.163% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 7.707% | 2.294% | 1.077% | 0.768% | 0.487% | 0.431% | 0.243% |
| POOLED excl stablecoins | 9.517% | 2.840% | 1.333% | 0.951% | 0.603% | 0.533% | 0.301% |
| POOLED stablecoin pairs | 0.097% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |



#### 30d@1h: % of timestamps with fewer than 4 exchanges left (upper bound, see method)

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| btc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usd | 3.947% | 0.439% | 0.146% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 1.389% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| bnb/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usd | 86.957% | 60.870% | 47.826% | 47.826% | 43.478% | 43.478% | 34.783% |
| ton/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| trx/usdt | 3.333% | 0.833% | 0.139% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdt/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usd | 0.163% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 0.768% | 0.215% | 0.122% | 0.103% | 0.094% | 0.094% | 0.075% |
| POOLED excl stablecoins | 0.939% | 0.267% | 0.151% | 0.128% | 0.116% | 0.116% | 0.093% |
| POOLED stablecoin pairs | 0.049% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |



#### 30d@1h: which exchange is the outlier (pooled, non-stablecoin pairs)

| exchange | pairs | observations | >1% from median | >2% | >2.5% | worst (pair) |
|---|---|---|---|---|---|---|
| xt | 7 | 5040 | 1.825% | 0.496% | 0.357% | 16.5% (xmr/usdt) |
| gemini | 7 | 3557 | 0.843% | 0.337% | 0.253% | 15.8% (ton/usd) |
| kucoin | 8 | 5760 | 0.556% | 0.330% | 0.156% | 5.1% (trx/usdt) |
| bitfinex | 11 | 6728 | 0.669% | 0.297% | 0.208% | 18.2% (ton/usdt) |
| okx | 7 | 5040 | 0.575% | 0.218% | 0.060% | 3.5% (trx/usdt) |
| kraken | 12 | 7606 | 0.210% | 0.053% | 0.026% | 3.1% (ton/usdt) |
| cryptocom | 10 | 6033 | 0.199% | 0.033% | 0.000% | 2.2% (ton/usdt) |
| binance | 10 | 7061 | 0.241% | 0.014% | 0.000% | 2.4% (sol/usd) |
| bybit | 9 | 5853 | 0.171% | 0.000% | 0.000% | 1.9% (eth/usd) |
| gate | 9 | 6480 | 0.046% | 0.000% | 0.000% | 1.7% (eth/usd) |
| mexc | 7 | 5040 | 0.139% | 0.000% | 0.000% | 1.7% (trx/usdt) |
| htx | 1 | 720 | 0.000% | 0.000% | 0.000% | 0.9% (xmr/usdt) |



#### 30d@1h: observations more than 1% from the median, by pair and class

| pair | exchange-observations >1% from median | by exchange | timing / persistent / isolated |
|---|---|---|---|
| btc/usd | 3 | gate 1, bybit 1, binance 1 | 2 / 0 / 1 |
| btc/usdt | 5 | gemini 5 | 3 / 0 / 2 |
| eth/usd | 10 | bybit 8, gemini 1, gate 1 | 5 / 0 / 5 |
| eth/usdt | 11 | gemini 11 | 1 / 0 / 10 |
| sol/usd | 5 | binance 5 | 0 / 0 / 5 |
| ltc/usd | 3 | gemini 3 | 1 / 0 / 2 |
| ltc/usdt | 1 | mexc 1 | 0 / 0 / 1 |
| xmr/usdt | 93 | xt 92, bitfinex 1 | 12 / 12 / 69 |
| ton/usd | 17 | gemini 10, bitfinex 4, cryptocom 2, kraken 1 | 1 / 0 / 16 |
| ton/usdt | 70 | bitfinex 40, kraken 15, cryptocom 10, mexc 5 | 17 / 0 / 53 |
| trx/usdt | 75 | kucoin 32, okx 29, binance 11, bybit 1, gate 1, mexc 1 | 13 / 53 / 9 |

### D. Window W1 (2025-10-10)

#### W1@1m: deviation percentiles

| pair | exchanges with data | timestamps with ≥4 (of all) | obs | p50 | p90 | p99 | p99.9 | max (when, who) |
|---|---|---|---|---|---|---|---|---|
| btc/usd | 3 | 0 of 480 | 0 | - | - | - | - | not enough exchanges with candles |
| btc/usdt | 8 | 480 of 480 (100%) | 3817 | 0.010% | 0.085% | 0.477% | 0.901% | 1.39% (2025-10-10 21:51 UTC, kraken) |
| eth/usd | 3 | 0 of 480 | 0 | - | - | - | - | not enough exchanges with candles |
| eth/usdt | 8 | 480 of 480 (100%) | 3787 | 0.018% | 0.224% | 1.149% | 1.694% | 2.68% (2025-10-10 21:56 UTC, binance) |
| sol/usd | 3 | 0 of 480 | 0 | - | - | - | - | not enough exchanges with candles |
| sol/usdt | 8 | 480 of 480 (100%) | 3769 | 0.044% | 0.643% | 2.941% | 13.035% | 21.47% (2025-10-10 21:20 UTC, kucoin) |
| ltc/usd | 3 | 0 of 480 | 0 | - | - | - | - | not enough exchanges with candles |
| ltc/usdt | 8 | 480 of 480 (100%) | 3663 | 0.054% | 0.725% | 4.427% | 10.072% | 12.64% (2025-10-10 21:23 UTC, kucoin) |
| xmr/usdt | 4 | 172 of 480 (36%) | 688 | 0.089% | 0.404% | 1.967% | 2.713% | 2.88% (2025-10-10 22:45 UTC, bitfinex) |
| bnb/usdt | 6 | 480 of 480 (100%) | 2601 | 0.031% | 0.158% | 3.173% | 7.872% | 10.42% (2025-10-10 22:15 UTC, kraken) |
| ton/usd | 2 | 0 of 410 | 0 | - | - | - | - | not enough exchanges with candles |
| ton/usdt | 5 | 247 of 480 (51%) | 1039 | 0.168% | 2.963% | 20.205% | 101.069% | 108.44% (2025-10-10 21:19 UTC, bitfinex) |
| trx/usdt | 4 | 479 of 480 (100%) | 1916 | 0.027% | 0.171% | 1.205% | 1.886% | 2.89% (2025-10-10 21:19 UTC, binance) |
| usdt/usd | 4 | 366 of 480 (76%) | 1464 | 0.033% | 0.170% | 0.711% | 1.705% | 12.55% (2025-10-10 21:38 UTC, cryptocom) |
| usdc/usd | 2 | 0 of 480 | 0 | - | - | - | - | not enough exchanges with candles |
| usdc/usdt | 7 | 480 of 480 (100%) | 2959 | 0.010% | 0.060% | 0.231% | 0.596% | 0.75% (2025-10-10 21:31 UTC, bitfinex) |
| POOLED all |  | 4144 | 25703 | 0.024% | 0.307% | 2.957% | 12.161% | 108.44% (ton/usdt 2025-10-10 21:19 UTC, bitfinex) |
| POOLED excl stablecoins |  | 3298 | 21280 | 0.029% | 0.392% | 3.338% | 13.184% | 108.44% (ton/usdt 2025-10-10 21:19 UTC, bitfinex) |
| POOLED stablecoin pairs |  | 846 | 4423 | 0.010% | 0.125% | 0.452% | 1.290% | 12.55% (usdt/usd 2025-10-10 21:38 UTC, cryptocom) |



#### W1@1m: % of exchange-observations that would be dropped

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usdt | 0.891% | 0.079% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 4.463% | 1.400% | 0.528% | 0.026% | 0.026% | 0.000% | 0.000% |
| sol/usdt | 12.735% | 5.731% | 3.794% | 2.361% | 1.486% | 0.955% | 0.557% |
| ltc/usdt | 12.776% | 8.026% | 6.143% | 4.696% | 3.221% | 2.239% | 0.819% |
| xmr/usdt | 7.703% | 3.052% | 2.326% | 1.017% | 0.436% | 0.000% | 0.000% |
| bnb/usdt | 4.883% | 2.884% | 2.307% | 1.922% | 1.538% | 1.153% | 0.461% |
| ton/usdt | 32.724% | 22.137% | 17.228% | 14.052% | 11.935% | 9.817% | 6.641% |
| trx/usdt | 6.106% | 2.818% | 0.313% | 0.052% | 0.052% | 0.000% | 0.000% |
| usdt/usd | 2.254% | 0.478% | 0.205% | 0.068% | 0.068% | 0.068% | 0.068% |
| usdc/usdt | 0.237% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 7.112% | 3.708% | 2.537% | 1.817% | 1.338% | 0.977% | 0.517% |
| POOLED excl stablecoins | 8.402% | 4.445% | 3.050% | 2.190% | 1.612% | 1.175% | 0.620% |
| POOLED stablecoin pairs | 0.904% | 0.158% | 0.068% | 0.023% | 0.023% | 0.023% | 0.023% |



#### W1@1m: % of timestamps where at least one exchange would be dropped

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usdt | 6.458% | 0.625% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 23.750% | 9.167% | 3.750% | 0.208% | 0.208% | 0.000% | 0.000% |
| sol/usdt | 32.292% | 19.375% | 17.917% | 12.083% | 7.083% | 3.750% | 1.458% |
| ltc/usdt | 38.750% | 29.583% | 25.417% | 21.042% | 17.083% | 13.125% | 5.208% |
| xmr/usdt | 26.163% | 11.047% | 9.302% | 4.070% | 1.744% | 0.000% | 0.000% |
| bnb/usdt | 23.333% | 15.417% | 12.500% | 10.417% | 8.333% | 6.250% | 2.500% |
| ton/usdt | 64.777% | 53.846% | 47.368% | 43.320% | 38.057% | 31.984% | 23.482% |
| trx/usdt | 7.933% | 4.175% | 1.044% | 0.209% | 0.209% | 0.000% | 0.000% |
| usdt/usd | 8.743% | 1.913% | 0.820% | 0.273% | 0.273% | 0.273% | 0.273% |
| usdc/usdt | 1.458% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 21.236% | 12.910% | 10.304% | 7.867% | 6.178% | 4.609% | 2.486% |
| POOLED excl stablecoins | 25.500% | 16.010% | 12.856% | 9.854% | 7.732% | 5.761% | 3.093% |
| POOLED stablecoin pairs | 4.610% | 0.827% | 0.355% | 0.118% | 0.118% | 0.118% | 0.118% |



#### W1@1m: % of timestamps with fewer than 4 exchanges left (upper bound, see method)

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 0.208% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usdt | 5.208% | 1.458% | 1.250% | 0.833% | 0.833% | 0.625% | 0.208% |
| ltc/usdt | 6.042% | 1.250% | 0.417% | 0.000% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 26.163% | 11.047% | 9.302% | 4.070% | 1.744% | 0.000% | 0.000% |
| bnb/usdt | 0.625% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usdt | 61.943% | 52.227% | 44.939% | 38.462% | 32.794% | 27.530% | 18.623% |
| trx/usdt | 7.933% | 4.175% | 1.044% | 0.209% | 0.209% | 0.000% | 0.000% |
| usdt/usd | 8.743% | 1.913% | 0.820% | 0.273% | 0.273% | 0.273% | 0.273% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 7.867% | 4.537% | 3.451% | 2.606% | 2.172% | 1.737% | 1.158% |
| POOLED excl stablecoins | 8.914% | 5.488% | 4.245% | 3.244% | 2.699% | 2.153% | 1.425% |
| POOLED stablecoin pairs | 3.783% | 0.827% | 0.355% | 0.118% | 0.118% | 0.118% | 0.118% |



#### W1@1m: which exchange is the outlier (pooled, non-stablecoin pairs)

| exchange | pairs | observations | >1% from median | >2% | >2.5% | worst (pair) |
|---|---|---|---|---|---|---|
| kraken | 7 | 2082 | 12.536% | 7.685% | 5.956% | 19.9% (ton/usdt) |
| kucoin | 8 | 3298 | 4.609% | 3.214% | 2.911% | 29.2% (ton/usdt) |
| cryptocom | 4 | 1917 | 4.121% | 1.982% | 1.200% | 7.4% (ltc/usdt) |
| okx | 6 | 2879 | 5.523% | 1.806% | 0.903% | 13.2% (sol/usdt) |
| bitfinex | 6 | 2283 | 3.855% | 1.489% | 1.183% | 108.4% (ton/usdt) |
| bybit | 7 | 3126 | 3.615% | 1.312% | 0.672% | 6.8% (ton/usdt) |
| xt | 7 | 2816 | 2.131% | 0.888% | 0.604% | 8.1% (sol/usdt) |
| binance | 6 | 2879 | 1.181% | 0.347% | 0.313% | 8.5% (sol/usdt) |



#### W1@1m: observations more than 1% from the median, by pair and class

| pair | exchange-observations >1% from median | by exchange | timing / persistent / isolated |
|---|---|---|---|
| btc/usdt | 3 | kraken 3 | 2 / 0 / 1 |
| eth/usdt | 53 | okx 30, bitfinex 11, kraken 5, xt 3, bybit 2, cryptocom 1, binance 1 | 13 / 25 / 15 |
| sol/usdt | 216 | okx 64, cryptocom 52, kraken 33, kucoin 20, bybit 20, binance 10, xt 10, bitfinex 7 | 48 / 125 / 43 |
| ltc/usdt | 294 | kraken 117, okx 52, bybit 50, bitfinex 27, cryptocom 26, kucoin 11, binance 8, xt 3 | 58 / 172 / 64 |
| xmr/usdt | 21 | bitfinex 11, xt 10 | 3 / 0 / 18 |
| bnb/usdt | 75 | kraken 73, xt 1, kucoin 1 | 16 / 23 / 36 |
| ton/usdt | 230 | kucoin 107, xt 33, bitfinex 32, kraken 30, bybit 28 | 55 / 106 / 69 |
| trx/usdt | 54 | binance 15, bybit 13, kucoin 13, okx 13 | 11 / 14 / 29 |
| usdt/usd | 7 | cryptocom 7 | 5 / 0 / 2 |

### E. Window W2 (2026-02-05/06)

#### W2@1m: deviation percentiles

| pair | exchanges with data | timestamps with ≥4 (of all) | obs | p50 | p90 | p99 | p99.9 | max (when, who) |
|---|---|---|---|---|---|---|---|---|
| btc/usd | 4 | 712 of 720 (99%) | 2848 | 0.030% | 0.315% | 0.389% | 0.796% | 1.56% (2026-02-06 00:19 UTC, kraken) |
| btc/usdt | 8 | 720 of 720 (100%) | 5757 | 0.008% | 0.038% | 0.152% | 0.754% | 1.35% (2026-02-06 00:14 UTC, kraken) |
| eth/usd | 3 | 0 of 720 | 0 | - | - | - | - | not enough exchanges with candles |
| eth/usdt | 8 | 720 of 720 (100%) | 5757 | 0.010% | 0.052% | 0.151% | 0.242% | 0.33% (2026-02-05 22:30 UTC, bitfinex) |
| sol/usd | 3 | 0 of 720 | 0 | - | - | - | - | not enough exchanges with candles |
| sol/usdt | 8 | 720 of 720 (100%) | 5755 | 0.012% | 0.064% | 0.181% | 0.293% | 0.53% (2026-02-06 00:15 UTC, xt) |
| ltc/usd | 3 | 0 of 720 | 0 | - | - | - | - | not enough exchanges with candles |
| ltc/usdt | 8 | 720 of 720 (100%) | 5190 | 0.018% | 0.092% | 0.453% | 0.813% | 1.33% (2026-02-06 00:17 UTC, bitfinex) |
| xmr/usdt | 4 | 395 of 720 (55%) | 1580 | 0.062% | 0.230% | 0.614% | 2.160% | 2.50% (2026-02-05 18:25 UTC, xt) |
| bnb/usdt | 6 | 720 of 720 (100%) | 3702 | 0.014% | 0.055% | 0.208% | 0.549% | 0.80% (2026-02-05 19:06 UTC, kraken) |
| ton/usd | 2 | 0 of 517 | 0 | - | - | - | - | not enough exchanges with candles |
| ton/usdt | 5 | 170 of 720 (24%) | 708 | 0.037% | 0.218% | 0.768% | 1.286% | 1.30% (2026-02-06 00:18 UTC, bitfinex) |
| trx/usdt | 4 | 720 of 720 (100%) | 2880 | 0.016% | 0.048% | 0.095% | 0.164% | 0.18% (2026-02-06 00:08 UTC, binance) |
| usdt/usd | 5 | 703 of 720 (98%) | 3215 | 0.017% | 0.281% | 0.306% | 0.313% | 0.32% (2026-02-05 19:04 UTC, bitfinex) |
| usdc/usd | 3 | 0 of 720 | 0 | - | - | - | - | not enough exchanges with candles |
| usdc/usdt | 7 | 720 of 720 (100%) | 4429 | 0.000% | 0.010% | 0.025% | 0.030% | 0.04% (2026-02-05 21:54 UTC, kucoin) |
| POOLED all |  | 7020 | 41821 | 0.012% | 0.080% | 0.338% | 0.739% | 2.50% (xmr/usdt 2026-02-05 18:25 UTC, xt) |
| POOLED excl stablecoins |  | 5597 | 34177 | 0.013% | 0.081% | 0.352% | 0.794% | 2.50% (xmr/usdt 2026-02-05 18:25 UTC, xt) |
| POOLED stablecoin pairs |  | 1423 | 7644 | 0.009% | 0.044% | 0.301% | 0.311% | 0.32% (usdt/usd 2026-02-05 19:04 UTC, bitfinex) |



#### W2@1m: % of exchange-observations that would be dropped

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usd | 0.456% | 0.070% | 0.035% | 0.000% | 0.000% | 0.000% | 0.000% |
| btc/usdt | 0.191% | 0.035% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usdt | 0.035% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usdt | 0.751% | 0.039% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 1.646% | 0.570% | 0.190% | 0.190% | 0.000% | 0.000% | 0.000% |
| bnb/usdt | 0.189% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usdt | 3.107% | 0.565% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| trx/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdt/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 0.287% | 0.045% | 0.010% | 0.007% | 0.000% | 0.000% | 0.000% |
| POOLED excl stablecoins | 0.351% | 0.056% | 0.012% | 0.009% | 0.000% | 0.000% | 0.000% |
| POOLED stablecoin pairs | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |



#### W2@1m: % of timestamps where at least one exchange would be dropped

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usd | 1.826% | 0.281% | 0.140% | 0.000% | 0.000% | 0.000% | 0.000% |
| btc/usdt | 1.528% | 0.278% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usdt | 0.278% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usdt | 4.583% | 0.278% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 6.582% | 2.278% | 0.759% | 0.759% | 0.000% | 0.000% | 0.000% |
| bnb/usdt | 0.972% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usdt | 12.941% | 2.353% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| trx/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdt/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 1.624% | 0.271% | 0.057% | 0.043% | 0.000% | 0.000% | 0.000% |
| POOLED excl stablecoins | 2.037% | 0.339% | 0.071% | 0.054% | 0.000% | 0.000% | 0.000% |
| POOLED stablecoin pairs | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |



#### W2@1m: % of timestamps with fewer than 4 exchanges left (upper bound, see method)

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usd | 1.826% | 0.281% | 0.140% | 0.000% | 0.000% | 0.000% | 0.000% |
| btc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 6.582% | 2.278% | 0.759% | 0.759% | 0.000% | 0.000% | 0.000% |
| bnb/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usdt | 8.235% | 1.765% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| trx/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdt/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 0.755% | 0.199% | 0.057% | 0.043% | 0.000% | 0.000% | 0.000% |
| POOLED excl stablecoins | 0.947% | 0.250% | 0.071% | 0.054% | 0.000% | 0.000% | 0.000% |
| POOLED stablecoin pairs | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |



#### W2@1m: which exchange is the outlier (pooled, non-stablecoin pairs)

| exchange | pairs | observations | >1% from median | >2% | >2.5% | worst (pair) |
|---|---|---|---|---|---|---|
| xt | 7 | 4165 | 0.168% | 0.072% | 0.000% | 2.5% (xmr/usdt) |
| binance | 7 | 5032 | 0.000% | 0.000% | 0.000% | 0.4% (btc/usd) |
| bitfinex | 7 | 3904 | 0.154% | 0.000% | 0.000% | 1.3% (ltc/usdt) |
| cryptocom | 5 | 3592 | 0.000% | 0.000% | 0.000% | 0.5% (btc/usd) |
| kraken | 8 | 3789 | 0.158% | 0.000% | 0.000% | 1.6% (btc/usd) |
| bybit | 7 | 4490 | 0.000% | 0.000% | 0.000% | 0.2% (sol/usdt) |
| kucoin | 8 | 4885 | 0.000% | 0.000% | 0.000% | 0.5% (xmr/usdt) |
| okx | 6 | 4320 | 0.000% | 0.000% | 0.000% | 0.3% (sol/usdt) |



#### W2@1m: observations more than 1% from the median, by pair and class

| pair | exchange-observations >1% from median | by exchange | timing / persistent / isolated |
|---|---|---|---|
| btc/usd | 2 | kraken 2 | 0 / 0 / 2 |
| btc/usdt | 2 | kraken 2 | 0 / 0 / 2 |
| ltc/usdt | 2 | bitfinex 2 | 0 / 0 / 2 |
| xmr/usdt | 9 | xt 7, kraken 1, bitfinex 1 | 0 / 0 / 9 |
| ton/usdt | 4 | bitfinex 3, kraken 1 | 1 / 0 / 3 |

### F. Window W3 (2025-02-03)

#### W3@1m: deviation percentiles

| pair | exchanges with data | timestamps with ≥4 (of all) | obs | p50 | p90 | p99 | p99.9 | max (when, who) |
|---|---|---|---|---|---|---|---|---|
| btc/usd | 3 | 0 of 360 | 0 | - | - | - | - | not enough exchanges with candles |
| btc/usdt | 8 | 360 of 360 (100%) | 2863 | 0.009% | 0.065% | 0.399% | 1.349% | 1.75% (2025-02-03 01:57 UTC, kucoin) |
| eth/usd | 3 | 0 of 360 | 0 | - | - | - | - | not enough exchanges with candles |
| eth/usdt | 8 | 360 of 360 (100%) | 2856 | 0.014% | 0.136% | 1.112% | 3.903% | 4.16% (2025-02-03 02:19 UTC, cryptocom) |
| sol/usd | 3 | 0 of 360 | 0 | - | - | - | - | not enough exchanges with candles |
| sol/usdt | 8 | 360 of 360 (100%) | 2865 | 0.019% | 0.118% | 0.398% | 0.713% | 0.85% (2025-02-03 02:10 UTC, bitfinex) |
| ltc/usd | 3 | 0 of 360 | 0 | - | - | - | - | not enough exchanges with candles |
| ltc/usdt | 8 | 360 of 360 (100%) | 2640 | 0.028% | 0.204% | 0.649% | 1.195% | 1.75% (2025-02-03 01:56 UTC, bitfinex) |
| xmr/usdt | 4 | 77 of 360 (21%) | 308 | 0.081% | 0.334% | 0.826% | 1.207% | 1.29% (2025-02-03 01:54 UTC, bitfinex) |
| bnb/usdt | 5 | 360 of 360 (100%) | 1800 | 0.015% | 0.060% | 0.209% | 0.878% | 0.98% (2025-02-03 02:07 UTC, okx) |
| ton/usd | 2 | 0 of 343 | 0 | - | - | - | - | not enough exchanges with candles |
| ton/usdt | 4 | 293 of 360 (81%) | 1172 | 0.035% | 2.116% | 16.576% | 23.104% | 31.28% (2025-02-03 02:07 UTC, bitfinex) |
| trx/usdt | 4 | 360 of 360 (100%) | 1440 | 0.019% | 0.062% | 0.141% | 0.591% | 0.86% (2025-02-03 01:55 UTC, binance) |
| usdt/usd | 4 | 260 of 360 (72%) | 1040 | 0.009% | 0.052% | 0.080% | 0.120% | 0.12% (2025-02-03 02:16 UTC, cryptocom) |
| usdc/usd | 2 | 0 of 360 | 0 | - | - | - | - | not enough exchanges with candles |
| usdc/usdt | 7 | 360 of 360 (100%) | 2147 | 0.010% | 0.025% | 0.050% | 0.060% | 0.10% (2025-02-03 01:14 UTC, bitfinex) |
| POOLED all |  | 3150 | 19131 | 0.015% | 0.111% | 1.465% | 15.158% | 31.28% (ton/usdt 2025-02-03 02:07 UTC, bitfinex) |
| POOLED excl stablecoins |  | 2530 | 15944 | 0.018% | 0.132% | 1.772% | 15.928% | 31.28% (ton/usdt 2025-02-03 02:07 UTC, bitfinex) |
| POOLED stablecoin pairs |  | 620 | 3187 | 0.010% | 0.035% | 0.074% | 0.115% | 0.12% (usdt/usd 2025-02-03 02:16 UTC, cryptocom) |



#### W3@1m: % of exchange-observations that would be dropped

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usdt | 0.699% | 0.454% | 0.105% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 2.486% | 1.155% | 0.805% | 0.630% | 0.525% | 0.385% | 0.000% |
| sol/usdt | 0.349% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usdt | 1.932% | 0.341% | 0.038% | 0.000% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 5.195% | 0.649% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| bnb/usdt | 0.333% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usdt | 19.198% | 17.150% | 13.652% | 10.324% | 8.276% | 7.338% | 5.631% |
| trx/usdt | 0.139% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdt/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 2.096% | 1.349% | 0.977% | 0.727% | 0.585% | 0.507% | 0.345% |
| POOLED excl stablecoins | 2.515% | 1.618% | 1.173% | 0.872% | 0.702% | 0.608% | 0.414% |
| POOLED stablecoin pairs | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |



#### W3@1m: % of timestamps where at least one exchange would be dropped

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usdt | 5.556% | 3.611% | 0.833% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 12.778% | 8.333% | 6.111% | 5.000% | 4.167% | 3.056% | 0.000% |
| sol/usdt | 1.944% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usdt | 10.000% | 1.944% | 0.278% | 0.000% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 15.584% | 2.597% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| bnb/usdt | 1.389% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usdt | 75.427% | 68.601% | 54.608% | 41.297% | 33.106% | 29.352% | 22.526% |
| trx/usdt | 0.556% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdt/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 11.079% | 8.032% | 5.905% | 4.413% | 3.556% | 3.079% | 2.095% |
| POOLED excl stablecoins | 13.794% | 10.000% | 7.352% | 5.494% | 4.427% | 3.834% | 2.609% |
| POOLED stablecoin pairs | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |



#### W3@1m: % of timestamps with fewer than 4 exchanges left (upper bound, see method)

****

| pair | 0.5% | 1% | 1.5% | 2% | 2.5% | 3% | 5% |
|---|---|---|---|---|---|---|---|
| btc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| eth/usdt | 0.278% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| sol/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ltc/usdt | 0.278% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| xmr/usdt | 15.584% | 2.597% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| bnb/usdt | 0.278% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ton/usdt | 75.427% | 68.601% | 54.608% | 41.297% | 33.106% | 29.352% | 22.526% |
| trx/usdt | 0.556% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdt/usd | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| usdc/usdt | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| POOLED all | 7.556% | 6.444% | 5.079% | 3.841% | 3.079% | 2.730% | 2.095% |
| POOLED excl stablecoins | 9.407% | 8.024% | 6.324% | 4.783% | 3.834% | 3.399% | 2.609% |
| POOLED stablecoin pairs | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |



#### W3@1m: which exchange is the outlier (pooled, non-stablecoin pairs)

| exchange | pairs | observations | >1% from median | >2% | >2.5% | worst (pair) |
|---|---|---|---|---|---|---|
| bitfinex | 6 | 1639 | 12.691% | 7.383% | 5.918% | 31.3% (ton/usdt) |
| cryptocom | 4 | 1430 | 1.329% | 1.189% | 0.979% | 4.2% (eth/usdt) |
| kucoin | 8 | 2530 | 0.949% | 0.040% | 0.040% | 2.7% (eth/usdt) |
| binance | 6 | 2160 | 0.093% | 0.000% | 0.000% | 1.1% (ltc/usdt) |
| bybit | 7 | 2453 | 0.000% | 0.000% | 0.000% | 0.8% (ltc/usdt) |
| kraken | 5 | 1402 | 0.143% | 0.000% | 0.000% | 1.1% (ltc/usdt) |
| okx | 6 | 2160 | 0.046% | 0.000% | 0.000% | 1.0% (ltc/usdt) |
| xt | 7 | 2170 | 0.092% | 0.000% | 0.000% | 1.6% (eth/usdt) |



#### W3@1m: observations more than 1% from the median, by pair and class

| pair | exchange-observations >1% from median | by exchange | timing / persistent / isolated |
|---|---|---|---|
| btc/usdt | 13 | kucoin 13 | 1 / 12 / 0 |
| eth/usdt | 33 | cryptocom 19, kucoin 11, binance 1, xt 1, kraken 1 | 7 / 23 / 3 |
| ltc/usdt | 9 | bitfinex 5, binance 1, okx 1, xt 1, kraken 1 | 1 / 0 / 8 |
| xmr/usdt | 2 | bitfinex 2 | 2 / 0 / 0 |
| ton/usdt | 201 | bitfinex 201 | 11 / 103 / 87 |

### G. Upper/lower bounds, 1-hour grid

| pair | configured / with candles | timestamps | cannot price @1% (upper / lower) | @2% | @2.5% |
|---|---|---|---|---|---|
| usdt/usd | 7 / 7 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| usdc/usd | 4 / 4 | 612 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| bnb/usdt | 8 / 8 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| sol/usdt | 10 / 10 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| ton/usd | 4 / 4 | 23 | 60.87% / 60.87% | 47.83% / 47.83% | 43.48% / 43.48% |
| btc/usdt | 11 / 11 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| sol/usd | 5 / 5 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| btc/usd | 7 / 7 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| eth/usdt | 11 / 11 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| ltc/usd | 4 / 4 | 684 | 0.44% / 0.44% | 0.00% / 0.00% | 0.00% / 0.00% |
| ltc/usdt | 10 / 10 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| usdc/usdt | 9 / 9 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| eth/usd | 7 / 7 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| trx/usdt | 6 / 6 | 720 | 0.83% / 0.83% | 0.00% / 0.00% | 0.00% / 0.00% |
| ton/usdt | 10 / 10 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
| xmr/usdt | 5 / 5 | 720 | 0.00% / 0.00% | 0.00% / 0.00% | 0.00% / 0.00% |
