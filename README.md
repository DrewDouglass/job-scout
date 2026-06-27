# Job Scout

A private, self-hosting job-search dashboard. It searches job boards and LinkedIn for roles that fit you, scores each one 1–10 with a plain-English reason, runs end-to-end resume tailoring, and keeps an unemployment-grade job-search activity log — all running locally on your own computer, with your data in a single SQLite file that never leaves your machine.

> **Built on [Adli Waziri](https://github.com/adlidev)'s [cowork-job-scout](https://github.com/adlidev/cowork-job-scout).** Adli designed the product — the 1–10 scoring rubric, the smart filtering, the activity log with state unemployment compliance, the configurable scoring penalties, the resume library. This is a re-platform of his tool out of Claude Cowork into a standalone, portable, shareable app, with his explicit blessing ("Do anything you like with it. Would love a more agnostic version."). His product design is preserved throughout; the MIT license and his copyright are kept. Thank you, Adli.

## What changed in the re-platform

- **Runs standalone** — a small local web server (Node, zero runtime dependencies) + SQLite, instead of a Claude Cowork artifact with browser `localStorage`.
- **Portable** — built-in `node:sqlite` (no native compile), runs on macOS / Windows / Linux. Requires Node 24+.
- **Real job sources** — Adli's Cowork board connectors (Dice, Indeed, ZipRecruiter via per-user MCP UUIDs) are replaced by **JSearch** (one free RapidAPI key covering Indeed/ZipRecruiter/Glassdoor & more) plus a **LinkedIn ride-along** that reads your own logged-in session, and optional email-alert readers.
- **End-to-end** — scoring and resume tailoring run for real (no copy-paste), free on a keyword baseline or via Claude Haiku / a local Ollama model.
- **Reversible dismiss**, durable activity log, and a daily refresh job.

## Quick start

```
job-scout serve     # then open http://127.0.0.1:7777
```

Full setup (job sources, LinkedIn, scoring) is in **[GETTING-STARTED.md](GETTING-STARTED.md)** and inside the app under the **ℹ️ Setup & Help** tab.

## License

MIT — see [LICENSE](LICENSE). Original work © Adli Waziri; re-platform © Drew Douglass.
