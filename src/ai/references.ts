/**
 * Reference library for whole-model requests (get_reference).
 *
 * A modeller asked for "an Easter Island head" works from references: what
 * the real thing looks like, its proportions, the few details that make it
 * instantly recognizable, and the usual ways a quick model gets it wrong.
 * Each entry is such a reference sheet plus, for subjects people ask for
 * often, a worked example: a build_model step list made and checked by hand
 * (every feature named and editable, one solid, prints and exports cleanly).
 * Examples are in inches at their own height and are scaled to the size and
 * units asked for.
 *
 * Subjects without an entry: the chat researches them on the web (see the
 * system prompt) and uses the general guides here (figure proportions,
 * printable parts).
 */
import MOAI from './references/moai.json';
import BEAR from './references/cartoon-bear.json';

type Step = Record<string, unknown>;

export interface Reference {
  id: string;
  title: string;
  /** Words that find this entry (lower case). */
  aliases: string[];
  /** What the real subject looks like: proportions, signature details, common mistakes. */
  sheet: string[];
  /** How to model it with the organic toolkit. */
  technique: string[];
  /** Worked example (inches), and its overall height. */
  example?: { steps: Step[]; height: number; size: string; notes: string };
}

export const REFERENCES: Reference[] = [
  {
    id: 'moai',
    title: 'Easter Island head (moai, Rapa Nui)',
    aliases: ['moai', 'easter island', 'easter island head', 'easter island statue', 'rapa nui', 'stone head', 'tiki head'],
    sheet: [
      'What it is: a monolithic stone figure from Rapa Nui. Tabletop models show the head plus the top of the torso as one block (a bust). The head is about 60-65% of the model height and is long and tall, not round.',
      'Head block: tall, deep and flat-sided, carved in broad planes with softened edges (never an egg, ball or cylinder). Width about 0.33 of the model height, front-to-back depth about 0.30, head height about 1.9 times its width. Flat top (pukao hat optional), flat vertical back of the head.',
      'Brow: one heavy straight ridge across the whole face width at about 3/4 of the head height. It juts forward and casts the eyes into shadow. The face below steps back under it.',
      'Eyes: deep, dark, elliptical sockets directly under the brow, no eyeballs. They are wide (about 1/3 of the face width each) and shallow in height.',
      'Nose: the most prominent feature. It starts at the brow and runs straight down to about mid-face (it is 30-35% of the head height). It is a wedge: a narrow ridge on top, broad and deep at the bottom, flat sides. The bottom has curled, flared nostrils.',
      'Mouth: thin, pouting lips that protrude in a mound under the nose, a firm straight or slightly down-curving line between them. The mouth is narrow (about the nose width plus a little).',
      'Chin and jaw: massive, squarish chin that juts forward, and a strong jawline that ends in a ledge above a short neck. The chin is as far forward as the lips.',
      'Ears: long, narrow, rectangular slabs on the sides of the head from brow level down to about mouth level, with a groove carved inside (elongated lobes).',
      'Torso (bust): narrow shoulders, a thin slab-like chest (depth about 0.7 of its width), arms in shallow relief at most. The model stands on the flat bottom of the torso.',
      'Common mistakes that make it look goofy: a round or egg-shaped head; a small round nose or a teardrop stuck on the face; eyes as balls or small dots; no brow ridge; a short head; round disc ears; no jutting chin; a head the same width as the body with no neck step; smooth cartoon blending everywhere.',
    ],
    technique: [
      'Head: ONE profile_body (squareness 3.5-4, front_squareness 4-5 for a flat face) whose y (front) silhouette carries the brow (forward peak), the step back under it, the cheeks, the chin jut and the jaw ledge. Use 10-14 stations so each ridge has rising, peak and falling stations. end "round" with a small end_dome for a flat top with soft edges.',
      'Nose: a separate profile_body (front_squareness about 1.6 for the wedge: broad at the bottom, narrow ridge) from just above the mouth to the brow, sunk into the face. Nostrils: small loft_sections dish cuts from below.',
      'Eye sockets: loft_sections cut on plane XZ (oval in front of the face, oval at the surface, end_point well inside): a deep rounded dish under the brow. Mirror to the right side.',
      'Lips: a profile_body along X (axis X) with round ends: a low mound. Mouth line: a thin tube cut along the lips.',
      'Ears: profile_body slabs (squareness 4) on each side, plus a profile_body cut for the inner groove, mirrored together.',
      'Torso: a profile_body with a flat bottom (the print base) and narrowing shoulders; the head starts slightly inside its top.',
    ],
    example: {
      steps: MOAI as Step[], height: 6.115, size: '2.7 x 2.4 x 6.1 in',
      notes: 'Bust on a flat base; head is about 62% of the height. Front faces -Y. 12 named features, one solid, about 22 cubic inches at 6.1 in tall.',
    },
  },
  {
    id: 'cartoon-bear',
    title: 'Cartoon bear (sitting teddy / chibi bear)',
    aliases: ['cartoon bear', 'teddy bear', 'teddy', 'bear', 'chibi bear', 'cute bear', 'bear figurine'],
    sheet: [
      'Proportions (chibi style): the head is big, 45-50% of the total height and as wide as or wider than the body. The body is a soft pear (wider at the belly and hips), sitting, with a flat bottom.',
      'Head: round but a little wider than tall, fullest at the cheeks (lower half); slightly flattened front.',
      'Muzzle: a protruding oval snout on the lower half of the face (about 40% of the face width), with the nose a rounded oval or soft triangle on its top front.',
      'Eyes: small, round, set wide apart just above the muzzle (around or a little below the middle of the head height). Bumps or small domes read best on a print.',
      'Ears: round half-discs on top of the head at about 10 and 2 o\'clock, with a dished inner ear. Not on the sides like a human.',
      'Arms: short, thick, tapering tubes from the shoulders down to the belly sides, ending round. Legs: stubby, sticking forward from the bottom, with oval foot pads on the soles.',
      'Optional: a mouth line under the nose (a small "w" or smile), a belly patch, a small round tail.',
      'Common mistakes: a head smaller than the body, ears too small or on the sides, eyes too big or too low, no muzzle, long thin limbs, parts that float or just touch the body.',
    ],
    technique: [
      'Body: profile_body along Z with a flat start (the base). Head: profile_body with round start and end, its bottom sunk into the body top.',
      'Muzzle: profile_body along Y with a round front end, sunk into the face; Nose: a small profile_body along Y with round ends on the muzzle top front.',
      'Eyes: short tubes with a round outer end sunk into the head. Ears: profile_body along Y with round ends (an oblate disc) sunk into the head top, inner ear as a loft_sections dish cut; mirror both.',
      'Arms and legs: tubes starting inside the body (flat start, larger first radius), round free ends; foot pads as shallow dish cuts. Mirror the left side.',
    ],
    example: {
      steps: BEAR as Step[], height: 4.43, size: '2.6 x 2.6 x 4.4 in',
      notes: 'Sitting on its flat bottom, front faces -Y. 16 named features, one solid, about 15 cubic inches at 4.4 in tall.',
    },
  },
  {
    id: 'figure-proportions',
    title: 'Figures and faces: general proportions',
    aliases: ['face', 'human', 'person', 'head', 'bust', 'figure', 'figurine', 'character', 'statue', 'animal', 'cartoon', 'chibi'],
    sheet: [
      'Realistic human head (front): eyes at half the head height, one eye width apart; nose bottom halfway from the eyes to the chin; mouth a third of the way from the nose to the chin; ears from the eye line to the nose bottom. Side: the face is about 2/3 of the head depth.',
      'Realistic figure: about 7.5 heads tall; shoulders 2 heads wide (men), hips about 1.5-2 heads.',
      'Cartoon/chibi characters and animals: head 1/3 to 1/2 of the total height, big round forms, short thick limbs, eyes low and wide, small details exaggerated. Keep the silhouette readable from the front and the side.',
      'Animals: build from the real animal\'s side and front silhouettes (spine line, belly line, head and snout angle), then the signature parts (ears shape and position, snout length, tail, horns). Identify the 3-5 features people recognize it by before modelling.',
    ],
    technique: [
      'Main masses with profile_body from front and side silhouettes; limbs, tails and horns with tube; carved features as dish cuts; left-side parts mirrored.',
    ],
  },
  {
    id: 'printable-part',
    title: 'Printable and machinable parts',
    aliases: ['print', 'printable', '3d print', 'stl', 'cnc', 'cam', 'machining', 'step'],
    sheet: [
      'One solid: every piece must overlap the body (sink attachments at least a third of their thickness). Floating or barely touching pieces are errors.',
      'A flat base to stand on the bed, wide enough that the centre of mass is over it. Figurines usually sit on a flat-bottomed body or on a plinth.',
      'Minimum thickness about 0.06 in (1.5 mm) for printed details, thicker for small parts that stick out (ear tips, fingers, horns). Carved details at least about 0.02 in (0.5 mm) deep so they show after printing.',
      'Overhangs steeper than 45 degrees need supports; that is normal under chins, arms and noses of figurines but say so.',
      'CNC / CAM: export STEP. Keep the part one closed solid with no tiny slivers or nearly touching features (they make bad toolpaths). For machining, avoid inside corners smaller than the tool radius and undercuts the tool cannot reach from the chosen side.',
    ],
    technique: ['Run check_part at the end (build_model reports it too) and fix every problem before you finish.'],
  },
];

