// Minimal streaming tar.gz writer (ustar), so a report can travel as ONE file without any dependency.
// (Same code as _kiromask_diag-n-test/lib/tar.mjs: the product stays self-contained, the diagnostic tools stay standalone.)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';

function header(name, size, mtime, isDir) {
  const b = Buffer.alloc(512);
  let prefix = '';
  let nm = name;
  if (Buffer.byteLength(nm) > 100) { // ustar: split into prefix (<=155) + name (<=100); truncate an over-long basename
    const i = nm.lastIndexOf('/');
    const dir = i > 0 ? nm.slice(0, i) : '';
    const base = (i > 0 ? nm.slice(i + 1) : nm).slice(0, 100);
    if (dir && Buffer.byteLength(dir) <= 155) { prefix = dir; nm = base; } else nm = base;
  }
  b.write(nm, 0, 100, 'utf8');
  b.write(octal(isDir ? 0o755 : 0o644, 8), 100);
  b.write(octal(0, 8), 108); b.write(octal(0, 8), 116);
  b.write(octal(size, 12), 124);
  b.write(octal(Math.floor(mtime / 1000), 12), 136);
  b.write('        ', 148); // checksum placeholder (spaces)
  b.write(isDir ? '5' : '0', 156);
  b.write('ustar\0', 257); b.write('00', 263);
  b.write(prefix, 345, 155, 'utf8');
  let sum = 0; for (const v of b) sum += v;
  b.write(octal(sum, 7) + ' ', 148);
  return b;
}

function* walk(dir, base = dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { yield { full, rel: path.relative(base, full).split(path.sep).join('/'), dir: true }; yield* walk(full, base); }
    else if (e.isFile()) yield { full, rel: path.relative(base, full).split(path.sep).join('/'), dir: false };
  }
}

/** Pack `dir` into `outFile` (.tar.gz), with every entry under `rootName/`. */
export function tarGz(dir, outFile, rootName = path.basename(dir)) {
  return new Promise((resolve, reject) => {
    const gz = zlib.createGzip({ level: 6 });
    const out = fs.createWriteStream(outFile);
    gz.pipe(out);
    out.on('finish', () => resolve(outFile)); out.on('error', reject); gz.on('error', reject);
    (async () => {
      const w = (buf) => new Promise((r) => (gz.write(buf) ? r() : gz.once('drain', r)));
      await w(header(`${rootName}/`, 0, Date.now(), true));
      for (const f of walk(dir)) {
        const st = fs.statSync(f.full);
        if (f.dir) { await w(header(`${rootName}/${f.rel}/`, 0, st.mtimeMs, true)); continue; }
        await w(header(`${rootName}/${f.rel}`, st.size, st.mtimeMs, false));
        let written = 0;
        for await (const chunk of fs.createReadStream(f.full)) { written += chunk.length; await w(chunk); }
        if (written !== st.size) throw new Error(`${f.rel} changed while archiving`);
        if (st.size % 512) await w(Buffer.alloc(512 - (st.size % 512)));
      }
      await w(Buffer.alloc(1024));
      gz.end();
    })().catch(reject);
  });
}
