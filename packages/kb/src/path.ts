import { existsSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

export class KbPathError extends Error {
  constructor(message: string, public code = 2) { super(message); }
}

export interface PathOptions {
  repo?: string;
  skillsDir?: string;
  runtime?: string;
}

export interface ResolvedPath {
  type: "doc" | "workflow" | "skill" | "tool";
  address: string;
  path: string;
  mode?: string;
  command: string;
}

function inside(base: string, p: string): string {
  const b = resolve(base);
  const n = normalize(p);
  if (n !== b && !n.startsWith(b + sep)) throw new KbPathError(`path escapes ${base}: ${p}`, 2);
  return n;
}

function existing(p: string, address: string): string {
  if (!existsSync(p)) throw new KbPathError(`address not found: ${address} → ${p}`, 4);
  return p;
}

export function resolveKbPath(root: string, address: string, opts: PathOptions = {}): ResolvedPath {
  const repo = resolve(opts.repo || process.cwd());
  const skills = resolve(opts.skillsDir || join(repo, "skills"));
  const addr = address.trim();
  if (!addr) throw new KbPathError("missing address", 2);

  if (addr.startsWith("doc:")) {
    const rel = addr.slice(4);
    const p = inside(root, join(root, rel.endsWith(".md") ? rel : `${rel}.md`));
    return { type: "doc", address: addr, path: existing(p, addr), command: p };
  }
  if (addr.startsWith("workflow:")) {
    const name = addr.slice(9);
    const p = inside(root, join(root, "workflows", name.endsWith(".md") ? name : `${name}.md`));
    return { type: "workflow", address: addr, path: existing(p, addr), command: p };
  }
  if (addr.startsWith("skill:")) {
    const name = addr.slice(6);
    const p = inside(skills, join(skills, name, "SKILL.md"));
    return { type: "skill", address: addr, path: existing(p, addr), command: p };
  }
  if (addr.startsWith("tool:")) {
    const raw = addr.slice(5);
    const hash = raw.indexOf("#");
    const rel = hash >= 0 ? raw.slice(0, hash) : raw;
    const mode = hash >= 0 ? raw.slice(hash + 1) : undefined;
    if (!rel || isAbsolute(rel)) throw new KbPathError("tool path must be relative to repo", 2);
    const p = inside(repo, join(repo, rel));
    existing(p, addr);
    let command = p;
    if (mode) {
      if (rel.endsWith(".sh")) command = `bash ${p} ${mode}`;
      else if (/\.(mjs|js|ts)$/.test(rel)) command = `${opts.runtime || "bun"} ${p} ${mode}`;
      else command = `${p}#${mode}`;
    }
    return { type: "tool", address: addr, path: p, mode, command };
  }
  throw new KbPathError(`unsupported address: ${addr} (doc:/workflow:/skill:/tool:)`, 2);
}
