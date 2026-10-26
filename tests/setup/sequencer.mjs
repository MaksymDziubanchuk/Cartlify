import TestSequencer from '@jest/test-sequencer';

// a test file that changes what the whole shop does for everybody (a version of the terms every
// registration and every order has to accept) runs after every other file and alone: its name ends
// with .shopwide.test.ts, and tests/setup/integration.shopState.ts makes it wait for the files
// running before it. The order of the rest is the one jest picks
const BaseSequencer = TestSequencer.default ?? TestSequencer;

export const isShopWide = (testPath) => testPath.endsWith('.shopwide.test.ts');

export default class ShopWideLast extends BaseSequencer {
  async sort(tests) {
    const sorted = await super.sort(tests);

    return [
      ...sorted.filter((test) => !isShopWide(test.path)),
      ...sorted.filter((test) => isShopWide(test.path)),
    ];
  }
}
