import { HttpResponseData } from '../client/http.js';
import { AssertionReport } from './assertion.js';

export interface TestStepResult {
  stepName: string;
  url: string;
  method: string;
  responseStatus?: number;
  durationMs?: number;
  assertionReport?: AssertionReport;
  error?: string;
  extractionErrors?: string[];
}

export interface TestSuiteResult {
  suiteName: string;
  passed: boolean;
  steps: TestStepResult[];
  startTime: number;
  endTime: number;
}

export class TestReporter {
  /**
   * Generates a detailed Markdown report for a test suite execution.
   */
  static generateMarkdown(result: TestSuiteResult): string {
    const durationTotal = result.endTime - result.startTime;
    const totalSteps = result.steps.length;
    const passedSteps = result.steps.filter(s => {
      if (s.error) return false;
      if (s.assertionReport && !s.assertionReport.passed) return false;
      return true;
    }).length;
    const failedSteps = totalSteps - passedSteps;
    const passPercentage = totalSteps > 0 ? Math.round((passedSteps / totalSteps) * 100) : 100;

    const parts: string[] = [];
    parts.push(`## 📊 Test Suite Report: ${result.suiteName}\n\n`);

    // Alert badge for status
    if (result.passed) {
      parts.push(`> [!NOTE]\n> **Status:** ✅ PASSED | **Success Rate:** ${passPercentage}% (${passedSteps}/${totalSteps} steps passed)\n\n`);
    } else {
      parts.push(`> [!WARNING]\n> **Status:** ❌ FAILED | **Success Rate:** ${passPercentage}% (${passedSteps}/${totalSteps} steps passed)\n\n`);
    }

    // Summary details
    parts.push(`| Metric | Value |\n| :--- | :--- |\n`);
    parts.push(`| **Start Time** | ${new Date(result.startTime).toISOString()} |\n`);
    parts.push(`| **Duration** | ${durationTotal} ms |\n`);
    parts.push(`| **Total Steps** | ${totalSteps} |\n`);
    parts.push(`| **Passed** | ${passedSteps} |\n`);
    parts.push(`| **Failed** | ${failedSteps} |\n\n`);

    parts.push(`### 📋 Step-by-Step Breakdown\n\n`);
    parts.push(`| Step Name | Method | URL | Status Code | Duration | Assertions | Result |\n`);
    parts.push(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`);

    for (const step of result.steps) {
      const methodBadge = `\`${step.method.toUpperCase()}\``;
      const statusBadge = step.responseStatus !== undefined 
        ? (step.responseStatus >= 200 && step.responseStatus < 300 ? `🟢 ${step.responseStatus}` : `🔴 ${step.responseStatus}`)
        : 'N/A';
      const durationText = step.durationMs !== undefined ? `${step.durationMs}ms` : 'N/A';
      
      let assertionSummary = 'N/A';
      if (step.assertionReport) {
        const { total, passed } = step.assertionReport.summary;
        assertionSummary = `${passed}/${total}`;
      }

      let stepResult = '❌ Error';
      if (!step.error) {
        stepResult = (!step.assertionReport || step.assertionReport.passed) ? '✅ Pass' : '❌ Fail';
      }

      parts.push(`| ${step.stepName} | ${methodBadge} | \`${step.url}\` | ${statusBadge} | ${durationText} | ${assertionSummary} | ${stepResult} |\n`);
    }

    parts.push('\n');

    // Detailed failure information
    const failures = result.steps.filter(s => s.error || (s.assertionReport && !s.assertionReport.passed));
    if (failures.length > 0) {
      parts.push(`### 🔍 Failure Details\n\n`);
      for (const step of failures) {
        parts.push(`#### ❌ Step: ${step.stepName} (${step.method.toUpperCase()} ${step.url})\n`);
        if (step.error) parts.push(`> [!CAUTION]\n> **Execution Error:** ${step.error}\n\n`);
        if (step.assertionReport && !step.assertionReport.passed) {
          parts.push(`**Failed Assertions:**\n`);
          for (const res of step.assertionReport.results) {
            if (!res.passed) {
              parts.push(`- [ ] \`Type: ${res.assertion.type}\` (Property: \`${res.assertion.property || 'none'}\`): ${res.message}\n`);
            }
          }
          parts.push('\n');
        }
      }
    }

    // Variable extraction warnings
    const stepsWithExtractionErrors = result.steps.filter(s => s.extractionErrors && s.extractionErrors.length > 0);
    if (stepsWithExtractionErrors.length > 0) {
      parts.push(`### ⚠️ Variable Extraction Warnings\n\n`);
      for (const step of stepsWithExtractionErrors) {
        parts.push(`**Step: ${step.stepName}**\n`);
        for (const err of step.extractionErrors!) {
          parts.push(`- ⚠️ ${err}\n`);
        }
        parts.push('\n');
      }
    }

    return parts.join('');
  }
}
