import { isolateEnv } from './isolateEnv.js';

// unit tests use no database or redis, a closed local port makes an accidental call fail at once
isolateEnv({
  DATABASE_URL: 'postgresql://unit:unit@127.0.0.1:9/unit_tests_use_no_database',
  REDIS_URL: 'redis://127.0.0.1:9',
});
