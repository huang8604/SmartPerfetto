// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

function isReadOnlySql(sql) {
  const withoutComments = String(sql).replace(/--.*$/gm, '').trim();
  const withoutIncludes = withoutComments.replace(
    /^(?:INCLUDE\s+PERFETTO\s+MODULE\s+[^;]+;\s*)+/i,
    '',
  );
  if (!/^(SELECT|WITH)\b/i.test(withoutIncludes)) return false;
  return !/\b(?:ALTER|ATTACH|CREATE|DELETE|DETACH|DROP|INSERT|PRAGMA|REPLACE|UPDATE|VACUUM)\b/i
    .test(withoutIncludes);
}

function collectStepSql(steps) {
  const sqlSteps = [];
  const topLevelSqlIndexes = new Set();
  const visit = (step, topLevelIndex) => {
    if (!step || typeof step !== 'object') return;
    if (typeof step.sql === 'string' && step.sql.trim() !== '') {
      sqlSteps.push({
        id: step.id,
        sql: step.sql,
        condition: typeof step.condition === 'string' ? step.condition : null,
        topLevelIndex,
      });
      topLevelSqlIndexes.add(topLevelIndex);
    }
    for (const child of Array.isArray(step.steps) ? step.steps : []) visit(child, topLevelIndex);
    for (const condition of Array.isArray(step.conditions) ? step.conditions : []) {
      if (condition?.then && typeof condition.then === 'object') visit(condition.then, topLevelIndex);
    }
    if (step.else && typeof step.else === 'object') visit(step.else, topLevelIndex);
  };
  steps.forEach((step, index) => visit(step, index));
  return {sqlSteps, topLevelSqlIndexes};
}

function referencedSqlVariables(sql) {
  return [...String(sql).matchAll(/\$\{([^}]+)\}/g)].map((match) => {
    const expression = match[1].trim();
    return expression.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:(?:\.|\[|\?)|(?:\|[^}]*$)|$)/)?.[1]
      ?? null;
  });
}

function producedVariablesBefore(steps, topLevelIndex) {
  const names = new Set();
  for (const step of steps.slice(0, topLevelIndex)) {
    if (!step || typeof step !== 'object') continue;
    if (typeof step.id === 'string' && step.id) names.add(step.id);
    if (typeof step.save_as === 'string' && step.save_as) names.add(step.save_as);
  }
  return names;
}

function skillSqlContract(definition) {
  const steps = Array.isArray(definition?.steps) ? definition.steps : [];
  const hasRootSql = typeof definition?.sql === 'string' && definition.sql.trim() !== '';
  const {sqlSteps, topLevelSqlIndexes} = collectStepSql(steps);
  const inputNames = new Set(
    (Array.isArray(definition?.inputs) ? definition.inputs : [])
      .map((input) => input?.name)
      .filter(Boolean),
  );
  const canForceProbe = (step) => {
    const availableNames = producedVariablesBefore(steps, step.topLevelIndex);
    return isReadOnlySql(step.sql)
      && referencedSqlVariables(step.sql).every((name) =>
        name !== null && (inputNames.has(name) || availableNames.has(name)));
  };
  const stepSqlIds = sqlSteps.map((step) => step.id).filter(Boolean);
  const sqlIds = [...(hasRootSql ? ['root'] : []), ...stepSqlIds];
  const forcedSqlStepIds = sqlSteps
      .filter((step) => step.condition && canForceProbe(step))
      .map((step) => step.id)
      .filter(Boolean);
  const conditionOnlySqlStepIds = sqlSteps
      .filter((step) => step.condition && !canForceProbe(step))
      .map((step) => step.id)
      .filter(Boolean);
  const lastSqlTopLevelIndex = topLevelSqlIndexes.size > 0
    ? Math.max(...topLevelSqlIndexes)
    : -1;
  return {
    hasRootSql,
    hasStepSql: sqlSteps.length > 0,
    steps,
    sqlSteps,
    sqlIds,
    forcedSqlStepIds,
    conditionOnlySqlStepIds,
    lastSqlTopLevelIndex,
  };
}

module.exports = {isReadOnlySql, skillSqlContract};
