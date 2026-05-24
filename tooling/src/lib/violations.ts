// Violation type and formatting for the rstream-query-based validator.

export type Severity = "error" | "warning" | "info";

export interface Violation {
  rule: string;
  severity: Severity;
  subject?: string;   // entity id or predicate id or lens id
  predicate?: string; // predicate id (when relevant)
  value?: string;     // target id or extra context
  message: string;
  file?: string;
  line?: number;
  lens?: string;
}

export function formatViolation(v: Violation): string {
  const prefix = v.severity === "error" ? "ERROR " : v.severity === "warning" ? "WARN  " : "INFO  ";
  const loc = v.file && v.line ? `${v.file}:${v.line}` : v.file ?? "(unknown)";
  const lens = v.lens ?? "?";
  const subj = v.subject ?? "?";
  const pred = v.predicate ?? "?";
  return `${prefix} [${lens}] ${loc} [${subj}] {${pred}} ${v.rule}: ${v.message}`;
}
