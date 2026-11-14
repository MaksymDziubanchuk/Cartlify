// Every outside service the app works with is a kind (src/providers/<kind>): payments, mail, files,
// ai, captcha, identity. A kind has an interface of its own in our words (types.ts: the actions,
// the answers, the errors the rest of the app knows), the names of its providers (names.ts, no sdk
// there, the schemas read it) and a registry (index.ts) the app asks. Each provider lives in a
// folder of its own (src/providers/<kind>/<name>/) with its client, its settings, its webhook and
// the way its answers become ours: no other file of the app names it (tests/unit/providers/
// boundaries.test.ts). A new provider is a new folder and a line in its registry.

// what every provider has, whatever its kind
export interface Provider<Name extends string = string> {
  // the name the settings, the requests and the database know it by
  name: Name;
  // the name people see, in the answers of the bot and in the descriptions of the api
  label: string;
}

// The provider of a kind the server works with one at a time (mail, files, ai, captcha): the one
// its setting names (MAIL_PROVIDER and the like, src/config/env.ts). A name the server has no
// provider for stops the start, with the names it knows
export function pickProvider<P extends Provider>(
  setting: string,
  chosen: string,
  providers: readonly P[],
): P {
  const provider = providers.find((candidate) => candidate.name === chosen);

  if (!provider) {
    throw new Error(
      `${setting} names no provider of this server; known: ${providers
        .map((candidate) => candidate.name)
        .join(', ')}`,
    );
  }

  return provider;
}
