import { AssertionEngine, Assertion } from '../utils/assertion.js';
import { HttpResponseData } from '../client/http.js';
import jp from 'jsonpath';

// Simulation of httpClient.send logic
function simulateSend(responseData: any, jsonpathFilter?: string): HttpResponseData {
  let responseBody = responseData;
  
  if (jsonpathFilter && responseBody) {
    try {
      const parsedJson = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;
      const filtered = jp.query(parsedJson, jsonpathFilter);
      responseBody = filtered.length === 1 ? filtered[0] : filtered;
    } catch (jpErr: any) {
      responseBody = { error: jpErr.message };
    }
  }

  return {
    status: 200,
    statusText: 'OK',
    headers: {},
    body: responseBody,
    fullBody: responseData,
    durationMs: 50,
    isTruncated: false,
    originalSize: 100
  };
}

// Scenario A: responseData is an object, filter returns a scalar
const originalObjA = { code: 200, data: { total: 10, list: [] } };
const resA = simulateSend(originalObjA, '$.data.total');

console.log('Scenario A - resA.body:', resA.body); // Should be 10
console.log('Scenario A - resA.fullBody:', JSON.stringify(resA.fullBody)); // Should be original object
const reportA = AssertionEngine.run(resA, [
  { type: 'body', property: '$.data.total', operator: 'equals', expected: 10 }
]);
console.log('Scenario A - Assertion Passed:', reportA.passed);

// Scenario B: responseData is an object, filter returns a nested object (e.g. $.data)
const originalObjB = { code: 200, data: { total: 10, list: [] } };
const resB = simulateSend(originalObjB, '$.data');

console.log('Scenario B - resB.body:', JSON.stringify(resB.body)); // Should be { total: 10, list: [] }
console.log('Scenario B - resB.fullBody:', JSON.stringify(resB.fullBody)); // Should be original object
const reportB = AssertionEngine.run(resB, [
  { type: 'body', property: '$.data.total', operator: 'equals', expected: 10 }
]);
console.log('Scenario B - Assertion Passed:', reportB.passed);