const LENGTH_KEYS = new Set(['at', 'x', 'y', 'z', 'offset', 'cx', 'cy', 'rx', 'ry', 'path', 'radius', 'radii', 'start_point', 'end_point', 'start_dome', 'end_dome', 'depth', 'depth2', 'distance', 'points']);

/** Scale every length in build_model steps (numbers under length keys, at any depth). */
export function scaleSteps(steps: Step[], k: number): Step[] {
  const scaleAll = (v: unknown): unknown => (typeof v === 'number' ? +(v * k).toFixed(6) : Array.isArray(v) ? v.map(scaleAll) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, scaleAll(x)])) : v);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, LENGTH_KEYS.has(key) ? scaleAll(x) : walk(x)]));
    return v;
  };
  return steps.map((s) => walk(s) as Step);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Best entry for a subject: an exact alias, then the longest alias contained in the subject. */
export function findReference(subject: string): Reference | null {
  const s = norm(subject);
  if (!s) return null;
  for (const r of REFERENCES) if (r.id === s || r.aliases.includes(s)) return r;
  let best: Reference | null = null; let bestLen = 0;
  for (const r of REFERENCES) for (const a of r.aliases) {
    if (a.length > bestLen && new RegExp(`\\b${a}\\b`).test(s)) { best = r; bestLen = a.length; }
  }
  return best;
}

