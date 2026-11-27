const magic = "KBD2";
const hashLength = 64;
export const disciplineCacheHeaderLength = magic.length + hashLength;

export function disciplineCacheHeader(sourceHash: string): Buffer {
  return Buffer.from(magic + sourceHash, "ascii");
}

/** The header only selects the database read. The worker verifies the whole artifact. */
export function disciplineCacheSourceHash(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength < disciplineCacheHeaderLength) return undefined;
  const header = Buffer.from(bytes.subarray(0, disciplineCacheHeaderLength));
  if (header.subarray(0, magic.length).toString("latin1") !== magic) return undefined;
  const hash = header.subarray(magic.length).toString("latin1");
  return /^[0-9a-f]{64}$/u.test(hash) ? hash : undefined;
}
