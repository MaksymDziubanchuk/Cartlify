import type { FastifyBaseLogger } from 'fastify';

import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { enabledLocaleOf } from '@helpers/locale.js';
import { mapWithLimit } from '@helpers/mapWithLimit.js';
import { newsletterAllowedDomains } from '@helpers/newsletterDomains.js';
import { NEWSLETTER_TRANSLATE_TOTAL_MAX } from '@schemas/dto/newslettersCampaign.dtoSchemas.js';
import { isAiServiceError } from '@services/ai/ai.errors.js';
import { aiClientService } from '@services/ai/aiClient.service.js';
import { AppError, BadRequestError } from '@utils/errors.js';
import type { AiErrorCode } from '@services/ai/ai.types.js';
import type {
  NewsletterTranslateBodyDto,
  NewsletterTranslateItemDto,
  NewsletterTranslateResponseDto,
  NewsletterTranslateWarningDto,
} from 'types/dto/newsletters.dto.js';

import {
  judgeTranslation,
  parseModelAnswer,
  type Judgement,
} from './helpers/translateAnswer.helper.js';
import { buildTranslateRequest } from './helpers/translatePrompt.helper.js';

// The translation of the texts of a campaign into other languages, for the people who write it. The
// model of openai gives a draft of each text in each language; the server keeps none of them and logs
// no text, the person edits the drafts and saves in the campaign the ones they keep. Nothing the model
// says is trusted: each draft is judged (helpers/translateAnswer.helper.ts) and one that fails is left
// out with its warning. One request to the model is for one language, a few at a time

// how many languages are asked of the model at once
const TRANSLATE_CONCURRENCY = 4;

// the model gave an answer, but a broken one: the same request is asked once more
const MAX_ATTEMPTS = 2;
const BROKEN_ANSWER_CODES = new Set<AiErrorCode>([
  'AI_INVALID_RESPONSE_FORMAT',
  'AI_EMPTY_RESPONSE',
]);

// the code of an answer that is not the json of the schema, in the log
const ANSWER_INVALID = 'TRANSLATE_ANSWER_INVALID';

type TranslateLog = Pick<FastifyBaseLogger, 'warn'>;

type Failure = { code: string; status: number | null };
type Outcome =
  { locale: string; answer: Map<string, string> } | { locale: string; failure: Failure };

const invalidLocale = (field: string, locale: string) =>
  new BadRequestError('LOCALE_INVALID', { field, locale });

// The languages of the request, as the keys of the texts of a campaign are written (exact, small
// letters): the one to translate from, the shop's own unless given, and each one to translate into,
// which the shop answers in, is not the first and is asked once. The one at fault is named
function checkLocales(dto: NewsletterTranslateBodyDto): string {
  const exact = (code: string) => enabledLocaleOf(code) === code;

  if (dto.from !== undefined && !exact(dto.from)) throw invalidLocale('from', dto.from);

  const from = dto.from ?? shopSettings().shopLocale;
  const seen = new Set<string>();

  dto.to.forEach((code, index) => {
    if (!exact(code) || code === from || seen.has(code)) {
      throw invalidLocale(`to[${index}]`, code);
    }
    seen.add(code);
  });

  return from;
}

// each key is used once: the drafts come back under it
function checkKeys(items: NewsletterTranslateItemDto[]): void {
  const seen = new Set<string>();

  items.forEach((item, index) => {
    if (seen.has(item.key)) {
      throw new BadRequestError('VALIDATION_ERROR', [
        { in: 'body', field: `items.${index}.key`, message: 'must be unique' },
      ]);
    }
    seen.add(item.key);
  });
}

// the texts of one request have so many characters in all at the most
function checkTotal(items: NewsletterTranslateItemDto[]): void {
  const length = items.reduce((sum, item) => sum + [...item.text].length, 0);

  if (length > NEWSLETTER_TRANSLATE_TOTAL_MAX) {
    throw new BadRequestError('NEWSLETTER_TRANSLATE_TOO_MUCH_TEXT', {
      limit: NEWSLETTER_TRANSLATE_TOTAL_MAX,
      length,
    });
  }
}

// a bad gateway with nothing of openai in it; the reason (a code of ours) and the status are for the
// log, never for the answer, and the cause is none: a message of openai quotes a part of the key
function translateFailed(failure: Failure): AppError {
  return new AppError({
    statusCode: 502,
    errorCode: 'NEWSLETTER_TRANSLATE_FAILED',
    message: 'Bad Gateway',
    details: { reason: failure.code, status: failure.status },
  });
}

