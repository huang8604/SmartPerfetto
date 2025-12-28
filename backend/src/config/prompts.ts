/**
 * Prompt Engineering Templates
 * Optimized prompts for different analysis scenarios
 */

export const PROMPTS = {
  // SQL Generation Prompts
  SQL_GENERATION: {
    basic: `Generate a Perfetto SQL query for: {query}

Rules:
- Use ONLY existing Perfetto tables
- Return ONLY the SQL query
- Convert timestamps: ts / 1e6 for milliseconds`,

    withContext: `Generate a Perfetto SQL query for: {query}

Context:
- Package: {package}
- Time Range: {timeRange}

Rules:
- Use ONLY existing Perfetto tables
- Return ONLY the SQL query`,

    withSchema: `Generate a Perfetto SQL query for: {query}

Available Schema:
{schema}

Rules:
- Use ONLY the tables listed above
- Return ONLY the SQL query`,
  },

  // Analysis Prompts
  ANALYSIS_SUMMARY: {
    basic: `Summarize the analysis results:
{results}

Include:
1. Key findings
2. Performance impact
3. Recommendations`,

    detailed: `Provide a detailed performance analysis:
{results}

Include:
1. Executive Summary
2. Detailed Findings
3. Root Cause Analysis
4. Recommendations
5. SQL queries for further investigation`,
  },

  // Error Recovery Prompts
  ERROR_FIX: {
    syntax: `Fix this SQL syntax error:
{sql}
Error: {error}`,

    noResults: `This query returned no results:
{sql}

Suggest an alternative approach.`,
  },
};
