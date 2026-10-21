import { CLOUDINARY_PLACEHOLDERS, isolateEnv } from './isolateEnv.js';

// unit tests use no database or redis, a closed local port makes an accidental call fail at once
isolateEnv({
  DATABASE_URL: 'postgresql://unit:unit@127.0.0.1:9/unit_tests_use_no_database',
  REDIS_URL: 'redis://127.0.0.1:9',
  // unit tests never reach cloudinary: the made-up keys, and no CLOUDINARY_URL of a ci secret
  CLOUDINARY_URL: '',
  ...CLOUDINARY_PLACEHOLDERS,
});
