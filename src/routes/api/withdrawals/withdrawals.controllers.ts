import type { ControllerRouter } from 'types/controller.js';
import type {
  WithdrawalFormBodyDto,
  WithdrawalItemsBodyDto,
  WithdrawalItemsResponseDto,
  WithdrawalProofBodyDto,
  WithdrawalReceivedResponseDto,
  WithdrawalRouteBodyDto,
  WithdrawalRouteResponseDto,
} from 'types/dto/withdrawals.dto.js';

import { withdrawalsServices } from './withdrawals.services.js';

const postRoute: ControllerRouter<
  {},
  WithdrawalRouteBodyDto,
  {},
  WithdrawalRouteResponseDto
> = async (req, reply) => {
  const result = await withdrawalsServices.routeWithdrawal(req.body);
  return reply.code(200).send(result);
};

const postItems: ControllerRouter<
  {},
  WithdrawalItemsBodyDto,
  {},
  WithdrawalItemsResponseDto
> = async (req, reply) => {
  const result = await withdrawalsServices.listWithdrawableItems(req.body);
  return reply.code(200).send(result);
};

const postForm: ControllerRouter<
  {},
  WithdrawalFormBodyDto,
  {},
  WithdrawalReceivedResponseDto
> = async (req, reply) => {
  const result = await withdrawalsServices.submitWithdrawalForm({ ...req.body, log: req.log });
  return reply.code(201).send(result);
};

const postProof: ControllerRouter<
  {},
  WithdrawalProofBodyDto,
  {},
  WithdrawalReceivedResponseDto
> = async (req, reply) => {
  const result = await withdrawalsServices.provideFormProof(req.body);
  return reply.code(200).send(result);
};

export const withdrawalsController = { postRoute, postItems, postForm, postProof };
