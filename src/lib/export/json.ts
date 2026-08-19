import type { SbemDocument } from '@/lib/sbem/decode'

/**
 * JSON export.
 *
 * The shape is ours, not `sbem2json`'s: one object per record, keyed by stream,
 * with repeated samples as samples. See docs/sbem-format.md for why the two
 * differ. Anyone who needs the reference tool's exact output already has it -
 * export the raw `.sbem` and run `sbem2json` on it.
 */
export function toJson(document: SbemDocument, indent = 2): string {
  return JSON.stringify(
    {
      header: document.header,
      [document.rootName ?? 'Samples']: document.records.map((record) => record.value),
    },
    null,
    indent,
  )
}

/** One record per line. The right choice for a long recording. */
export function toJsonLines(document: SbemDocument): string {
  return document.records.map((record) => JSON.stringify(record.value)).join('\n')
}
