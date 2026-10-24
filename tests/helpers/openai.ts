import { randomBytes } from 'node:crypto';

import env from '@config/env.js';

import { jsonResponse } from './fetchStub.js';
import { isRealService } from './services.js';

const OPENAI_RESPONSES = 'https://api.openai.com/v1/responses';

// the answer of the bot with its decision about a human admin, as the schema of the app asks
export type ModelReply = {
  reply: string;
  escalate: boolean;
  reason: 'DIRECT_ADMIN_REQUEST' | 'HUMAN_REQUIRED' | 'BOT_CANNOT_HELP' | 'NONE';
};

type OpenAiRequest = {
  model: string;
  instructions: string;
  input: Array<{ role: string; content: string }>;
  store?: boolean;
  max_output_tokens?: number;
  text?: { format?: { type?: string; name?: string; strict?: boolean } };
};

// one request of the app to the model: the answer of the bot (with its decision), or a fixed
// text of the app the model puts in the language of the customer
export type ModelCall = {
  purpose: 'answer' | 'fixed_text';
  // the text of the customer the request is about
  customerText: string;
  // what a fixed text has to say, empty for an answer
  meaning: string;
  request: OpenAiRequest;
};

// a reply, a fixed text, or a whole answer of openai (a failure, a cut answer)
export type ModelAnswer = ModelReply | string | Response;

const between = (text: string, open: string, close: string) =>
  text.includes(open)
    ? text.slice(text.indexOf(open) + open.length, text.indexOf(close)).trim()
    : '';

function callOf(request: OpenAiRequest): ModelCall {
  const last = request.input.at(-1)?.content ?? '';

  if (request.text?.format?.name === 'chat_bot_reply') {
    return {
      purpose: 'answer',
      customerText: last
        .slice(last.indexOf('customer_message:') + 'customer_message:'.length)
        .trim(),
      meaning: '',
      request,
    };
  }

  const developer = request.input.find((message) => message.role === 'developer')?.content ?? '';
  return {
    purpose: 'fixed_text',
    customerText: between(last, '<latest_customer_message>', '</latest_customer_message>'),
    meaning: between(developer, '<response_meaning>', '</response_meaning>'),
    request,
  };
}

// a bot that answers every question and never asks for an admin; a fixed text is its meaning
export const plainAnswer = (call: ModelCall): ModelAnswer =>
  call.purpose === 'answer'
    ? { reply: `Bot answer to: ${call.customerText}`, escalate: false, reason: 'NONE' }
    : `Fixed text: ${call.meaning}`;

const idOf = (prefix: string, length: number) =>
  `${prefix}${randomBytes(length).toString('hex').slice(0, length)}`;

// the body of an answer of the responses api, the way openai gives it (checked on 24.10.2026): the
// text is in the content of the message in output; output_text at the top is only a field the
// sdk of openai adds, the http answer has none. A cut answer is incomplete with its reason
export function modelBody(
  text: string,
  opts: { incomplete?: 'max_output_tokens' | 'content_filter' } = {},
) {
  const status = opts.incomplete ? 'incomplete' : 'completed';

  return {
    id: idOf('resp_', 50),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: opts.incomplete ? { reason: opts.incomplete } : null,
    model: `${env.OPENAI_MODEL}-2025-04-14`,
    output: [
      {
        id: idOf('msg_', 50),
        type: 'message',
        status,
        content: [{ type: 'output_text', annotations: [], logprobs: [], text }],
        role: 'assistant',
      },
    ],
    store: false,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

// the http answer of openai with that body
export const modelResponse = (text: string, opts: Parameters<typeof modelBody>[1] = {}) =>
  jsonResponse(modelBody(text, opts));

function responseOf(answer: ModelAnswer): Response {
  if (answer instanceof Response) return answer;

  return modelResponse(typeof answer === 'string' ? answer : JSON.stringify(answer));
}

let passOn: typeof fetch | null = null;
let keyBefore = '';

// the model of the bot answers the app from now until stopModel, through the handler, with a key
// made up for the run: nothing reaches openai. By assignment like the SendGrid wrapper, every other
// request passes untouched. Returns every request the app made
export function answerAsModel(
  handler: (call: ModelCall) => ModelAnswer | Promise<ModelAnswer> = plainAnswer,
): ModelCall[] {
  stopModel();

  const calls: ModelCall[] = [];
  const realFetch = globalThis.fetch;
  passOn = realFetch;
  keyBefore = env.OPENAI_API_KEY;
  env.OPENAI_API_KEY = 'sk-test-made-up-model-key';

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== OPENAI_RESPONSES) return realFetch(input, init);

    const call = callOf(JSON.parse(String(init?.body)) as OpenAiRequest);
    calls.push(call);
    return responseOf(await handler(call));
  }) as typeof fetch;

  return calls;
}

export const realOpenAi = isRealService('openai');

// the model of the bot for a test that runs with either model until stopModel: the test's own
// (plainAnswer) unless the run takes openai for real (service:openai), then openai itself with
// the test key (OPENAI_API_TEST_KEY, tests/setup/integration.setup.ts). Returns every request the
// app made, with the status of the answer
export function useModel(): Array<ModelCall & { status?: number }> {
  if (!realOpenAi) return answerAsModel();

  stopModel();

  const calls: Array<ModelCall & { status?: number }> = [];
  const realFetch = globalThis.fetch;
  passOn = realFetch;
  keyBefore = env.OPENAI_API_KEY;
  env.OPENAI_API_KEY = process.env.OPENAI_API_TEST_KEY!.trim();

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== OPENAI_RESPONSES) return realFetch(input, init);

    const call: ModelCall & { status?: number } = callOf(
      JSON.parse(String(init?.body)) as OpenAiRequest,
    );
    calls.push(call);
    const response = await realFetch(input, init);
    call.status = response.status;
    return response;
  }) as typeof fetch;

  return calls;
}

// the app is left without the model again, the way the tests run it otherwise
export function stopModel(): void {
  if (!passOn) return;

  globalThis.fetch = passOn;
  env.OPENAI_API_KEY = keyBefore;
  passOn = null;
}

// a promise the test lets go of when it wants: the model holds its answer until then
export function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { wait, open };
}
