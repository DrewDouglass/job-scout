#!/usr/bin/env node
/**
 * shoot-tabs.js — capture each dashboard tab as a full-resolution PNG (for review).
 * Reuses the zero-dep CDP client from the LinkedIn observer to drive a headless Chrome.
 *   node scripts/shoot-tabs.js   (env: SHOOT_URL, SHOOT_OUT)
 */
const fs = require('node:fs');
const path = require('node:path');
const { launchChrome, attachPage } = require('../src/sources/linkedin/observer');

const URL = process.env.SHOOT_URL || 'http://127.0.0.1:7777';
const OUT = process.env.SHOOT_OUT || '/tmp/jobscout-shots';
const PORT = Number(process.env.SHOOT_PORT || 9333);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = '/tmp/jobscout-shot-profile';
  await launchChrome({ headless: true, port: PORT, profileDir: profile, startUrl: URL });
  const { cdp, sessionId } = await attachPage(PORT);
  await cdp.send('Page.navigate', { url: URL }, sessionId);
  await sleep(2200);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 2, mobile: false }, sessionId);
  const tabs = [['matches', '1-Matches'], ['activities', '2-Job-Search-Log'], ['resumes', '3-Resumes'], ['settings', '4-Settings'], ['setup', '5-Setup-and-Help']];
  const files = [];
  for (const [tab, name] of tabs) {
    await cdp.send('Runtime.evaluate', { expression: `switchTab('${tab}')` }, sessionId);
    await sleep(800);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
    const f = path.join(OUT, `${name}.png`);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    files.push(f);
    process.stderr.write(`shot ${f}\n`);
  }
  cdp.close();
  process.stdout.write(files.join(' ') + '\n');
  process.exit(0);
})().catch(e => { process.stderr.write((e.stack || e.message) + '\n'); process.exit(1); });
