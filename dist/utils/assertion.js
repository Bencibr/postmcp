import jp from 'jsonpath';
export class AssertionEngine {
    /**
     * Runs a suite of assertions against an HTTP response and generates a report.
     */
    static run(response, assertions) {
        const results = [];
        let passedCount = 0;
        for (const assertion of assertions) {
            let passed = false;
            let actualValue = undefined;
            let message = '';
            try {
                switch (assertion.type) {
                    case 'status':
                        actualValue = response.status;
                        passed = this.evaluate(actualValue, assertion.operator, assertion.expected);
                        message = passed
                            ? `Status code is ${actualValue}`
                            : `Expected status to be ${assertion.operator} ${JSON.stringify(assertion.expected)}, but got ${actualValue}`;
                        break;
                    case 'responseTime':
                        actualValue = response.durationMs;
                        passed = this.evaluate(actualValue, assertion.operator, assertion.expected);
                        message = passed
                            ? `Response time is ${actualValue}ms`
                            : `Expected response time to be ${assertion.operator} ${assertion.expected}ms, but got ${actualValue}ms`;
                        break;
                    case 'header':
                        const headerName = (assertion.property || '').toLowerCase();
                        // Find header key case-insensitively
                        const foundKey = Object.keys(response.headers).find(k => k.toLowerCase() === headerName);
                        actualValue = foundKey ? response.headers[foundKey] : undefined;
                        passed = this.evaluate(actualValue, assertion.operator, assertion.expected);
                        message = passed
                            ? `Header "${assertion.property}" matched condition`
                            : `Expected header "${assertion.property}" to be ${assertion.operator} ${JSON.stringify(assertion.expected)}, but got ${actualValue !== undefined ? JSON.stringify(actualValue) : 'undefined'}`;
                        break;
                    case 'body':
                        const jsonPath = assertion.property || '$';
                        let parsedBody = response.fullBody !== undefined ? response.fullBody : response.body;
                        // Attempt parsing if string
                        if (typeof parsedBody === 'string') {
                            try {
                                parsedBody = JSON.parse(parsedBody);
                            }
                            catch {
                                // Not JSON, treat as raw body if checking simple string
                            }
                        }
                        if (assertion.operator === 'exists' || assertion.operator === 'notExists') {
                            let exists = false;
                            try {
                                const nodes = jp.query(parsedBody, jsonPath);
                                exists = nodes.length > 0 && nodes[0] !== undefined;
                            }
                            catch {
                                exists = false;
                            }
                            passed = assertion.operator === 'exists' ? exists : !exists;
                            actualValue = exists ? 'exists' : 'does not exist';
                            message = passed
                                ? `Body path "${jsonPath}" ${actualValue}`
                                : `Expected body path "${jsonPath}" to ${assertion.operator === 'exists' ? 'exist' : 'not exist'}`;
                        }
                        else {
                            // Retrieve value
                            let nodes = [];
                            try {
                                nodes = jp.query(parsedBody, jsonPath);
                            }
                            catch (jpErr) {
                                throw new Error(`JSONPath evaluation failed: ${jpErr.message}`);
                            }
                            actualValue = nodes.length === 0 ? undefined : (nodes.length === 1 ? nodes[0] : nodes);
                            passed = this.evaluate(actualValue, assertion.operator, assertion.expected);
                            message = passed
                                ? `Body path "${jsonPath}" matched condition`
                                : `Expected body path "${jsonPath}" to be ${assertion.operator} ${JSON.stringify(assertion.expected)}, but got ${JSON.stringify(actualValue)}`;
                        }
                        break;
                    default:
                        message = `Unsupported assertion type: ${assertion.type}`;
                        passed = false;
                }
            }
            catch (err) {
                passed = false;
                message = `Assertion failed with error: ${err.message}`;
            }
            if (passed)
                passedCount++;
            results.push({ assertion, passed, actualValue, message });
        }
        return {
            passed: passedCount === assertions.length,
            results,
            summary: {
                total: assertions.length,
                passed: passedCount,
                failed: assertions.length - passedCount
            }
        };
    }
    /**
     * Helper to evaluate basic operators
     */
    static evaluate(actual, operator, expected) {
        switch (operator) {
            case 'equals':
                return actual == expected; // loose comparison for string/number flexibility
            case 'notEquals':
                return actual != expected;
            case 'contains':
                if (typeof actual === 'string') {
                    return actual.includes(String(expected));
                }
                if (Array.isArray(actual)) {
                    return actual.includes(expected);
                }
                if (actual !== null && typeof actual === 'object') {
                    return Object.keys(actual).includes(String(expected)) || Object.values(actual).includes(expected);
                }
                return false;
            case 'notContains':
                return !this.evaluate(actual, 'contains', expected);
            case 'exists':
                return actual !== undefined && actual !== null;
            case 'notExists':
                return actual === undefined || actual === null;
            case 'matches':
                if (typeof actual !== 'string')
                    actual = JSON.stringify(actual);
                const regex = new RegExp(String(expected));
                return regex.test(actual);
            case 'greaterThan':
                return Number(actual) > Number(expected);
            case 'lessThan':
                return Number(actual) < Number(expected);
            case 'in':
                if (Array.isArray(expected)) {
                    return expected.includes(actual);
                }
                if (typeof expected === 'string') {
                    return expected.split(',').map(s => s.trim()).includes(String(actual));
                }
                return false;
            case 'notIn':
                return !this.evaluate(actual, 'in', expected);
            default:
                return false;
        }
    }
}