// the warning of a draft that was refused: the language, the key of the text and why. A draft with an
// address that is not allowed also names the place, `<key>.<locale>` like the error of the content
// when the draft is saved, and the address
function warningOf(
  locale: string,
  key: string,
  verdict: Extract<Judgement, { ok: false }>,
): NewsletterTranslateWarningDto {
  if (verdict.code !== 'ADDRESS_NOT_ALLOWED') return { locale, key, code: verdict.code };

  return { locale, key, code: verdict.code, field: `${key}.${locale}`, address: verdict.address };
}

// Asks the model for one language. An answer that is broken (no text, or not the json of the schema)
// is asked for once more, any other failure (the time, the limit of openai, a refusal, an answer cut
// short) is not. Every failed attempt is a line of the log with the code, never a text. Gives the
// answer, or the failure of the last attempt; an error of our own is thrown
async function translateInto(
  from: string,
  locale: string,
  items: NewsletterTranslateItemDto[],
  log: TranslateLog,
): Promise<Outcome> {
  const request = buildTranslateRequest({ from, to: locale, items });
  const keys = items.map((item) => item.key);
  let failure: Failure = { code: ANSWER_INVALID, status: null };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const willRetry = attempt < MAX_ATTEMPTS;

    try {
      const result = await aiClientService.generateText(request);
      const answer = parseModelAnswer(result.text, keys);
      if (answer) return { locale, answer };

      failure = { code: ANSWER_INVALID, status: null };
      log.warn(
        { locale, attempt, willRetry, code: ANSWER_INVALID },
        'newsletter translation failed',
      );
    } catch (error) {
      if (!isAiServiceError(error)) throw error;

      const broken = BROKEN_ANSWER_CODES.has(error.code);
      failure = { code: error.code, status: error.statusCode };
      log.warn(
        {
          locale,
          attempt,
          willRetry: broken && willRetry,
          provider: error.provider,
          code: error.code,
          statusCode: error.statusCode,
        },
        'newsletter translation failed',
      );

      if (!broken) return { locale, failure };
    }
  }

  return { locale, failure };
}

// The drafts of the texts in the languages asked. The refusals come in this order: the languages
// (400 `LOCALE_INVALID`), a key used twice (400 `VALIDATION_ERROR`), too much text (400
// `NEWSLETTER_TRANSLATE_TOO_MUCH_TEXT`), then the model: with no key of openai, or when the request
// failed for every language, 502 `NEWSLETTER_TRANSLATE_FAILED`. When it failed for some languages
// only, the others come with their drafts and the ones that failed with a warning for each text
export async function translateNewsletterTexts(
  dto: NewsletterTranslateBodyDto,
  log: TranslateLog,
): Promise<NewsletterTranslateResponseDto> {
  const from = checkLocales(dto);
  checkKeys(dto.items);
  checkTotal(dto.items);

  if (!env.OPENAI_API_KEY.trim())
    throw translateFailed({ code: 'AI_NOT_CONFIGURED', status: null });

  const outcomes = await mapWithLimit(dto.to, TRANSLATE_CONCURRENCY, (locale) =>
    translateInto(from, locale, dto.items, log),
  );

  const failed = outcomes.filter(
    (outcome): outcome is { locale: string; failure: Failure } => 'failure' in outcome,
  );
  if (failed.length === outcomes.length) throw translateFailed(failed[0]!.failure);

  // read once for the whole answer: root may change the trusted domains between two requests, not inside one
  const domains = newsletterAllowedDomains();
  const translations: Record<string, Record<string, string>> = {};
  const warnings: NewsletterTranslateWarningDto[] = [];

  for (const outcome of outcomes) {
    const drafts: Array<[string, string]> = [];

    for (const item of dto.items) {
      if ('failure' in outcome) {
        warnings.push({ locale: outcome.locale, key: item.key, code: 'TRANSLATION_FAILED' });
        continue;
      }

      const verdict = judgeTranslation(item, outcome.answer.get(item.key), domains);
      if (verdict.ok) drafts.push([item.key, verdict.text]);
      else warnings.push(warningOf(outcome.locale, item.key, verdict));
    }

    translations[outcome.locale] = Object.fromEntries(drafts);
  }

  return { translations, warnings };
}
