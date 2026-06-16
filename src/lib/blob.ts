export function blobToFloat32Array(blob: Uint8Array): number[] {
  if (blob.byteLength % 4 !== 0) {
    throw new Error(`BLOB length ${blob.byteLength} is not a multiple of 4`);
  }
  const length = blob.byteLength / 4;
  if (blob.byteOffset % 4 === 0) {
    return Array.from(new Float32Array(blob.buffer, blob.byteOffset, length));
  }
  const aligned = new ArrayBuffer(blob.byteLength);
  new Uint8Array(aligned).set(blob);
  return Array.from(new Float32Array(aligned));
}

export function float32ArrayToBlob(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}
