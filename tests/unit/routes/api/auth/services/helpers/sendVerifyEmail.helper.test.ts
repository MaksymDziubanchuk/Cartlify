import { describeLinkEmail } from './linkEmailCases.js';

describeLinkEmail('sendVerifyEmail', {
  specifier: '@routes/api/auth/services/helpers/sendVerifyEmail.helper.js',
  pick: (module) => module.sendVerifyEmail,
  linkPath: '/web/login',
  failureCode: 'VERIFY_EMAIL_SEND_FAILED',
});
