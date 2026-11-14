import TestSequencer from '@jest/test-sequencer';

// a test file that changes what the whole shop does for everybody (a version of the terms every
// registration and every order has to accept) runs after every other file and alone: its name ends
// with .shopwide.test.ts, and tests/setup/integration.shopState.ts makes it wait for the files
// running before it. The unit files take no lock (they have no database), so they go first: left to
// the end by jest (they are short), they ran next to the first shopwide file and took the processor
// from it and from postgres. The order of the rest is the one jest picks, and the order of the
// shopwide files among themselves is the order of their paths: jest would put the longest first, which changes from
// run to run, and a shopwide file can depend on what the ones before it left. The campaigns of the
// newsletters stay in the window of the limit of campaigns for a day and the pass of the newsletters
// (tests/integration/worker) starts dozens at the real clock, so the files that schedule a campaign
// for now (api/newsletters/campaignsSchedule, flows/newsletterWatch) must run before it: by path they do
const BaseSequencer = TestSequencer.default ?? TestSequencer;

export const isShopWide = (testPath) => testPath.endsWith('.shopwide.test.ts');

export const isUnit = (testPath) => testPath.replace(/\\/g, '/').includes('/tests/unit/');

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export default class ShopWideLast extends BaseSequencer {
  async sort(tests) {
    const sorted = await super.sort(tests);

    return [
      ...sorted.filter((test) => isUnit(test.path)),
      ...sorted.filter((test) => !isUnit(test.path) && !isShopWide(test.path)),
      ...sorted.filter((test) => isShopWide(test.path)).sort(byPath),
    ];
  }
}
