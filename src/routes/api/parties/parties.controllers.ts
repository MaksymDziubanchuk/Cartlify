import type { ControllerRouter } from 'types/controller.js';
import type { User } from 'types/user.js';
import type { MessageResponseDto } from 'types/common.js';
import type {
  CreatePartyBodyDto,
  PartiesListQueryDto,
  PartiesListResponseDto,
  PartyDetailDto,
  PartyDto,
  PartyParamsDto,
  UpdatePartyBodyDto,
} from 'types/dto/parties.dto.js';
import { partiesServices } from './parties.services.js';

const LIST_LIMIT_DEFAULT = 50;

const postParty: ControllerRouter<{}, CreatePartyBodyDto, {}, PartyDto> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await partiesServices.createParty({ actorId, actorRole, body: req.body });
  return reply.code(201).send(result);
};

const getParties: ControllerRouter<{}, {}, PartiesListQueryDto, PartiesListResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;
  const { limit, cursor, q, country, sortOrder } = req.query;

  const result = await partiesServices.listParties({
    actorId,
    actorRole,
    limit: limit ?? LIST_LIMIT_DEFAULT,
    sortOrder: sortOrder ?? 'asc',
    ...(cursor ? { cursor } : {}),
    ...(q?.trim() ? { q: q.trim() } : {}),
    ...(country?.trim() ? { country: country.trim() } : {}),
  });
  return reply.code(200).send(result);
};

const getParty: ControllerRouter<PartyParamsDto, {}, {}, PartyDetailDto> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await partiesServices.getParty({
    actorId,
    actorRole,
    partyId: Number(req.params.partyId),
  });
  return reply.code(200).send(result);
};

const patchParty: ControllerRouter<PartyParamsDto, UpdatePartyBodyDto, {}, PartyDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await partiesServices.updateParty({
    actorId,
    actorRole,
    partyId: Number(req.params.partyId),
    body: req.body,
  });
  return reply.code(200).send(result);
};

const deleteParty: ControllerRouter<PartyParamsDto, {}, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await partiesServices.deleteParty({
    actorId,
    actorRole,
    partyId: Number(req.params.partyId),
  });
  return reply.code(200).send(result);
};

export const partiesController = {
  postParty,
  getParties,
  getParty,
  patchParty,
  deleteParty,
};
