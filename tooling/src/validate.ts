// Validator: load → rstream-query rules → format/print → exit code.

import { loadData } from "./lib/load.js";
import { runAllRules } from "./lib/rules.js";
import { formatViolation } from "./lib/violations.js";

const db = loadData();
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
