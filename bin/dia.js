#!/usr/bin/env node
import("../dist/cli.js").catch((e) => {
  console.error(e && e.message ? e.message : String(e));
  process.exit(1);
});
