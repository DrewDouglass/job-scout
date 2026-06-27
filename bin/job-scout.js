#!/usr/bin/env node
/**
 * job-scout — CLI entry.
 *
 *   job-scout serve            start the local dashboard + JSON API (default port 7777)
 *   job-scout daily            run one search-and-score pass, write results to the DB
 *   job-scout migrate <file>   import an Adli-format backup JSON (lossless)
 *   job-scout linkedin login   one-time headful LinkedIn sign-in (dedicated profile)
 *   job-scout linkedin probe   discover the live LinkedIn job-cards responses
 *   job-scout setup            print the first-run setup checklist
 *   job-scout help
 */
const { JobScoutDB } = require('../src/db');

// Node 24 LTS floor: node:sqlite (the built-in database this tool runs on) is STABLE in Node 24.
// In Node 22 it's experimental and prints a warning, so we require 24 for a clean experience.
const MIN_NODE_MAJOR = 24;
function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    console.error(`job-scout needs Node ${MIN_NODE_MAJOR}+ (you have ${process.version}). The built-in node:sqlite database is the reason — please install Node ${MIN_NODE_MAJOR} LTS from https://nodejs.org and re-run.`);
    process.exit(1);
  }
}

async function main() {
  checkNode();
  const cmd = process.argv[2] || 'help';

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return printHelp();

  if (cmd === 'linkedin') {
    // delegate to the observer CLI; it reads its mode at argv[2]
    const { runCli } = require('../src/sources/linkedin/observer');
    return runCli(['node', 'observer', ...process.argv.slice(3)]);
  }

  if (cmd === 'autostart') {
    const { installAutostart } = require('../src/autostart');
    try { console.log(installAutostart({ off: process.argv.includes('--off') })); }
    catch (e) { console.error(e.message); process.exit(1); }
    return;
  }

  const db = new JobScoutDB();
  try {
    switch (cmd) {
      case 'serve': {
        const { createServer } = require('../src/server');
        const { runDaily } = require('../src/pipeline');
        const port = Number(process.env.PORT || 7777);
        const server = createServer(db);
        server.listen(port, '127.0.0.1', () => {
          console.log(`\n  job-scout is running.  Open:  http://127.0.0.1:${port}\n`);
        });
        // Backstop: if the last run is >24h old (or never), catch up in-process.
        const last = db.lastRun();
        const stale = !last || !last.finished_at || (Date.now() - last.finished_at) > 24 * 3600 * 1000;
        if (stale) {
          console.log('  (no recent run — fetching jobs in the background…)');
          runDaily(db, db.getSettings(), { onStatus: m => process.stderr.write('  ' + m + '\n') })
            .then(r => console.log(`  background run: ${r.scoredCount} jobs scored.`))
            .catch(e => console.error('  background run failed:', e.message));
        }
        return; // keep the process alive
      }
      case 'daily': {
        const { runDaily } = require('../src/pipeline');
        const res = await runDaily(db, db.getSettings(), { onStatus: m => process.stderr.write(m + '\n') });
        console.log(`daily run #${res.runId}: ${res.scoredCount} scored / ${res.jobCount} found`, res.counts);
        if (res.canary) console.log('LinkedIn:', res.canary.message);
        if (res.errors && res.errors.length) console.log('notes:', res.errors.join('; '));
        break;
      }
      case 'migrate': {
        const file = process.argv[3];
        if (!file) { console.error('usage: job-scout migrate <adli-backup.json>'); process.exit(1); }
        const fs = require('node:fs');
        const counts = db.migrateFromBackup(JSON.parse(fs.readFileSync(file, 'utf8')));
        console.log('migrated:', counts);
        break;
      }
      case 'setup': return printSetup(db);
      default:
        console.error(`unknown command: ${cmd}`);
        printHelp();
        process.exit(1);
    }
  } finally {
    if (cmd !== 'serve') db.close();
  }
}

function printHelp() {
  console.log(`job-scout — a portable, self-hosting job search dashboard (built on Adli Waziri's cowork-job-scout).

  job-scout serve            start the dashboard + API   -> http://127.0.0.1:7777
  job-scout daily            run one search + score pass
  job-scout migrate <file>   import an Adli backup JSON
  job-scout linkedin login   one-time LinkedIn sign-in (dedicated browser profile)
  job-scout linkedin probe   discover the live LinkedIn job-cards responses
  job-scout autostart        schedule a daily search; add --off to remove
  job-scout setup            first-run checklist
`);
}
function printSetup(db) {
  const s = db.getSettings();
  console.log(`First-run setup:
  1. Edit your profile + search terms:  open http://127.0.0.1:7777 (Settings tab) or POST /api/settings
  2. JSearch (job boards): get a FREE RapidAPI key for JSearch (200/mo, no card) and set RAPIDAPI_KEY in your environment.
  3. LinkedIn (optional, richer): run  job-scout linkedin login  once, then enable it in Settings.
  4. Scoring: default is free 'keyword'. For AI scoring set scoreProvider to 'haiku' (your ANTHROPIC_API_KEY) or 'ollama'.
  5. Run:  job-scout daily   then   job-scout serve

  current provider: ${s.scoreProvider}   sources: ${JSON.stringify(s.sources)}
`);
}

main().catch(e => { console.error('job-scout error:', e.stack || e.message); process.exit(1); });
