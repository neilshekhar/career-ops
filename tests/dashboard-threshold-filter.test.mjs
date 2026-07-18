import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { join } from 'node:path';
import { ROOT, pass } from './helpers.mjs';

const source = readFileSync(join(ROOT, 'dashboard/web/app.js'), 'utf8');
const sandbox = {
  console,
  document: { addEventListener() {} },
  setTimeout,
  clearTimeout,
};

vm.runInNewContext(
  `${source}
globalThis.__thresholdTest = {
  rolePassesThreshold,
  filterRoles,
  visibleScoredInboxRoles,
  setState(nextSettings, nextQuery = '', nextRoles = []) {
    settings = nextSettings;
    query = nextQuery;
    allRoles = nextRoles;
  },
};`,
  sandbox,
);

const testApi = sandbox.__thresholdTest;
const roles = [
  { id: 'high', company: 'Acme', title: 'Analyst', location: 'Melbourne', stage: 'inbox', status: 'scored', score: 4.4 },
  { id: 'low', company: 'Beta', title: 'Engineer', location: 'Sydney', stage: 'inbox', status: 'scored', score: 3.8 },
  { id: 'new', company: 'Gamma', title: 'Scientist', location: '', stage: 'inbox', status: 'new', score: null },
  { id: 'todo-low', company: 'Delta', title: 'Developer', location: '', stage: 'todo', status: 'prepare-queued', score: 3.5 },
];

testApi.setState({ score_threshold: 4 }, '', roles);
assert.deepEqual(
  Array.from(testApi.filterRoles(roles), (role) => role.id),
  ['high', 'new', 'todo-low'],
  'threshold should hide only below-floor scored Inbox roles',
);
assert.deepEqual(
  Array.from(testApi.visibleScoredInboxRoles(), (role) => role.id),
  ['high'],
  'bulk PREPARE should include only visible scored Inbox roles',
);

testApi.setState({ score_threshold: 4 }, 'gamma', roles);
assert.deepEqual(
  Array.from(testApi.filterRoles(roles), (role) => role.id),
  ['new'],
  'search and threshold filters should compose',
);

assert.equal(testApi.rolePassesThreshold(roles[1], 0), true);
assert.equal(testApi.rolePassesThreshold(roles[1], null), true);
pass('dashboard threshold filters scored Inbox roles without hiding unscored or in-progress work');
