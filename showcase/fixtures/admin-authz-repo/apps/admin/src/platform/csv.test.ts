// Unit tests of the reference toCsvCell / toCsv (FE §8.4 cap:import-export).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, toCsvCell } from './csv.ts';

test('text cells starting with = + - @ tab or CR are neutralized with a leading apostrophe', () => {
  assert.equal(toCsvCell('=1+1'), "'=1+1");
  assert.equal(toCsvCell('+1'), "'+1");
  assert.equal(toCsvCell('-1'), "'-1");
  assert.equal(toCsvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(toCsvCell('\tcmd'), "'\tcmd");
  assert.equal(toCsvCell('\rcmd'), `"'\rcmd"`);
});

test('numbers and booleans are written raw; empty values are empty cells', () => {
  assert.equal(toCsvCell(-42.5), '-42.5');
  assert.equal(toCsvCell(0), '0');
  assert.equal(toCsvCell(Number.NaN), '');
  assert.equal(toCsvCell(true), 'true');
  assert.equal(toCsvCell(null), '');
  assert.equal(toCsvCell(undefined), '');
});

test('RFC 4180 quoting: commas, quotes and line breaks are quoted, quotes doubled', () => {
  assert.equal(toCsvCell('a,b'), '"a,b"');
  assert.equal(toCsvCell('say "hi"'), '"say ""hi"""');
  assert.equal(toCsvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(toCsvCell('plain'), 'plain');
  assert.equal(toCsvCell('=A1,B1'), `"'=A1,B1"`);
});

test('toCsv writes a header row and CRLF-terminated records', () => {
  assert.equal(toCsv([{ a: '=x', b: 2 }], ['a', 'b']), "a,b\r\n'=x,2\r\n");
});
