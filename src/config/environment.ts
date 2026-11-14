import env from '@config/env.js';

// The name of the environment the server runs in: prod, test, or dev for anything else. Every
// environment numbers its rows from 1, so what it leaves at an outside service shared by the
// environments carries this name: the folders of the files (without it user 5 of dev and user 5 of
// prod would write and delete the same file), the tags of the mails of the newsletters (the webhook
// of each environment hears the events of the other's mails too)
export const ENVIRONMENT_NAME =
  env.NODE_ENV === 'production' ? 'prod' : env.NODE_ENV === 'test' ? 'test' : 'dev';
