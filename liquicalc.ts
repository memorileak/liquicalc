// Variable references:
// - Lev: Leverage
// - Dvi: Price deviation (percentage)
// - Mul: Order size multiplier

// - E: Average entry price
// - S: Position size (in quantity of the asset)
// - M: Total margin (unleveraged)
// - MM: Total maintenance margin
// - R: Maintenance margin rate
// - Liq: Liquidation price

type PositionSnapshot = {
  EntryPrice: number;
  AverageEntryPrice: number;
  LiquidationPrice: number;
  TotalInvested: number;
};

function calculateLiquidationPrices(config: {
  Lev: number;
  Dvi: number;
  Mul: number;
  FirstE: number;
  FirstM: number;
}): PositionSnapshot[] {
  const { Lev, Dvi, Mul, FirstE, FirstM } = config;
  const calculatingResults: PositionSnapshot[] = [];

  const R = 1 / 200; // 0.5%

  let TotalM = 0;
  let TotalS = 0;
  let AvgE = 0;
  let TotalMM = 0;
  let TotalInvested = 0;

  let E = FirstE;
  let MToAdd = FirstM;

  TotalM += MToAdd;
  TotalInvested += MToAdd;

  let S = (Lev * MToAdd) / E;
  AvgE = (AvgE * TotalS + E * S) / (TotalS + S);
  TotalS = TotalS + S;

  let MM = Lev * MToAdd * R;
  TotalMM = TotalMM + MM;

  let Liq = AvgE - (TotalM - TotalMM) / TotalS;

  calculatingResults.push({
    EntryPrice: E,
    AverageEntryPrice: AvgE,
    LiquidationPrice: Liq,
    TotalInvested: TotalInvested,
  });

  for (let i = 0; i < 99; i++) {
    let Ei = E - E * (Dvi / 100);

    if (Ei < Liq) {
      break;
    }

    let Loss = Lev * TotalM - Ei * TotalS;
    TotalM = TotalM - Loss;

    MToAdd = MToAdd * Mul;
    TotalM = TotalM + MToAdd;
    TotalInvested += MToAdd;

    let Si = (Lev * MToAdd) / Ei;
    AvgE = (AvgE * TotalS + Ei * Si) / (TotalS + Si);
    TotalS = TotalS + Si;

    let MMi = Lev * R * MToAdd;
    TotalMM = TotalMM + MMi;

    Liq = AvgE - (TotalM - TotalMM) / TotalS;

    E = Ei;

    calculatingResults.push({
      EntryPrice: E,
      AverageEntryPrice: AvgE,
      LiquidationPrice: Liq,
      TotalInvested: TotalInvested,
    });
  }

  return calculatingResults;
}

function main() {
  const config = {
    Lev: 2,
    Dvi: (100 * 5) / 70,
    Mul: 2,
    FirstE: 70000,
    FirstM: 100,
  };

  const results = calculateLiquidationPrices(config);

  // Let's print the results in a pretty table format, AI!

  console.log("Liquidation prices calculated successfully.");
  console.log("Results:", results);
}

main();
