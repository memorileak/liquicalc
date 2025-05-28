import { writeFile, readFile } from "node:fs/promises";

import {
  addPercentage,
  subtractPercentage,
} from "./libnumber";

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

export type RiskBracket = {
  bracketSeq: number;
  bracketNotionalFloor: number;
  bracketNotionalCap: number;
  bracketMaintenanceMarginRate: number;
  cumFastMaintenanceAmount: number;
  minOpenPosLeverage: number;
  maxOpenPosLeverage: number;
};

export type SymbolRiskBracketInfo = {
  symbol: string;
  updateTime: number;
  notionalLimit: number;
  riskBrackets: RiskBracket[];
};

export enum TradingMode {
  LONG = "LONG",
  SHORT = "SHORT",
}

export type LiquidationPriceConfig = {
  tradingPair: string;
  mode: TradingMode;
  leverage: number;
  priceDeviationPercent: number;
  priceDeviationMultiplier: number;
  orderSizeMultiplier: number;
  initialEntryPrice: number;
  initialMargin: number;
};

export type PositionSnapshot = {
  entryPrice: number;
  orderSizeQuote: number; // For example: USDT
  orderSizeBase: number; // For example: BTC
  avgEntryPrice: number;
  liquidationPrice: number;
  totalInvesment: number;
  divergence: number; // Difference between entryPrice and avgEntryPrice in %
  difference: number; // Difference between initialEntryPrice and entryPrice in %
};

export async function fetchMaintenanceMarginRates(): Promise<void> {
  const response = await fetch(
    "https://www.binance.com/bapi/futures/v1/friendly/future/common/brackets",
    {
      headers: {
        "content-type": "application/json",
      },
      body: "{}",
      method: "POST",
    }
  );
  const data = await response.json();

  if (!response.ok) {
    console.error("Failed to fetch maintenance margin rates");
    return;
  }

  const brackets = data.data?.brackets ?? [];

  await writeFile(MAINTENANCE_MARGIN_RATE_FILE_PATH, JSON.stringify(brackets));
  console.log(
    `Maintenance margin rates saved to ${MAINTENANCE_MARGIN_RATE_FILE_PATH}`
  );
}

export async function calculateLiquidationPrices(
  config: LiquidationPriceConfig
): Promise<PositionSnapshot[]> {
  if (config.mode !== TradingMode.LONG && config.mode !== TradingMode.SHORT) {
    config.mode = TradingMode.LONG;
  }

  const {
    tradingPair,
    mode,
    leverage,
    priceDeviationPercent,
    priceDeviationMultiplier,
    orderSizeMultiplier,
    initialEntryPrice,
    initialMargin,
  } = config;

  const calculatingResults: PositionSnapshot[] = [];

  const symbolRiskBracketInfo: SymbolRiskBracketInfo = JSON.parse(
    await readFile(MAINTENANCE_MARGIN_RATE_FILE_PATH, "utf-8")
  ).find((bracket: SymbolRiskBracketInfo) => bracket.symbol === tradingPair);

  if (!symbolRiskBracketInfo) {
    throw new Error(
      `No risk bracket info found for trading pair: ${tradingPair}`
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

  let previousMarketPrice = 0;
  let liquidationPrice = -1;
  let totalDeviation = 0;

  for (let i = 0; i < 50; i += 1) {
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
      // Store the previous market price before updating
      previousMarketPrice = marketPrice;

      const deviationPercentThisRound =
        priceDeviationPercent *
        (priceDeviationMultiplier !== 1
          ? Math.pow(priceDeviationMultiplier, i - 1)
          : 1);
      totalDeviation = totalDeviation + deviationPercentThisRound;

      // Apply the deviation to the initial entry price
      marketPrice =
        mode === TradingMode.LONG
          ? subtractPercentage(initialEntryPrice, totalDeviation)
          : addPercentage(initialEntryPrice, totalDeviation);

      // Calculate loss based on the price movement from previous to current price
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

    if (marketPrice <= 0) {
      break;
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
        positionNotionalValue < bracket?.bracketNotionalCap
    );

    if (!riskBracket) {
      console.error(
        `No risk bracket found for position notional value: ${positionNotionalValue}. Perhaps the position is too large.`
      );
      break;
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

    const difference =
      (Math.abs(initialEntryPrice - marketPrice) / initialEntryPrice) * 100;
    const divergence =
      (Math.abs(marketPrice - averageEntryPrice) / marketPrice) * 100;

    calculatingResults.push({
      entryPrice: marketPrice,
      orderSizeQuote: marginToAdd,
      orderSizeBase: assetSizeToAdd,
      avgEntryPrice: averageEntryPrice,
      liquidationPrice: liquidationPrice,
      totalInvesment: totalActualInvesment,
      divergence: divergence,
      difference: difference,
    });
  }

  return calculatingResults;
}