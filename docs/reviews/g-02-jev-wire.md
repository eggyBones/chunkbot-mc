# G-02 — Jev wire and account probe

Coordinator probe, 2026-10-04, authorized by Jake’s implementation request. This gate is resolved; the action controller is not implemented or accepted.

Used the vault item `Openrouter DSH Key` through the credentials helper’s environment injection. No key was placed in a worker prompt or tracked file. Sent one tiny raw HTTP request to `POST https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13`, provider fallback disabled, a structured state, and one choice question with two criteria.

HTTP 200 in 426 ms. Actual response model `typesafe/jev-1.13-20260917`, provider TypeSafe. Selected `wait`, probabilities `{move: 0, wait: 1}`, confidence 1. Usage used snake_case fields: 346 input tokens, 32 output tokens, cost USD 0.000014532. Envelope, admitted ID, complete bounded distribution, and cost were checked by the coordinator.

[Redacted request/response fixture](g-02-jev-wire.json) contains the exact wire shape and timing, without authorization headers. The application must validate runtime responses, count attempts, reserve conservative ambiguous costs, and reject stale decisions. A successful access probe does not establish gameplay correctness.

Primary reference: [OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request). Raw HTTP fields must not be replaced with the SDK’s camelCase wrapper.

## Price ceiling probe

On 2026-10-04 (Phoenix; 2026-10-05T01:09:30Z), the coordinator independently verified the Decisions route honors `provider.max_price` with fallbacks disabled. A zero input ceiling returned HTTP 404, explicitly no eligible endpoint; `{prompt: 0.042, completion: 0, request: 0}` returned HTTP 200 in 337 ms, actual `typesafe/jev-1.13-20260917`, 321 input / 25 output tokens and USD 0.000013482. No secret was persisted. [Redacted exact fixture](g-02-jev-price.json).

The [official model page](https://openrouter.ai/typesafe/jev-1.13/) currently lists USD 0.042 per million input tokens and free output; the [provider routing documentation](https://openrouter.ai/docs/guides/routing/provider-selection#maximum-price) defines the ceiling units and failure behavior. Use the proven request-level ceiling plus bounded request/token accounting to reserve a conservative maximum before dispatch. A post-response cost check alone cannot enforce a spend cap. A price/route change must fail closed rather than silently exceed the configured ceiling. Controller accounting and fault tests remain phase03 work.
