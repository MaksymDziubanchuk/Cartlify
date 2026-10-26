import type { ControllerRouter } from 'types/controller.js';
import type {
  AcceptLegalDocumentsBodyDto,
  LegalAcceptanceStatusDto,
  LegalDocumentDto,
  LegalDocumentParamsDto,
  LegalDocumentsHistoryQueryDto,
  LegalDocumentsHistoryResponseDto,
  PublishLegalDocumentBodyDto,
} from 'types/dto/legal.dto.js';
import type { UserEntity } from 'types/user.js';

import { legalServices } from './legal.services.js';

const getCurrentDocuments: ControllerRouter<{}, {}, {}, { items: LegalDocumentDto[] }> = async (
  _req,
  reply,
) => reply.code(200).send(await legalServices.getCurrentLegalDocuments());

const getDocument: ControllerRouter<LegalDocumentParamsDto, {}, {}, LegalDocumentDto> = async (
  req,
  reply,
) => reply.code(200).send(await legalServices.getLegalDocument(Number(req.params.documentId)));

const getAcceptanceStatus: ControllerRouter<{}, {}, {}, LegalAcceptanceStatusDto> = async (
  req,
  reply,
) => {
  const { id } = req.user as UserEntity;
  return reply.code(200).send(await legalServices.getAcceptanceStatus(id));
};

const postAcceptances: ControllerRouter<
  {},
  AcceptLegalDocumentsBodyDto,
  {},
  LegalAcceptanceStatusDto
> = async (req, reply) => {
  const { id } = req.user as UserEntity;
  const result = await legalServices.acceptLegalDocuments({
    userId: id,
    documentIds: req.body.documentIds,
  });
  return reply.code(200).send(result);
};

// root
const postDocument: ControllerRouter<
  {},
  PublishLegalDocumentBodyDto,
  {},
  LegalDocumentDto
> = async (req, reply) => {
  const { id, role } = req.user as UserEntity;
  const result = await legalServices.publishLegalDocument({
    actorId: id,
    actorRole: role,
    kind: req.body.kind,
    title: req.body.title,
    content: req.body.content,
  });
  return reply.code(201).send(result);
};

const getDocuments: ControllerRouter<
  {},
  {},
  LegalDocumentsHistoryQueryDto,
  LegalDocumentsHistoryResponseDto
> = async (req, reply) => {
  const { id, role } = req.user as UserEntity;
  const result = await legalServices.listLegalDocuments({
    actorId: id,
    actorRole: role,
    kind: req.query.kind,
    limit: req.query.limit ?? 20,
    cursor: req.query.cursor,
  });
  return reply.code(200).send(result);
};

export const legalController = {
  getCurrentDocuments,
  getDocument,
  getAcceptanceStatus,
  postAcceptances,
  postDocument,
  getDocuments,
};
