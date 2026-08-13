import { PART_SIZE } from './config.js';

/**
 * Plan how a backup is divided across release assets.
 *
 * Parts are byte ranges of the original file — nothing is written to disk, and
 * `createReadStream(path, {start, end})` streams each range straight to GitHub.
 * `end` is inclusive in Node's stream API, hence the -1.
 *
 * Concatenating the parts in order reproduces the source file byte for byte,
 * which is what makes `cat part*` / `copy /b` a valid rejoin. Names are
 * zero-padded so lexicographic shell globbing yields numeric order.
 *
 * @returns {Array<{name: string, start: number, end: number, size: number}>}
 */
export function planParts(size, partSize = PART_SIZE) {
  if (size <= 0) throw new Error('Cannot split an empty file.');
  if (size <= partSize) return [{ name: 'backup.zip', start: 0, end: size - 1, size }];

  const count = Math.ceil(size / partSize);
  if (count > 99) {
    throw new Error(
      `This backup would need ${count} parts, exceeding the 2-digit naming scheme. ` +
        `Split it manually before uploading.`
    );
  }

  return Array.from({ length: count }, (_, i) => {
    const start = i * partSize;
    const end = Math.min(start + partSize, size) - 1;
    return {
      name: `backup.zip.part${String(i + 1).padStart(2, '0')}`,
      start,
      end,
      size: end - start + 1,
    };
  });
}
