import { describe, expect, it } from 'vitest';

import { createSineWav } from './wav';

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
