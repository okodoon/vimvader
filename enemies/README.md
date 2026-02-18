# Enemy Designs

Add your own enemy to VimVader by dropping a `.enemy` file here.

## Format

```
# comment (optional)
name: My Enemy      ← display name (optional)
author: yourname    ← your name (optional)

# Grid rows — space-separated tokens:
. * a
b v *
. c .
```

## Token Reference

| Token | Meaning | How to destroy |
|-------|---------|----------------|
| `v`   | **Core** (red) — must kill this to defeat the enemy | Shoot `v` |
| `*` or `■` | Block (gray) — generic armour | Any character |
| `a`–`z` | Letter cell (yellow) | Shoot the **same letter** |
| `.`   | Empty / no cell | — |

## Rules

- Every design **must have exactly one `v`** (the core).
- Grid can be **any size** — rows don't need to be the same length.
- Short rows are padded with empty cells automatically.
- Uppercase letters in the grid are treated as lowercase.

## Example

```
name: Crab
author: you

. c . c .
c * c * c
. * v * .
```

## Contributing

Just push your `.enemy` file to this directory — it will be picked up automatically on the next game start!
