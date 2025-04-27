import { writeFile, readFile } from "node:fs/promises";
import commandLineArgs from "command-line-args";

import {
  addPercentage,
  subtractPercentage,
  roundDown,
  round,
} from "./numberlib";
import {
  getExchangeInfo,
  placeMultipleOrders,
  OrderType,
  BuySellSide,
  PositionSide,
  NewOrderParams,
} from "./binancelib";

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

const MAINTENANCE_MARGIN_RATE_FILE_PATH = `${process.cwd()}/data/maintenance-margin-rates.json`;

const HELP_MSG = `Usage: node dist/liquicalc.js [OPTIONS]

Options:
  -t, --tradepair   Trading pair symbol (e.g., BTCUSDT) (REQUIRED)
  -s, --short       Use SHORT mode (default: LONG if not specified)
  -l, --leverage    Leverage ratio (default: 1)
  -d, --deviation   Price deviation percent between orders (default: 5)
  -x, --sizemult    Order size multiplier (default: 1)
  -e, --entryprice  Entry price (REQUIRED)
  -i, --initmargin  Initial margin (REQUIRED)
  -r, --reload      Reload maintenance margin rates from Binance API
  --apply           Apply calculations to create orders on Binance (default: false)
  -h, --help        Show this help message`;

type RiskBracket = {
  bracketSeq: number;
  bracketNotionalFloor: number;
  bracketNotionalCap: number;
  bracketMaintenanceMarginRate: number;
  cumFastMaintenanceAmount: number;
  minOpenPosLeverage: number;
  maxOpenPosLeverage: number;
};

type SymbolRiskBracketInfo = {
  symbol: string;
  updateTime: number;
  notionalLimit: number;
  riskBrackets: RiskBracket[];
};

enum TradingMode {
  LONG = "LONG",
  SHORT = "SHORT",
}

type LiquidationPriceConfig = {
  tradingPair: string;
  mode: TradingMode;
  leverage: number;
  priceDeviationPercent: number;
  orderSizeMultiplier: number;
  initialEntryPrice: number;
  initialMargin: number;
};

type PositionSnapshot = {
  entryPrice: number;
  orderSizeQuote: number; // For example: USDT
  orderSizeBase: number; // For example: BTC
  avgEntryPrice: number;
  liquidationPrice: number;
  totalInvesment: number;
};

async function fetchMaintenanceMarginRates(): Promise<void> {
  const response = await fetch(
    "https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets",
    {
      headers: {
        "content-type": "application/json",
      },
      body: "{}",
      method: "POST",
    },
  );
  const data = await response.json();

  if (!response.ok) {
    console.error("Failed to fetch maintenance margin rates");
    return;
  }

  const brackets = data.data?.brackets ?? [];

  await writeFile(MAINTENANCE_MARGIN_RATE_FILE_PATH, JSON.stringify(brackets));
  console.log(
    `Maintenance margin rates saved to ${MAINTENANCE_MARGIN_RATE_FILE_PATH}`,
  );
}

