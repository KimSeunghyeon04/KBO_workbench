import { setImmediate } from "node:timers/promises";

const ROWS_PER_MESSAGE = 5000;

interface RowChunk<Row> {
  rows: readonly Row[];
  append: boolean;
  complete: boolean;
}

/** Bound structured-clone work on the HTTP thread and yield between season chunks. */
export async function sendWorkerRows<Row>(
  rows: readonly Row[],
  send: (chunk: RowChunk<Row>) => void,
  isActive: () => boolean,
): Promise<void> {
  if (!isActive()) return;
  if (rows.length <= ROWS_PER_MESSAGE) {
    send({ rows, append: false, complete: true });
    return;
  }
  for (let offset = 0; offset < rows.length && isActive(); offset += ROWS_PER_MESSAGE) {
    send({
      rows: rows.slice(offset, offset + ROWS_PER_MESSAGE),
      append: offset > 0,
      complete: offset + ROWS_PER_MESSAGE >= rows.length,
    });
    await setImmediate();
  }
}
