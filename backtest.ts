import commandLineArgs from "command-line-args";

import {
  addPercentage,
  roundDown,
  roundUp,
  subtractPercentage,
} from "./libs/libnumber";
import { getExchangeInfo, getKlines, KlineInterval } from "./libs/libbinance";
import {
  calculateLiquidationPrices,
  fetchMaintenanceMarginRates,
  LiquidationPriceConfig,
  PositionSnapshot,
  TradingMode,
} from "./libs/libliqui";

// const HELP_MSG = `Usage: node dist/liquicalc.js [OPTIONS]

// Options:
//   -t, --tradepair   Trading pair symbol (e.g., BTCUSDT) (REQUIRED)
//   -l, --leverage    Leverage ratio (default: 1)
//   -d, --deviation   Price deviation percent between orders (default: 5)
//   -p, --dvimult     Price deviation multiplier (default: 1)
//   -x, --sizemult    Order size multiplier (default: 1)
//   -e, --entryprice  Entry price (optional, will use current market price if not provided)
//   -i, --initmargin  Initial margin (REQUIRED)
//   -r, --reload      Reload maintenance margin rates from Binance API
//   --apply           Apply calculations to create orders on Binance (default: false)
//   -h, --help        Show this help message`;

const HELP_MSG = `HELP_MSG`;

type PositionSnapshotWithTP = PositionSnapshot & {
  index: number; // Positive for short positions, negative for long positions
  takeProfitPrice: number;
};

type BacktestConfig = Omit<
  LiquidationPriceConfig,
  "mode" | "initialEntryPrice"
> & {
  maxOrdersPerSide: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  klines: Array<[number, string, string, string, string]>; // [time, open, high, low, close]
  pricePrecision: number;
};

type BacktestEvent = {
  time: number;
  stateTransitionFrom: number;
  stateTransitionTo: number;
  endResult?: "PROFIT" | "LOSS";
};

async function calculatePositionsBothSides(
  config: Omit<LiquidationPriceConfig, "mode"> & {
    maxOrdersPerSide: number;
    takeProfitPercent: number;
    stopLossPercent: number;
  }
): Promise<{
  longPositions: PositionSnapshotWithTP[];
  shortPositions: PositionSnapshotWithTP[];
  longStopLossPrice: number;
  shortStopLossPrice: number;
}> {
  const longPositions = (
    await calculateLiquidationPrices({
      ...config,
      mode: TradingMode.LONG,
    })
  )
    .slice(0, config.maxOrdersPerSide)
    .map((r, i) => ({
      ...r,
      index: -i - 1, // Negative index for long positions
      takeProfitPrice: addPercentage(r.avgEntryPrice, config.takeProfitPercent),
    }));

  const longStopLossPrice = subtractPercentage(
    longPositions[longPositions.length - 1]?.avgEntryPrice,
    config.stopLossPercent
  );

  const shortPositions = (
    await calculateLiquidationPrices({
      ...config,
      mode: TradingMode.SHORT,
    })
  )
    .slice(0, config.maxOrdersPerSide)
    .map((r, i) => ({
      ...r,
      index: i + 1, // Positive index for short positions
      takeProfitPrice: subtractPercentage(
        r.avgEntryPrice,
        config.takeProfitPercent
      ),
    }));

  const shortStopLossPrice = addPercentage(
    shortPositions[shortPositions.length - 1]?.avgEntryPrice,
    config.stopLossPercent
  );

  return {
    longPositions,
    shortPositions,
    longStopLossPrice,
    shortStopLossPrice,
  };
}

