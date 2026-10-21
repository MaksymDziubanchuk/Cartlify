// the external services this run takes for real: tests/run.mjs names them in TEST_REAL_SERVICES
// (a checkbox under Services, service:<name>); the others answer from their mocks, and so do all
// of them when jest runs without the launcher
export type TestService = 'sendgrid';

export const isRealService = (service: TestService): boolean =>
  (process.env.TEST_REAL_SERVICES ?? '').split(',').includes(service);
