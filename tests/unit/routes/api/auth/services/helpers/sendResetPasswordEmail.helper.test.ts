import { describeLinkEmail } from './linkEmailCases.js';

describeLinkEmail('sendResetPasswordEmail', {
  specifier: '@routes/api/auth/services/helpers/sendResetPasswordEmail.helper.js',
  pick:
    (module) =>
    ({ to, token, expiresAt }) =>
      module.sendResetPasswordEmail({ to, resetToken: token, expiresAt }),
  linkPath: '/web/auth/reset',
  failureCode: 'RESET_EMAIL_SEND_FAILED',
});
