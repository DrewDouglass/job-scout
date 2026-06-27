/**
 * db.js — Durable store, replacing Adli's browser localStorage.
 *
 * Uses Node's BUILT-IN node:sqlite (DatabaseSync) — zero native compilation, so
 * `npm install` never needs node-gyp / Visual Studio Build Tools (the #1 mixed-OS
 * install killer for the Boat). Requires Node 24+ (node:sqlite is flag-free since
 * 22.13 / 23.4 and stabilized by Node 26).
 *
 * The five Cowork localStorage keys map to tables:
 *   jd_job_cache  -> jobs        (+ dismissed_at/dismiss_reason: reversible dismiss, fixing Adli's no-undo gap)
 *   jd_activities -> activities  (the Colorado-compliance log — the crown jewel)
 *   jd_settings   -> settings    (key/value)
 *   jd_resumes    -> resumes
 *   jd_dismissed  -> folded into jobs.dismissed_at (+ stub rows so the cross-repost dedup keys survive)
 * plus a new `runs` table for daily-job timestamps.
 *
 * The repository API mirrors Adli's localStorage helper semantics (getCache/setCache,
 * getActs/setActs, getSettings/setSettings, ...) so porting the dashboard + server is mechanical.
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Mirrors Adli's DEFAULT_SETTINGS (dashboard.html). Kept here as the single source of truth
// so getSettings() can merge stored overrides onto the defaults exactly as the dashboard did.
const DEFAULT_SETTINGS = {
  candidateName: '', location: '', profile: '',
  workArrangements: ['remote'], commuteRangeMiles: 0, minSalary: 0, hideNoSalary: false,
  defensePreference: 'penalize',
  weeklyActivityGoal: 5,           // Colorado unemployment-insurance number
  autoBackupIntervalHours: 0,
  scorePenaltyTerms: [],
  searchTerms: null,
  diceSearchTerms: null, indeedSearchTerms: null, zrSearchTerms: null, localMetroCities: null,
  // re-platform additions (provider/source config); absent in Adli's data, defaulted here:
  scoreProvider: 'keyword',        // keyword | haiku | ollama  — keyword is the free, portable default
  sources: { jsearch: true, linkedinGuest: true, linkedinRideAlong: false, appleMail: false, gmail: false },
};

function defaultDbPath() {
  if (process.env.JOB_SCOUT_DB) return process.env.JOB_SCOUT_DB;
  const home = process.env.JOB_SCOUT_HOME || path.join(os.homedir(), '.job-scout');
  return path.join(home, 'job-scout.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  guid            TEXT PRIMARY KEY,
  title           TEXT,
  company_name    TEXT,
  location        TEXT,            -- jobLocation.displayName
  posted_date     TEXT,
  salary          TEXT,
  employment_type TEXT,
  details_url     TEXT,
  workplace_types TEXT,           -- JSON array
  is_remote       INTEGER DEFAULT 0,
  source          TEXT,
  also_seen_in    TEXT,           -- JSON array (other sources that surfaced the same posting)
  summary         TEXT,
  match_score     INTEGER,
  match_reason    TEXT,
  first_seen_at   INTEGER,
  last_seen_at    INTEGER,
  run_id          INTEGER,
  dismissed_at    INTEGER,        -- NULL = active; set = dismissed (reversible)
  dismiss_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_dismissed ON jobs(dismissed_at);
CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(match_score);

CREATE TABLE IF NOT EXISTS activities (
  id              TEXT PRIMARY KEY,
  type            TEXT,
  date            TEXT,           -- YYYY-MM-DD
  employer        TEXT,
  role            TEXT,
  method          TEXT,
  contact         TEXT,
  url             TEXT,
  notes           TEXT,
  app_status      TEXT,
  app_status_note TEXT,
  from_apply      INTEGER DEFAULT 0,
  created_at      INTEGER,
  updated_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT                      -- JSON-encoded
);

CREATE TABLE IF NOT EXISTS resumes (
  id       TEXT PRIMARY KEY,
  file     TEXT,
  company  TEXT,
  role     TEXT,
  created  TEXT,
  type     TEXT,
  folder   TEXT,
  archived INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    INTEGER,
  finished_at   INTEGER,
  source_counts TEXT,             -- JSON
  job_count     INTEGER,
  scored_count  INTEGER,
  status        TEXT,
  note          TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

class JobScoutDB {
  /** @param {string} [dbPath] */
  constructor(dbPath = defaultDbPath()) {
    this.path = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this._setMeta('schema_version', '1');
  }

  close() { this.db.close(); }

  // ─── meta ──────────────────────────────────────────────────────────────────
  _setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, String(value));
  }
  _getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? row.value : null;
  }

  // ─── settings (Adli getSettings/setSettings semantics: defaults merged with stored) ──
  getSettings() {
    const out = structuredClone(DEFAULT_SETTINGS);
    for (const { key, value } of this.db.prepare('SELECT key,value FROM settings').all()) {
      try { out[key] = JSON.parse(value); } catch { /* skip a corrupt row */ }
    }
    return out;
  }
  setSettings(partial) {
    const stmt = this.db.prepare(
      'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    const tx = this.db.prepare('BEGIN'); tx.run();
    try {
      for (const [k, v] of Object.entries(partial || {})) stmt.run(k, JSON.stringify(v));
      this.db.prepare('COMMIT').run();
    } catch (e) { this.db.prepare('ROLLBACK').run(); throw e; }
  }

  // ─── jobs (the cache + the scored set) ───────────────────────────────────────
  /** Upsert a scored job, refreshing last_seen_at and preserving first_seen_at + any dismissal. */
  upsertJob(job, { runId = null, now = Date.now() } = {}) {
    const existing = this.db.prepare('SELECT first_seen_at FROM jobs WHERE guid=?').get(job.guid);
    const firstSeen = existing ? existing.first_seen_at : now;
    this.db.prepare(`
      INSERT INTO jobs (guid,title,company_name,location,posted_date,salary,employment_type,details_url,
        workplace_types,is_remote,source,also_seen_in,summary,match_score,match_reason,
        first_seen_at,last_seen_at,run_id)
      VALUES (@guid,@title,@company_name,@location,@posted_date,@salary,@employment_type,@details_url,
        @workplace_types,@is_remote,@source,@also_seen_in,@summary,@match_score,@match_reason,
        @first_seen_at,@last_seen_at,@run_id)
      ON CONFLICT(guid) DO UPDATE SET
        title=excluded.title, company_name=excluded.company_name, location=excluded.location,
        posted_date=excluded.posted_date, salary=excluded.salary, employment_type=excluded.employment_type,
        details_url=excluded.details_url, workplace_types=excluded.workplace_types, is_remote=excluded.is_remote,
        source=excluded.source, also_seen_in=excluded.also_seen_in, summary=excluded.summary,
        match_score=excluded.match_score, match_reason=excluded.match_reason,
        last_seen_at=excluded.last_seen_at, run_id=excluded.run_id
    `).run({
      guid: job.guid,
      title: job.title ?? '',
      company_name: job.companyName ?? '',
      location: job.jobLocation?.displayName ?? '',
      posted_date: job.postedDate ?? null,
      salary: job.salary ?? null,
      employment_type: job.employmentType ?? null,
      details_url: job.detailsPageUrl ?? null,
      workplace_types: JSON.stringify(job.workplaceTypes ?? []),
      is_remote: job.isRemote ? 1 : 0,
      source: job.source ?? null,
      also_seen_in: JSON.stringify(job.alsoSeenIn ?? []),
      summary: job.summary ?? '',
      match_score: job.matchScore ?? null,
      match_reason: job.matchReason ?? null,
      first_seen_at: firstSeen,
      last_seen_at: now,
      run_id: runId,
    });
  }

  /** Hydrate a DB row back into Adli's in-memory job shape (so renderers stay unchanged). */
  static _rowToJob(r) {
    if (!r) return null;
    return {
      guid: r.guid,
      title: r.title,
      companyName: r.company_name,
      jobLocation: { displayName: r.location || '' },
      postedDate: r.posted_date,
      salary: r.salary,
      employmentType: r.employment_type,
      detailsPageUrl: r.details_url,
      workplaceTypes: safeJson(r.workplace_types, []),
      isRemote: !!r.is_remote,
      source: r.source,
      alsoSeenIn: safeJson(r.also_seen_in, []),
      summary: r.summary,
      matchScore: r.match_score,
      matchReason: r.match_reason,
      dismissedAt: r.dismissed_at,
      dismissReason: r.dismiss_reason,
    };
  }

  /** Active (non-dismissed) jobs, highest score first — what the Matches tab shows. */
  getActiveJobs() {
    return this.db.prepare('SELECT * FROM jobs WHERE dismissed_at IS NULL ORDER BY match_score DESC')
      .all().map(JobScoutDB._rowToJob);
  }
  getJob(guid) { return JobScoutDB._rowToJob(this.db.prepare('SELECT * FROM jobs WHERE guid=?').get(guid)); }
  getDismissedMap() {
    const map = {};
    for (const r of this.db.prepare('SELECT guid,dismiss_reason,dismissed_at,company_name,title FROM jobs WHERE dismissed_at IS NOT NULL').all())
      map[r.guid] = { reason: r.dismiss_reason || '', dismissedAt: r.dismissed_at, companyName: r.company_name || '', title: r.title || '' };
    return map;
  }

  /** Dismiss a job (reversible). Creates a stub row if the job isn't cached, so the cross-repost dedup key survives. */
  dismissJob(guid, reason = '', { job = null, now = Date.now() } = {}) {
    const exists = this.db.prepare('SELECT guid FROM jobs WHERE guid=?').get(guid);
    if (!exists && job) {
      this.upsertJob({ ...job, guid }, { now });
    } else if (!exists) {
      this.db.prepare('INSERT INTO jobs(guid,first_seen_at,last_seen_at) VALUES(?,?,?)').run(guid, now, now);
    }
    this.db.prepare('UPDATE jobs SET dismissed_at=?, dismiss_reason=? WHERE guid=?').run(now, reason, guid);
  }
  /** Undo a dismissal — the gap Adli's localStorage version could not do. */
  undismissJob(guid) {
    this.db.prepare('UPDATE jobs SET dismissed_at=NULL, dismiss_reason=NULL WHERE guid=?').run(guid);
  }

  // ─── activities (the compliance log) ─────────────────────────────────────────
  getActs() {
    const out = {};
    for (const r of this.db.prepare('SELECT * FROM activities').all()) out[r.id] = JobScoutDB._rowToAct(r);
    return out;
  }
  static _rowToAct(r) {
    return {
      id: r.id, type: r.type, date: r.date, employer: r.employer, role: r.role, method: r.method,
      contact: r.contact, url: r.url, notes: r.notes,
      appStatus: r.app_status ?? undefined, appStatusNote: r.app_status_note ?? undefined,
      fromApply: !!r.from_apply, createdAt: r.created_at, updatedAt: r.updated_at ?? undefined,
    };
  }
  putActivity(a) {
    this.db.prepare(`
      INSERT INTO activities (id,type,date,employer,role,method,contact,url,notes,app_status,app_status_note,from_apply,created_at,updated_at)
      VALUES (@id,@type,@date,@employer,@role,@method,@contact,@url,@notes,@app_status,@app_status_note,@from_apply,@created_at,@updated_at)
      ON CONFLICT(id) DO UPDATE SET
        type=excluded.type, date=excluded.date, employer=excluded.employer, role=excluded.role,
        method=excluded.method, contact=excluded.contact, url=excluded.url, notes=excluded.notes,
        app_status=excluded.app_status, app_status_note=excluded.app_status_note, updated_at=excluded.updated_at
    `).run({
      id: a.id, type: a.type ?? null, date: a.date ?? null, employer: a.employer ?? null,
      role: a.role ?? null, method: a.method ?? null, contact: a.contact ?? null, url: a.url ?? null,
      notes: a.notes ?? null, app_status: a.appStatus ?? null, app_status_note: a.appStatusNote ?? null,
      from_apply: a.fromApply ? 1 : 0, created_at: a.createdAt ?? Date.now(), updated_at: a.updatedAt ?? null,
    });
  }
  deleteActivity(id) { this.db.prepare('DELETE FROM activities WHERE id=?').run(id); }

  // ─── resumes ─────────────────────────────────────────────────────────────────
  getResumes() {
    return this.db.prepare('SELECT * FROM resumes').all().map(r => ({
      id: r.id, file: r.file, company: r.company, role: r.role, created: r.created,
      type: r.type, folder: r.folder, archived: !!r.archived,
    }));
  }
  putResume(r) {
    this.db.prepare(`
      INSERT INTO resumes (id,file,company,role,created,type,folder,archived)
      VALUES (@id,@file,@company,@role,@created,@type,@folder,@archived)
      ON CONFLICT(id) DO UPDATE SET file=excluded.file, company=excluded.company, role=excluded.role,
        created=excluded.created, type=excluded.type, folder=excluded.folder, archived=excluded.archived
    `).run({
      id: r.id, file: r.file ?? '', company: r.company ?? '', role: r.role ?? '',
      created: r.created ?? '', type: r.type ?? '', folder: r.folder ?? '', archived: r.archived ? 1 : 0,
    });
  }
  deleteResume(id) { this.db.prepare('DELETE FROM resumes WHERE id=?').run(id); }

  // ─── runs ────────────────────────────────────────────────────────────────────
  startRun({ now = Date.now() } = {}) {
    return this.db.prepare('INSERT INTO runs(started_at,status) VALUES(?,?)').run(now, 'running').lastInsertRowid;
  }
  finishRun(id, { sourceCounts = {}, jobCount = 0, scoredCount = 0, status = 'ok', note = '', now = Date.now() } = {}) {
    this.db.prepare('UPDATE runs SET finished_at=?, source_counts=?, job_count=?, scored_count=?, status=?, note=? WHERE id=?')
      .run(now, JSON.stringify(sourceCounts), jobCount, scoredCount, status, note, id);
  }
  lastRun() { return this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() || null; }

  // ─── migrate: import an Adli-format backup JSON (lossless, count-verified) ────
  /**
   * @param {object} backup — Adli's export: { data: { jd_settings, jd_activities, jd_dismissed, jd_resumes, jd_job_cache } }
   * @returns {{settings:number, activities:number, dismissed:number, resumes:number, jobs:number}} imported counts
   */
  migrateFromBackup(backup) {
    const data = backup && backup.data ? backup.data : backup || {};
    const parse = (v, fallback) => {
      if (v == null) return fallback;
      if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
      return v;
    };
    const counts = { settings: 0, activities: 0, dismissed: 0, resumes: 0, jobs: 0 };
    const now = Date.now();

    this.db.prepare('BEGIN').run();
    try {
      // settings
      const settings = parse(data.jd_settings, null);
      if (settings && typeof settings === 'object') { this._setSettingsRaw(settings); counts.settings = Object.keys(settings).length; }

      // activities (the compliance log — never drop)
      const acts = parse(data.jd_activities, {});
      for (const [id, a] of Object.entries(acts || {})) { this.putActivity({ ...a, id: a.id || id }); counts.activities++; }

      // resumes
      const resumes = parse(data.jd_resumes, []);
      for (const r of resumes || []) { if (r && r.id) { this.putResume(r); counts.resumes++; } }

      // job cache
      const cache = parse(data.jd_job_cache, {});
      const cacheJobs = Array.isArray(cache) ? cache : Object.values(cache || {});
      for (const j of cacheJobs) { if (j && j.guid) { this.upsertJob(j, { now }); counts.jobs++; } }

      // dismissed (map guid -> {reason, dismissedAt, companyName, title}); array form = bare guids
      const dismissed = parse(data.jd_dismissed, {});
      if (Array.isArray(dismissed)) {
        for (const guid of dismissed) { this.dismissJob(guid, '', { now }); counts.dismissed++; }
      } else {
        for (const [guid, d] of Object.entries(dismissed || {})) {
          this.dismissJob(guid, (d && d.reason) || '', {
            job: { guid, companyName: (d && d.companyName) || '', title: (d && d.title) || '' },
            now: (d && d.dismissedAt) || now,
          });
          counts.dismissed++;
        }
      }
      this.db.prepare('COMMIT').run();
    } catch (e) { this.db.prepare('ROLLBACK').run(); throw e; }
    return counts;
  }

  _setSettingsRaw(obj) {
    const stmt = this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const [k, v] of Object.entries(obj)) stmt.run(k, JSON.stringify(v));
  }
}

function safeJson(s, fallback) { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } }

module.exports = { JobScoutDB, DEFAULT_SETTINGS, defaultDbPath };
