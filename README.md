# Crypto Trading Tools

A collection of TypeScript utilities for cryptocurrency trading on Binance Futures, with a focus on liquidation price calculation and order placement.

## Features

- **Liquidation Price Calculator**: Calculate liquidation prices for long/short positions
- **Order Placement**: Generate and place multiple orders with customizable parameters
- **Risk Management**: Analyze maintenance margin rates and risk brackets
- **Interactive Mode**: Confirm order placement with safety prompts

## Installation

```bash
# Install dependencies
pnpm install

# Build the project
pnpm build
```

## Usage

### Liquidation Price Calculator

Calculate liquidation prices for a trading position:

```bash
node dist/liquicalc.js -t BTCUSDT -e 60000 -i 1000
```

#### Options:

- `-t, --tradepair`: Trading pair (e.g., BTCUSDT)
- `-s, --short`: Use short mode (default: false)
- `-l, --leverage`: Leverage multiplier (default: 1)
- `-d, --deviation`: Price deviation percentage (default: 5)
- `-x, --sizemult`: Order size multiplier (default: 1)
- `-e, --entryprice`: Initial entry price
- `-i, --initmargin`: Initial margin amount
- `-r, --reload`: Force reload of maintenance margin rates
- `--apply`: Place orders based on calculations (requires confirmation)

### Examples

Calculate liquidation price for a long position:
```bash
node dist/liquicalc.js -t BTCUSDT -e 60000 -i 1000 -l 5
```

Calculate liquidation price for a short position:
```bash
node dist/liquicalc.js -t BTCUSDT -e 60000 -i 1000 -l 5 -s
```

Place orders with confirmation:
```bash
# Requires BINANCE_API_KEY and BINANCE_API_SECRET environment variables
export BINANCE_API_KEY="your_api_key"
export BINANCE_API_SECRET="your_api_secret"
node dist/liquicalc.js -t BTCUSDT -e 60000 -i 1000 -l 5 --apply
```

## Safety Features

- Interactive confirmation before placing orders
- Requires explicit "yes" to proceed with order placement
- Displays order details before confirmation

## License

[MIT License](LICENSE)
