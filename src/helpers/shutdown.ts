type ShutdownLog = {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

type ShutdownOptions = {
  // run one after another: stop the workers, close the app, close redis, flush the logs
  steps: Array<() => void | Promise<void>>;
  // a request or a worker step that never ends must not keep the old process alive on deploy
  deadlineMs: number;
  log: ShutdownLog;
  exit: (code: number) => void;
};

// the handler of SIGINT and SIGTERM: runs the steps once, exits with 0 when they all ended,
// with 1 when one failed or they took longer than the deadline; a second signal exits at once
export function createShutdown({ steps, deadlineMs, log, exit }: ShutdownOptions) {
  let started = false;
  let exited = false;

  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  return async (signal: string): Promise<void> => {
    if (started) {
      log.info({ signal }, 'second signal during shutdown, exiting now');
      exitOnce(1);
      return;
    }
    started = true;

    log.info({ signal }, 'shutting down');

    const deadline = setTimeout(() => {
      log.error({ deadlineMs }, 'shutdown took longer than its deadline, exiting');
      exitOnce(1);
    }, deadlineMs);
    deadline.unref?.();

    try {
      for (const step of steps) await step();

      clearTimeout(deadline);
      exitOnce(0);
    } catch (err) {
      clearTimeout(deadline);
      log.error({ err }, 'shutdown failed');
      exitOnce(1);
    }
  };
}
