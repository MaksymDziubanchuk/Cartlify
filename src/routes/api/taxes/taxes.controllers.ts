import type { ControllerRouter } from 'types/controller.js';
import type {
  GetShopCountriesResponseDto,
  GetTaxGroupsResponseDto,
  PatchTaxGroupBodyDto,
  PostCopyExceptionsBodyDto,
  PostCopyExceptionsResponseDto,
  PostTaxGroupBodyDto,
  PutShopCountryBodyDto,
  ShopCountryDto,
  TaxGroupDto,
} from 'types/dto/taxes.dto.js';
import type { UserEntity } from 'types/user.js';

import {
  copyShopCountryExceptions,
  deleteShopCountry,
  getShopCountries,
  getShopCountry,
  putShopCountry,
} from './services/countries.service.js';
import {
  deleteTaxGroup,
  getTaxGroups,
  patchTaxGroup,
  postTaxGroup,
} from './services/taxGroups.service.js';

type CountryParams = { country: string };
type GroupParams = { groupId: string };

// root: GET /api/root/countries
const getCountries: ControllerRouter<{}, {}, {}, GetShopCountriesResponseDto> = async (
  _req,
  reply,
) => reply.code(200).send(await getShopCountries());

// root: GET /api/root/countries/:country
const getCountry: ControllerRouter<CountryParams, {}, {}, ShopCountryDto> = async (req, reply) =>
  reply.code(200).send(await getShopCountry(req.params.country));

// root: PUT /api/root/countries/:country
const putCountry: ControllerRouter<
  CountryParams,
  PutShopCountryBodyDto,
  {},
  ShopCountryDto
> = async (req, reply) => {
  const { id } = req.user as UserEntity;
  const result = await putShopCountry({ actorId: id, country: req.params.country, body: req.body });
  return reply.code(200).send(result);
};

// root: DELETE /api/root/countries/:country
const deleteCountry: ControllerRouter<CountryParams, {}, {}, null> = async (req, reply) => {
  const { id } = req.user as UserEntity;
  await deleteShopCountry({ actorId: id, country: req.params.country });
  return reply.code(204).send();
};

// root: POST /api/root/countries/:country/copy-exceptions
const postCopyExceptions: ControllerRouter<
  CountryParams,
  PostCopyExceptionsBodyDto,
  {},
  PostCopyExceptionsResponseDto
> = async (req, reply) => {
  const { id } = req.user as UserEntity;
  const result = await copyShopCountryExceptions({
    actorId: id,
    country: req.params.country,
    from: req.body.from,
  });
  return reply.code(200).send(result);
};

// root: GET /api/root/tax-groups
const getGroups: ControllerRouter<{}, {}, {}, GetTaxGroupsResponseDto> = async (req, reply) => {
  const { id } = req.user as UserEntity;
  return reply.code(200).send(await getTaxGroups(id));
};

// root: POST /api/root/tax-groups
const postGroup: ControllerRouter<{}, PostTaxGroupBodyDto, {}, TaxGroupDto> = async (
  req,
  reply,
) => {
  const { id } = req.user as UserEntity;
  return reply.code(201).send(await postTaxGroup({ actorId: id, body: req.body }));
};

// root: PATCH /api/root/tax-groups/:groupId
const patchGroup: ControllerRouter<GroupParams, PatchTaxGroupBodyDto, {}, TaxGroupDto> = async (
  req,
  reply,
) => {
  const { id } = req.user as UserEntity;
  const result = await patchTaxGroup({
    actorId: id,
    id: Number(req.params.groupId),
    body: req.body,
  });
  return reply.code(200).send(result);
};

// root: DELETE /api/root/tax-groups/:groupId
const deleteGroup: ControllerRouter<GroupParams, {}, {}, null> = async (req, reply) => {
  const { id } = req.user as UserEntity;
  await deleteTaxGroup({ actorId: id, id: Number(req.params.groupId) });
  return reply.code(204).send();
};

export const taxesController = {
  getCountries,
  getCountry,
  putCountry,
  deleteCountry,
  postCopyExceptions,
  getGroups,
  postGroup,
  patchGroup,
  deleteGroup,
};
