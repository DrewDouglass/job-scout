/**
 * autostart.test.js — pure per-OS scheduler generators.
 * (The install action modifies the live OS scheduler and is exercised by the user via `job-scout autostart`.)
 * Run: node --test test/autostart.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { launchdPlist, systemdUnits, windowsTaskArgs, LABEL } = require('../src/autostart');

describe('launchd plist (macOS)', () => {
  const p = launchdPlist({ node: '/usr/bin/node', script: '/app/bin/job-scout.js', hour: 8, logDir: '/logs' });
  it('runs `daily` at the chosen hour, at load, with the label', () => {
    assert.ok(p.includes(`<string>${LABEL}</string>`));
    assert.ok(p.includes('<string>daily</string>'));
    assert.ok(p.includes('<key>Hour</key><integer>8</integer>'));
    assert.ok(p.includes('<key>RunAtLoad</key><true/>'));
    assert.ok(p.includes('/logs/daily.log'));
  });
});

describe('systemd units (Linux)', () => {
  const { service, timer } = systemdUnits({ node: '/usr/bin/node', script: '/app/bin/job-scout.js', hour: 7 });
  it('service runs `daily`, timer fires daily at the hour, persistent', () => {
    assert.ok(service.includes('ExecStart=/usr/bin/node /app/bin/job-scout.js daily'));
    assert.ok(timer.includes('OnCalendar=*-*-* 07:00:00'));
    assert.ok(timer.includes('Persistent=true'));
  });
});

describe('Windows Task Scheduler args', () => {
  const args = windowsTaskArgs({ node: 'C:\\node.exe', script: 'C:\\app\\bin\\job-scout.js', hour: 9 });
  it('creates a daily task named JobScoutDaily at the hour', () => {
    assert.deepEqual(args.slice(0, 6), ['/Create', '/F', '/SC', 'DAILY', '/TN', 'JobScoutDaily']);
    assert.ok(args.join(' ').includes('job-scout.js" daily'));
    assert.ok(args.includes('09:00'));
  });
});
