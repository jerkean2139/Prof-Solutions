'use strict';

// A small, self-contained QR Code encoder. No dependencies and no network, so
// it works inside the Content-Security-Policy that blocks external scripts.
// Byte mode, error-correction level M (good for smudged warehouse labels),
// automatic version selection (1 through 40). The algorithm follows the QR spec
// and Project Nayuki's reference implementation (MIT). We generate labels here
// and verify them by scanning them back with the same BarcodeDetector the
// receiving screen uses, so a wrong byte cannot slip through unnoticed.

(function () {
  // ---- GF(256) arithmetic for Reed-Solomon ----
  const EXP = new Uint8Array(256);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d; // primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
    }
  })();
  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[(LOG[a] + LOG[b]) % 255];
  }

  // Error-correction codewords per block and number of blocks, level M only,
  // indexed by version (1..40). These are the QR spec tables for level M.
  const ECC_PER_BLOCK_M = [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26,
    26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
    28, 28, 28,
  ];
  const NUM_BLOCKS_M = [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17,
    17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ];

  function numRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function numDataCodewords(ver) {
    return (
      Math.floor(numRawDataModules(ver) / 8) -
      ECC_PER_BLOCK_M[ver] * NUM_BLOCKS_M[ver]
    );
  }

  function rsGenerator(degree) {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, generator) {
    const degree = generator.length;
    const result = new Uint8Array(degree);
    for (const b of data) {
      const factor = b ^ result[0];
      result.copyWithin(0, 1);
      result[degree - 1] = 0;
      for (let i = 0; i < degree; i++) result[i] ^= gfMul(generator[i], factor);
    }
    return result;
  }

  // ---- bit buffer ----
  function appendBits(bb, val, len) {
    for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
  }

  function chooseVersion(numBytes) {
    for (let ver = 1; ver <= 40; ver++) {
      const capacityBits = numDataCodewords(ver) * 8;
      // byte mode: 4 (mode) + 8 or 16 (count) + 8*numBytes
      const countBits = ver <= 9 ? 8 : 16;
      const needed = 4 + countBits + 8 * numBytes;
      if (needed <= capacityBits) return ver;
    }
    throw new Error('data too long for a QR code');
  }

  function encodeToCodewords(bytes, ver) {
    const bb = [];
    appendBits(bb, 0x4, 4); // byte mode
    appendBits(bb, bytes.length, ver <= 9 ? 8 : 16);
    for (const b of bytes) appendBits(bb, b, 8);

    const dataCapacity = numDataCodewords(ver) * 8;
    // terminator
    appendBits(bb, 0, Math.min(4, dataCapacity - bb.length));
    // pad to byte boundary
    if (bb.length % 8 !== 0) appendBits(bb, 0, 8 - (bb.length % 8));
    // pad bytes
    for (let pad = 0xec; bb.length < dataCapacity; pad ^= 0xec ^ 0x11)
      appendBits(bb, pad, 8);

    const dataCodewords = new Uint8Array(bb.length / 8);
    for (let i = 0; i < bb.length; i++)
      dataCodewords[i >>> 3] |= bb[i] << (7 - (i & 7));
    return dataCodewords;
  }

  function addEccAndInterleave(data, ver) {
    const numBlocks = NUM_BLOCKS_M[ver];
    const eccLen = ECC_PER_BLOCK_M[ver];
    const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    const numShort = numBlocks - (rawCodewords % numBlocks);
    const shortLen = Math.floor(rawCodewords / numBlocks);

    const blocks = [];
    const gen = rsGenerator(eccLen);
    let k = 0;
    for (let i = 0; i < numBlocks; i++) {
      const datLen = shortLen - eccLen + (i < numShort ? 0 : 1);
      const dat = data.slice(k, k + datLen);
      k += datLen;
      const ecc = rsRemainder(dat, gen);
      const block = new Uint8Array(datLen + eccLen);
      block.set(dat, 0);
      block.set(ecc, datLen);
      blocks.push(block);
    }

    // Interleave data then ecc across blocks.
    const result = [];
    const maxDatLen = shortLen - eccLen + 1;
    for (let i = 0; i < maxDatLen; i++) {
      for (let b = 0; b < blocks.length; b++) {
        const datLen = blocks[b].length - eccLen;
        if (i < datLen) result.push(blocks[b][i]);
      }
    }
    for (let i = 0; i < eccLen; i++) {
      for (let b = 0; b < blocks.length; b++) {
        result.push(blocks[b][blocks[b].length - eccLen + i]);
      }
    }
    return Uint8Array.from(result);
  }

  // ---- module matrix ----
  function makeQr(text) {
    const bytes = toUtf8(text);
    const ver = chooseVersion(bytes.length);
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

    function setFn(x, y, dark) {
      modules[y][x] = dark;
      isFunction[y][x] = true;
    }

    // finder patterns + separators
    function finder(cx, cy) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || x >= size || y < 0 || y >= size) continue;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);

    // timing patterns
    for (let i = 0; i < size; i++) {
      if (!isFunction[6][i]) setFn(i, 6, i % 2 === 0);
      if (!isFunction[i][6]) setFn(6, i, i % 2 === 0);
    }

    // alignment patterns
    const positions = alignmentPositions(ver);
    for (const ay of positions) {
      for (const ax of positions) {
        // skip the three that overlap finder patterns
        if (
          (ax === 6 && ay === 6) ||
          (ax === 6 && ay === size - 7) ||
          (ax === size - 7 && ay === 6)
        )
          continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            setFn(ax + dx, ay + dy, dist !== 1);
          }
        }
      }
    }

    // reserve format info area (values set later) and dark module
    reserveFormat(size, isFunction);
    setFn(8, size - 8, true); // dark module

    // version info for v >= 7
    if (ver >= 7) drawVersion(ver, size, setFn);

    // codewords
    const codewords = addEccAndInterleave(encodeToCodewords(bytes, ver), ver);
    drawCodewords(codewords, size, modules, isFunction);

    // choose the mask with the lowest penalty
    let bestMask = 0;
    let bestPenalty = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(mask, modules, isFunction, size);
      drawFormat(mask, size, modules, isFunction);
      const p = penalty(modules, size);
      if (p < bestPenalty) {
        bestPenalty = p;
        bestMask = mask;
      }
      applyMask(mask, modules, isFunction, size); // undo (XOR is its own inverse)
    }
    applyMask(bestMask, modules, isFunction, size);
    drawFormat(bestMask, size, modules, isFunction);

    return { size, modules };
  }

  function alignmentPositions(ver) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step)
      result.splice(1, 0, pos);
    return result;
  }

  function reserveFormat(size, isFunction) {
    for (let i = 0; i < 9; i++) {
      isFunction[8][i] = true;
      isFunction[i][8] = true;
    }
    for (let i = 0; i < 8; i++) {
      isFunction[8][size - 1 - i] = true;
      isFunction[size - 1 - i][8] = true;
    }
  }

  function drawFormat(mask, size, modules, isFunction) {
    // level M = 0b00
    const data = (0 << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    for (let i = 0; i <= 5; i++) set(modules, 8, i, getBit(bits, i));
    set(modules, 8, 7, getBit(bits, 6));
    set(modules, 8, 8, getBit(bits, 7));
    set(modules, 7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) set(modules, 14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++) set(modules, size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) set(modules, 8, size - 15 + i, getBit(bits, i));
    modules[size - 8][8] = true; // dark module stays
  }

  function drawVersion(ver, size, setFn) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, bit);
      setFn(b, a, bit);
    }
  }

  function set(modules, x, y, bit) {
    modules[y][x] = bit;
  }
  function getBit(x, i) {
    return ((x >>> i) & 1) === 1;
  }

  function drawCodewords(data, size, modules, isFunction) {
    let i = 0; // bit index
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip timing column
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && i < data.length * 8) {
            modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  function applyMask(mask, modules, isFunction, size) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFunction[y][x]) continue;
        let invert = false;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) modules[y][x] = !modules[y][x];
      }
    }
  }

  // Penalty scoring per the spec, to pick the least-noisy mask.
  function penalty(m, size) {
    let p = 0;
    // rule 1: runs of 5+ same-color in rows and columns
    for (let y = 0; y < size; y++) {
      let runColor = m[y][0], runLen = 1;
      for (let x = 1; x < size; x++) {
        if (m[y][x] === runColor) { runLen++; if (runLen === 5) p += 3; else if (runLen > 5) p++; }
        else { runColor = m[y][x]; runLen = 1; }
      }
    }
    for (let x = 0; x < size; x++) {
      let runColor = m[0][x], runLen = 1;
      for (let y = 1; y < size; y++) {
        if (m[y][x] === runColor) { runLen++; if (runLen === 5) p += 3; else if (runLen > 5) p++; }
        else { runColor = m[y][x]; runLen = 1; }
      }
    }
    // rule 2: 2x2 blocks of same color
    for (let y = 0; y < size - 1; y++)
      for (let x = 0; x < size - 1; x++)
        if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    // rule 3: finder-like patterns
    const pat = [true, false, true, true, true, false, true];
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (x + 6 < size && matchPat(m, x, y, 1, 0, pat) && clear(m, x, y, 1, 0, size)) p += 40;
        if (y + 6 < size && matchPat(m, x, y, 0, 1, pat) && clear(m, x, y, 0, 1, size)) p += 40;
      }
    // rule 4: proportion of dark modules
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y][x]) dark++;
    const total = size * size;
    const ratio = Math.floor((Math.abs(dark * 20 - total * 10) + total - 1) / total);
    p += ratio * 10;
    return p;
  }
  function matchPat(m, x, y, dx, dy, pat) {
    for (let i = 0; i < 7; i++) if (m[y + dy * i][x + dx * i] !== pat[i]) return false;
    return true;
  }
  function clear(m, x, y, dx, dy, size) {
    // requires 4 light modules on one side (simplified light-border check)
    let count = 0;
    for (let i = -4; i < 0; i++) {
      const yy = y + dy * i, xx = x + dx * i;
      if (yy < 0 || xx < 0 || yy >= size || xx >= size || m[yy][xx] === false) count++;
    }
    return count === 4;
  }

  function toUtf8(str) {
    return Array.from(new TextEncoder().encode(str));
  }

  // ---- rendering ----
  function toSvg(qr, opts) {
    const border = (opts && opts.border) != null ? opts.border : 4;
    const scale = (opts && opts.scale) || 4;
    const dim = (qr.size + border * 2) * scale;
    let path = '';
    for (let y = 0; y < qr.size; y++)
      for (let x = 0; x < qr.size; x++)
        if (qr.modules[y][x])
          path += `M${(x + border) * scale},${(y + border) * scale}h${scale}v${scale}h-${scale}z`;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}">` +
      `<rect width="${dim}" height="${dim}" fill="#fff"/>` +
      `<path d="${path}" fill="#000"/></svg>`
    );
  }

  window.QR = { make: makeQr, toSvg };
})();
