// @ts-ignore
import { UMFutures } from "@binance/futures-connector";

export enum PositionMode {
  HEDGE_MODE = "true",
  ONE_WAY_MODE = "false",
}

export enum MultiAssetsMode {
  MULTI_ASSETS = "true",
  SINGLE_ASSET = "false",
}

export enum MarginType {
  ISOLATED = "ISOLATED",
  CROSSED = "CROSSED",
}

export enum BuySellSide {
  BUY = "BUY",
  SELL = "SELL",
}

export enum OrderType {
  LIMIT = "LIMIT",
  MARKET = "MARKET",
  STOP = "STOP",
  TAKE_PROFIT = "TAKE_PROFIT",
  STOP_MARKET = "STOP_MARKET",
  TAKE_PROFIT_MARKET = "TAKE_PROFIT_MARKET",
  TRAILING_STOP_MARKET = "TRAILING_STOP_MARKET",
}

export enum PositionSide {
  BOTH = "BOTH",
  LONG = "LONG",
  SHORT = "SHORT",
}

export interface NewOrderParams {
  symbol: string;
  side: BuySellSide;
  positionSide: PositionSide;
  type: OrderType;
  timeInForce?: "GTC" | "IOC" | "FOK" | "GTD";
  quantity?: number;
  reduceOnly?: boolean;
  price?: number;
  newClientOrderId?: string;
  stopPrice?: number;
  closePosition?: boolean;
  activationPrice?: number;
  callbackRate?: number;
  workingType?: "MARK_PRICE" | "CONTRACT_PRICE";
  priceProtect?: boolean;
  newOrderRespType?: "ACK" | "RESULT";
  priceMatch?:
    | "OPPONENT"
    | "OPPONENT_5"
    | "OPPONENT_10"
    | "OPPONENT_20"
    | "QUEUE"
    | "QUEUE_5"
    | "QUEUE_10"
    | "QUEUE_20";
  selfTradePreventionMode?:
    | "NONE"
    | "EXPIRE_TAKER"
    | "EXPIRE_MAKER"
    | "EXPIRE_BOTH";
  goodTillDate?: number;
  recvWindow?: number;
  timestamp?: number;
}

export interface Order extends Record<string, any> {}

// Exchange info
export type RateLimit = {
  rateLimitType: string;
  interval: string;
  intervalNum: number;
  limit: number;
};

export type Asset = {
  asset: string;
  marginAvailable: boolean;
  autoAssetExchange: string;
};

export type Filter = {
  filterType: string;
  maxPrice?: string;
  minPrice?: string;
  tickSize?: string;
  maxQty?: string;
  minQty?: string;
  stepSize?: string;
  limit?: number;
  notional?: string;
  multiplierDown?: string;
  multiplierUp?: string;
  multiplierDecimal?: string;
};

export type Symbol = {
  symbol: string;
  pair: string;
  contractType: string;
  deliveryDate: number;
  onboardDate: number;
  status: string;
  maintMarginPercent: string;
  requiredMarginPercent: string;
  baseAsset: string;
  quoteAsset: string;
  marginAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  baseAssetPrecision: number;
  quotePrecision: number;
  underlyingType: string;
  underlyingSubType: string[];
  triggerProtect: string;
  liquidationFee: string;
  marketTakeBound: string;
  maxMoveOrderLimit: number;
  filters: Filter[];
  orderTypes: string[];
  timeInForce: string[];
};

export type ExchangeInfo = {
  timezone: string;
  serverTime: number;
  futuresType: string;
  rateLimits: RateLimit[];
  exchangeFilters: any[];
  assets: Asset[];
  symbols: Symbol[];
};

const { BINANCE_API_KEY, BINANCE_API_SECRET } = process.env;
const client: UMFutures = new UMFutures(
  BINANCE_API_KEY || "",
  BINANCE_API_SECRET || "",
);

export async function getExchangeInfo(): Promise<ExchangeInfo> {
  const res = await client.getExchangeInfo();
  return res?.data ?? {};
}

export async function getMarketPrice(symbol: string): Promise<number> {
  const res = await client.getPremiumIndex(symbol);
  return parseFloat(res?.data?.markPrice ?? "0");
}

export async function prepareTradingEnvironment(
  symbol: string,
  leverage: number,
): Promise<void> {
  // Position mode: HEDGE_MODE
  try {
    await client.changePositionMode(PositionMode.HEDGE_MODE);
  } catch (err: any) {
    // Error code -4059 indicates that the position mode is already set to HEDGE_MODE
    if (err?.response?.data?.code !== -4059) {
      console.log("Error changing position mode:", err);
      throw err;
    }
  }

  // Multi-assets mode: SINGLE_ASSET
  try {
    await client.changeMultiAssetsMode(MultiAssetsMode.SINGLE_ASSET);
  } catch (err: any) {
    // Error code -4171 indicates that the multi-assets mode is already set to SINGLE_ASSET
    if (err?.response?.data?.code !== -4171) {
      throw err;
    }
  }

  // Margin type: ISOLATED
  try {
    await client.changeMarginType(symbol, MarginType.ISOLATED);
  } catch (err: any) {
    // Error code -4046 indicates that the margin type is already set to ISOLATED
    if (err?.response?.data?.code !== -4046) {
      throw err;
    }
  }

  await client.changeInitialLeverage(symbol, leverage);
}

export async function placeMultipleOrders(
  orderParamsList: NewOrderParams[],
): Promise<Order[]> {
  if (!Array.isArray(orderParamsList) || orderParamsList.length === 0) {
    throw new Error("No order parameters provided");
  }

  const BATCH_SIZE = 5;
  const allResults: Order[] = [];

  for (let i = 0; i < orderParamsList.length; i += BATCH_SIZE) {
    const batch = orderParamsList.slice(i, i + BATCH_SIZE);

    const orderParamsPayload = JSON.stringify(
      batch.map((op) => serializePayloadValues(op)),
    );

    const res = await client.placeMultipleOrders(orderParamsPayload);

    if (
      Array.isArray(res?.data) &&
      res?.data?.length > 0 &&
      res?.data?.every((o: Record<string, any>) => o.orderId)
    ) {
      allResults.push(...res.data);
    } else {
      throw new Error(
        `Placing multiple orders failure in batch ${i / BATCH_SIZE + 1}.` +
          ` Response:\n${res?.data ? JSON.stringify(res?.data, null, 2) : res?.data}`,
      );
    }
  }

  return allResults;
}

function serializePayloadValues(
  payload: Record<string, any>,
): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "number" || typeof value === "boolean") {
      result[key] = value.toString();
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "object"
          ? serializePayloadValues(item)
          : typeof item === "number" || typeof item === "boolean"
            ? item.toString()
            : item,
      );
    } else if (typeof value === "object" && value !== null) {
      result[key] = serializePayloadValues(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
