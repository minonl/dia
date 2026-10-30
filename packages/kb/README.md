# @dia/kb

Generic knowledge engine extracted from `src/kb.ts` (M2).

- md is the only source of truth; sqlite is a derived index.
- API: `buildIndex` / `search` / `lint` / `getDoc`.
- Domain semantics (yan scenes/rules/claims) stay in the domain, not here.