async function backtest(
  backtestConfig: BacktestConfig
): Promise<BacktestEvent[]> {
  const events: BacktestEvent[] = [];
  const { klines, pricePrecision, ...liquiConfig } = backtestConfig;
  let state = 0;

  let initialEntryPrice = parseFloat(klines?.[0]?.[1]) ?? null;
  if (!initialEntryPrice) {
    console.error("Failed to get entry price from klines data");
    return [];
  }

  // Calculate positions for both sides
  let longPositions: PositionSnapshotWithTP[] = [];
  let shortPositions: PositionSnapshotWithTP[] = [];
  let longStopLossPrice = 0;
  let shortStopLossPrice = 0;
  const calculatePositions = async (entryPrice: number) => {
    const result = await calculatePositionsBothSides({
      ...liquiConfig,
      initialEntryPrice: entryPrice,
    });
    longPositions = result.longPositions;
    shortPositions = result.shortPositions;
    longStopLossPrice = result.longStopLossPrice;
    shortStopLossPrice = result.shortStopLossPrice;
  };

  await calculatePositions(initialEntryPrice);

  // Loop through klines
  for (const kline of backtestConfig.klines ?? []) {
    const [time, openStr, highStr, lowStr, closeStr] = kline;
    const open = parseFloat(openStr);
    const high = parseFloat(highStr);
    const low = parseFloat(lowStr);
    const close = parseFloat(closeStr);
    const isGreen = close >= open;
    const priceMovement = isGreen
      ? [open, low, high, close]
      : [open, high, low, close];

    for (const price of priceMovement) {
      if (state === 0) {
        // LONG_DOMINATED next order
        if (price <= roundDown(longPositions[1].entryPrice, pricePrecision)) {
          events.push({
            time,
            stateTransitionFrom: state,
            stateTransitionTo: -2,
          });
          state = -2;
        }

        // SHORT_DOMINATED next order
        else if (
          price >= roundUp(shortPositions[1].entryPrice, pricePrecision)
        ) {
          events.push({
            time,
            stateTransitionFrom: state,
            stateTransitionTo: 2,
          });
          state = 2;
        }
      }

      if (
        2 <= Math.abs(state) &&
        Math.abs(state) < liquiConfig.maxOrdersPerSide
      ) {
        // LONG_DOMINATED next order
        if (
          state < 0 &&
          price <=
            roundDown(longPositions[Math.abs(state)].entryPrice, pricePrecision)
        ) {
          events.push({
            time,
            stateTransitionFrom: state,
            stateTransitionTo: state - 1,
          });
          state = state - 1;
        }

        // LONG_DOMINATED take profit
        else if (
          state < 0 &&
          price >=
            roundUp(
              longPositions[Math.abs(state) - 1].takeProfitPrice,
              pricePrecision
            )
        ) {
          events.push({
            time,
            stateTransitionFrom: state,
            stateTransitionTo: 0,
            endResult: "PROFIT",
          });
          initialEntryPrice = roundUp(
            longPositions[Math.abs(state) - 1].takeProfitPrice,
            pricePrecision
          );
          await calculatePositions(initialEntryPrice);
          state = 0;
        }

        // SHORT_DOMINATED next order
        else if (
          state > 0 &&
          price >=
            roundUp(shortPositions[Math.abs(state)].entryPrice, pricePrecision)
        ) {
          events.push({
            time,
            stateTransitionFrom: state,
            stateTransitionTo: state + 1,
          });
          state = state + 1;
        }

        // SHORT_DOMINATED take profit
        else if (
          state > 0 &&
          price <=
            roundDown(
              shortPositions[Math.abs(state) - 1].takeProfitPrice,
              pricePrecision
            )
        ) {
          events.push({
            time,
            stateTransitionFrom: state,
            stateTransitionTo: 0,
            endResult: "PROFIT",
          });
          initialEntryPrice = roundDown(
            shortPositions[Math.abs(state) - 1].takeProfitPrice,
            pricePrecision
          );
          await calculatePositions(initialEntryPrice);
          state = 0;
        }
      }

      if (Math.abs(state) === liquiConfig.maxOrdersPerSide) {
        // LONG_DOMINATED stop loss
        if (
          state < 0 &&
          price <= roundDown(longStopLossPrice, pricePrecision)
        ) {
          events.push({
            time,
            stateTransitionFrom: state,
            stateTransitionTo: 0,
            endResult: "LOSS",
          });
          initialEntryPrice = roundDown(longStopLossPrice, pricePrecision);
          await calculatePositions(initialEntryPrice);
          state = 0;
        }

        // LONG_DOMINATED take profit
        else if (
          state < 0 &&
          price >=
            roundUp(
              longPositions[Math.abs(state) - 1].takeProfitPrice,
              pricePrecision
            )
        ) {
          events.push({
            time,
            stateTransitionFrom: state,
            stateTransitionTo: 0,
            endResult: "PROFIT",
          });
          initialEntryPrice = roundUp(
            longPositions[Math.abs(state) - 1].takeProfitPrice,
            pricePrecision
          );
          await calculatePositions(initialEntryPrice);
          state = 0;
        }

        // SHORT_DOMINATED stop loss
        else if (
          state > 0 &&
          price >= roundUp(shortStopLossPrice, pricePrecision)
        ) {
          events.push({
            time,
            stateTransitionFrom: state,
            stateTransitionTo: 0,
            endResult: "LOSS",
          });
          initialEntryPrice = roundUp(shortStopLossPrice, pricePrecision);
          await calculatePositions(initialEntryPrice);
          state = 0;
        }

        // SHORT_DOMINATED take profit
        else if (
          state > 0 &&
          price <=
            roundDown(
              shortPositions[Math.abs(state) - 1].takeProfitPrice,
              pricePrecision
            )
        ) {
          events.push({
            time,
            stateTransitionFrom: state,
            stateTransitionTo: 0,
            endResult: "PROFIT",
          });
          initialEntryPrice = roundDown(
            shortPositions[Math.abs(state) - 1].takeProfitPrice,
            pricePrecision
          );
          await calculatePositions(initialEntryPrice);
          state = 0;
        }
      }
    }
  }

  return events;
}

