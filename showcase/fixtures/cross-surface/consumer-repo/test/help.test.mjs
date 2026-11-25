import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helpLink } from '../src/help.mjs';

test('help links are encoded', () => assert.equal(helpLink('a b'), '/help/a%20b'));
