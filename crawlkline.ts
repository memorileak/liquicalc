import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import commandLineArgs from "command-line-args";

import { getKlines, KlineInterval } from "./libs/libbinance";

const KLINE_DB_DIR = `${process.cwd()}/data`;

async function crawlKlineData(
  symbol: string,
  interval: KlineInterval,
  startTime: number,
  endTime: number
): Promise<void> {
  try {
    // Create directory if it doesn't exist
    if (!fs.existsSync(KLINE_DB_DIR)) {
      fs.mkdirSync(KLINE_DB_DIR, { recursive: true });
    }

    const dbPath = path.join(KLINE_DB_DIR, `${symbol}_${interval}.db`);
    console.log(`Creating/opening database at ${dbPath}`);

    // Open the database
    const db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });

    // Create the table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS klines (
        time INTEGER PRIMARY KEY,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL
      )
    `);
    console.log("Database table created or already exists");

    // Calculate the time difference for a 10-day batch in milliseconds
    const BATCH_SIZE = 1000; // Number of klines per batch
    let currentStartTime = startTime;

    console.log(
      `Starting data retrieval from ${new Date(
        startTime
      ).toISOString()} to ${new Date(endTime).toISOString()}`
    );

    // Fetch data in batches
    while (currentStartTime < endTime) {
      try {
        console.log(
          `Fetching batch from ${new Date(
            currentStartTime
          ).toISOString()} with limit of ${BATCH_SIZE} records`
        );

        const klines = await getKlines({
          symbol,
          interval,
          startTime: currentStartTime,
          endTime,
          limit: BATCH_SIZE,
        });

        if (klines.length === 0) {
          console.log("No more klines to fetch, exiting loop");
          break; // Exit loop if no more klines are returned
        }

        console.log(
          `Retrieved ${klines.length} klines, storing in database...`
        );

        // Begin transaction for batch insert
        await db.exec("BEGIN TRANSACTION");

        // Prepare statement for inserting klines
        const stmt = await db.prepare(`
          INSERT OR REPLACE INTO klines (time, open, high, low, close)
          VALUES (?, ?, ?, ?, ?)
        `);

        // Insert each kline
        for (const kline of klines) {
          const [time, open, high, low, close] = kline;
          await stmt.run(
            time,
            parseFloat(open),
            parseFloat(high),
            parseFloat(low),
            parseFloat(close)
          );
        }

        await stmt.finalize();
        await db.exec("COMMIT");
        console.log(`Stored ${klines.length} klines for this batch`);

        // Move to next batch
        currentStartTime = klines?.[klines.length - 1]?.[0] + 1;

        // Wait for 2 seconds to avoid rate limit
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(
          `Error fetching batch from ${new Date(
            currentStartTime
          ).toISOString()}:`,
          error
        );
        break; // Exit the loop on error
      }
    }

    console.log("Data retrieval completed");
    await db.close();
  } catch (error) {
    console.error("Error in crawlKlineData:", error);
  }
}

async function main() {
  const optionDefinitions = [
    { name: "symbol", alias: "s", type: String },
    { name: "interval", alias: "i", type: String },
    { name: "startTime", alias: "f", type: String }, // Format: YYYY-MM-DD
    { name: "endTime", alias: "t", type: String }, // Format: YYYY-MM-DD
  ];

  const options = commandLineArgs(optionDefinitions);

  if (!options.symbol || !options.interval) {
    console.error("Symbol and interval are required");
    console.log(
      "Usage: pnpm run crawl -- -s BTCUSDT -i 15m -f 2023-01-01 -t 2023-02-01"
    );
    process.exit(1);
  }

  // Parse dates to timestamps
  const startTime = options.startTime
    ? new Date(options.startTime).getTime()
    : Date.now() - 30 * 24 * 60 * 60 * 1000; // Default to 30 days ago

  const endTime = options.endTime
    ? new Date(options.endTime).getTime()
    : Date.now(); // Default to now

  console.log(
    `Crawling kline data for ${options.symbol} with interval ${options.interval}`
  );
  console.log(`From: ${new Date(startTime).toISOString()}`);
  console.log(`To: ${new Date(endTime).toISOString()}`);

  await crawlKlineData(
    options.symbol,
    options.interval as KlineInterval,
    startTime,
    endTime
  );
}

main().catch((error) => {
  console.error("Error in main:", error);
  process.exit(1);
});
