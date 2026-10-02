# CLAUDE.md — contract for AI coding sessions

Autonomous Russian-language Telegram monitor of Russia–NATO escalation / de-escalation
signals. Owner is a non-developer; optimise for correctness, traceability, €0 running
cost and being understandable by one person. Product docs: `README.md` (Russian),
design rationale: `docs/PLAN.md`.

## Stack and conventions

- Node 24, TypeScript run **directly** by Node (type stripping) — no build step.
  Only erasable syntax: no `enum`, no constructor parameter properties, no namespaces.
  Relative imports end in `.ts`.
- SQLite via built-in `node:sqlite` (`src/db.ts`). Migrations are an append-only array;
  `PRAGMA user_version` = applied count. Never edit an existing migration.
- Gemini over REST (`src/llm.ts`): model chain with automatic fallback on quota,
  per-run and per-day call caps recorded in `llm_usage`. Every LLM output is validated
  with zod; editorial fields that matter (statements, signal, category) are required —
  never add a silent `.catch()` default to them.
- Config only through `src/config.ts` (zod-validated env). Never read `process.env` elsewhere.
- Logs are NDJSON to stdout/stderr; the logger redacts bot tokens.

## Commands

| Command | What |
|---|---|
| `npm run cycle` | one full cycle (what Actions runs hourly) |
| `npm run quick` | admin bot + delivery only |
| `npm run posts -- 10` | print latest generated posts |
| `npm run report` | `out/report.html` editorial dashboard |
| `node src/cli.ts <stage>` | `collect`, `triage`, `cluster`, `analyze`, `editorial`, `digest`, `index`, `discover` |
| `node scripts/sql.ts "SELECT …"` | read-only ad-hoc query |
| `npm run check` | typecheck + tests — must pass before a commit |

On Git Bash, `node src/cli.ts admin "/status"` needs `MSYS_NO_PATHCONV=1` (MSYS rewrites `/status` as a path).

## Editorial invariants (do not weaken without the owner's say)

- A party's claim is never rendered as FACT; `checkText` flags FACT attributed to ministries.
- Independence = distinct *origins* (re-prints of one wire story count once).
- Only `NEW_EVENT` / `SIGNIFICANT_UPDATE` are published; updates reply to the original post.
- No coordinates, no model-generated links, Russian text only — hard checks.
- Social-only (tier G) sourcing or `headline_risk` ⇒ human review, never auto.
- The escalation index is labelled as indicator intensity, never a war probability.
- Telegram delivery: `sending` is committed before the request; ambiguous outcomes become
  `uncertain` and are never auto-retried.

## State and deployment

GitHub Actions (`.github/workflows/monitor.yml`) restores `data/monitor.db` from the
`state` branch, runs, and force-pushes a single-commit `state` branch back. `prune()`
keeps the file small (bodies dropped after 48 h for noise, rows deleted after 10 days).

## When you change things

- Prompt changes: bump `ANALYSIS_VERSION` / `TRIAGE_VERSION` and check real output with
  `node src/cli.ts analyze` + `npm run posts`.
- New source: add to `config/sources.yaml` (verify the URL live first). Discovered sources
  enter the DB as `testing` and graduate automatically.
- Thresholds (`SIM_*` in `cluster.ts`, `PUBLISH_THRESHOLD`) were calibrated on one day of
  data (2026-10-02); recalibrate from the report, not from intuition.
