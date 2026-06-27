/**
 * autostart.js — cross-OS "run the daily search automatically" setup.
 *
 * `job-scout autostart` schedules a daily `job-scout daily` run (fetch + score + write to the DB)
 * so fresh jobs are waiting whenever the user opens `job-scout serve`. Per-OS: launchd (macOS),
 * a systemd user timer (Linux), Task Scheduler (Windows). `--off` removes it. An in-process
 * "catch up if last run > 24h" backstop already lives in `serve`, so a missed scheduled run
 * (closed-lid laptop) self-heals on next open.
 *
 * The file/command GENERATORS are pure (testable); the install action writes + activates them.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LABEL = 'com.sillydroose.job-scout.daily';

/** macOS launchd plist that runs `<node> <script> daily` at `hour`:00 local, plus once at load. */
function launchdPlist({ node, script, hour = 8, logDir }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${script}</string>
    <string>daily</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${logDir}/daily.log</string>
  <key>StandardErrorPath</key><string>${logDir}/daily.err.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
</dict>
</plist>
`;
}

/** Linux systemd user service + timer. */
function systemdUnits({ node, script, hour = 8 }) {
  const service = `[Unit]
Description=Job Scout daily search

[Service]
Type=oneshot
ExecStart=${node} ${script} daily
`;
  const timer = `[Unit]
Description=Run Job Scout daily search every morning

[Timer]
OnCalendar=*-*-* ${String(hour).padStart(2, '0')}:00:00
Persistent=true

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

/** Windows Task Scheduler create command (array form for execFile). */
function windowsTaskArgs({ node, script, hour = 8 }) {
  return ['/Create', '/F', '/SC', 'DAILY', '/TN', 'JobScoutDaily',
    '/TR', `"${node}" "${script}" daily`, '/ST', `${String(hour).padStart(2, '0')}:00`];
}

function homeDir() { return process.env.JOB_SCOUT_HOME || path.join(os.homedir(), '.job-scout'); }
function scriptPath() { return path.join(__dirname, '..', 'bin', 'job-scout.js'); }

/**
 * Install (or with off:true, remove) the daily scheduler for the current OS.
 * Returns a human-readable summary; throws only on unexpected failure.
 */
function installAutostart({ off = false, hour = 8, platform = process.platform, node = process.execPath } = {}) {
  const script = scriptPath();
  const logDir = path.join(homeDir(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  if (platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const domain = `gui/${process.getuid ? process.getuid() : ''}`;
    if (off) {
      try { execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`]); } catch {}
      try { fs.unlinkSync(plistPath); } catch {}
      return `Removed the daily scheduler (launchd: ${LABEL}).`;
    }
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, launchdPlist({ node, script, hour, logDir }));
    try { execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`]); } catch {}
    execFileSync('launchctl', ['bootstrap', domain, plistPath]);
    return `Scheduled a daily run at ${hour}:00 (launchd). Plist: ${plistPath}`;
  }

  if (platform === 'linux') {
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    if (off) {
      try { execFileSync('systemctl', ['--user', 'disable', '--now', 'job-scout-daily.timer']); } catch {}
      try { fs.unlinkSync(path.join(unitDir, 'job-scout-daily.timer')); } catch {}
      try { fs.unlinkSync(path.join(unitDir, 'job-scout-daily.service')); } catch {}
      return 'Removed the daily scheduler (systemd user timer).';
    }
    const { service, timer } = systemdUnits({ node, script, hour });
    fs.writeFileSync(path.join(unitDir, 'job-scout-daily.service'), service);
    fs.writeFileSync(path.join(unitDir, 'job-scout-daily.timer'), timer);
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', 'job-scout-daily.timer']);
    return `Scheduled a daily run at ${hour}:00 (systemd user timer).`;
  }

  if (platform === 'win32') {
    if (off) {
      try { execFileSync('schtasks', ['/Delete', '/F', '/TN', 'JobScoutDaily']); } catch {}
      return 'Removed the daily scheduler (Task Scheduler: JobScoutDaily).';
    }
    execFileSync('schtasks', windowsTaskArgs({ node, script, hour }), { shell: true });
    return `Scheduled a daily run at ${hour}:00 (Windows Task Scheduler: JobScoutDaily).`;
  }

  throw new Error(`autostart not supported on platform: ${platform}`);
}

module.exports = { launchdPlist, systemdUnits, windowsTaskArgs, installAutostart, LABEL };
