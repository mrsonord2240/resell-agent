// Pure checks for Anthropic-compatible gateway configuration.
// Run: npm run build && node dist/brain/anthropic.test.js
import assert from "node:assert";
import { authenticationHeaders, messagesEndpoint, parseJson } from "./anthropic.js";

// A reply with two objects used to fail "Unexpected non-whitespace character after JSON".
assert.deepEqual(parseJson('{"title":"a","description":"x}y"}\n\n{"title":"b"}'), { title: "a", description: "x}y" });
assert.deepEqual(parseJson('Here you go:\n```json\n{"a":{"b":"\\"}"}}\n```'), { a: { b: '"}' } });
assert.throws(() => parseJson('{"a":1'), /no complete JSON object/);
assert.throws(() => parseJson("no json here"), /no JSON in model reply/);

assert.equal(messagesEndpoint("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
assert.equal(messagesEndpoint("https://api.example.test/v1/"), "https://api.example.test/v1/messages");
assert.deepEqual(authenticationHeaders("gateway-secret", undefined), { Authorization: "Bearer gateway-secret" });
assert.deepEqual(authenticationHeaders(undefined, "native-secret"), { "x-api-key": "native-secret" });
assert.throws(() => authenticationHeaders(undefined, undefined), /ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY/);

console.log("anthropic.test ok");
