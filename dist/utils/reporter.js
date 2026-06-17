export class TestReporter {
    /**
     * Generates a detailed Markdown report for a test suite execution.
     */
    static generateMarkdown(result) {
        const durationTotal = result.endTime - result.startTime;
        const totalSteps = result.steps.length;
        const passedSteps = result.steps.filter(s => {
            if (s.error)
                return false;
            if (s.assertionReport && !s.assertionReport.passed)
                return false;
            return true;
        }).length;
        const failedSteps = totalSteps - passedSteps;
        const passPercentage = totalSteps > 0 ? Math.round((passedSteps / totalSteps) * 100) : 100;
        let md = `## 📊 Test Suite Report: ${result.suiteName}\n\n`;
        // Alert badge for status
        if (result.passed) {
            md += `> [!NOTE]\n> **Status:** ✅ PASSED | **Success Rate:** ${passPercentage}% (${passedSteps}/${totalSteps} steps passed)\n\n`;
        }
        else {
            md += `> [!WARNING]\n> **Status:** ❌ FAILED | **Success Rate:** ${passPercentage}% (${passedSteps}/${totalSteps} steps passed)\n\n`;
        }
        // Summary details
        md += `| Metric | Value |\n`;
        md += `| :--- | :--- |\n`;
        md += `| **Start Time** | ${new Date(result.startTime).toISOString()} |\n`;
        md += `| **Duration** | ${durationTotal} ms |\n`;
        md += `| **Total Steps** | ${totalSteps} |\n`;
        md += `| **Passed** | ${passedSteps} |\n`;
        md += `| **Failed** | ${failedSteps} |\n\n`;
        md += `### 📋 Step-by-Step Breakdown\n\n`;
        md += `| Step Name | Method | URL | Status Code | Duration | Assertions | Result |\n`;
        md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
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
                if (!step.assertionReport || step.assertionReport.passed) {
                    stepResult = '✅ Pass';
                }
                else {
                    stepResult = '❌ Fail';
                }
            }
            md += `| ${step.stepName} | ${methodBadge} | \`${step.url}\` | ${statusBadge} | ${durationText} | ${assertionSummary} | ${stepResult} |\n`;
        }
        md += '\n';
        // Detailed failure information
        const failures = result.steps.filter(s => s.error || (s.assertionReport && !s.assertionReport.passed));
        if (failures.length > 0) {
            md += `### 🔍 Failure Details\n\n`;
            for (const step of failures) {
                md += `#### ❌ Step: ${step.stepName} (${step.method.toUpperCase()} ${step.url})\n`;
                if (step.error) {
                    md += `> [!CAUTION]\n> **Execution Error:** ${step.error}\n\n`;
                }
                if (step.assertionReport && !step.assertionReport.passed) {
                    md += `**Failed Assertions:**\n`;
                    for (const res of step.assertionReport.results) {
                        if (!res.passed) {
                            md += `- [ ] \`Type: ${res.assertion.type}\` (Property: \`${res.assertion.property || 'none'}\`): ${res.message}\n`;
                        }
                    }
                    md += '\n';
                }
            }
        }
        return md;
    }
}
