import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { returnsSchema } from './returns.schemas.js';
import { returnsController } from './returns.controllers.js';

// the statements of withdrawal and of return, for an admin or a root: make one, read it, take its
// goods in, confirm the proof of the buyer, give the money back; a root also records money sent
// outside the app and closes rows without a refund
export default async function returnsRouter(app: FastifyInstance) {
  app.get(
    '/',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: returnsSchema.getReturnsSchema,
    },
    returnsController.getReturns,
  );
  app.post(
    '/',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
      schema: returnsSchema.postReturnSchema,
    },
    returnsController.postReturn,
  );
  app.get(
    '/:returnId',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('returnId')],
      schema: returnsSchema.getReturnSchema,
    },
    returnsController.getReturn,
  );
  app.post(
    '/:returnId/receive',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('returnId')],
      schema: returnsSchema.postReceiveItemsSchema,
    },
    returnsController.postReceiveItems,
  );
  app.post(
    '/:returnId/refund',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('returnId')],
      schema: returnsSchema.postRefundSchema,
    },
    returnsController.postRefund,
  );
  app.post(
    '/:returnId/refund/outside',
    {
      preHandler: [authGuard, requireRole(['ROOT']), validateId('returnId')],
      schema: returnsSchema.postRefundOutsideSchema,
    },
    returnsController.postRefundOutside,
  );
  app.post(
    '/:returnId/reimbursement',
    {
      preHandler: [authGuard, requireRole(['ROOT']), validateId('returnId')],
      schema: returnsSchema.postReimbursementSchema,
    },
    returnsController.postReimbursement,
  );
  app.post(
    '/:returnId/dispute',
    {
      preHandler: [authGuard, requireRole(['ROOT']), validateId('returnId')],
      schema: returnsSchema.postDisputeSchema,
    },
    returnsController.postDispute,
  );
  app.post(
    '/:returnId/close',
    {
      preHandler: [authGuard, requireRole(['ROOT']), validateId('returnId')],
      schema: returnsSchema.postCloseSchema,
    },
    returnsController.postClose,
  );
  app.post(
    '/:returnId/shipments',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('returnId')],
      schema: returnsSchema.postShipmentSchema,
    },
    returnsController.postShipment,
  );
  app.patch(
    '/:returnId/shipments/:shipmentId',
    {
      preHandler: [
        authGuard,
        requireRole(['ADMIN', 'ROOT']),
        validateId('returnId'),
        validateId('shipmentId'),
      ],
      schema: returnsSchema.patchShipmentCostSchema,
    },
    returnsController.patchShipmentCost,
  );
  app.post(
    '/:returnId/proof/confirm',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('returnId')],
      schema: returnsSchema.postConfirmProofSchema,
    },
    returnsController.postConfirmProof,
  );
  app.post(
    '/:returnId/accept',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT']), validateId('returnId')],
      schema: returnsSchema.postAcceptSchema,
    },
    returnsController.postAccept,
  );
}
