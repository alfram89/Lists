import { describe, expect, it } from 'vitest';
import { Space } from '../src/core/space';
import {
  EXPORT_FORMAT,
  ImportError,
  exportFileName,
  exportSpace,
  importInto,
  parseExport,
} from '../src/core/export';

function sampleSpace(): Space {
  const space = new Space();
  const groceries = space.createList('Groceries');
  space.addItem(groceries, 'Milk');
  const bread = space.addItem(groceries, 'Bread')!;
  space.setChecked(groceries, bread, true);
  space.createList('Empty');
  return space;
}

describe('export and import', () => {
  it('round-trips lists, items, order and check state', () => {
    const exported = exportSpace(sampleSpace(), 'Home');
    const parsed = parseExport(JSON.stringify(exported));

    const target = new Space();
    expect(importInto(target, parsed)).toEqual({ lists: 2, items: 2 });
    expect(exportSpace(target, 'Home').lists).toEqual(exported.lists);
    expect(exported.lists[0]).toEqual({
      name: 'Groceries',
      items: [
        { text: 'Milk', checked: false },
        { text: 'Bread', checked: true },
      ],
    });
  });

  it('appends to existing lists instead of replacing them', () => {
    const target = sampleSpace();
    importInto(target, parseExport(JSON.stringify(exportSpace(sampleSpace(), 'x'))));
    expect(target.getLists().map((l) => l.name)).toEqual([
      'Groceries',
      'Empty',
      'Groceries',
      'Empty',
    ]);
  });

  it('never contains keys or ids', () => {
    const json = JSON.stringify(exportSpace(sampleSpace(), 'Home'));
    expect(json).not.toMatch(/"id"|secret|order|createdAt/);
  });

  it('makes safe file names', () => {
    const name = exportFileName({
      ...exportSpace(new Space(), '../Hjem & Hytte!'),
      exportedAt: '2026-10-26T10:00:00Z',
    });
    expect(name).toBe('lists-hjem-hytte-2026-10-26.json');
  });

  it('rejects files that are not exports', () => {
    expect(() => parseExport('not json')).toThrow(ImportError);
    expect(() => parseExport('{"format":"other"}')).toThrow(/not a Lists export/);
    expect(() =>
      parseExport(JSON.stringify({ format: EXPORT_FORMAT, version: 99, lists: [] })),
    ).toThrow(/newer version/);
    expect(() => parseExport('x'.repeat(6 * 1024 * 1024))).toThrow(/too large/);
  });

  it('cleans and limits untrusted content', () => {
    const parsed = parseExport(
      JSON.stringify({
        format: EXPORT_FORMAT,
        version: 1,
        name: 42,
        lists: [
          {
            name: '  Multi\nline  ',
            items: [
              { text: 'ok', checked: 'yes' },
              { text: '' },
              { nope: true },
              'string',
              { text: 'y'.repeat(5000), checked: true },
            ],
          },
          null,
          { items: [] },
        ],
      }),
    );
    expect(parsed.name).toBe('');
    expect(parsed.lists).toHaveLength(2);
    expect(parsed.lists[0]!.name).toBe('Multi line');
    expect(parsed.lists[0]!.items).toEqual([
      { text: 'ok', checked: false },
      { text: 'y'.repeat(1000), checked: true },
    ]);
    expect(parsed.lists[1]!.name).toBe('Imported list');
  });
});
