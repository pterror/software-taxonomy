// New validator: load2 → rstream-query rules → format/print → exit code.
// Parallel to validate.ts; the old validate pipeline is untouched.

import { loadData2 } from "./lib/load2.js";
import { runAllRules } from "./lib/rules2.js";
import { formatViolation } from "./lib/violations2.js";

const db = loadData2();
const violations = runAllRules(db);

const sorted = [...violations].sort((a, b) => {
  const sevOrder: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const sA = sevOrder[a.severity] ?? 3;
  const sB = sevOrder[b.severity] ?? 3;
  if (sA !== sB) return sA - sB;
  return (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0);
});

for (const v of sorted) {
  const logFn = v.severity === "error" ? console.error : v.severity === "warning" ? console.warn : console.info;
  logFn(formatViolation(v));
}

const totalErrors = sorted.filter(v => v.severity === "error").length;
const totalWarnings = sorted.filter(v => v.severity === "warning").length;

console.log(`\n${totalErrors} error(s), ${totalWarnings} warning(s).`);

if (totalErrors > 0) process.exit(1);
