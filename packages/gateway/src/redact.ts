import type { ChatRequest, Message } from "@crucible/core";

export interface RedactionRule { name: string; pattern: RegExp; replacement: string }

export const DEFAULT_RULES: RedactionRule[] = [
  { name: "email", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: "[EMAIL]" },
  { name: "credit_card", pattern: /\b(?:\d[ -]?){13,19}\b/g, replacement: "[CARD]" },
  { name: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN]" },
  { name: "phone", pattern: /\b(?:\+?\d{1,3}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/g, replacement: "[PHONE]" },
  { name: "ipv4", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: "[IP]" },
  { name: "api_key", pattern: /\b(?:sk|pk|rk|cru|ghp|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/g, replacement: "[API_KEY]" },
  { name: "aws_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[AWS_KEY]" },
];

export interface RedactionReport { total: number; byRule: Record<string, number> }

export function redactText(text: string, rules: RedactionRule[] = DEFAULT_RULES, report?: RedactionReport): string {
  let out = text;
  for (const r of rules) {
    out = out.replace(r.pattern, () => {
      if (report) { report.total++; report.byRule[r.name] = (report.byRule[r.name] ?? 0) + 1; }
      return r.replacement;
    });
  }
  return out;
}

export function redactMessages(messages: Message[], rules: RedactionRule[] = DEFAULT_RULES): { messages: Message[]; report: RedactionReport } {
  const report: RedactionReport = { total: 0, byRule: {} };
  const out = messages.map((m) => ({
    ...m,
    content: typeof m.content === "string"
      ? redactText(m.content, rules, report)
      : m.content.map((p) => (p.type === "text" ? { ...p, text: redactText(p.text, rules, report) } : p.type === "tool_result" ? { ...p, content: redactText(p.content, rules, report) } : p)),
  }));
  return { messages: out, report };
}

export function redactRequest(req: ChatRequest, rules?: RedactionRule[]): { request: ChatRequest; report: RedactionReport } {
  const { messages, report } = redactMessages(req.messages, rules);
  return { request: { ...req, messages }, report };
}
