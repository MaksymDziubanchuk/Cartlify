import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { partiesSchema } from './parties.schemas.js';
import { partiesController } from './parties.controllers.js';

// the directory of the manufacturers and of the persons responsible in the EU, for an admin or a
// root; the buyer reads a party in the card of a product
export default async function partiesRouter(app: FastifyInstance) {
  app.post(
    '/',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: partiesSchema.postPartySchema,
    },
    partiesController.postParty,
  );
  app.get(
    '/',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: partiesSchema.getPartiesSchema,
    },
    partiesController.getParties,
  );
  app.get(
    '/:partyId',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('partyId')],
      schema: partiesSchema.getPartySchema,
    },
    partiesController.getParty,
  );
  app.patch(
    '/:partyId',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('partyId')],
      schema: partiesSchema.patchPartySchema,
    },
    partiesController.patchParty,
  );
  app.delete(
    '/:partyId',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('partyId')],
      schema: partiesSchema.deletePartySchema,
    },
    partiesController.deleteParty,
  );
}
