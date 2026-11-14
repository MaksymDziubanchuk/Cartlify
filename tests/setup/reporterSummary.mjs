import { SummaryReporter } from '@jest/reporters';

import { timeInMinutes } from './runPace.mjs';

// The summary of jest as it is, with the time of the run told in minutes and seconds
// (tests/setup/runPace.mjs)
export default class SummaryInMinutes extends SummaryReporter {
  log(message) {
    super.log(timeInMinutes(message));
  }
}
