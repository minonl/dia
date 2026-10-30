export interface RedactResult { text: string; hits: Record<string, number> }

const RULES: [string, RegExp][] = [
  ["PRIVATE_KEY", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["GITHUB_TOKEN", /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["OPENAI_KEY", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["AWS_KEY", /\bAKIA[0-9A-Z]{16}\b/g],
  ["SLACK_TOKEN", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["BEARER", /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi],
  ["ASSIGNMENT", /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD))\s*=\s*("[^"]*"|'[^']*'|\S+)/g],
  ["EMAIL", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["PHONE_CN", /\b1[3-9]\d{9}\b/g],
  ["INTERNAL_HOST", /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|corp|local)\b/gi],
  ["PRIVATE_IP", /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g],
];

export function redact(input: string): RedactResult {
  let text = input;
  const hits: Record<string, number> = {};
  for (const [label, re] of RULES) {
    text = text.replace(re, (...args) => {
      hits[label] = (hits[label] || 0) + 1;
      if (label === "ASSIGNMENT") return `${args[1]}=[REDACTED:ASSIGNMENT]`;
      return `[REDACTED:${label}]`;
    });
  }
  return { text, hits };
}

export function hasSecrets(text: string): boolean {
  return RULES.some(([, re]) => { re.lastIndex = 0; return re.test(text); });
}