async function calculateLiquidationPrices(
  config: LiquidationPriceConfig,
): Promise<PositionSnapshot[]> {
  if (config.mode !== TradingMode.LONG && config.mode !== TradingMode.SHORT) {
    config.mode = TradingMode.LONG;
  }

  const {
    tradingPair,
    mode,
    leverage,
    priceDeviationPercent,
    orderSizeMultiplier,
    initialEntryPrice,
    initialMargin,
  } = config;

  const calculatingResults: PositionSnapshot[] = [];

  const symbolRiskBracketInfo: SymbolRiskBracketInfo = JSON.parse(
    await readFile(MAINTENANCE_MARGIN_RATE_FILE_PATH, "utf-8"),
  ).find((bracket: SymbolRiskBracketInfo) => bracket.symbol === tradingPair);

  if (!symbolRiskBracketInfo) {
    throw new Error(
      `No risk bracket info found for trading pair: ${tradingPair}`,
    );
  }

  let marketPrice = 0;
  let marginToAdd = 0;
  let assetSizeToAdd = 0;

  let margin = 0; // This margin changes through time and will reduce if there is a loss
  let positionAssetSize = 0;
  let averageEntryPrice = 0;
  let totalActualInvesment = 0;
  let totalLeveragedInvestment = 0;

  let liquidationPrice = -1;

  for (let i = 0; i < 20; i += 1) {
    if (i === 0) {
      marketPrice = initialEntryPrice;
      marginToAdd = initialMargin;
      margin = marginToAdd;
      totalActualInvesment = initialMargin;
      totalLeveragedInvestment = leverage * initialMargin;
      assetSizeToAdd = (leverage * initialMargin) / initialEntryPrice;
      positionAssetSize = assetSizeToAdd;
      averageEntryPrice = initialEntryPrice; // It's totalLeveragedInvestment / positionAssetSize
    } else {
      const previousMarketPrice = marketPrice;
      marketPrice =
        mode === TradingMode.LONG
          ? subtractPercentage(marketPrice, priceDeviationPercent)
          : addPercentage(marketPrice, priceDeviationPercent);
      const loss =
        mode === TradingMode.LONG
          ? (previousMarketPrice - marketPrice) * positionAssetSize
          : (marketPrice - previousMarketPrice) * positionAssetSize;
      marginToAdd = marginToAdd * orderSizeMultiplier;
      margin = margin - loss + marginToAdd;
      totalActualInvesment = totalActualInvesment + marginToAdd;
      totalLeveragedInvestment =
        totalLeveragedInvestment + leverage * marginToAdd;
      assetSizeToAdd = (leverage * marginToAdd) / marketPrice;
      positionAssetSize = positionAssetSize + assetSizeToAdd;
      averageEntryPrice = totalLeveragedInvestment / positionAssetSize;
    }

    if (
      liquidationPrice > 0 &&
      ((mode === TradingMode.LONG && marketPrice <= liquidationPrice) ||
        (mode === TradingMode.SHORT && marketPrice >= liquidationPrice))
    ) {
      break;
    }

    const positionNotionalValue = marketPrice * positionAssetSize;
    const riskBracket = symbolRiskBracketInfo.riskBrackets.find(
      (bracket: RiskBracket) =>
        positionNotionalValue >= bracket?.bracketNotionalFloor &&
        positionNotionalValue < bracket?.bracketNotionalCap,
    );

    if (!riskBracket) {
      throw new Error(
        `No risk bracket found for position notional value: ${positionNotionalValue}`,
      );
    }

    const maintenanceMarginRate =
      riskBracket?.bracketMaintenanceMarginRate ?? 0;
    const maintenanceAmount = riskBracket?.cumFastMaintenanceAmount ?? 0;

    const maintenanceMargin =
      positionNotionalValue * maintenanceMarginRate - maintenanceAmount;

    liquidationPrice =
      mode === TradingMode.LONG
        ? averageEntryPrice - (margin - maintenanceMargin) / positionAssetSize
        : averageEntryPrice + (margin - maintenanceMargin) / positionAssetSize;

    calculatingResults.push({
      entryPrice: marketPrice,
      orderSizeQuote: marginToAdd,
      orderSizeBase: assetSizeToAdd,
      avgEntryPrice: averageEntryPrice,
      liquidationPrice: liquidationPrice,
      totalInvesment: totalActualInvesment,
    });
  }

  return calculatingResults;
}

