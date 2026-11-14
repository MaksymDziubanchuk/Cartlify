import { DefaultReporter } from '@jest/reporters';

import { timeInMinutes } from './runPace.mjs';

// The reporter of jest as it is, with the time of its progress block told in minutes and seconds
// (tests/setup/runPace.mjs). The block is made by the status the reporter keeps; only its text is
// read on the way out, the lines stay as many as they were
export default class ProgressInMinutes extends DefaultReporter {
  constructor(...args) {
    super(...args);

    const status = this._status;
    const get = status.get.bind(status);
    status.get = () => {
      const block = get();
      return { ...block, content: timeInMinutes(block.content) };
    };
  }
}
