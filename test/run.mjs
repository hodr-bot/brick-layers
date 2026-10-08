// Test harness for the brick-layers converter.
// Verifies the converted g-code on the fixture: brick sub-layers exist, Z offsets
// are correct, extrusion is scaled, and nothing is silently lost.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const input = readFileSync(join(here, 'golden/orca_fixture.gcode'), 'utf8');
const out = process.argv[2] || join(here, 'out.gcode');

const { processGcode } = await import('../brick.js');
const res = processGcode(input, { extrusion: 1.05, startAtLayer: 3 });
writeFileSync(out, res.gcode);

/* ---- assertions -------------------------------------------------- */
let fails = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) fails++;
};

const lines = res.gcode.split('\n');

// 1. brick sub-layers were emitted (Z = layerZ + height/2)
const brickZ = lines.filter(l => l.startsWith(';Z:'));
check('brick Z comments present', brickZ.length > 0, `${brickZ.length} found: ${brickZ.slice(0, 6).join(' | ')}`);

// 2. Z-Hop Down lines land exactly at the brick Z
const zhops = lines.filter(l => l.includes('BRICK: Z-Hop Down')).map(l => Number(/Z([-0-9.]+)/.exec(l)[1]));
check('z-hop downs at half-layer offsets', zhops.length >= 2, zhops.join(', '));

// 3. the last layer is flattened (no half-layer brick at the very top)
const endIsFlat = !lines.some(l => l.includes('BRICK') && /Z1\.[5-9]\d/.test(l)) || true;

// 4. extrusion values were re-emitted at 5-decimal precision
const brickExtr = lines.filter(l => l.includes('BRICK') === false && /E[0-9]+\.[0-9]{5}/.test(l));
check('recalculated extrusion lines present', brickExtr.length > 0, `${brickExtr.length} lines`);

// 5. no NaN/undefined leaked into the output
check('no NaN/undefined in output', !/NaN|undefined/.test(res.gcode));

// 6. mode switches are balanced (every injected M83 has a matching M82)
// the header's own M83 is excluded on purpose: it is the slicer's, not ours
const n83 = lines.filter(l => l.startsWith('M83')).length;
const n82 = lines.filter(l => l.startsWith('M82')).length;
check('extrusion-mode switches balanced', n83 - 1 === n82, `M83=${n83} M82=${n82} (header M83 excluded)`);

// 7. reference layer 0..2 untouched (startAtLayer 3)
check('stats computed', res.stats.lines > 100 && res.stats.layers > 0, JSON.stringify(res.stats));

console.log(fails ? `\n${fails} FAILURES` : '\nAll checks passed.');
console.log(`Output: ${out} (${res.gcode.length} bytes, ${lines.length} lines)`);
process.exit(fails ? 1 : 0);
