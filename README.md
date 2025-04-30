# Crypto Trading Tools

A collection of TypeScript utilities for cryptocurrency trading on Binance Futures, with a focus on liquidation price calculation and order placement.

## Features

- **Liquidation Price Calculator**: Calculate liquidation prices for long/short positions
- **Order Placement**: Generate and place multiple orders with customizable parameters
- **Risk Management**: Analyze maintenance margin rates and risk brackets
- **Trading Environment Setup**: Automatically configure position mode, leverage and margin type
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
- Automatic trading environment configuration (ONE_WAY mode, ISOLATED margin, proper leverage)

## Important Requirements

This tool only works with the assumption position mode is ONE_WAY, margin type is ISOLATED, Single Asset mode is enabled. The tool will automatically set these parameters for you.

## License

[MIT License](LICENSE)
