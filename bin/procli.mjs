#!/usr/bin/env node
import { main } from "../src/main.mjs";

main(process.argv.slice(2)).catch((error) => {
  const result = {
    ok: false,
    error: {
      code: error.code || "CLI_ERROR",
      message: error.message || String(error),
      ...(error.details ? { details: error.details } : {}),
    },
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = Number(error.exitCode || 1);
});
