import { FastifyInstance } from 'fastify';

import { requestLimits } from '../../../plugins/requestLimits.js';
import { withdrawalsSchema } from './withdrawals.schemas.js';
import { withdrawalsController } from './withdrawals.controllers.js';

// the public form of withdrawal and the proof of a parcel by the code of a mail, for a buyer with no
// account to sign in to: no login, and so the limits of attempts by address and by order
export default async function withdrawalsRouter(app: FastifyInstance) {
  app.post(
    '/route',
    { preHandler: [...requestLimits.withdrawalForm], schema: withdrawalsSchema.postRouteSchema },
    withdrawalsController.postRoute,
  );
  app.post(
    '/items',
    { preHandler: [...requestLimits.withdrawalForm], schema: withdrawalsSchema.postItemsSchema },
    withdrawalsController.postItems,
  );
  app.post(
    '/',
    { preHandler: [...requestLimits.withdrawalForm], schema: withdrawalsSchema.postFormSchema },
    withdrawalsController.postForm,
  );
  app.post(
    '/proof',
    { preHandler: [...requestLimits.withdrawalForm], schema: withdrawalsSchema.postProofSchema },
    withdrawalsController.postProof,
  );
}
