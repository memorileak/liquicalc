import commandLineArgs from "command-line-args";

import { roundDown, round } from "./libs/libnumber";
import {
  getExchangeInfo,
  prepareTradingEnvironment,
  placeMultipleOrders,
  getMarketPrice,
  OrderType,
  BuySellSide,
  PositionSide,
  NewOrderParams,
} from "./libs/libbinance";
import {
  calculateLiquidationPrices,
  fetchMaintenanceMarginRates,
  PositionSnapshot,
  TradingMode,
} from "./libs/libliqui";

// Variable references:
// - Leverage: Leverage ratio used for trading
// - PriceDeviationPercent: Percentage decrease in price between orders
// - OrderSizeMultiplier: Multiplier for increasing order size
// - EntryPrice: Price at which an order is executed
// - PositionSize: Quantity of the asset being traded
// - Margin: Total capital allocated (unleveraged)
// - MaintenanceMargin: Minimum margin required to keep position open
// - MaintenanceMarginRate: Rate used to calculate maintenance margin
// - LiquidationPrice: Price at which position gets liquidated

// Formula for calculating liquidation prices:
//
// LONG:
// Liquidation = AverageEntryPrice - (Margin - MaintenanceMargin) / PositionAssetSize;
//
// SHORT:
// Liquidation = AverageEntryPrice + (Margin - MaintenanceMargin) / PositionAssetSize;
//
// Calculate MaintenanceMargin:
// MaintenanceMargin = MarketPrice * PositionAssetSize * MaintenanceMarginRate - MaintenanceAmount;

const HELP_MSG = `Usage: node dist/liquicalc.js [OPTIONS]

Options:
  -t, --tradepair   Trading pair symbol (e.g., BTCUSDT) (REQUIRED)
  -l, --leverage    Leverage ratio (default: 1)
  -d, --deviation   Price deviation percent between orders (default: 5)
  -p, --dvimult     Price deviation multiplier (default: 1)
  -x, --sizemult    Order size multiplier (default: 1)
  -e, --entryprice  Entry price (optional, will use current market price if not provided)
  -i, --initmargin  Initial margin (REQUIRED)
  -r, --reload      Reload maintenance margin rates from Binance API
  --apply           Apply calculations to create orders on Binance (default: false)
  -h, --help        Show this help message`;

type IndexedPositionSnapshot = PositionSnapshot & {
  index: number;
};

function reverseArray<T>(arr: T[]): T[] {
  const reversed: T[] = [];
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    reversed.push(arr[i]);
  }
  return reversed;
}

function mergeTwoArraysAlternatively<T>(arr1: T[], arr2: T[]): T[] {
  const result: T[] = [];
  const maxLength = Math.max(arr1.length, arr2.length);
  for (let i = 0; i < maxLength; i++) {
    if (i < arr1.length) {
      result.push(arr1[i]);
    }
    if (i < arr2.length) {
      result.push(arr2[i]);
    }
  }
  return result;
}

