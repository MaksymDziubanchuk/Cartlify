import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { attributesSchema as schema } from './attributes.schemas.js';
import { attributesController as controller } from './attributes.controllers.js';

// the directory of the characteristics a variant is described by, for an admin or a root: the
// groups, the characteristics and the values of a choice. The routes are under /api/admin
export default async function attributesRouter(app: FastifyInstance) {
  const admin = [authGuard, requireRole(['ADMIN', 'ROOT'])];
  const withId = (...names: string[]) => [...admin, ...names.map((name) => validateId(name))];

  // the groups
  app.post(
    '/attribute-groups',
    { preHandler: admin, schema: schema.postGroup },
    controller.postGroup,
  );
  app.get(
    '/attribute-groups',
    { preHandler: admin, schema: schema.getGroups },
    controller.getGroups,
  );
  app.put(
    '/attribute-groups/order',
    { preHandler: admin, schema: schema.putGroupsOrder },
    controller.putGroupsOrder,
  );
  app.patch(
    '/attribute-groups/:groupId',
    { preHandler: withId('groupId'), schema: schema.patchGroup },
    controller.patchGroup,
  );
  app.delete(
    '/attribute-groups/:groupId',
    { preHandler: withId('groupId'), schema: schema.deleteGroup },
    controller.deleteGroup,
  );
  app.put(
    '/attribute-groups/:groupId/attributes/order',
    { preHandler: withId('groupId'), schema: schema.putAttributesOrder },
    controller.putAttributesOrder,
  );

  // the characteristics
  app.post(
    '/attributes',
    { preHandler: admin, schema: schema.postAttribute },
    controller.postAttribute,
  );
  app.get(
    '/attributes',
    { preHandler: admin, schema: schema.getAttributes },
    controller.getAttributes,
  );
  app.get(
    '/attributes/:attributeId',
    { preHandler: withId('attributeId'), schema: schema.getAttribute },
    controller.getAttribute,
  );
  app.patch(
    '/attributes/:attributeId',
    { preHandler: withId('attributeId'), schema: schema.patchAttribute },
    controller.patchAttribute,
  );
  app.delete(
    '/attributes/:attributeId',
    { preHandler: withId('attributeId'), schema: schema.deleteAttribute },
    controller.deleteAttribute,
  );

  // the values of a choice
  app.post(
    '/attributes/:attributeId/options',
    { preHandler: withId('attributeId'), schema: schema.postOption },
    controller.postOption,
  );
  app.get(
    '/attributes/:attributeId/options',
    { preHandler: withId('attributeId'), schema: schema.getOptions },
    controller.getOptions,
  );
  app.put(
    '/attributes/:attributeId/options/order',
    { preHandler: withId('attributeId'), schema: schema.putOptionsOrder },
    controller.putOptionsOrder,
  );
  app.patch(
    '/attributes/:attributeId/options/:optionId',
    { preHandler: withId('attributeId', 'optionId'), schema: schema.patchOption },
    controller.patchOption,
  );
  app.post(
    '/attributes/:attributeId/options/:optionId/replace',
    { preHandler: withId('attributeId', 'optionId'), schema: schema.postOptionReplace },
    controller.postOptionReplace,
  );
  app.delete(
    '/attributes/:attributeId/options/:optionId',
    { preHandler: withId('attributeId', 'optionId'), schema: schema.deleteOption },
    controller.deleteOption,
  );
}
