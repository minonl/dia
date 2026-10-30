export interface Db {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
  all<T = any>(sql: string, params?: unknown[]): T[];
  close(): void;
}

const isBun = typeof (globalThis as any).Bun !== "undefined";

export async function openDb(path: string, opts: { readonly?: boolean } = {}): Promise<Db> {
  if (isBun) {
    const mod: any = await import("bun:sqlite");
    const db = opts.readonly ? new mod.Database(path, { readonly: true }) : new mod.Database(path);
    return {
      exec: (s) => db.exec(s),
      run: (s, p = []) => { db.query(s).run(...p); },
      all: (s, p = []) => db.query(s).all(...p),
      close: () => db.close(),
    };
  }
  const mod: any = await import("node:sqlite");
  const db = opts.readonly ? new mod.DatabaseSync(path, { readOnly: true }) : new mod.DatabaseSync(path);
  return {
    exec: (s) => db.exec(s),
    run: (s, p = []) => { db.prepare(s).run(...p); },
    all: (s, p = []) => db.prepare(s).all(...p),
    close: () => db.close(),
  };
}

export function isBunRuntime(): boolean {
  return isBun;
}
