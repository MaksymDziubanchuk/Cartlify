import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { AUDIT_EVENTS } from '@config/journalEvents.js';

// The events the newsletters write to the admin log (src/config/journalEvents.ts): every one the code
// writes is declared (the database holds the shape of an event only, so a misspelled event would be
// written and never listed for the checkboxes of the log), and every one declared is written by a
// route (an event nothing writes is a checkbox that finds nothing)

const SRC_DIR = path.resolve('src');

// the files that declare the events and pair them with a kind of thing and an action; the rest of
// the source is the places that write them
const DECLARING = new Set(
  ['config/journalEvents.ts', 'db/adminAudit.helper.ts'].map((file) => path.join(SRC_DIR, file)),
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

// an event written as a string: 'newsletter.campaign_created'
const WRITTEN = /(['"])(newsletter\.[a-z_]+)\1/g;

const declared = AUDIT_EVENTS.filter((event) => event.startsWith('newsletter.'));

const written = new Map<string, string[]>();
for (const file of sourceFiles(SRC_DIR)) {
  if (DECLARING.has(file)) continue;

  for (const match of readFileSync(file, 'utf8').matchAll(WRITTEN)) {
    const event = match[2]!;
    written.set(event, [...(written.get(event) ?? []), path.relative(SRC_DIR, file)]);
  }
}

describe('the events of the newsletters in the admin log', () => {
  it('declares every event the code writes', () => {
    expect([...written.keys()].filter((event) => !declared.includes(event as never))).toEqual([]);
  });

  it('writes every event the log declares', () => {
    expect(declared.filter((event) => !written.has(event))).toEqual([]);
  });

  it('declares each event once, in the form domain.name', () => {
    expect(new Set(declared).size).toBe(declared.length);
    for (const event of declared) expect(event).toMatch(/^newsletter\.[a-z]+(?:_[a-z]+)*$/);
  });

  it('declares the thirteen events of the people who run the newsletters', () => {
    expect([...declared].sort()).toEqual(
      [
        'newsletter.block_added',
        'newsletter.block_removed',
        'newsletter.campaign_cancelled',
        'newsletter.campaign_copied',
        'newsletter.campaign_created',
        'newsletter.campaign_deleted',
        'newsletter.campaign_scheduled',
        'newsletter.campaign_stopped',
        'newsletter.campaign_test_sent',
        'newsletter.campaign_updated',
        'newsletter.manager_granted',
        'newsletter.manager_revoked',
        'newsletter.subscriber_erased',
      ].sort(),
    );
  });

  // the sending pass and the webhook run as the system, with no admin to name: what they do is in the
  // totals of the campaign and in the log of the subscription, not in the admin log
  it('has no event for what the system does', () => {
    for (const event of declared) {
      expect(event).not.toMatch(/started|finished|sent_mail|bounce|complaint|webhook/);
    }
  });
});
