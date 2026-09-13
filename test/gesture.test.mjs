// gesture.test.mjs — classifier unit tests with synthetic landmarks (no camera).
// Run: node test/gesture.test.mjs

import { classifyHand, GestureStateMachine } from '../src/gesture.js';

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}  ${detail}`); }
}

// Build a straight (palm, fingers up) hand. x right, y DOWN (image coords).
const W = { x: 0.5, y: 0.95 };
function straightFinger(x, mcpY, len, spread = 0) {
  return [
    { x, y: mcpY },                                         // mcp
    { x, y: mcpY - len * 0.45 },                            // pip (farther up)
    { x, y: mcpY - len * 0.45 },                            // dip
    { x, y: mcpY - len },                                   // tip (straight up)
  ].map((p, i) => i === 3 ? { x: x + spread, y: p.y } : p); // slight spread on tip
}

function palmLandmarks() {
  const lm = [
    W,                                          // 0 wrist
    { x: 0.40, y: 0.88 },                       // 1 thumb cmc
    { x: 0.36, y: 0.84 },                       // 2 thumb mcp
    { x: 0.32, y: 0.80 },                       // 3 thumb ip
    { x: 0.28, y: 0.76 },                       // 4 thumb tip (out)
    ...straightFinger(0.45, 0.82, 0.26, 0.01),  // 5-8 index
    ...straightFinger(0.50, 0.82, 0.30),        // 9-12 middle
    ...straightFinger(0.55, 0.82, 0.26, -0.01), // 13-16 ring
    ...straightFinger(0.605, 0.85, 0.22, -0.02),// 17-20 pinky
  ];
  return lm;
}

// Fold every non-thumb fingertip in toward the palm: acute bend at the PIP.
function fistLandmarks() {
  const lm = palmLandmarks();
  const bends = [
    { pip: 6, tip: 8 }, { pip: 10, tip: 12 }, { pip: 14, tip: 16 }, { pip: 18, tip: 20 },
  ];
  for (const { pip, tip } of bends) {
    const p = lm[pip];
    lm[tip] = { x: p.x - 0.06, y: p.y + 0.02 }; // curled LEFT-inward, barely down
  }
  lm[4] = { x: 0.42, y: 0.80 };                 // thumb squished toward palm
  return lm;
}

console.log('classifyHand');
{
  const palm = classifyHand(palmLandmarks());
  check('palm -> gesture palm', palm.gesture === 'palm', JSON.stringify(palm));
  check('palm -> >=4 extended', palm.extended >= 4, `extended=${palm.extended}`);
  check('palm -> reliable', palm.reliable === true);

  const fist = classifyHand(fistLandmarks());
  check('fist -> gesture fist', fist.gesture === 'fist', JSON.stringify(fist));
  check('fist -> <=1 extended', fist.extended <= 1, `extended=${fist.extended}`);

  for (const angles of [NaN, Infinity]) {
    const broken = classifyHand([{ x: 0, y: 0 }, { x: angles, y: 0 }]);
    check(`degen -> unreliable (${angles})`, broken.gesture === 'unreliable', JSON.stringify(broken));
  }
  check('empty -> unreliable', classifyHand([]).gesture === 'unreliable');
  check('null -> unreliable', classifyHand(null).gesture === 'unreliable');
}

console.log('GestureStateMachine (holdFrames=3)');
{
  const events = [];
  const states = [];
  const m = new GestureStateMachine({
    holdFrames: 3,
    onEvent: (e) => events.push(e.type),
    onState: (s) => states.push(s),
  });

  const palm = classifyHand(palmLandmarks());
  const fist = classifyHand(fistLandmarks());

  palm; // keep symmetry with fist
  for (let i = 0; i < 3; i++) m.update(palm);   // commit PALM
  for (let i = 0; i < 3; i++) m.update(fist);   // commit FIST -> grab
  for (let i = 0; i < 3; i++) {
    m.update(fist);                             // hold
    m.update({ ...fist, gesture: 'unreliable' }); // flappy frames in between
  }
  for (let i = 0; i < 3; i++) m.update(palm);   // commit PALM -> release

  check('debounced commit to PALM', states[0] === 'palm', states.join(','));
  check('grab fired on palm->fist', events.includes('grab'), events.join(','));
  check('flap did not re-commit noisy state', states.filter((s) => s === 'fist').length === 1,
    states.join(','));
  check('release fired on fist->palm', events.includes('release'), events.join(','));
  check('no phantom duplicates', events.length === 2, events.join(','));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);