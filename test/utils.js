/**
 * utils.js — Compatibility barrel.
 *
 * In Adli Waziri's original cowork-job-scout this file WAS the source of truth:
 * pure functions extracted from dashboard.html for testing. In the re-platformed
 * tool those functions now live in canonical modules under src/ (so the server,
 * the daily job, and the sources can all import them). This barrel re-exports
 * them under their original names so Adli's test/utils.test.js keeps passing
 * BYTE-FOR-BYTE — proving the port is behaviour-preserving.
 */

const format       = require('../src/lib/format');
const filters      = require('../src/scoring/filters');
const { keywordScore } = require('../src/scoring/keyword');
const jobs         = require('../src/lib/jobs');
const searchterms  = require('../src/lib/searchterms');
const { parseIndeedResults } = require('../src/sources/indeed-parse');

module.exports = {
  // src/lib/format.js
  normalizeForMatch: format.normalizeForMatch,
  esc: format.esc,
  scoreClass: format.scoreClass,
  sourceBadgeClass: format.sourceBadgeClass,
  typeInfo: format.typeInfo,
  formatDate: format.formatDate,
  fmtShortDate: format.fmtShortDate,
  getWeekBounds: format.getWeekBounds,
  // src/scoring/filters.js
  isDefenseRole: filters.isDefenseRole,
  getJobArrangement: filters.getJobArrangement,
  meetsWorkArrangement: filters.meetsWorkArrangement,
  meetsMinSalary: filters.meetsMinSalary,
  isNonSalaried: filters.isNonSalaried,
  isHybridOutsideLocalArea: filters.isHybridOutsideLocalArea,
  // src/scoring/keyword.js
  keywordScore,
  // src/lib/jobs.js
  getAppliedJobKeys: jobs.getAppliedJobKeys,
  getDismissedJobKeys: jobs.getDismissedJobKeys,
  // src/lib/searchterms.js
  getEffectiveDiceSearches: searchterms.getEffectiveDiceSearches,
  getEffectiveIndeedSearches: searchterms.getEffectiveIndeedSearches,
  getEffectiveZrSearches: searchterms.getEffectiveZrSearches,
  getEffectiveLocalAreaRe: searchterms.getEffectiveLocalAreaRe,
  // src/sources/indeed-parse.js
  parseIndeedResults,
};
