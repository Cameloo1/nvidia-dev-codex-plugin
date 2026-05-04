export function auditTechnologyRegistry(registry, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const stalenessDays = Number(options.stalenessDays || options.staleness_days || 90);
  const sources = Array.isArray(registry?.sources) ? registry.sources : [];
  const technologies = Array.isArray(registry?.technologies) ? registry.technologies : [];
  const sourceIds = new Set(sources.map((source) => source.id));
  const staleSources = [];
  const missingSourceFields = [];

  for (const source of sources) {
    for (const field of ["id", "name", "url", "kind", "verified_date"]) {
      if (!source[field]) missingSourceFields.push({ source_id: source.id || null, missing_field: field });
    }
    const ageDays = source.verified_date ? daysBetween(new Date(source.verified_date), now) : null;
    if (ageDays === null || ageDays > stalenessDays) {
      staleSources.push({
        source_id: source.id,
        name: source.name,
        verified_date: source.verified_date || null,
        age_days: ageDays
      });
    }
  }

  const technologyFindings = technologies.map((tech) => {
    const missing = [];
    for (const field of ["id", "canonical_name", "family", "status", "content_domains", "official_sources", "requirements", "validation"]) {
      if (!tech[field] || (Array.isArray(tech[field]) && !tech[field].length)) missing.push(field);
    }
    const unresolvedSources = (tech.official_sources || []).filter((id) => !sourceIds.has(id));
    return {
      technology_id: tech.id,
      missing_fields: missing,
      unresolved_sources: unresolvedSources,
      source_count: (tech.official_sources || []).length,
      requirement_count: (tech.requirements || []).length,
      validation_count: (tech.validation || []).length
    };
  });

  const score = readinessScore({
    staleSources,
    missingSourceFields,
    technologyFindings
  });

  return {
    generated_at: now.toISOString(),
    schema_version: registry?.schema_version || null,
    source_count: sources.length,
    technology_count: technologies.length,
    stale_source_count: staleSources.length,
    stale_sources: staleSources,
    missing_source_fields: missingSourceFields,
    technology_findings: technologyFindings,
    readiness_score: score,
    recommendations: recommendationsFor(score, staleSources, missingSourceFields, technologyFindings)
  };
}

function daysBetween(start, end) {
  if (Number.isNaN(start.getTime())) return null;
  return Math.floor((end.getTime() - start.getTime()) / 86400000);
}

function readinessScore(input) {
  let score = 100;
  score -= Math.min(30, input.staleSources.length * 3);
  score -= Math.min(20, input.missingSourceFields.length * 4);
  for (const finding of input.technologyFindings) {
    score -= Math.min(8, finding.missing_fields.length * 2);
    score -= Math.min(8, finding.unresolved_sources.length * 4);
  }
  return Math.max(0, score);
}

function recommendationsFor(score, staleSources, missingSourceFields, technologyFindings) {
  const output = [];
  if (staleSources.length) output.push("Refresh stale official source verification dates and compare current docs against registry assumptions.");
  if (missingSourceFields.length) output.push("Fill missing source metadata before marketplace submission.");
  if (technologyFindings.some((item) => item.missing_fields.length || item.unresolved_sources.length)) {
    output.push("Repair technology entries with missing fields or unresolved source ids.");
  }
  if (score >= 90) output.push("Registry is in good release-candidate shape; continue with fixture and header-aware validation.");
  return output;
}
