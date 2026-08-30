import { describe, expect, it } from 'vitest';

import { createSineWav, readWavProperties } from './wav';

const ascii = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

describe('createSineWav', () => {
  it('creates deterministic mono 16-bit PCM with a valid RIFF/WAVE header', () => {
    const first = createSineWav({ seconds: 1, frequencyHz: 220, sampleRate: 8_000 });
    const second = createSineWav({ seconds: 1, frequencyHz: 220, sampleRate: 8_000 });

    expect(first).toEqual(second);
    expect(ascii(first.slice(0, 4))).toBe('RIFF');
    expect(ascii(first.slice(8, 12))).toBe('WAVE');
    expect(ascii(first.slice(12, 16))).toBe('fmt ');
    expect(ascii(first.slice(36, 40))).toBe('data');
    expect(first.byteLength).toBe(44 + 8_000 * 2);
    expect(view(first).getUint32(4, true)).toBe(first.byteLength - 8);
    expect(view(first).getUint16(20, true)).toBe(1);
    expect(view(first).getUint16(22, true)).toBe(1);
    expect(view(first).getUint32(24, true)).toBe(8_000);
    expect(view(first).getUint16(34, true)).toBe(16);
    expect(view(first).getUint32(40, true)).toBe(8_000 * 2);
  });

  it.each([
    { seconds: 0, frequencyHz: 220, sampleRate: 8_000 },
    { seconds: -1, frequencyHz: 220, sampleRate: 8_000 },
    { seconds: 1, frequencyHz: 0, sampleRate: 8_000 },
    { seconds: 1, frequencyHz: 220, sampleRate: 0 },
    { seconds: Number.NaN, frequencyHz: 220, sampleRate: 8_000 },
  ])('rejects invalid input %#', (options) => {
    expect(() => createSineWav(options)).toThrow(/positive finite/);
  });
});

const chunk = (id: string, body: Uint8Array): Uint8Array => {
  const pad = body.byteLength % 2;
  const out = new Uint8Array(8 + body.byteLength + pad);
  for (let i = 0; i < 4; i += 1) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, body.byteLength, true);
  out.set(body, 8);
  return out;
};

const fmtBody = (channels: number, sampleRate: number, bitsPerSample: number): Uint8Array => {
  const body = new Uint8Array(16);
  const view = new DataView(body.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, (sampleRate * channels * bitsPerSample) / 8, true);
  view.setUint16(12, (channels * bitsPerSample) / 8, true);
  view.setUint16(14, bitsPerSample, true);
  return body;
};

const riff = (chunks: Uint8Array[]): Uint8Array => {
  const payload = chunks.reduce((total, part) => total + part.byteLength, 0);
  const out = new Uint8Array(12 + payload);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i += 1) out[i] = 'RIFF'.charCodeAt(i);
  view.setUint32(4, out.byteLength - 8, true);
  for (let i = 0; i < 4; i += 1) out[8 + i] = 'WAVE'.charCodeAt(i);
  let offset = 12;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

describe('readWavProperties', () => {
  it('reads a file whose data chunk is preceded by metadata, not sitting at offset 36', () => {
    const bytes = riff([
      chunk('LIST', new Uint8Array(30)),
      chunk('fmt ', fmtBody(2, 48_000, 16)),
      chunk('data', new Uint8Array(48_000 * 2 * 2)),
    ]);

    expect(readWavProperties(bytes)).toEqual({
      sampleRate: 48_000,
      channels: 2,
      bitsPerSample: 16,
      dataBytes: 48_000 * 2 * 2,
      durationSeconds: 1,
    });
  });

  it('steps over the pad byte RIFF adds after an odd-sized chunk', () => {
    const bytes = riff([
      chunk('fmt ', fmtBody(1, 8_000, 16)),
      chunk('note', new Uint8Array(5)),
      chunk('data', new Uint8Array(16_000)),
    ]);

    expect(readWavProperties(bytes).durationSeconds).toBe(1);
  });

  it('refuses a chunk that claims more bytes than the payload holds', () => {
    const bytes = riff([chunk('fmt ', fmtBody(1, 8_000, 16)), chunk('data', new Uint8Array(8))]);
    new DataView(bytes.buffer).setUint32(bytes.byteLength - 8 - 4, 0xffff, true);

    expect(() => readWavProperties(bytes)).toThrow(RangeError);
  });

  it('refuses a payload that is not a RIFF/WAVE container at all', () => {
    expect(() => readWavProperties(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow(RangeError);
  });

  it('refuses a container that never declares a data chunk', () => {
    expect(() => readWavProperties(riff([chunk('fmt ', fmtBody(1, 8_000, 16))]))).toThrow(RangeError);
  });
});
