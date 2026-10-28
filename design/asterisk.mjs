// Generates the Flux asterisk (the chunky, slightly tilted stamp asterisk from the logo
// board) as one SVG path in a -12..12 box. Run: node design/asterisk.mjs
// Six arms, each wider at the tip than at the centre, with a slanted flat end; arm lengths
// vary a little so it reads as stamped, not geometric.
const TILT = 12;                                  // degrees clockwise
const LENGTHS = [11, 10.2, 10.8, 10.4, 11.2, 9.9];
const BASE_W = 4.2;                               // arm width at the centre
const TIP_W = 5.8;                                // arm width at the tip
const SLANT = 0.7;                                // how much the tip end is cut on an angle

const r = (x) => Math.round(x * 100) / 100;
const arms = LENGTHS.map((len, i) => {
  const a = ((TILT + i * 60) * Math.PI) / 180;
  const pts = [[-BASE_W / 2, 0], [-TIP_W / 2, -(len - SLANT)], [TIP_W / 2, -(len + SLANT)], [BASE_W / 2, 0]];
  const rot = pts.map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]);
  return `M${rot.map(([x, y]) => `${r(x)} ${r(y)}`).join('L')}Z`;
});
// Hexagonal hub so the arms join without gaps.
const hub = Array.from({ length: 6 }, (_, i) => {
  const a = ((TILT + 30 + i * 60) * Math.PI) / 180;
  return `${r(2.6 * Math.sin(a))} ${r(-2.6 * Math.cos(a))}`;
});
console.log(`${arms.join('')}M${hub.join('L')}Z`);
