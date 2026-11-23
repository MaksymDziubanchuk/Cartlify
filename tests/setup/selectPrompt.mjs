// The list of the launcher (tests/run.mjs): the parts of the tests with a check box each, and the
// services with three states each (not run, the mock, the real service), in one list. Space checks a
// part and moves a service on to its next state. The key a checks every part and takes every service
// to its last state (real), and once all are there clears them all. Built on the core of the prompts
// of @inquirer, the way their checkbox is, since a check box has two states only

import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isSpaceKey,
  isUpKey,
  makeTheme,
  Separator,
  useKeypress,
  usePagination,
  usePrefix,
  useState,
} from '@inquirer/core';
import { styleText } from 'node:util';

// the terminal hides its cursor while the list is drawn, the way the prompts of @inquirer do
const cursorHide = '\u001b[?25l';

const isRow = (item) => !Separator.isSeparator(item);

// the mark of a row: a part checked or not, a service in its state
const markOf = (item) => {
  if (item.states) {
    return {
      skip: '[ ] skip',
      mock: styleText('yellow', '[m] mock'),
      real: styleText('green', '[r] real'),
    }[item.state];
  }
  return item.checked ? styleText('green', '[x]') : '[ ]';
};

const nextOf = (item) =>
  item.states
    ? { ...item, state: item.states[(item.states.indexOf(item.state) + 1) % item.states.length] }
    : { ...item, checked: !item.checked };

// a row at its fullest: a part checked, a service at its last state (real)
const isFull = (item) => (item.states ? item.state === item.states.at(-1) : item.checked);

// the key a: every row at its fullest, and once all of them are, every row back to its first state
// (no part checked, every service not run)
const allOf = (item, full) =>
  item.states
    ? { ...item, state: full ? item.states.at(-1) : item.states[0] }
    : { ...item, checked: full };

// choices: separators, parts { value, name, checked } and services { value, name, states, state };
// the answer: { parts: [value], services: { value: state } }
export const selectPrompt = createPrompt((config, done) => {
  const { pageSize = 7 } = config;
  const theme = makeTheme({}, config.theme);
  const [status, setStatus] = useState('idle');
  const prefix = usePrefix({ status, theme });
  const [items, setItems] = useState(config.choices);
  const first = items.findIndex(isRow);
  const last = items.findLastIndex(isRow);
  const [active, setActive] = useState(first);
  const [error, setError] = useState();

  const answerOf = () => ({
    parts: items.filter((item) => isRow(item) && !item.states && item.checked).map((i) => i.value),
    services: Object.fromEntries(
      items.filter((item) => isRow(item) && item.states).map((item) => [item.value, item.state]),
    ),
  });

  useKeypress((key) => {
    if (status !== 'idle') return;
    if (isEnterKey(key)) {
      const answer = answerOf();
      if (!answer.parts.length) {
        setError('Select at least one part');
        return;
      }
      setStatus('done');
      done(answer);
    } else if (isUpKey(key) || isDownKey(key)) {
      setError(undefined);
      const offset = isUpKey(key) ? -1 : 1;
      // stop at the first and last row instead of jumping around a scrolled list
      if ((offset < 0 && active === first) || (offset > 0 && active === last)) return;
      let next = active;
      do next += offset;
      while (!isRow(items[next]));
      setActive(next);
    } else if (isSpaceKey(key)) {
      setError(undefined);
      setItems(items.map((item, i) => (i === active ? nextOf(item) : item)));
    } else if (key.name === 'a') {
      setError(undefined);
      const full = !items.filter(isRow).every(isFull);
      setItems(items.map((item) => (isRow(item) ? allOf(item, full) : item)));
    }
  });

  const message = theme.style.message(config.message, status);
  if (status === 'done') {
    const answer = answerOf();
    const services = Object.entries(answer.services)
      .filter(([, state]) => state !== 'skip')
      .map(([name, state]) => `${name} ${state}`);
    return [prefix, message, theme.style.answer([...answer.parts, ...services].join(', '))].join(
      ' ',
    );
  }

  const page = usePagination({
    items,
    active,
    renderItem({ item, isActive }) {
      if (!isRow(item)) return ` ${item.separator}`;
      const cursor = isActive ? '>' : ' ';
      const line = `${cursor}${markOf(item)} ${item.name}`;
      return isActive ? theme.style.highlight(line) : line;
    },
    pageSize,
    loop: false,
  });
  const help = styleText(
    'dim',
    'up/down move, space checks or moves a service on (skip, mock, real), a all real, enter runs',
  );
  return `${[[prefix, message].join(' '), page, ' ', error ? theme.style.error(error) : '', help]
    .filter(Boolean)
    .join('\n')
    .trimEnd()}${cursorHide}`;
});

export { Separator };
