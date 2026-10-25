# Acceptance and behavior tests

`run.sh` executes the inherited **live health** feature, not all credential lifecycle scenarios. Do not report this as full functional BDD acceptance.

`features/credential-lifecycle.feature` describes the functional acceptance scenarios. Local scenarios map to executable Node tests in `test/unit/lifecycle.test.cjs`, `test/unit/integration-regressions.test.cjs`, `test/unit/smoke-runner.test.cjs` and real Vue DOM interactions in `test/ui/dom-smoke.cjs`. Run `npm test` at the package root; run `npm install --ignore-scripts && npm test` inside `test/ui` for DOM checks.

The two `@live @not-executed` scenarios require the user's deployment and provider onboarding. Run `scripts/retrieval-smoke.cjs <namespace> --accept`, then the checklist in `docs/CLUSTER-ACCEPTANCE.md`. A pending Storage blocker is not a passed lifecycle scenario. No Cucumber engine or simulated cluster result is claimed.
