export interface SineWavOptions {
  seconds: number;
  frequencyHz: number;
  sampleRate: number;
}

const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;
const AMPLITUDE = 0.25;

const assertPositiveFinite = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
};

const writeAscii = (bytes: Uint8Array, offset: number, value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
};

/** Create deterministic mono, signed 16-bit little-endian PCM in a RIFF/WAVE container. */
export function createSineWav({ seconds, frequencyHz, sampleRate }: SineWavOptions): Uint8Array {
  assertPositiveFinite('seconds', seconds);
  assertPositiveFinite('frequencyHz', frequencyHz);
  assertPositiveFinite('sampleRate', sampleRate);

  if (!Number.isInteger(sampleRate)) {
    throw new RangeError('sampleRate must be a positive finite integer');
  }

  const sampleCount = Math.round(seconds * sampleRate);
  const dataBytes = sampleCount * BYTES_PER_SAMPLE;
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0 || dataBytes > 0xffff_ffff - 36) {
    throw new RangeError('seconds and sampleRate must produce a playable WAV length');
  }

  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const header = new DataView(bytes.buffer);

  writeAscii(bytes, 0, 'RIFF');
  header.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  header.setUint16(32, BYTES_PER_SAMPLE, true);
  header.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  header.setUint32(40, dataBytes, true);

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequencyHz * sample) / sampleRate) * AMPLITUDE * 0x7fff);
    header.setInt16(HEADER_BYTES + sample * BYTES_PER_SAMPLE, value, true);
  }

  return bytes;
}
