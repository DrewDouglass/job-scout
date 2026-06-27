/**
 * indeed-parse.js — Parse an Indeed/JSearch-style markdown text block into jobs.
 *
 * Ported VERBATIM from Adli Waziri's cowork-job-scout (test/utils.js). The old
 * Cowork Indeed connector returned a markdown text block in this shape; some
 * job-alert emails carry the same "**Field:** value" structure, so this stays
 * useful for the email readers. Pure + tested.
 */

function parseIndeedResults(text) {
  const jobs = [];
  if (!text) return jobs;
  for (const block of text.split(/\n(?=\*\*Job Title:\*\*)/).filter(b => b.includes('**Job Title:**'))) {
    const get = f => {
      const m = block.match(new RegExp(`\\*\\*${f}:\\*\\*\\s*([^\n]+)`));
      return m ? m[1].trim() : '';
    };
    const loc = get('Location');
    const isRemote = loc.toLowerCase().includes('remote');
    const comp = get('Compensation');
    jobs.push({
      guid: 'indeed_' + get('Job Id'),
      title: get('Job Title').replace(/^\(Remote\)\s*/i, '').trim(),
      companyName: get('Company'),
      jobLocation: { displayName: loc },
      postedDate: get('Posted on'),
      salary: comp === 'N/A' ? null : comp,
      employmentType: get('Job Type'),
      detailsPageUrl: get('View Job URL'),
      workplaceTypes: isRemote ? ['Remote'] : ['On-Site'],
      isRemote,
      source: 'Indeed',
      summary: '',
    });
  }
  return jobs;
}

module.exports = { parseIndeedResults };
