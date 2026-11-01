import type { FastifyRequest } from 'fastify';

import type { ControllerRouter } from 'types/controller.js';
import type { User } from 'types/user.js';
import type {
  AttributeParamsDto,
  AttributesListQueryDto,
  CategoryParamsDto,
  GroupParamsDto,
  OptionParamsDto,
} from 'types/dto/attributes.dto.js';
import { attributesServices as services } from './attributes.services.js';

// the actor of a request: authGuard and requireRole have let an admin or a root through
const actorOf = (req: FastifyRequest) => {
  const { id, role } = req.user as User;
  return { actorId: id, actorRole: role };
};

// a handler of a route: its params, body and query typed, the answer free
type Handler<P = {}, B = unknown, Q = {}> = ControllerRouter<P, B, Q, unknown>;

// the groups
const postGroup: Handler = async (req, reply) =>
  reply.code(201).send(await services.createAttributeGroup({ ...actorOf(req), body: req.body }));

const getGroups: Handler = async (req, reply) =>
  reply.code(200).send(await services.listAttributeGroups(actorOf(req)));

const patchGroup: Handler<GroupParamsDto> = async (req, reply) =>
  reply.code(200).send(
    await services.updateAttributeGroup({
      ...actorOf(req),
      groupId: Number(req.params.groupId),
      body: req.body,
    }),
  );

const putGroupsOrder: Handler = async (req, reply) =>
  reply.code(200).send(await services.reorderAttributeGroups({ ...actorOf(req), body: req.body }));

const deleteGroup: Handler<GroupParamsDto> = async (req, reply) =>
  reply
    .code(200)
    .send(
      await services.deleteAttributeGroup({ ...actorOf(req), groupId: Number(req.params.groupId) }),
    );

// the characteristics
const postAttribute: Handler = async (req, reply) =>
  reply.code(201).send(await services.createAttribute({ ...actorOf(req), body: req.body }));

const getAttributes: Handler<{}, unknown, AttributesListQueryDto> = async (req, reply) => {
  const { q, groupId, type } = req.query;

  return reply.code(200).send(
    await services.listAttributes({
      ...actorOf(req),
      ...(q?.trim() ? { q: q.trim() } : {}),
      ...(groupId !== undefined ? { groupId } : {}),
      ...(type ? { type } : {}),
    }),
  );
};

const getAttribute: Handler<AttributeParamsDto> = async (req, reply) =>
  reply
    .code(200)
    .send(
      await services.getAttribute({ ...actorOf(req), attributeId: Number(req.params.attributeId) }),
    );

const patchAttribute: Handler<AttributeParamsDto> = async (req, reply) =>
  reply.code(200).send(
    await services.updateAttribute({
      ...actorOf(req),
      attributeId: Number(req.params.attributeId),
      body: req.body,
    }),
  );

const putAttributesOrder: Handler<GroupParamsDto> = async (req, reply) =>
  reply.code(200).send(
    await services.reorderGroupAttributes({
      ...actorOf(req),
      groupId: Number(req.params.groupId),
      body: req.body,
    }),
  );

const deleteAttribute: Handler<AttributeParamsDto> = async (req, reply) =>
  reply.code(200).send(
    await services.deleteAttribute({
      ...actorOf(req),
      attributeId: Number(req.params.attributeId),
    }),
  );

// the values of a choice
const postOption: Handler<AttributeParamsDto> = async (req, reply) =>
  reply.code(201).send(
    await services.createAttributeOption({
      ...actorOf(req),
      attributeId: Number(req.params.attributeId),
      body: req.body,
    }),
  );

const getOptions: Handler<AttributeParamsDto> = async (req, reply) =>
  reply.code(200).send(
    await services.listAttributeOptions({
      ...actorOf(req),
      attributeId: Number(req.params.attributeId),
    }),
  );

const patchOption: Handler<OptionParamsDto> = async (req, reply) =>
  reply.code(200).send(
    await services.updateAttributeOption({
      ...actorOf(req),
      attributeId: Number(req.params.attributeId),
      optionId: Number(req.params.optionId),
      body: req.body,
    }),
  );

const putOptionsOrder: Handler<AttributeParamsDto> = async (req, reply) =>
  reply.code(200).send(
    await services.reorderAttributeOptions({
      ...actorOf(req),
      attributeId: Number(req.params.attributeId),
      body: req.body,
    }),
  );

const postOptionReplace: Handler<OptionParamsDto> = async (req, reply) =>
  reply.code(200).send(
    await services.replaceAttributeOption({
      ...actorOf(req),
      attributeId: Number(req.params.attributeId),
      optionId: Number(req.params.optionId),
      body: req.body,
    }),
  );

const deleteOption: Handler<OptionParamsDto> = async (req, reply) =>
  reply.code(200).send(
    await services.deleteAttributeOption({
      ...actorOf(req),
      attributeId: Number(req.params.attributeId),
      optionId: Number(req.params.optionId),
    }),
  );

// the characteristics a category asks for
const getCategoryAttributes: Handler<CategoryParamsDto> = async (req, reply) =>
  reply.code(200).send(
    await services.getCategoryAttributes({
      ...actorOf(req),
      categoryId: Number(req.params.categoryId),
    }),
  );

const putCategoryAttributes: Handler<CategoryParamsDto> = async (req, reply) =>
  reply.code(200).send(
    await services.setCategoryAttributes({
      ...actorOf(req),
      categoryId: Number(req.params.categoryId),
      body: req.body,
    }),
  );

export const attributesController = {
  getCategoryAttributes,
  putCategoryAttributes,
  postGroup,
  getGroups,
  patchGroup,
  putGroupsOrder,
  deleteGroup,
  postAttribute,
  getAttributes,
  getAttribute,
  patchAttribute,
  putAttributesOrder,
  deleteAttribute,
  postOption,
  getOptions,
  patchOption,
  putOptionsOrder,
  postOptionReplace,
  deleteOption,
};
