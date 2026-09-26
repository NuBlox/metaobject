# Runtime deployment policy gates

M21 adds asynchronous preflight governance to the M17–M20 deployment pipeline.

Policies run while a deployment is still `planned`, after any required manual approval has been recorded and immediately before the deployment transitions to `running`.

## Policy outcomes

A policy returns one of:

```text
allow   deployment may proceed
warn    deployment may proceed, but the warning is retained
 deny   deployment must remain planned
```

Warnings and denials require a message. Policies may also return structured evidence and an external reference.

```ts
const policies = new RuntimeDeploymentPolicyRegistry()
  .register({
    id: "change-window",
    async evaluate({ deployment }) {
      const window = await changeService.currentWindow();
      return window.open
        ? {
            outcome: "allow",
            evidence: { externalReference: window.id },
          }
        : {
            outcome: "deny",
            message: "No approved change window is open.",
            evidence: { externalReference: window.id },
          };
    },
  });
```

Policies receive a detached copy of the durable deployment record, including the exact M16 plan, target/source profile versions and current approval/journal state.

## Fail-closed evaluation

Policy evaluation is fail-closed.

If a policy:

- throws;
- returns an unsupported outcome;
- returns a warning/denial without a message; or
- returns malformed evidence;

its evaluation becomes a `deny` result containing the policy failure message.

An unreliable governance dependency therefore cannot silently turn into permission to deploy.

## Atomic audit recording

`RuntimeDeploymentPolicyGate` combines a policy registry with a `RuntimeDeploymentStore`:

```ts
const gate = new RuntimeDeploymentPolicyGate(
  deploymentStore,
  policies,
);
```

Evaluation returns both the report and the updated durable record:

```ts
const { report, record } = await gate.evaluate(deployment);
```

Every policy decision is appended as:

```text
deployment-policy-evaluated
```

to the M19 journal in one optimistic store save. M20 append-only enforcement means previous decisions cannot later be rewritten.

The event includes:

```text
policyId
policyOutcome
message
evidence.recordedAt
evidence.externalReference
evidence.details
```

If three policies run, all three decisions are appended atomically in registration order.

## Runner integration

M21 is optional in `RuntimeDeploymentRunner`.

Existing code without a policy gate behaves exactly as M18 did.

To enable gates:

```ts
const runner = new RuntimeDeploymentRunner(
  deployments,
  executors,
  undefined,
  undefined,
  gate,
);
```

For a planned deployment the runner evaluates gates in this order:

```text
manual-review approval required?
        ↓
autoStart enabled?
        ↓
M21 preflight policies
        ↓
all policies allow/warn?
        ↓
M17 start
        ↓
M18 executor loop
```

A denial returns:

```text
blockedReason = "policy-denied"
```

The deployment remains `planned`, no step is leased, and no executor side effect is invoked.

## Re-evaluation

A denied deployment can be evaluated again later.

This is important for conditions such as:

- temporary change freezes;
- maintenance windows;
- external approvals;
- service-health gates;
- capacity thresholds;
- prerequisite deployment status.

Each evaluation appends another immutable journal event. For example:

```text
1  deployment-created
2  deployment-policy-evaluated  change-freeze  deny
3  deployment-policy-evaluated  change-freeze  allow
4  deployment-started
```

The previous denial remains part of the audit record even after the condition changes.

## No hidden policy side effects

Policies are not evaluated when the runner is already blocked by explicit manual-review approval.

They are also not evaluated when the caller uses:

```ts
runner.run(id, { autoStart: false });
```

so a non-starting inspection does not unexpectedly call external governance systems or append policy events.

## Responsibility boundary

M21 defines the governance mechanism, not particular organisational policy.

The core package contains no concepts such as CAB, production, tenant, security accreditation or business-hours calendars. A consuming package/application can register policies that call those systems without coupling `@nublox/metaobject` to them.

```text
application policy
      ↓
M21 registry + gate
      ↓
M19/M20 immutable decision journal
      ↓
M17 deployment lifecycle
      ↓
M18 execution framework
```
