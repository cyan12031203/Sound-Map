const MAX_PHASES = 5;

/** Build a small, evidence-backed musical outline from the existing route context. */
export function buildMusicPhaseSkeleton(routeProfile = {}) {
  const duration = Number(routeProfile.total_duration_sec) || 0;
  const count = Math.max(1, Math.min(MAX_PHASES, Math.floor(duration / 180) || 1));
  const context = routeProfile.route_context ?? {};
  const areas = context.areas ?? [];
  const transitions = context.transition_segments ?? [];
  const environments = context.environment_segments ?? routeProfile.segments ?? [];
  const boundaries = [0];
  for (let part = 1; part < count; part += 1) {
    const target = part / count;
    const cues = [...areas.flatMap((area) => [area.start_ratio, area.end_ratio]),
      ...transitions.flatMap((segment) => [segment.start_ratio, segment.end_ratio])]
      .filter((ratio) => Number.isFinite(ratio) && ratio > boundaries.at(-1) + 0.12 && ratio < 1 - 0.12);
    const nearest = cues.filter((ratio) => Math.abs(ratio - target) <= 0.12)
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    let boundary = nearest ?? target;
    boundary = Math.max(boundaries.at(-1) + 0.12, Math.min(1 - (count - part) * 0.12, boundary));
    boundaries.push(boundary);
  }
  boundaries.push(1);

  return Array.from({ length: count }, (_, index) => {
    const start_ratio = Number(boundaries[index].toFixed(4));
    const end_ratio = Number(boundaries[index + 1].toFixed(4));
    const midpoint = (start_ratio + end_ratio) / 2;
    const phaseAreas = areas.filter((area) => overlaps(start_ratio, end_ratio, area.start_ratio, area.end_ratio));
    const phaseTransitions = transitions.filter((segment) => overlaps(start_ratio, end_ratio, segment.start_ratio, segment.end_ratio));
    const phaseEnvironment = environments.filter((segment) => overlaps(start_ratio, end_ratio, segment.start_ratio, segment.end_ratio));
    const imagery = phaseAreas.flatMap((area) => (area.imagery?.images ?? []).flatMap((image) => [image.term, ...(image.associations ?? [])]))
      .filter((value) => typeof value === 'string').slice(0, 6);
    return {
      phase_id: `phase_${index + 1}`,
      start_ratio,
      end_ratio,
      midpoint_ratio: Number(midpoint.toFixed(4)),
      evidence: {
        areas: [...new Set(phaseAreas.map((area) => area.name).filter(Boolean))].slice(0, 3),
        imagery: [...new Set(imagery)].slice(0, 6),
        transitions: [...new Set(phaseTransitions.flatMap((segment) => [...(segment.labels ?? []), ...(segment.traits ?? [])]))].slice(0, 6),
        environment: [...new Set(phaseEnvironment.flatMap((segment) => [segment.label, ...(segment.traits ?? [])]).filter(Boolean))].slice(0, 6),
      },
    };
  });
}

function overlaps(start, end, otherStart = 0, otherEnd = 1) {
  return Number(otherEnd) > start && Number(otherStart) < end;
}
