import type { ControllerRouter } from 'types/controller.js';
import type { User } from 'types/user.js';
import type { MessageResponseDto } from 'types/common.js';
import type {
  DocumentDetailDto,
  DocumentDto,
  DocumentParamsDto,
  DocumentsListQueryDto,
  DocumentsListResponseDto,
  UpdateDocumentBodyDto,
  UploadedDocumentFile,
} from 'types/dto/documents.dto.js';
import { BadRequestError } from '@utils/errors.js';
import { MAX_DOCUMENT_SIZE_BYTES } from '@config/limits.js';
import { documentsServices } from './documents.services.js';
import {
  beginDocumentUpload,
  discardDocumentUploads,
} from './services/helpers/documents.helper.js';

const LIST_LIMIT_DEFAULT = 50;

// the form of a document: one PDF file in `file`, the title and the kind as text fields. The file is
// read into Cloudinary while the form is parsed, whatever the order of the parts; a request that is
// refused deletes it. The routes of the documents take files up to DOCUMENT_MAX_BYTES, the limit of
// the other forms is lower
const postDocument: ControllerRouter<{}, {}, {}, DocumentDto> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  if (!req.isMultipart()) throw new BadRequestError('MULTIPART_REQUIRED');

  let upload: Promise<UploadedDocumentFile> | undefined;
  let title: string | undefined;
  let kind: string | undefined;

  try {
    for await (const part of req.parts({ limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES } })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file') {
          part.file.resume();
          continue;
        }

        // one file to a document
        if (upload) {
          part.file.resume();
          throw new BadRequestError('DOCUMENT_MULTIPLE');
        }

        upload = beginDocumentUpload({ file: part.file, mimetype: part.mimetype });
        // awaited by the service; a failure before that must not stop the process
        upload.catch(() => undefined);
        continue;
      }

      const value = typeof part.value === 'string' ? part.value : String(part.value ?? '');
      if (value.includes('\u0000')) throw new BadRequestError('TEXT_NUL_FORBIDDEN');

      if (part.fieldname === 'title') title = value;
      else if (part.fieldname === 'kind') kind = value;
    }

    if (!upload) throw new BadRequestError('DOCUMENT_REQUIRED');

    const result = await documentsServices.createDocument({
      actorId,
      actorRole,
      upload,
      title,
      kind,
    });
    return reply.code(201).send(result);
  } catch (err) {
    // the file that waits on Cloudinary goes with the refused request
    if (upload) await discardDocumentUploads([upload], req.log);
    throw err;
  }
};

const getDocuments: ControllerRouter<
  {},
  {},
  DocumentsListQueryDto,
  DocumentsListResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;
  const { limit, cursor, q, kind, sortOrder } = req.query;

  const result = await documentsServices.listDocuments({
    actorId,
    actorRole,
    limit: limit ?? LIST_LIMIT_DEFAULT,
    sortOrder: sortOrder ?? 'asc',
    ...(cursor ? { cursor } : {}),
    ...(q?.trim() ? { q: q.trim() } : {}),
    ...(kind ? { kind } : {}),
  });
  return reply.code(200).send(result);
};

const getDocument: ControllerRouter<DocumentParamsDto, {}, {}, DocumentDetailDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await documentsServices.getDocument({
    actorId,
    actorRole,
    documentId: Number(req.params.documentId),
  });
  return reply.code(200).send(result);
};

const patchDocument: ControllerRouter<
  DocumentParamsDto,
  UpdateDocumentBodyDto,
  {},
  DocumentDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await documentsServices.updateDocument({
    actorId,
    actorRole,
    documentId: Number(req.params.documentId),
    body: req.body,
  });
  return reply.code(200).send(result);
};

const deleteDocument: ControllerRouter<DocumentParamsDto, {}, {}, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { id: actorId, role: actorRole } = req.user as User;

  const result = await documentsServices.deleteDocument({
    actorId,
    actorRole,
    documentId: Number(req.params.documentId),
    log: req.log,
  });
  return reply.code(200).send(result);
};

export const documentsController = {
  postDocument,
  getDocuments,
  getDocument,
  patchDocument,
  deleteDocument,
};