async function main() {
  {
    const optionDefinitions = [
      { name: "tradepair", alias: "t", type: String },
      { name: "leverage", alias: "l", type: Number, defaultValue: 1 },
      { name: "deviation", alias: "d", type: Number, defaultValue: 5 },
      { name: "dvimult", alias: "p", type: Number, defaultValue: 1 },
      { name: "sizemult", alias: "x", type: Number, defaultValue: 1 },
      { name: "orders", alias: "o", type: Number, defaultValue: 5 },
      { name: "stoploss", alias: "s", type: Number, defaultValue: 5 },
      { name: "takeprofit", alias: "k", type: Number, defaultValue: 1 },
      {
        name: "interval",
        alias: "i",
        type: String,
        defaultValue: KlineInterval._1h,
      },
      { name: "initmargin", alias: "m", type: Number, defaultValue: 12 },
      { name: "help", alias: "h", type: Boolean, defaultValue: false },
    ];

    const options = commandLineArgs(optionDefinitions);

    if (options.help || !options.tradepair) {
      console.log(HELP_MSG);
      process.exit(options.help ? 0 : 1);
    }

    if (
      !Number.isInteger(options.leverage) ||
      options.leverage < 1 ||
      options.leverage > 125
    ) {
      console.error("Leverage must be an integer between 1 and 125");
      return;
    }

    try {
      await fetchMaintenanceMarginRates();
    } catch (error) {
      console.error("Failed to fetch maintenance margin rates:", error);
    }

    // Get exchange info from Binance
    // Including price precision and quantity precision
    const exchangeInfo = await getExchangeInfo();
    if (!exchangeInfo) {
      console.error("Failed to fetch exchange info");
      return;
    }

    const symbolInfo = (exchangeInfo?.symbols ?? []).find(
      (symInfo) => symInfo.symbol === options.tradepair
    );
    if (!symbolInfo) {
      console.error(
        `Trading pair ${options.tradepair} not found in exchange info.`
      );
      return;
    }

    let klines = [];
    try {
      klines = await getKlines({
        symbol: options.tradepair,
        interval: options.interval,
        limit: 1000,
      });
    } catch (error) {
      console.error("Error getting klines:", error);
      return;
    }

    let entryPrice = parseFloat(klines?.[0]?.[1]) ?? null;
    if (!entryPrice) {
      console.error("Failed to get entry price from klines data");
      return;
    }

    // const priceFilter = symbolInfo?.filters.find(
    //   (filter) => filter.filterType === "PRICE_FILTER"
    // );
    // const tickSize = parseFloat(priceFilter?.tickSize ?? "0.1");

    // const pricePrecision = Math.log10(1 / tickSize);
    // const quantityPrecision = symbolInfo?.quantityPrecision ?? 0;
    const pricePrecision = symbolInfo?.pricePrecision ?? 0;

    const backtestConfig: BacktestConfig = {
      tradingPair: options.tradepair,
      leverage: options.leverage,
      priceDeviationPercent: options.deviation,
      priceDeviationMultiplier: options.dvimult,
      orderSizeMultiplier: options.sizemult,
      initialMargin: options.initmargin,
      maxOrdersPerSide: options.orders,
      takeProfitPercent: options.takeprofit,
      stopLossPercent: options.stoploss,
      klines,
      pricePrecision,
    };

    const backtestEvents = await backtest(backtestConfig);
    console.table(
      backtestEvents.map((event) => {
        const stateFrom = event.stateTransitionFrom.toString().padStart(2, " ");
        const stateTo = event.stateTransitionTo.toString().padStart(2, " ");
        const date = new Date(event.time);

        // Format the date as DD/MM/YYYY HH:mm:ss with local timezone
        const formattedDate =
          date.toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
          }) +
          " " +
          date.toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          });

        const logEntry: Record<string, string> = {
          Time: formattedDate,
          "State Transition": `${stateFrom} -> ${stateTo}`,
        };

        if (event.endResult) {
          logEntry[
            "End Result"
          ] = `${event.endResult} (${event.stateTransitionFrom})`;
        }

        return logEntry;
      })
    );

    // Group backtest events by endResult then by stateTransitionFrom
    const groupedEvents = backtestEvents.reduce(
      (acc: Record<string, any>, event) => {
        const key = `${event.endResult ?? "ONGOING"} (${
          event.stateTransitionFrom
        })`;
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(event);
        return acc;
      },
      {}
    );

    // Print out only the number of events for TAKE_PROFIT and LOSS
    console.log("\n===== SUMMARY =====");
    for (const [key, events] of Object.entries(groupedEvents).sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      if (key.startsWith("PROFIT") || key.startsWith("LOSS")) {
        console.log(`${key}:\t${events.length}`);
      }
    }
  }
}

main();
