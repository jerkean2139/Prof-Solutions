import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Locks the QR encoder's output. The encoder was verified as genuinely
// scannable by decoding its generated codes with an independent QR reader
// (jsQR) across versions 1, 2, 3, and 5. Those fingerprints are captured here,
// so any change to the algorithm that alters the output for a fixed input fails
// this test and must be re-verified against a decoder before it ships.

interface QrApi {
  make: (text: string) => { size: number; modules: boolean[][] };
  toSvg: (qr: { size: number; modules: boolean[][] }, opts?: { scale?: number; border?: number }) => string;
}

let QR: QrApi;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(join(here, '..', 'public', 'qr.js'), 'utf8');
  const win: { QR?: QrApi } = {};
  // The module is a browser IIFE that assigns window.QR. Load it with a shim.
  new Function('window', src)(win);
  QR = win.QR!;
});

function fingerprint(text: string): string {
  const qr = QR.make(text);
  const bits = qr.modules.map((row) => row.map((b) => (b ? 1 : 0)).join('')).join('');
  return createHash('sha256').update(bits).digest('hex').slice(0, 16);
}

describe('QR encoder', () => {
  it('selects the smallest version that fits the data', () => {
    expect(QR.make('QR-CAN-3PK').size).toBe(21); // version 1
    expect(QR.make('WAX-6PK-2026-Q3-BATCH-0007').size).toBe(25); // version 2
    expect(QR.make('PROFITABLE-SOLUTIONS-SKU-000123456789').size).toBe(29); // version 3
  });

  it('produces the exact verified module pattern for fixed inputs', () => {
    // If these change, the encoder output changed -- re-verify with a decoder.
    expect(fingerprint('QR-CAN-3PK')).toBe('b9c03dea5536790f');
    expect(fingerprint('A')).toBe('2092585037e9da56');
    expect(fingerprint('WAX-6PK-2026-Q3-BATCH-0007')).toBe('97a3678723ba0005');
  });

  it('renders a self-contained SVG with no external references', () => {
    const svg = QR.toSvg(QR.make('QR-DET-5GAL'), { scale: 6, border: 2 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // no external hosts except the SVG namespace
    expect(svg).toContain('<path');
  });

  it('is deterministic', () => {
    expect(fingerprint('QR-CAN-3PK')).toBe(fingerprint('QR-CAN-3PK'));
  });
});
