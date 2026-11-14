import { login } from './services/login.service.js';
import { register } from './services/register.service.js';

import { oauthCallback, oauthStart } from './services/oauth.service.js';

import { resendVerify, verifyEmail } from './services/verifyEmail.service.js';

import { passwordForgot, passwordReset } from './services/passwordReset.service.js';

import { logout } from './services/logout.service.js';
import { refresh } from './services/refresh.service.js';
import { closeSession, listSessions } from './services/sessions.service.js';
import { changePassword } from './services/passwordChange.service.js';

export const authServices = {
  login,
  register,

  oauthStart,
  oauthCallback,

  resendVerify,
  verifyEmail,

  passwordForgot,
  passwordReset,

  logout,
  refresh,

  listSessions,
  closeSession,
  changePassword,
};
