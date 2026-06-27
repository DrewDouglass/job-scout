/**
 * filters.js — Pure job-classification + filtering predicates.
 *
 * Ported VERBATIM from Adli Waziri's cowork-job-scout (test/utils.js). These
 * are the product wins we preserve: defense detection, work-arrangement match,
 * salary floor, non-salaried/contract detection, hybrid-outside-metro exclude.
 */

function isDefenseRole(job) {
  const t = [job.title, job.summary, job.companyName].filter(Boolean).join(' ').toLowerCase();
  return /clearance|secret|top secret|\bdod\b|military|defense contractor|homeland security/.test(t);
}

function getJobArrangement(job) {
  const types = (job.workplaceTypes || []).join(' ').toLowerCase();
  if (job.isRemote || types.includes('remote')) return 'remote';
  if (types.includes('hybrid')) return 'hybrid';
  return 'onsite';
}

function meetsWorkArrangement(job, cfg) {
  const arr = cfg.workArrangements || ['remote'];
  if (!arr.length) return true;
  return arr.includes(getJobArrangement(job));
}

function meetsMinSalary(job, min, hideNoSalary) {
  const nums = (job.salary || '').match(/\d[\d,]*/g);
  if (!nums) return !hideNoSalary;
  if (!min || min <= 0) return true;
  const maxVal = Math.max(...nums.map(n => parseInt(n.replace(/,/g, ''))));
  return (maxVal < 1000 ? maxVal * 1000 : maxVal) >= min;
}

function isNonSalaried(job) {
  const salary  = (job.salary || '').toLowerCase();
  const empType = (job.employmentType || '').toLowerCase();
  const summary = (job.summary || '').toLowerCase();
  if (/\/hr\b|per hour|\/hour/.test(salary)) return true;
  if (/\bcontract\b|\btemp\b|temporary|part.?time/.test(empType)) return true;
  if (/\b(c2c|1099|w-?2 contract|contract-to-hire|temp-to-perm|contract position|month contract)\b/.test(summary)) return true;
  return false;
}

/**
 * isHybridOutsideLocalArea — parameterized version.
 * In dashboard.html this calls getEffectiveLocalAreaRe(); here we take it directly.
 */
function isHybridOutsideLocalArea(job, localAreaRe) {
  if (job.isRemote) return false;
  const types = (job.workplaceTypes || []).join(' ').toLowerCase();
  if (types.includes('remote')) return false;
  const loc = (job.jobLocation?.displayName || '').toLowerCase();
  if (localAreaRe.test(loc)) return false;
  return true;
}

module.exports = {
  isDefenseRole,
  getJobArrangement,
  meetsWorkArrangement,
  meetsMinSalary,
  isNonSalaried,
  isHybridOutsideLocalArea,
};
