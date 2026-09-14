# Gameplay and visual target

## User direction

The core motivation is character growth expressed through increasingly powerful-feeling attacks. Environmental reactions should make that growth visible while preserving combat readability. This is a world interaction system, including spell impacts and shaking vegetation/trees, rather than a set of unrelated material demonstrations.

- Overworld: typically near top-down, scrollable camera distance, relaxed play; user cites Flyff as an engagement reference.
- Dungeons: closer, near third-person camera; user cites Monster Hunter-like engagement.
- Primary deployment: dungeons and contained, visually impressive areas. Continuous world-wide high-detail simulation is not required.
- Unreal Editor is not currently installed. Avoid requiring it; inspect documentation and visual references first.
- Target hardware, numerical frame budget and persistence lifetime remain unspecified.

## User-selected visual references

Video: https://www.youtube.com/watch?v=QuCO66Tv8zw

| Material | Start | Range |
| --- | --- | --- |
| Mist / ground fog | 1:58 | Several seconds onward |
| Grass | 2:18 | Several seconds onward |
| Sand | 2:24 | Onward |
| Snow | 2:44 | Several seconds onward |

The URL supplied includes t=137s; the explicit per-material timestamps above are authoritative. The browsing tool could not fetch the video. These are recorded user targets, not visually inspected footage.

Documentation: https://majorsmash.github.io/fnl-docs-v2/manual/ninjalive2-manual/

The manual's introduction distinguishes painter/imprint mode from fluid simulation and describes shared inputs driving surfaces, volumes, foliage and particles, with passive rendering beyond the player-local simulation domain. This supports modular responses to shared interactions; it does not require every response to use our fog solver.

## Proposed next milestone

Build one small encounter scene with both camera extremes and a shared attack input. The same attack should displace mist, bend grass, shake a test tree and disturb a material patch. Use material-specific response and recovery; retain the current individual modes for diagnostics.

Express interaction in world units: position, direction, radius/shape, impulse, duration and effect profile. Separate authored visual strength from gameplay damage. Provide modest and stronger versions of the same attack to assess progression, timing and readability.

Prioritize a fog renderer that works at low camera angles: the current horizontal sheets remain transitional. For tree response, begin with a damped bend/recoil model; full tree physics is unnecessary for this milestone. Spatial masks should constrain reactions to the intended room/surface rather than let projected stamps affect unrelated floors.

Acceptance: clear impact onset, coherent direction across responders, readable recovery, visible strength contrast, and stable appearance at both camera extremes. Choose numerical performance targets once target hardware is specified.