async function main() {
  const optionDefinitions = [
    { name: "tradepair", alias: "t", type: String },
    { name: "short", alias: "s", type: Boolean, defaultValue: false },
    { name: "leverage", alias: "l", type: Number, defaultValue: 1 },
    { name: "deviation", alias: "d", type: Number, defaultValue: 5 },
    { name: "sizemult", alias: "x", type: Number, defaultValue: 1 },
    { name: "entryprice", alias: "e", type: Number },
    { name: "initmargin", alias: "i", type: Number },
    { name: "reload", alias: "r", type: Boolean, defaultValue: false },
    { name: "apply", type: Boolean, defaultValue: false },
    { name: "help", alias: "h", type: Boolean, defaultValue: false },
  ];

  const options = commandLineArgs(optionDefinitions);

  if (
    options.help ||
    !options.tradepair ||
    !options.entryprice ||
    !options.initmargin
  ) {
    console.log(HELP_MSG);
    process.exit(options.help ? 0 : 1);
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
    (symInfo) => symInfo.symbol === options.tradepair,
  );
  if (!symbolInfo) {
    console.error(
      `Trading pair ${options.tradepair} not found in exchange info.`,
    );
    return;
  }

  const priceFilter = symbolInfo?.filters.find(
    (filter) => filter.filterType === "PRICE_FILTER",
  );
  const tickSize = parseFloat(priceFilter?.tickSize ?? "0.1");

  // Tick size awareness price precision
  const pricePrecision = Math.log10(1 / tickSize);
  const quantityPrecision = symbolInfo?.quantityPrecision ?? 0;

  const mode = options.short ? TradingMode.SHORT : TradingMode.LONG;

  const config = {
    tradingPair: options.tradepair,
    mode: mode,
    leverage: options.leverage,
    priceDeviationPercent: options.deviation,
    orderSizeMultiplier: options.sizemult,
    initialEntryPrice: options.entryprice,
    initialMargin: options.initmargin,
  };

  const results = await calculateLiquidationPrices(config);

  // Print results in a pretty table format
  console.table(
    results.map((result, index) => ({
      "Order #": index + 1,
      "Entry Price": result.entryPrice.toLocaleString(undefined, {
        minimumFractionDigits: pricePrecision,
        maximumFractionDigits: pricePrecision,
      }),
      "Order Size": result.orderSizeQuote.toLocaleString(undefined, {
        minimumFractionDigits: pricePrecision,
        maximumFractionDigits: pricePrecision,
      }),
      "Avg Entry": result.avgEntryPrice.toLocaleString(undefined, {
        minimumFractionDigits: pricePrecision,
        maximumFractionDigits: pricePrecision,
      }),
      Liquidation: result.liquidationPrice.toLocaleString(undefined, {
        minimumFractionDigits: pricePrecision,
        maximumFractionDigits: pricePrecision,
      }),
      "Total Investment": result.totalInvesment.toLocaleString(undefined, {
        minimumFractionDigits: pricePrecision,
        maximumFractionDigits: pricePrecision,
      }),
    })),
  );

  if (options.apply) {
    const readline = require("node:readline").createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const orderCount = await new Promise<number>((resolve) => {
      readline.question(
        "\nHow many orders do you want to place? (default: 5): ",
        (input: string) => {
          resolve(input ? parseInt(input, 10) : 5);
        },
      );
    });

    if (!Number.isFinite(orderCount) || orderCount <= 0) {
      console.error("Invalid number of orders. Exiting.");
      readline.close();
      return;
    }

    const resultsForCreatingOrders = results.slice(0, orderCount);

    console.log("\nThese orders are about to be placed:\n");
    console.table(
      resultsForCreatingOrders.map((result, index) => ({
        "Order #": index + 1,
        Mode: options.short ? TradingMode.SHORT : TradingMode.LONG,
        Side: options.short ? BuySellSide.SELL : BuySellSide.BUY,
        Type: OrderType.LIMIT,
        Price: result.entryPrice.toLocaleString(undefined, {
          minimumFractionDigits: pricePrecision,
          maximumFractionDigits: pricePrecision,
        }),
        "Order Size": result.orderSizeQuote.toLocaleString(undefined, {
          minimumFractionDigits: pricePrecision,
          maximumFractionDigits: pricePrecision,
        }),
        Quantity: roundDown(
          result.orderSizeBase,
          quantityPrecision,
        ).toLocaleString(undefined, {
          minimumFractionDigits: quantityPrecision,
          maximumFractionDigits: quantityPrecision,
        }),
      })),
    );

    const answer = await new Promise<string>((resolve) => {
      readline.question(
        '\nAre you sure you want to place those orders? Type "yes" to confirm: ',
        (input: string) => {
          resolve(input);
        },
      );
    });

    readline.close();

    if (answer !== "yes") {
      console.log("Order placement cancelled.");
      return;
    }

    const orderParamsList: NewOrderParams[] = resultsForCreatingOrders.map(
      (result) => ({
        symbol: options.tradepair,
        type: OrderType.LIMIT,
        price: round(result.entryPrice, pricePrecision),
        quantity: roundDown(result.orderSizeBase, quantityPrecision),
        timeInForce: "GTC",
        side: options.short ? BuySellSide.SELL : BuySellSide.BUY,
        positionSide: PositionSide.BOTH,
      }),
    );

    try {
      const orders = await placeMultipleOrders(orderParamsList);
      console.log("Orders placed successfully:", orders.length);
    } catch (error) {
      console.error("Error placing orders:", error);
    }
  }
}

main();
