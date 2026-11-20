// Tiny argv parser: `--key value`, `--key=value`, boolean `--flag`, repeated keys collect into
// arrays, everything else is positional. Unknown options are an error so typos never pass silently.

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @param {{ flags?: string[], options?: string[], multi?: string[] }} spec
 *   flags: boolean switches; options: take one value; multi: may repeat (value list, also comma-split)
 */
export function parseArgs(argv, spec = {}) {
  const flags = new Set(spec.flags || []);
  const options = new Set(spec.options || []);
  const multi = new Set(spec.multi || []);
  const out = { _: [] };
  for (const f of flags) out[f] = false;
  for (const m of multi) out[m] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || a === '--') { out._.push(a); continue; }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    if (flags.has(key)) {
      if (val !== undefined) out[key] = !/^(0|false|no)$/i.test(val);
      else out[key] = true;
      continue;
    }
    if (!options.has(key) && !multi.has(key)) {
      throw new Error(`unknown option --${key}`);
    }
    if (val === undefined) {
      if (i + 1 >= argv.length) throw new Error(`--${key} needs a value`);
      val = argv[++i];
    }
    if (multi.has(key)) {
      for (const v of String(val).split(',')) if (v.trim()) out[key].push(v.trim());
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** Runs `main` when the module is the entry point; prints a clean error and exits 1 on failure. */
export async function runMain(importMetaUrl, main) {
  const { pathToFileURL } = await import('node:url');
  const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
  if (entry !== importMetaUrl) return;
  try {
    const code = await main(process.argv.slice(2));
    process.exitCode = typeof code === 'number' ? code : 0;
  } catch (e) {
    console.error(`error: ${e && e.message ? e.message : e}`);
    if (process.env.LENS_DEBUG) console.error(e);
    process.exitCode = 1;
  }
}