async function main() {
  const optionDefinitions = [
    { name: "tradepair", alias: "t", type: String },
    { name: "leverage", alias: "l", type: Number, defaultValue: 1 },
    { name: "deviation", alias: "d", type: Number, defaultValue: 5 },
    { name: "dvimult", alias: "p", type: Number, defaultValue: 1 },
    { name: "sizemult", alias: "x", type: Number, defaultValue: 1 },
    { name: "entryprice", alias: "e", type: Number },
    { name: "initmargin", alias: "i", type: Number },
    { name: "reload", alias: "r", type: Boolean, defaultValue: false },
    { name: "apply", type: Boolean, defaultValue: false },
    { name: "help", alias: "h", type: Boolean, defaultValue: false },
  ];

  const options = commandLineArgs(optionDefinitions);

  if (options.help || !options.tradepair || !options.initmargin) {
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

  // Reload maintenance margin rates from Binance
  if (options.reload) {
    await fetchMaintenanceMarginRates();
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

  // Get current market price if entry price wasn't provided
  let entryPrice = options.entryprice;
  if (!entryPrice) {
    try {
      entryPrice = await getMarketPrice(options.tradepair);
    } catch (error) {
      console.error("Failed to fetch current market price:", error);
      console.log("Please provide an entry price using -e or --entryprice");
      return;
    }
  }

  const priceFilter = symbolInfo?.filters.find(
    (filter) => filter.filterType === "PRICE_FILTER"
  );
  const tickSize = parseFloat(priceFilter?.tickSize ?? "0.1");

  // Tick size awareness price precision
  const pricePrecision = Math.log10(1 / tickSize);
  const quantityPrecision = symbolInfo?.quantityPrecision ?? 0;

  let twoSidesResults: IndexedPositionSnapshot[][] = [];
  for (const mode of [TradingMode.SHORT, TradingMode.LONG]) {
    const config = {
      tradingPair: options.tradepair,
      mode: mode,
      leverage: options.leverage,
      priceDeviationPercent: options.deviation,
      priceDeviationMultiplier: options.dvimult,
      orderSizeMultiplier: options.sizemult,
      initialEntryPrice: entryPrice,
      initialMargin: options.initmargin,
    };

    const oneSideResults = await calculateLiquidationPrices(config);

    const indexedOneSideResults: IndexedPositionSnapshot[] = oneSideResults.map(
      (r, i) => ({
        index: mode === TradingMode.SHORT ? i + 1 : -i - 1,
        ...r,
      })
    );

    twoSidesResults.push(indexedOneSideResults);
  }

  const shortResults = twoSidesResults?.[0] ?? [];
  const longResults = twoSidesResults?.[1] ?? [];

  // The Array.prototype.reverse() method can't be used here because it modifies the original array
  const results = reverseArray(shortResults).concat(longResults);

  // Print results in a pretty table format
  console.log("");
  console.table(
    results.map((result) => ({
      "Order #": result.index,
      "Order Size": result.orderSizeQuote.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      Diff: result.difference.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      "Entry Price": result.entryPrice.toLocaleString(undefined, {
        minimumFractionDigits: pricePrecision,
        maximumFractionDigits: pricePrecision,
      }),
      "Avg Entry": result.avgEntryPrice.toLocaleString(undefined, {
        minimumFractionDigits: pricePrecision,
        maximumFractionDigits: pricePrecision,
      }),
      Divergence: result.divergence.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      Liquidation: result.liquidationPrice.toLocaleString(undefined, {
        minimumFractionDigits: pricePrecision,
        maximumFractionDigits: pricePrecision,
      }),
      "Total Investment": result.totalInvesment.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    }))
  );

  if (options.apply) {
    const readline = require("node:readline").createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const orderCount = await new Promise<number>((resolve) => {
      readline.question(
        "\nHow many orders ON EACH SIDE do you want to place? (default: 5): ",
        (input: string) => {
          resolve(input ? parseInt(input, 10) : 5);
        }
      );
    });

    if (!Number.isFinite(orderCount) || orderCount <= 0) {
      console.error("Invalid number of orders. Exiting.");
      readline.close();
      return;
    }

    const selectedShortResults = shortResults.slice(0, orderCount);
    const selectedLongResults = longResults.slice(0, orderCount);

    // The Array.prototype.reverse() method can't be used here because it modifies the original array
    const resultsForPreviewingOrders =
      reverseArray(selectedShortResults).concat(selectedLongResults);

    console.log("\nThese orders are about to be placed:\n");
    console.table(
      resultsForPreviewingOrders.map((result) => ({
        "Order #": result.index,
        Mode: result.index > 0 ? TradingMode.SHORT : TradingMode.LONG,
        Side: result.index > 0 ? BuySellSide.SELL : BuySellSide.BUY,
        Type: OrderType.LIMIT,
        Price: result.entryPrice.toLocaleString(undefined, {
          minimumFractionDigits: pricePrecision,
          maximumFractionDigits: pricePrecision,
        }),
        "Order Size": result.orderSizeQuote.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
        Quantity: roundDown(
          result.orderSizeBase,
          quantityPrecision
        ).toLocaleString(undefined, {
          minimumFractionDigits: quantityPrecision,
          maximumFractionDigits: quantityPrecision,
        }),
      }))
    );

    const answer = await new Promise<string>((resolve) => {
      readline.question(
        '\nAre you sure you want to place those orders? Type "yes" to confirm: ',
        (input: string) => {
          resolve(input);
        }
      );
    });

    readline.close();

    if (answer !== "yes") {
      console.log("Order placement cancelled.");
      return;
    }

    const resultsForCreatingOrders = mergeTwoArraysAlternatively(
      selectedShortResults,
      selectedLongResults
    );

    const orderParamsList: NewOrderParams[] = resultsForCreatingOrders.map(
      (result) => ({
        symbol: options.tradepair,
        type: OrderType.LIMIT,
        price: round(result.entryPrice, pricePrecision),
        quantity: roundDown(result.orderSizeBase, quantityPrecision),
        timeInForce: "GTC",
        side: result.index > 0 ? BuySellSide.SELL : BuySellSide.BUY,
        positionSide: result.index > 0 ? PositionSide.SHORT : PositionSide.LONG,
      })
    );

    try {
      await prepareTradingEnvironment(options.tradepair, options.leverage);
      const orders = await placeMultipleOrders(orderParamsList);
      console.log("Orders placed successfully:", orders.length);
    } catch (error) {
      console.error("Error placing orders:", error);
    }
  }
}

main();
