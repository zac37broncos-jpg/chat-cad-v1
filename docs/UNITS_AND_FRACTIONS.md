# Units, unit changes and fractions

How CHAD reads sizes, and what happens when the units change.

## Plain numbers

Inside the program every length is in millimeters (IEEE double). A number
typed or sent without a unit ("3.1417", or a sketch coordinate) is in the
document's units, the IPS / MMGS choice in the status bar. Angles typed without
a unit are degrees, in every document.

## Changing the units keeps the part

Changing the units menu, or the chat's `set_units`, changes how sizes are shown
and what new plain numbers mean. It never changes the part. This is how
unit systems work in professional CAD.

Before this fix, the plain numbers already in the part were re-read in the new
unit, so a 3.1417 in plate became a 3.1417 mm plate (16,387 times less volume).

How it works (`src/core/unitSwitch.ts`, called by `DocumentStore.setUnits`):

- Every length in the part that depended on the old unit gets that unit
  written out, first. In an inch part switched to mm:

  | Before | After |
  |---|---|
  | `3.1417` | `3.1417 in` |
  | `W + 5` | `W + 5 in` |
  | `(5) + (W)` | `(5 in) + (W)` |
  | `1/4` | `(1/4) in` |
  | sketch coordinate `2` (a number) | `"2 in"` |
  | parameter `L = 3.1417` | `L = 3.1417 in` |
  | `2*W`, `W/2`, `0`, `6 mm`, `1/4"` | unchanged (they do not depend on the unit) |

- Nothing is rounded. Typed text is kept and only a unit is added, so the
  value is the same to the last bit. Each rewritten value is checked: it must
  give exactly the same millimeters read as inches and as millimeters, or the
  change is refused.
- Angles (draft, revolve, pattern and chamfer angles, arc angles, angle
  dimensions) never depend on the document unit and are left exactly as they
  are. Counts are left as they are too.
- A parameter with no unit that is only ever used as an angle (`lean = 20`,
  used as `lean deg`) is left as it is, so `lean deg` keeps working.
- Where a sketch dimension's text sits is scaled (it is only where the label
  is drawn).
- If any value cannot be read (for example it names a parameter that was
  deleted), the units are **not** changed and the message names the value,
  because a value that cannot be read cannot be kept the same size.
- It is one undo step. Undo gives back the document exactly as it was.
- Switching back (mm to in) leaves `3.1417 in` as it is: it already says its
  unit.

Saved files store what is in the document, so a file saved after a unit
change opens at the same size. Files saved before this fix open exactly as
before (opening a file never changes its units).

The list of fields that hold lengths is in `src/core/unitSwitch.ts`. A test
(`tests/unit-switch.test.ts`) compares it with the type definitions, so a new
length field that is not added there fails the tests, instead of silently
changing size on a unit change.

## Fractions and mixed numbers

| Typed | Means | Notes |
|---|---|---|
| `1/4"`, `3/8 in` | a quarter inch, three eighths of an inch | a fraction directly before a unit is one quantity |
| `1-1/2"`, `1-1/2 in`, `2-3/8 in` | 1.5 in, 2.375 in | **mixed number**: whole number, hyphen with no spaces, proper fraction, unit |
| `1 1/2"` | 1.5 in | the same with a space instead of the hyphen |
| `1 - 1/2"` | 0.5 in | **subtraction** is written with spaces around the minus sign |
| `W + 1-1/2"` | W plus 1.5 in | a mixed number is one value inside a formula |
| `1-1/2` (no unit) | refused | could be 1.5 or 0.5; the message says how to write either |
| `2*1-1/2"`, `W/2-1/4"` | refused | after `*`, `/` or `^` it could be either; write `2*(1-1/2")` or `W/2 - 1/4"` |
| `1-3/2"` | refused | not a mixed number (the fraction must be less than 1) |
| `1.5-1/2"` | 1.0 in | a decimal is never the whole part of a mixed number, so this is subtraction |

Before this fix `1-1/2"` was read as 1 minus a half inch: 0.5 in in an inch
part, and 1 mm − 12.7 mm = −11.7 mm in a mm part, with no message.

**Why this choice.** `1-1/2"` is how drawings, machinists and CAD programs'
fraction displays write one and a half inches. Some CAD programs' dimension
boxes, however, read what is typed as arithmetic, so typing `3-1/2` there
gives 2.5 (users describe this on the Eng-Tips forum, "How to enter
fractions"). For a precision tool, CHAD reads the
written form the way a drawing means it, keeps subtraction available with
spaces, and refuses the forms that could honestly mean either, with a message,
instead of guessing. A mixed number gives exactly the same double as its
decimal (`1-1/2"` is bit for bit `1.5"`; `1-1/3"` is one correctly rounded
division, 4/3).

A document saved before this fix that contains `a-b/c` followed by a unit
(for example `3-1/2"`) now reads it as the mixed number. No such value was
found in the app's own output, tests or examples.
