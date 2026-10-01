// dom.test.mjs — the harness has to be right about the browser, or every test
// that trusts it is worth nothing (#1059).
//
// This file exists because the shim once disagreed with the DOM and every
// suite still passed: it agreed with ITSELF. The disagreement was found by
// driving the live page by hand, which is exactly the work the harness was
// built to remove, so the behaviour is pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createElement, fire, listens, find, findAll, byClass, installDom } from './dom.mjs';

test('#1059: assigning textContent leaves a text node, so a later appendChild does not erase it', () => {
  // THE DEFECT. `renderGovernanceNav` builds a button as
  // `el('button', null, 'Verdict queue')` and then appends a count span. In a
  // browser the button reads "Verdict queue (1)". The shim kept the assigned
  // string in a field beside the children and returned it only when there were
  // none, so the label vanished the moment anything was appended and the
  // button read " (1)".
  const button = createElement('button');
  button.textContent = 'Verdict queue';
  const count = createElement('span');
  count.textContent = ' (1)';
  button.appendChild(count);

  assert.equal(button.textContent, 'Verdict queue (1)', 'both halves survive, in order');
});

test('#1059: assigning textContent replaces whatever was there, as the DOM does', () => {
  const node = createElement('div');
  node.appendChild(createElement('span')).textContent = 'old';
  node.textContent = 'new';
  assert.equal(node.textContent, 'new');
  assert.equal(node.childNodes.length, 1, 'one text node, not the old element beside it');
});

test('#1059: an empty assignment leaves no child, and reads back empty', () => {
  const node = createElement('div');
  node.textContent = 'something';
  node.textContent = '';
  assert.equal(node.textContent, '');
  assert.equal(node.childNodes.length, 0);
});

test('#1059: nested text concatenates depth first, in document order', () => {
  const row = createElement('div');
  const a = createElement('span');
  a.textContent = 'a';
  const wrap = createElement('span');
  const b = createElement('em');
  b.textContent = 'b';
  wrap.appendChild(b);
  row.appendChild(a);
  row.appendChild(wrap);
  assert.equal(row.textContent, 'ab');
});

test('#1059: a fragment hands over its children and keeps none', () => {
  const frag = createElement('#fragment');
  const one = createElement('span');
  one.textContent = '1';
  const two = createElement('span');
  two.textContent = '2';
  frag.appendChild(one);
  frag.appendChild(two);

  const host = createElement('div');
  host.appendChild(frag);
  assert.equal(host.childNodes.length, 2);
  assert.equal(frag.childNodes.length, 0, 'the fragment is spent, as in the DOM');
  assert.equal(host.textContent, '12');
});

test('#1059: classList writes through className, so both views of a class agree', () => {
  const node = createElement('div');
  node.className = 'card';
  node.classList.add('selected');
  assert.equal(node.className, 'card selected');
  assert.ok(node.classList.contains('card'));
  node.classList.remove('card');
  assert.equal(node.className, 'selected');
  assert.ok(byClass('selected')(node));
  assert.ok(!byClass('card')(node));
});

test('#1059: fire runs the listeners a node was given, and refuses a node that has none', () => {
  const node = createElement('button');
  let calls = 0;
  node.addEventListener('click', () => { calls += 1; });
  assert.ok(listens(node, 'click'));
  assert.ok(!listens(node, 'keydown'));
  fire(node, 'click');
  assert.equal(calls, 1);

  // A test that fires at a node with no handler is asserting nothing. It must
  // fail loudly rather than pass quietly.
  assert.throws(() => fire(node, 'keydown'), /no keydown listener/);
});

test('#1059: find walks the tree depth first and find returns the first match', () => {
  const root = createElement('div');
  const first = createElement('span');
  first.className = 'hit';
  const branch = createElement('div');
  const second = createElement('span');
  second.className = 'hit';
  branch.appendChild(second);
  root.appendChild(first);
  root.appendChild(branch);

  assert.equal(findAll(root, byClass('hit')).length, 2);
  assert.equal(find(root, byClass('hit')), first);
});

test('#1059: installDom restores every global it replaced', () => {
  const before = { document: globalThis.document, fetch: globalThis.fetch, EventSource: globalThis.EventSource };
  const dom = installDom({ mountIds: ['canvas'] });
  assert.notEqual(globalThis.document, before.document, 'the shim is installed');
  dom.restore();
  assert.equal(globalThis.document, before.document, 'and taken back out — a harness that leaks its globals poisons every later test in the run');
  assert.equal(globalThis.fetch, before.fetch);
  assert.equal(globalThis.EventSource, before.EventSource);
});
