import type { FastifyRequest } from 'fastify';

import { captchaProvider } from '@providers/captcha/index.js';

// The captcha of a form (the captcha provider): a preHandler, so it runs after the schema of the body
// has been checked (a body that fails it never costs a call to the provider), and put after the guards
// and the limits of the route in its list (a request those refuse costs none either), in front of
// anything the route does: a captcha that fails creates no account, sends no mail, writes no token.
// It reads the field captchaToken of the body (captchaTokenField, src/schemas/captchaField.ts) and
// the address of the visitor. The swagger names its two refusals for every route that has it
// (src/plugins/openapi.plugin.ts): 400 CAPTCHA_INVALID and 503 CAPTCHA_UNAVAILABLE
export default async function requireCaptcha(req: FastifyRequest): Promise<void> {
  const body = req.body;
  const token =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).captchaToken
      : undefined;

  await captchaProvider.verify({ token, ip: req.ip, log: req.log });
}