/** get_reference: the reference sheet, technique, and (if there is one) the worked example scaled to `height`. */
export function getReference(subject: string, height: number | undefined, units: 'in' | 'mm'): Record<string, unknown> {
  const r = findReference(subject);
  const general = REFERENCES.filter((x) => !x.example).map((x) => x.id);
  if (!r) {
    return {
      found: false,
      subject,
      library: REFERENCES.map((x) => ({ id: x.id, title: x.title, worked_example: !!x.example })),
      next: 'No built-in reference for this subject. Research it: use WebSearch (and WebFetch on one or two good pages, e.g. Wikipedia or a modelling/sculpting reference) to learn its real proportions and signature details, then write your own reference sheet like the ones in this library (proportions, signature details, common mistakes) before modelling. Also read the general guides: ' + general.join(', ') + '.',
    };
  }
  const out: Record<string, unknown> = { found: true, id: r.id, title: r.title, reference_sheet: r.sheet, technique: r.technique };
  if (r.example) {
    const target = height && height > 0 ? height : r.example.height * (units === 'mm' ? 25.4 : 1);
    const inches = units === 'mm' ? target / 25.4 : target;
    const k = (inches / r.example.height) * (units === 'mm' ? 25.4 : 1);
    out.example = {
      height: +target.toFixed(4), units, notes: r.example.notes,
      how_to_use: 'A tested build of this subject, scaled to this height and these units (one solid, every feature named, prints and exports cleanly). For a plain request, run these steps with build_model (it is fine in one call), then view_model and check it against the reference sheet. When the user asks for changes (another size, pose, extra details, a different style) adapt the steps: keep the names and the structure, change the numbers, add or remove features. The document must be empty (or the steps will be added to the existing part).',
      steps: scaleSteps(r.example.steps, k),
    };
  } else out.note = 'Guide only (no worked example).';
  return out;
}
