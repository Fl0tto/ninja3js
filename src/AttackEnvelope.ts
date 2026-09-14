/** Shared world-space burst timing for simulation, vegetation and the visible cue. */
export function attackEnvelope(radius: number, duration: number, age: number) {
  const progress = Math.min(1, Math.max(0, age / Math.max(duration, 0.001)));
  const travel = Math.min(1, progress * 2);
  return {
    radius: radius * (0.18 + 0.82 * (1 - (1 - travel) ** 3)),
    // Front-load the shove, then release smoothly before residue begins.
    strength: (1.65 - 0.65 * progress) * Math.min(1, (1 - progress) / 0.28),
  };
}
